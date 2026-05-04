/**
 * Lichess OAuth 2.0 with PKCE, entirely client-side.
 *
 * Lichess doesn't require app registration — any URL works as `client_id`
 * and the redirect_uri is trusted as long as it matches what was sent with
 * the authorisation request. On the web we use the app's origin +
 * `/auth/lichess/callback`. In a Tauri build we use a reverse-domain
 * scheme (`io.github.eiontusk.cobra://auth/lichess/callback`) so Lichess
 * can hand control back to the OS, which routes the URL to our app via
 * the deep-link plugin. Lichess rejects "exotic" custom schemes like
 * `cobra://` — they require reverse-domain notation for custom-app
 * redirect URIs.
 *
 * Flow (web):
 *   1. startOAuth()     — generate PKCE verifier + challenge, stash the
 *                         verifier, redirect the current tab to Lichess.
 *   2. (user authorises in the same tab)
 *   3. Lichess redirects back with ?code=...&state=...
 *   4. handleCallback() — swap the code for an access token and persist it.
 *
 * Flow (Tauri desktop / Android / iOS):
 *   1. startOAuth()     — same PKCE prep, but open the auth URL in the
 *                         user's *system* browser (where saved passwords
 *                         and SSO live). The Tauri app stays in place.
 *   2. (user authorises in their real browser)
 *   3. Lichess redirects to `io.github.eiontusk.cobra://auth/lichess/
 *                         callback?...` — the OS hands that to us via
 *                         the deep-link listener registered in the layout.
 *   4. The listener navigates the SvelteKit router to
 *      `/auth/lichess/callback?...`, which calls handleCallback().
 *
 * Storage note: the PKCE verifier lives in localStorage (not session) so
 * it survives Android suspending or killing the app while the user is
 * over in their browser; we clear it eagerly in handleCallback once it's
 * been consumed.
 */

import { base } from '$app/paths';

import { getSettings, saveSettings } from '$lib/storage/settings';
import { openExternal } from '$lib/platform/openExternal';
import type { LichessOAuthToken } from '$lib/types';

const AUTH_URL = 'https://lichess.org/oauth';
const TOKEN_URL = 'https://lichess.org/api/token';
const VERIFIER_KEY = 'ot:lichess:pkce-verifier';
const STATE_KEY = 'ot:lichess:pkce-state';
// Lichess's /api/token response doesn't echo the granted `scope` back —
// the endpoint returns only {token_type, access_token, expires_in}. So we
// stash the scopes we *asked for* at startOAuth time and read them back in
// handleCallback. Lichess grants all-or-nothing: if the callback arrives
// without an `error` param, the user accepted every scope we requested.
const SCOPES_KEY = 'ot:lichess:pkce-scopes';
// Path-and-hash to navigate to after a successful callback. Set by
// `startOAuth` when the caller knows where the user started (e.g. clicking
// "Sign in with Lichess" from the explorer in /repertoire/.../edit), and
// consumed by the callback page. Falls back to /settings when unset so the
// "Connect Lichess" button on the Settings page itself behaves as before.
const RETURN_KEY = 'ot:lichess:return-to';

/** Reverse-domain URL scheme registered with Tauri's deep-link plugin.
 *  Must match `plugins.deep-link.{mobile,desktop}.scheme[s]` in
 *  `tauri.conf.json` and the deep-link protocol filter in
 *  `src/routes/+layout.svelte`. Lichess rejects "exotic" schemes like
 *  bare `cobra://` and requires reverse-domain notation for custom apps,
 *  so we use the bundle identifier verbatim. */
export const TAURI_DEEP_LINK_SCHEME = 'io.github.eiontusk.cobra';
const TAURI_REDIRECT_URI = `${TAURI_DEEP_LINK_SCHEME}://auth/lichess/callback`;
/** Lichess accepts any URL as client_id — using the same custom scheme
 *  keeps web and Tauri requests visually consistent in Lichess's consent
 *  screen ("authorise io.github.eiontusk.cobra://app to…"). */
const TAURI_CLIENT_ID = `${TAURI_DEEP_LINK_SCHEME}://app`;

function isTauriRuntime(): boolean {
	if (typeof window === 'undefined') return false;
	return '__TAURI_INTERNALS__' in window || '__TAURI_METADATA__' in window;
}

