/**
 * Lichess Opening Explorer client. Returns aggregate move distributions
 * for a given FEN, optionally filtered by rating band and time control.
 *
 *   GET https://explorer.lichess.ovh/lichess?fen=…&speeds=blitz&ratings=1400,1600
 *
 * Two cache layers (cheap-first):
 *
 *   1. **In-memory** map keyed by FEN+speeds+ratings. Cleared on reload.
 *   2. **IndexedDB** `explorer_stats` store reused from the existing
 *      explorer cache infra. Survives reloads. 30-day TTL via the
 *      existing `pruneExplorerCache` helper.
 *
 * Token forwarded via `Authorization: Bearer …` when available — the
 * Explorer host is technically anon but bearer doesn't hurt.
 *
 * Rate limiting: serialised promise chain with a configurable inter-
 * request delay (default 250ms ≈ 4 req/s). Lichess Explorer's anon ceiling
 * is around 6/s; we leave headroom so a stray burst doesn't trip 429.
 */

import { getDB, type ExplorerStatRow } from '$lib/storage/db';

const LICHESS_URL = 'https://explorer.lichess.ovh/lichess';
const MASTERS_URL = 'https://explorer.lichess.ovh/masters';
const ALLOWED_RATINGS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500] as const;
const DEFAULT_INTER_REQUEST_MS = 250;
const IDB_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ExplorerMove {
	uci: string;
	san: string;
	white: number;
	draws: number;
	black: number;
	averageRating?: number;
}

export interface ExplorerResult {
	total: number;
	white: number;
	draws: number;
	black: number;
	moves: ExplorerMove[];
}

export interface ExplorerOpts {
	speeds?: Array<'ultraBullet' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence'>;
	ratings?: number[];
	signal?: AbortSignal;
	/**
	 * Which Lichess explorer dataset to query. Defaults to `'lichess'` —
	 * crowd play filtered by speed/rating. `'masters'` queries the OTB
	 * masters DB, which ignores speed/rating filters; pass them anyway and
	 * they're silently dropped from the request.
	 */
	source?: 'lichess' | 'masters';
}

const memCache = new Map<string, ExplorerResult>();

/**
 * Pick the two Explorer rating bands flanking a user rating. The Explorer
 * accepts only the discrete buckets in ALLOWED_RATINGS; passing a value
 * not on that list returns 400.
 */
export function ratingsForRating(rating: number): number[] {
	const sorted = [...ALLOWED_RATINGS].sort((a, b) => Math.abs(a - rating) - Math.abs(b - rating));
	return sorted.slice(0, 2).sort((a, b) => a - b);
}

let chain: Promise<unknown> = Promise.resolve();
function nextSlot(interMs: number): Promise<void> {
	const slot = chain.then(() => new Promise<void>((r) => setTimeout(r, interMs)));
	chain = slot.catch(() => undefined);
	return slot;
}

export async function getExplorerStats(
	fen: string,
	opts: ExplorerOpts = {},
	token?: string,
	interRequestMs = DEFAULT_INTER_REQUEST_MS
): Promise<ExplorerResult> {
	const key = cacheKey(fen, opts);

	const memHit = memCache.get(key);
	if (memHit) return memHit;

	const idbHit = await readIdb(key);
	if (idbHit) {
		memCache.set(key, idbHit);
		return idbHit;
	}

	await nextSlot(interRequestMs);

	const source = opts.source ?? 'lichess';
	const url = new URL(source === 'masters' ? MASTERS_URL : LICHESS_URL);
	url.searchParams.set('fen', fen);
	url.searchParams.set('variant', 'standard');
	url.searchParams.set('topGames', '0');
	url.searchParams.set('moves', '12');
	if (source !== 'masters') {
		// /masters returns 400 on unrecognised params (recentGames, speeds,
		// ratings), and the masters DB is rating/speed-agnostic anyway.
		url.searchParams.set('recentGames', '0');
		if (opts.speeds && opts.speeds.length) {
			url.searchParams.set('speeds', opts.speeds.join(','));
		}
		if (opts.ratings && opts.ratings.length) {
			url.searchParams.set('ratings', opts.ratings.join(','));
		}
	}

	const headers: Record<string, string> = { Accept: 'application/json' };
	if (token) headers.Authorization = `Bearer ${token}`;

	const res = await fetch(url, { headers, signal: opts.signal });
	if (res.status === 429) throw new Error('Lichess Explorer rate-limited (429). Slow down.');
	if (!res.ok) throw new Error(`Lichess Explorer: HTTP ${res.status}`);

	const json = (await res.json()) as Omit<ExplorerResult, 'total'>;
	const total = (json.white ?? 0) + (json.draws ?? 0) + (json.black ?? 0);
	const result: ExplorerResult = { ...json, total };

	memCache.set(key, result);
	void writeIdb(key, result);
	return result;
}

function cacheKey(fen: string, opts: ExplorerOpts): string {
	const source = opts.source ?? 'lichess';
	if (source === 'masters') {
		// Masters has no speed/rating axis, so the cache key collapses on
		// those — same FEN always returns the same masters distribution.
		return `style:masters:${fen}`;
	}
	const speeds = (opts.speeds ?? []).slice().sort().join(',');
	const ratings = (opts.ratings ?? []).slice().sort().join(',');
	return `style:${fen}|${speeds}|${ratings}`;
}

async function readIdb(key: string): Promise<ExplorerResult | null> {
	try {
		const db = await getDB();
		const row = await db.get('explorer_stats', key);
		if (!row) return null;
		if (Date.now() - row.fetchedAt > IDB_TTL_MS) return null;
		return row.data as ExplorerResult;
	} catch {
		return null;
	}
}

async function writeIdb(key: string, data: ExplorerResult): Promise<void> {
	try {
		const db = await getDB();
		const row: ExplorerStatRow = { key, fetchedAt: Date.now(), data };
		await db.put('explorer_stats', row);
	} catch {
		/* cache write is non-critical */
	}
}

export function clearExplorerMemCache(): void {
	memCache.clear();
}
