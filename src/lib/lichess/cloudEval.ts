/**
 * Lichess cloud-eval client.
 *
 * Looks up precomputed deep Stockfish evaluations for a FEN against
 * Lichess's cache of ~15M analysed positions. Common openings and
 * master-game transpositions almost always hit; obscure middlegame
 * positions miss (404 → returned as null).
 *
 * Lichess returns cp/mate already in white's POV (positive = white winning,
 * per their public docs) — no further normalisation needed here. The
 * explorer + edit page render evals in white's POV; local Stockfish output
 * (which IS side-to-move POV per UCI) gets flipped to white's POV at the
 * call site in src/routes/repertoire/[id]/edit/+page.svelte so both
 * sources line up.
 */

export interface CloudEvalPv {
	/** UCI move list, first = best move. */
	moves: string[];
	/** Centipawns in white's POV (positive = white better). */
	scoreCp?: number;
	/** Mate distance in white's POV (positive = white mates). */
	scoreMate?: number;
}

export interface CloudEval {
	fen: string;
	depth: number;
	knodes: number;
	pvs: CloudEvalPv[];
}

const CACHE_CAP = 200;
const cache = new Map<string, CloudEval | null>();
const inflight = new Map<string, Promise<CloudEval | null>>();
let cooldownUntil = 0;

/**
 * Fetch a cloud eval for `fen`. Returns null for cache misses (most
 * middlegame positions), network errors, or during a cool-down after
 * a 429. Results are cached in memory per `(fen, multiPv)`.
 *
 * Pass `signal` to abort in-flight fetches when the caller's position
 * changes; the cache is still populated on successful abort-races.
 */
export async function fetchCloudEval(
	fen: string,
	multiPv: number = 5,
	opts: { token?: string; signal?: AbortSignal } = {}
): Promise<CloudEval | null> {
	const clamped = Math.max(1, Math.min(20, Math.floor(multiPv)));
	const key = `${fen}|${clamped}`;
	if (cache.has(key)) {
		const v = cache.get(key)!;
		// LRU bump.
		cache.delete(key);
		cache.set(key, v);
		return v;
	}
	if (Date.now() < cooldownUntil) return null;
	const existing = inflight.get(key);
	if (existing) return existing;

	const p = doFetch(fen, clamped, opts).finally(() => {
		if (inflight.get(key) === p) inflight.delete(key);
	});
	inflight.set(key, p);
	return p;
}

async function doFetch(
	fen: string,
	multiPv: number,
	opts: { token?: string; signal?: AbortSignal }
): Promise<CloudEval | null> {
	const key = `${fen}|${multiPv}`;
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`;
	// Lichess cloud-eval returns cp/mate already in white's POV (per their
	// docs: "positive means white is winning"). No flip needed here — that
	// matches the explorer + edit page display convention. Local Stockfish
	// output IS in side-to-move POV per UCI; that gets flipped at its call
	// site in src/routes/repertoire/[id]/edit/+page.svelte.
	try {
		const res = await fetch(url, { headers, signal: opts.signal });
		if (res.status === 404) {
			store(key, null);
			return null;
		}
		if (res.status === 429) {
			cooldownUntil = Date.now() + 60_000;
			return null;
		}
		if (!res.ok) return null;
		const raw = (await res.json()) as {
			fen: string;
			depth: number;
			knodes: number;
			pvs: Array<{ moves: string; cp?: number; mate?: number }>;
		};
		const out: CloudEval = {
			fen: raw.fen,
			depth: raw.depth,
			knodes: raw.knodes,
			pvs: (raw.pvs ?? []).map((pv) => ({
				moves: pv.moves.split(' ').filter(Boolean),
				scoreCp: pv.cp,
				scoreMate: pv.mate
			}))
		};
		store(key, out);
		return out;
	} catch {
		return null;
	}
}

function store(key: string, value: CloudEval | null): void {
	if (cache.size >= CACHE_CAP) {
		const first = cache.keys().next().value;
		if (first !== undefined) cache.delete(first);
	}
	cache.set(key, value);
}