/**
 * Scopes needed to read and write private Lichess studies from the
 * repertoire sync page. `study:read` opens private studies for pull;
 * `study:write` lets us create/replace chapters on push.
 */
export const STUDY_SCOPES = ['study:read', 'study:write'] as const;

/**
 * Scopes needed for the "Challenge bot" flow: `challenge:write` lets us
 * create a Stockfish AI game, and `bot:play` / `board:play` are what
 * Lichess checks when the opponent is a bot account (Maia1/5/9).
 */
export const CHALLENGE_SCOPES = ['challenge:write', 'bot:play', 'board:play'] as const;

/**
 * Full scope set we ask for when the user connects via the Settings page.
 * Grabbing everything up front means no "please reconnect" dance when the
 * user first tries to use a feature whose scope was left out.
 */
export const ALL_SCOPES = [...STUDY_SCOPES, ...CHALLENGE_SCOPES] as const;

export function tokenHasStudyScopes(t: LichessOAuthToken | null | undefined): boolean {
	if (!t) return false;
	return STUDY_SCOPES.every((s) => t.scopes.includes(s));
}

export function tokenHasChallengeScopes(t: LichessOAuthToken | null | undefined): boolean {
	if (!t) return false;
	return CHALLENGE_SCOPES.every((s) => t.scopes.includes(s));
}

// Include the SvelteKit `base` path so deployments under a subpath
// (e.g. GitHub Pages at /COBRA) use the correct callback URL. Lichess
// echoes this back verbatim, so it must match exactly. In the Tauri
// build we point at the custom scheme instead — see header docs.
function redirectUri(): string {
	if (isTauriRuntime()) return TAURI_REDIRECT_URI;
	return `${window.location.origin}${base}/auth/lichess/callback`;
}

function clientId(): string {
	if (isTauriRuntime()) return TAURI_CLIENT_ID;
	return `${window.location.origin}${base}/`;
}

/**
 * Reject anything that isn't a same-origin path. The post-OAuth callback
 * eventually feeds this string into `goto()`, so we have to defend against
 * open-redirect attacks where an attacker plants `?return=//evil.com` on a
 * link to /settings and waits for the victim to complete OAuth.
 *
 * Rules:
 *   - Must start with a single `/` (so `https://evil.com`, `javascript:…`,
 *     bare paths like `evil` are all rejected).
 *   - Must NOT start with `//` (protocol-relative — `//evil.com/x` resolves
 *     to https://evil.com/x) or `/\` (some browsers normalise the backslash
 *     to `/`, giving the same protocol-relative escape).
 *   - When resolved against the current origin must produce the same origin
 *     — defence-in-depth in case a parser quirk slips past the prefix check.
 */
export function isSafeReturnPath(raw: unknown): raw is string {
	if (typeof raw !== 'string' || raw.length === 0) return false;
	if (raw[0] !== '/') return false;
	if (raw.startsWith('//') || raw.startsWith('/\\')) return false;
	if (typeof window === 'undefined') return false;
	try {
		const resolved = new URL(raw, window.location.origin);
		return resolved.origin === window.location.origin;
	} catch {
		return false;
	}
}

function base64url(bytes: Uint8Array): string {
	let str = '';
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
	const random = crypto.getRandomValues(new Uint8Array(32));
	const verifier = base64url(random);
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	const challenge = base64url(new Uint8Array(hash));
	return { verifier, challenge };
}

/**
 * Kick off the OAuth flow. On the web this navigates the current tab away
 * to Lichess; in Tauri it instead opens Lichess in the user's system
 * browser and the Tauri app stays put — see the deep-link handler in the
 * layout for the return path. `scopes` defaults to none — the Lichess
 * explorer and public game history don't require any special scope.
 */
