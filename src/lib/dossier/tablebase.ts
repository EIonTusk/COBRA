/**
 * Syzygy tablebase lookups via Lichess's public endpoint
 * https://tablebase.lichess.ovh/standard. Covers up to 7-piece positions;
 * no auth; rate-limited generously for sparse access.
 *
 * When a position has ≤7 pieces it has a *ground-truth* verdict — the
 * engine's centipawn estimate is merely an approximation. Using the
 * tablebase answer lets the endgame-subtypes finding say "you had 8
 * tablebase-winning R+P endgames and converted 3" with certainty rather
 * than statistical estimate.
 *
 * We cache per FEN in memory; IDB cache would be nicer but memory is fine
 * for a per-scan workload.
 */

import { countFenPieces } from './sota';

const ENDPOINT = 'https://tablebase.lichess.ovh/standard';
const TABLEBASE_PIECE_LIMIT = 7;

export type Wdl = 'win' | 'cursed-win' | 'draw' | 'blessed-loss' | 'loss';

export interface TablebaseResult {
	/** WDL from the *side-to-move* POV at the queried FEN. */
	wdl: Wdl;
	/** Distance to zero (halfmove count to resetting 50-move draw clock). */
	dtz: number | null;
	/** Distance to mate. */
	dtm: number | null;
	/** Is the side-to-move checkmated / stalemated? */
	checkmate: boolean;
	stalemate: boolean;
}

const cache = new Map<string, TablebaseResult | null>();
const inflight = new Map<string, Promise<TablebaseResult | null>>();

export function isTablebaseEligible(fen: string): boolean {
	return countFenPieces(fen) <= TABLEBASE_PIECE_LIMIT;
}

export async function lookupTablebase(
	fen: string,
	signal?: AbortSignal
): Promise<TablebaseResult | null> {
	if (!isTablebaseEligible(fen)) return null;
	if (cache.has(fen)) return cache.get(fen) ?? null;
	const existing = inflight.get(fen);
	if (existing) return existing;

	const p = (async () => {
		try {
			const url = `${ENDPOINT}?fen=${encodeURIComponent(fen)}`;
			const res = await fetch(url, { signal });
			if (!res.ok) {
				cache.set(fen, null);
				return null;
			}
			const data = (await res.json()) as {
				category?: string;
				dtz?: number | null;
				dtm?: number | null;
				checkmate?: boolean;
				stalemate?: boolean;
			};
			const wdl = mapCategory(data.category);
			if (!wdl) {
				cache.set(fen, null);
				return null;
			}
			const out: TablebaseResult = {
				wdl,
				dtz: data.dtz ?? null,
				dtm: data.dtm ?? null,
				checkmate: !!data.checkmate,
				stalemate: !!data.stalemate
			};
			cache.set(fen, out);
			return out;
		} catch {
			cache.set(fen, null);
			return null;
		} finally {
			inflight.delete(fen);
		}
	})();
	inflight.set(fen, p);
	return p;
}

function mapCategory(c: string | undefined): Wdl | null {
	switch (c) {
		case 'win':
			return 'win';
		case 'cursed-win':
			return 'cursed-win';
		case 'draw':
			return 'draw';
		case 'blessed-loss':
			return 'blessed-loss';
		case 'loss':
			return 'loss';
		default:
			return null;
	}
}

/**
 * WDL value → signed CP representing tablebase truth. Tablebase wins are
 * rendered as +MATE_WP_CP so the sigmoid treats them as conclusive; cursed
 * wins / blessed losses are treated as draws because they're 50-move
 * casualties that don't affect the played-result in the real game.
 */
export function wdlToCp(wdl: Wdl): number {
	if (wdl === 'win') return 1500;
	if (wdl === 'loss') return -1500;
	return 0; // draw, cursed-win, blessed-loss all → 0 for accuracy purposes
}
