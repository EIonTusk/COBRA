/**
 * Lichess OAuth 2.0 with PKCE, entirely client-side.
 *
 * Lichess doesn't require app registration — any URL works as `client_id`
 * and the redirect_uri is trusted as long as it matches what was sent with
 * the authorisation request. We use the app's origin + `/auth/lichess/callback`.
 *
 * Flow:
 *   1. startOAuth()     — generate PKCE verifier + challenge, stash the
 *                         verifier in sessionStorage, redirect to Lichess.
 *   2. (user authorises)
 *   3. Lichess redirects back with ?code=...&state=...
 *   4. handleCallback() — swap the code for an access token and persist it
 *                         in AppSettings.
 */

import { base } from '$app/paths';

import { getSettings, saveSettings } from '$lib/storage/settings';
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
// echoes this back verbatim, so it must match exactly.
function redirectUri(): string {
	return `${window.location.origin}${base}/auth/lichess/callback`;
}

function clientId(): string {
	return `${window.location.origin}${base}/`;
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
 * Kick off the OAuth flow. Navigates away; callers don't come back from this.
 * `scopes` defaults to none — the Lichess explorer and public game history
 * don't require any special scope.
 */
export async function startOAuth(scopes: string[] = []): Promise<void> {
	const { verifier, challenge } = await generatePkce();
	const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
	sessionStorage.setItem(VERIFIER_KEY, verifier);
	sessionStorage.setItem(STATE_KEY, state);
	sessionStorage.setItem(SCOPES_KEY, scopes.join(' '));

	const params = new URLSearchParams({
		response_type: 'code',
		client_id: clientId(),
		redirect_uri: redirectUri(),
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state
	});
	if (scopes.length > 0) params.set('scope', scopes.join(' '));

	window.location.href = `${AUTH_URL}?${params.toString()}`;
}

export async function handleCallback(code: string, state: string): Promise<void> {
	const savedVerifier = sessionStorage.getItem(VERIFIER_KEY);
	const savedState = sessionStorage.getItem(STATE_KEY);
	const savedScopes = sessionStorage.getItem(SCOPES_KEY) ?? '';
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
