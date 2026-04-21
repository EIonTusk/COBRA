/**
 * Narrow-path detection for the "sharp" explorer tag.
 *
 * A move is "sharp" when the forced sequence it leads into is narrow — i.e.
 * the replies at the next couple of plies are heavily concentrated on a
 * single continuation. We approximate that by probing the child position
 * one or two plies deep and measuring the concentration of the top reply:
 *
 *   concentration = topReply.games / position.totalGames
 *
 * When concentration is ≥ 0.55 at ply 1, probe again one ply deeper (after
 * the forced reply) and take the min. That gives a crude "narrowness for N
 * plies" figure we can threshold for the badge.
 *
 * Callers are expected to invoke this after the main explorer fetch has
 * landed, and only for moves that already look like candidates — every
 * probe costs an extra request, and Lichess rate-limits hard.
 */

import { fetchExplorer, type ExplorerQuery, type ExplorerResponse } from './client';

export interface NarrownessResult {
	/** Minimum top-reply concentration observed across the probed plies. */
	concentration: number;
	/** How many plies we actually probed (1 or 2). */
	plies: number;
	/** Total games at the first probed position, for sample-size gating. */
	childGames: number;
}

const cache = new Map<string, NarrownessResult>();

function cacheKey(fen: string, play: string[]): string {
	return `${fen}|${play.join(',')}`;
}

function concentrationOf(r: ExplorerResponse): { c: number; top?: string; total: number } {
	if (!r.moves || r.moves.length === 0) return { c: 0, total: 0 };
	let total = 0;
	let topGames = 0;
	let topUci: string | undefined;
	for (const m of r.moves) {
		const g = m.white + m.draws + m.black;
		total += g;
		if (g > topGames) {
			topGames = g;
			topUci = m.uci;
		}
	}
	return { c: total === 0 ? 0 : topGames / total, top: topUci, total };
}

/**
 * Probe the narrowness of the line starting with `uci` from `fen`. Up to two
 * extra explorer requests. Resolves with a concentration ∈ [0, 1] even on
 * failure (returns 0 so callers can degrade silently). Results are cached
 * in memory.
 */
export async function probeNarrowness(
	fen: string,
	uci: string,
	base: Pick<ExplorerQuery, 'speeds' | 'ratings' | 'token'>
): Promise<NarrownessResult> {
	const k1 = cacheKey(fen, [uci]);
	const hit = cache.get(k1);
	if (hit) return hit;

	try {
		const r1 = await fetchExplorer({
			fen,
			play: [uci],
			speeds: base.speeds,
			ratings: base.ratings,
			token: base.token,
			moves: 6
		});
		const { c: c1, top, total } = concentrationOf(r1);
		if (!top || c1 < 0.55 || total < 30) {
			const result: NarrownessResult = { concentration: c1, plies: 1, childGames: total };
			cache.set(k1, result);
			return result;
		}

		// Ply-2 probe after the forced reply.
		const k2 = cacheKey(fen, [uci, top]);
		const cachedC2 = cache.get(k2);
		let c2 = cachedC2?.concentration;
		if (c2 === undefined) {
			const r2 = await fetchExplorer({
				fen,
				play: [uci, top],
				speeds: base.speeds,
				ratings: base.ratings,
				token: base.token,
				moves: 6
			});
			c2 = concentrationOf(r2).c;
			cache.set(k2, { concentration: c2, plies: 1, childGames: 0 });
		}

		const result: NarrownessResult = {
			concentration: Math.min(c1, c2),
			plies: 2,
			childGames: total
		};
		cache.set(k1, result);
		return result;
	} catch {
		// Rate limited or offline — don't crash the UI, just report "not narrow".
		return { concentration: 0, plies: 0, childGames: 0 };
	}
}

export function clearNarrownessCache(): void {
	cache.clear();
}
