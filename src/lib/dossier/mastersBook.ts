/**
 * Masters book lookups. A position with enough master-game entries is
 * "theory" and shouldn't be classified as a blunder or best move by the
 * engine — the player is recalling, not deciding. Lichess exposes the
 * Masters Database at https://explorer.lichess.ovh/masters.
 *
 * As of March 2026 the explorer endpoints (including /masters) require a
 * personal Lichess API token — unauthenticated requests 401. Callers
 * must pass `token`; without one we treat every position as non-book
 * (returns 0) rather than firing doomed network calls.
 *
 * Response shape we care about: `{ opening, white, draws, black, total,
 * moves: [...], ... }` — we only need `total` (= master-game count that
 * reached this position).
 *
 * We keep an in-memory cache keyed by FEN so a scan of 50 games that
 * share opening moves hits the API ~20–30 times, not ~3000.
 */

const ENDPOINT = 'https://explorer.lichess.ovh/masters';

/**
 * In-memory FEN → master-game-count cache. Lives for the lifetime of the
 * page load (SPA navigation preserves it; hard reload resets). A miss
 * returns 0 so the caller treats it as non-book.
 */
const cache = new Map<string, number>();
/** Track in-flight requests so concurrent callers dedupe onto one fetch. */
const inflight = new Map<string, Promise<number>>();

export interface MastersLookupOpts {
	/** ≥ this many master games = treat as book. Default 10. */
	minGames?: number;
	signal?: AbortSignal;
	/** Lichess personal API token (required by the explorer endpoint). */
	token?: string;
}

/**
 * Ask the masters DB how many games reached this FEN. Returns 0 on any
 * network / parse error — treats failures as "no book data", which
 * degrades gracefully (the engine pass still runs on those positions).
 *
 * Returns 0 immediately when no token is supplied: the endpoint requires
 * auth and unauthenticated calls just burn a 401 per move.
 */
export async function getMasterGameCount(
	fen: string,
	opts: MastersLookupOpts = {}
): Promise<number> {
	if (!opts.token) return 0;
	if (cache.has(fen)) return cache.get(fen) as number;
	const existing = inflight.get(fen);
	if (existing) return existing;

	const p = (async () => {
		try {
			const url = `${ENDPOINT}?fen=${encodeURIComponent(fen)}&moves=0&topGames=0`;
			const res = await fetch(url, {
				signal: opts.signal,
				headers: { Authorization: `Bearer ${opts.token}` }
			});
			if (!res.ok) {
				cache.set(fen, 0);
				return 0;
			}
			const data = (await res.json()) as { total?: number };
			const total = typeof data.total === 'number' ? data.total : 0;
			cache.set(fen, total);
			return total;
		} catch {
			cache.set(fen, 0);
			return 0;
		} finally {
			inflight.delete(fen);
		}
	})();
	inflight.set(fen, p);
	return p;
}

/** Convenience: is this position deep enough into the masters book to skip? */
export async function isBookPosition(fen: string, opts: MastersLookupOpts = {}): Promise<boolean> {
	const min = opts.minGames ?? 10;
	const total = await getMasterGameCount(fen, opts);
	return total >= min;
}