export async function startOAuth(scopes: string[] = [], returnTo?: string): Promise<void> {
	const { verifier, challenge } = await generatePkce();
	const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
	// localStorage (not sessionStorage) so the verifier survives the OS
	// suspending/killing our app while the user is in their browser.
	// `handleCallback` clears these on success or failure.
	localStorage.setItem(VERIFIER_KEY, verifier);
	localStorage.setItem(STATE_KEY, state);
	localStorage.setItem(SCOPES_KEY, scopes.join(' '));
	// Stash the desired post-OAuth landing page if the caller supplied a
	// safe same-origin path; otherwise clear any stale value so a previous
	// flow doesn't bleed into this one (e.g. the user kicked off from /edit,
	// abandoned, then later connected from /settings). Validating at write
	// time as well as read time means even if an attacker poisons the
	// localStorage stash through some other vector, the most they can plant
	// is a same-origin path.
	if (returnTo !== undefined && isSafeReturnPath(returnTo)) {
		localStorage.setItem(RETURN_KEY, returnTo);
	} else {
		localStorage.removeItem(RETURN_KEY);
	}

	const params = new URLSearchParams({
		response_type: 'code',
		client_id: clientId(),
		redirect_uri: redirectUri(),
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state
	});
	if (scopes.length > 0) params.set('scope', scopes.join(' '));

	const url = `${AUTH_URL}?${params.toString()}`;
	if (isTauriRuntime()) {
		// Hand the URL to the OS so it lands in the user's real browser
		// (where their Lichess login + 2FA lives). The deep-link listener
		// picks the callback up when Lichess redirects to the registered
		// reverse-domain scheme.
		await openExternal(url);
		return;
	}
	window.location.href = url;
}

export async function handleCallback(code: string, state: string): Promise<void> {
	// Read from localStorage (where startOAuth wrote them). Older sessions
	// might have used sessionStorage; fall back so a user mid-flow at the
	// time of the upgrade doesn't get a "missing verifier" error.
	const savedVerifier = localStorage.getItem(VERIFIER_KEY) ?? sessionStorage.getItem(VERIFIER_KEY);
	const savedState = localStorage.getItem(STATE_KEY) ?? sessionStorage.getItem(STATE_KEY);
	const savedScopes = localStorage.getItem(SCOPES_KEY) ?? sessionStorage.getItem(SCOPES_KEY) ?? '';
	localStorage.removeItem(VERIFIER_KEY);
	localStorage.removeItem(STATE_KEY);
	localStorage.removeItem(SCOPES_KEY);
	sessionStorage.removeItem(VERIFIER_KEY);
	sessionStorage.removeItem(STATE_KEY);
	sessionStorage.removeItem(SCOPES_KEY);

	if (!savedVerifier) {
		throw new Error('Missing PKCE verifier — start the OAuth flow again.');
	}
	if (!savedState || savedState !== state) {
		throw new Error('State mismatch — possible CSRF, aborting.');
	}

	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUri(),
		client_id: clientId(),
		code_verifier: savedVerifier
	});
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Token exchange failed: HTTP ${res.status} — ${text}`);
	}
	const data = (await res.json()) as {
		token_type: string;
		access_token: string;
		expires_in: number;
		scope?: string;
	};

	// Prefer the server-reported scope string if present (future-proof), else
	// fall back to what we asked for. Lichess currently doesn't return scope
	// in the token response, so the fallback is the common path.
	const scopeStr = data.scope ?? savedScopes;
	const token: LichessOAuthToken = {
		accessToken: data.access_token,
		tokenType: data.token_type,
		expiresAt: Date.now() + data.expires_in * 1000,
		scopes: scopeStr ? scopeStr.split(' ').filter(Boolean) : []
	};

	// Best-effort username probe so the UI can show who's connected.
	try {
		const meRes = await fetch('https://lichess.org/api/account', {
			headers: { Authorization: `Bearer ${token.accessToken}` }
		});
		if (meRes.ok) {
			const me = (await meRes.json()) as { username?: string };
			if (me.username) token.username = me.username;
		}
	} catch {
		/* fine — username is optional */
	}

	const settings = await getSettings();
	settings.lichessOAuth = token;
	await saveSettings(JSON.parse(JSON.stringify(settings)));
}

/**
 * Connect via a Personal Access Token the user generates on Lichess and
 * pastes back into the app. Bypasses the OAuth deep-link flow entirely —
 * essential on Android, where Tauri's `Java_…_Rust_onNewIntent` handler
 * panics (SIGABRT) when delivering the OAuth-callback intent to the
 * running activity, so the OAuth round-trip can never complete on
 * mobile. Desktop / web users stick with `startOAuth` for the smoother
 * one-click flow.
 *
 * Validates the token by:
 *   1. POST /api/token/test → confirms the token exists and reads back
 *      the scopes Lichess actually granted (the user might have
 *      ticked/unticked some on the create page).
 *   2. GET /api/account     → captures username for display, fails the
 *      whole connect if the token is rejected.
 *
 * Persists the result in `lichessOAuth` so every existing scope-aware
 * code path (study sync, bot-play, autobuild) treats it identically to
 * an OAuth-issued token. Lichess PATs don't expire — we encode that as
 * `expiresAt = +Infinity` (`Number.POSITIVE_INFINITY` survives
 * JSON.stringify as `null`, so we use a far-future epoch instead).
 */
const PAT_NEVER_EXPIRES_AT = 4102444800000; // 2100-01-01 UTC, ms

export async function connectViaPastedToken(rawToken: string): Promise<LichessOAuthToken> {
	const token = rawToken.trim();
	if (!token) throw new Error('Paste a token first.');
	// Lichess PATs are prefixed `lip_` (legacy: `lio_`); reject obvious
	// noise rather than firing requests that will 401.
	if (!/^l[a-z]{2}_[A-Za-z0-9]+$/.test(token)) {
		throw new Error("That doesn't look like a Lichess token (expected `lip_…`).");
	}

	// /api/token/test takes a newline-separated list of tokens in the
	// body and returns a JSON object keyed by token. Scopes for each
	// known token come back as a comma-separated string; an unknown
	// token maps to null.
	const testRes = await fetch(`${TOKEN_URL}/test`, {
		method: 'POST',
		headers: { 'Content-Type': 'text/plain' },
		body: token
	});
	if (!testRes.ok) {
		throw new Error(`Couldn't validate the token (HTTP ${testRes.status}).`);
	}
	const testData = (await testRes.json()) as Record<
		string,
		{ scopes?: string; userId?: string } | null
	>;
	const info = testData[token];
	if (!info) {
		throw new Error("Lichess didn't recognise that token. Generate a fresh one.");
	}
	const scopes = (info.scopes ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	const result: LichessOAuthToken = {
		accessToken: token,
		tokenType: 'Bearer',
		expiresAt: PAT_NEVER_EXPIRES_AT,
		scopes
	};

	try {
		const meRes = await fetch('https://lichess.org/api/account', {
			headers: { Authorization: `Bearer ${token}` }
		});
		if (meRes.ok) {
			const me = (await meRes.json()) as { username?: string };
			if (me.username) result.username = me.username;
		}
	} catch {
		/* username is optional — token is valid, /api/account just blipped */
	}

	const settings = await getSettings();
	settings.lichessOAuth = result;
	await saveSettings(JSON.parse(JSON.stringify(settings)));
	return result;
}

