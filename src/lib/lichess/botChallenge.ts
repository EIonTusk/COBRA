/**
 * Lichess bot-challenge launcher.
 *
 * Two flavours:
 *   1. Stockfish AI — `POST /api/challenge/ai` creates a game vs Lichess's
 *      own Stockfish wrapper at the requested level (1–8) and returns the
 *      game URL immediately. No opponent-accept step.
 *   2. Maia (maia1 / maia5 / maia9) — `POST /api/challenge/{username}`
 *      creates an open challenge the bot auto-accepts. We return the
 *      challenge URL; Lichess redirects to the game once accepted.
 *
 * Both require a Lichess personal token with `challenge:write` scope. If
 * the user's token lacks the scope, Lichess responds 401/403 and we
 * surface the error so the caller can nudge them toward Settings.
 */

export type ChallengeColor = 'white' | 'black' | 'random';

export interface StockfishChallengeOpts {
	/** Stockfish difficulty 1–8. Lichess caps at 8; anything higher is rejected. */
	level: number;
	color: ChallengeColor;
	/** Starting FEN. Lichess requires variant=standard and a legal position. */
	fen?: string;
	/** Initial clock in seconds (default 10 min). */
	clockLimit?: number;
	/** Clock increment in seconds (default 0). */
	clockIncrement?: number;
	token: string;
	signal?: AbortSignal;
}

export interface MaiaChallengeOpts {
	/** Maia rating: 1100, 1500, or 1900 (maps to bot username maia1/5/9). */
	rating: 1100 | 1500 | 1900;
	color: ChallengeColor;
	fen?: string;
	clockLimit?: number;
	clockIncrement?: number;
	token: string;
	signal?: AbortSignal;
}

export class BotChallengeError extends Error {
	constructor(
		message: string,
		public status: number,
		/** True when Lichess's reply mentions a missing scope — the UI can
		 *  then show a "regenerate token with scope X" helper link. */
		public missingScope: boolean = false
	) {
		super(message);
	}
}

/**
 * Scopes required to launch a bot game from Cobra. The token-create URL
 * below pre-checks these so the user gets a working token in one click.
 */
export const REQUIRED_CHALLENGE_SCOPES = ['challenge:write', 'bot:play', 'board:play'] as const;

/**
 * URL to Lichess's token-creation page with the required scopes
 * pre-selected. Open in a new tab; user pastes the resulting token
 * into Cobra Settings.
 */
export const TOKEN_WITH_SCOPES_URL = (() => {
	const params = new URLSearchParams();
	params.set('description', 'Cobra — challenge bots');
	for (const s of REQUIRED_CHALLENGE_SCOPES) params.append('scopes[]', s);
	return `https://lichess.org/account/oauth/token/create?${params.toString()}`;
})();

async function parseError(res: Response): Promise<{ message: string; missingScope: boolean }> {
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		/* non-JSON body */
	}
	const rawMsg =
		body &&
		typeof body === 'object' &&
		'error' in body &&
		typeof (body as { error: unknown }).error === 'string'
			? ((body as { error: string }).error as string)
			: `HTTP ${res.status}`;
	const missingScope = /scope/i.test(rawMsg);
	return {
		message: missingScope
			? `Lichess token is missing required scopes (challenge:write · bot:play · board:play). Regenerate a token with these scopes in Settings, then try again.`
			: `Lichess challenge failed: ${rawMsg}`,
		missingScope
	};
}

/**
 * Kick off a Stockfish AI game. Returns the game URL (e.g.
 * `https://lichess.org/<id>`) — open it in a new tab.
 */
export async function challengeStockfishAi(opts: StockfishChallengeOpts): Promise<string> {
	const level = Math.max(1, Math.min(8, Math.floor(opts.level)));
	const body = new URLSearchParams();
	body.set('level', String(level));
	body.set('color', opts.color);
	body.set('variant', 'standard');
	body.set('clock.limit', String(opts.clockLimit ?? 600));
	body.set('clock.increment', String(opts.clockIncrement ?? 0));
	if (opts.fen) body.set('fen', opts.fen);

	const res = await fetch('https://lichess.org/api/challenge/ai', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${opts.token}`,
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		},
		body,
		signal: opts.signal
	});
	if (!res.ok) {
		const { message, missingScope } = await parseError(res);
		throw new BotChallengeError(message, res.status, missingScope);
	}
	const data = (await res.json()) as { id?: string; url?: string };
	if (data.url) return data.url;
	if (data.id) return `https://lichess.org/${data.id}`;
	throw new BotChallengeError('Lichess AI challenge returned no game URL.', 0);
}

/**
 * Open a challenge to a Maia bot. Maia auto-accepts, so the returned URL
 * will resolve to the live game after the redirect.
 */
export async function challengeMaia(opts: MaiaChallengeOpts): Promise<string> {
	const username = opts.rating === 1100 ? 'maia1' : opts.rating === 1500 ? 'maia5' : 'maia9';
	const body = new URLSearchParams();
	body.set('rated', 'false');
	body.set('color', opts.color);
	body.set('variant', 'standard');
	body.set('clock.limit', String(opts.clockLimit ?? 600));
	body.set('clock.increment', String(opts.clockIncrement ?? 0));
	if (opts.fen) body.set('fen', opts.fen);

	const res = await fetch(`https://lichess.org/api/challenge/${username}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${opts.token}`,
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		},
		body,
		signal: opts.signal
	});
	if (!res.ok) {
		const { message, missingScope } = await parseError(res);
		throw new BotChallengeError(message, res.status, missingScope);
	}
	const data = (await res.json()) as {
		challenge?: { url?: string; id?: string };
		url?: string;
		urlWhite?: string;
		urlBlack?: string;
	};
	if (data.urlWhite && opts.color === 'white') return data.urlWhite;
	if (data.urlBlack && opts.color === 'black') return data.urlBlack;
	if (data.url) return data.url;
	if (data.challenge?.url) return data.challenge.url;
	if (data.challenge?.id) return `https://lichess.org/${data.challenge.id}`;
	throw new BotChallengeError('Maia challenge returned no URL to open.', 0);
}
