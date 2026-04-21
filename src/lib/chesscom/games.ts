/**
 * Chess.com public archive fetcher. Produces `LichessGameMeta` objects so
 * the existing mistake-detection pipeline (authored against Lichess
 * NDJSON) runs unchanged against chess.com games. Public API, no auth.
 *
 * Flow:
 *   1. GET /pub/player/{user}/games/archives → list of monthly URLs.
 *   2. Walk archives newest-first, fetch each month's games, yield in
 *      reverse chronological order until `max` is reached.
 */

import type { LichessGameMeta } from '$lib/lichess/games';

export interface ChesscomScanOpts {
	max?: number;
	signal?: AbortSignal;
	/** Only rated games when true. */
	rated?: boolean;
	/** Include games played at or after this timestamp (ms since epoch). */
	since?: number;
}

interface ChesscomArchivesResponse {
	archives: string[];
}

interface ChesscomGame {
	url: string;
	pgn: string;
	time_class: string;
	time_control: string;
	end_time: number;
	rated: boolean;
	rules: string;
	white: ChesscomPlayer;
	black: ChesscomPlayer;
}

interface ChesscomPlayer {
	username: string;
	rating: number;
	result: string; // 'win' | 'checkmated' | 'timeout' | 'resigned' | …
	'@id': string;
	uuid?: string;
}

interface ChesscomArchiveResponse {
	games: ChesscomGame[];
}

export async function* streamChesscomGames(
	username: string,
	opts: ChesscomScanOpts = {}
): AsyncGenerator<LichessGameMeta> {
	const user = username.trim().toLowerCase();
	if (!user) return;
	const max = opts.max ?? 50;
	const archivesUrl = `https://api.chess.com/pub/player/${encodeURIComponent(user)}/games/archives`;
	const archivesRes = await fetch(archivesUrl, { signal: opts.signal });
	if (archivesRes.status === 404) throw new Error(`chess.com user "${username}" not found.`);
	if (archivesRes.status === 429) throw new Error('Rate limited by chess.com. Wait and retry.');
	if (!archivesRes.ok) throw new Error(`chess.com API: HTTP ${archivesRes.status}`);
	const { archives } = (await archivesRes.json()) as ChesscomArchivesResponse;
	// archives come sorted oldest-first; walk newest-first to match
	// the Lichess "recent games" semantics.
	const ordered = [...archives].reverse();

	let yielded = 0;
	for (const url of ordered) {
		if (yielded >= max) break;
		const res = await fetch(url, { signal: opts.signal });
		if (!res.ok) continue;
		const { games } = (await res.json()) as ChesscomArchiveResponse;
		// Games within an archive are chronological; reverse so we yield
		// newest-first per month.
		const monthly = [...games].reverse();
		for (const g of monthly) {
			if (yielded >= max) break;
			if (g.rules !== 'chess') continue;
			if (opts.rated !== undefined && g.rated !== opts.rated) continue;
			const createdAt = g.end_time * 1000;
			if (opts.since !== undefined && createdAt < opts.since) continue;
			const winner =
				g.white.result === 'win' ? 'white' : g.black.result === 'win' ? 'black' : undefined;
			const id = extractGameId(g.url);
			yield {
				id,
				rated: g.rated,
				variant: 'standard',
				speed: g.time_class,
				createdAt,
				players: {
					white: { user: { name: g.white.username }, rating: g.white.rating },
					black: { user: { name: g.black.username }, rating: g.black.rating }
				},
				winner,
				pgn: g.pgn,
				status: g.white.result === 'win' || g.black.result === 'win' ? 'mate' : 'draw'
			};
			yielded += 1;
		}
	}
}

function extractGameId(url: string): string {
	// URLs look like https://www.chess.com/game/live/123456789 — take the
	// numeric suffix. Fall back to the whole string if the pattern shifts.
	const m = url.match(/(\d+)\/?$/);
	return m ? `cc-${m[1]}` : `cc-${url}`;
}