/**
 * URL of the Lichess token-create page with all scopes COBRA needs
 * pre-checked. Open this in the user's system browser; they tick the
 * scopes they want (defaults match COBRA's full feature set), name the
 * token, and copy the resulting `lip_…` string. Used by the Settings
 * "Paste a token" UI as the recommended OAuth-bypass path on Android.
 */
export function tokenCreatePageUrl(scopes: readonly string[] = ALL_SCOPES): string {
	const params = new URLSearchParams({
		scopes: scopes.join(' '),
		description: 'COBRA'
	});
	return `https://lichess.org/account/oauth/token/create?${params.toString()}`;
}

export async function disconnectOAuth(): Promise<void> {
	const settings = await getSettings();
	const token = settings.lichessOAuth?.accessToken;
	settings.lichessOAuth = null;
	await saveSettings(JSON.parse(JSON.stringify(settings)));
	if (token) {
		// Best-effort server-side revoke; don't block on it.
		try {
			await fetch(TOKEN_URL, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` }
			});
		} catch {
			/* ignore */
		}
	}
}

export function tokenIsFresh(t: LichessOAuthToken | null | undefined): boolean {
	return !!t && t.expiresAt > Date.now();
}

/**
 * Read-and-clear the post-OAuth return URL stashed by `startOAuth`. Returns
 * `null` if none was set (in which case the caller should fall back to a
 * sensible default like /settings) or if the stash isn't a same-origin
 * path. The strictness here is the load-bearing defence against open-
 * redirect attacks via a poisoned `?return=` query param — see
 * `isSafeReturnPath`.
 */
export function consumeOAuthReturnTo(): string | null {
	const raw = localStorage.getItem(RETURN_KEY);
	localStorage.removeItem(RETURN_KEY);
	return isSafeReturnPath(raw) ? raw : null;
}
