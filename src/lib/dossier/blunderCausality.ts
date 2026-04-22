/**
 * Blunder causality — trace each blunder back to the upstream decision
 * where the game's win probability first turned against the user.
 *
 * The blunder atlas tags *what* happened on the blunder ply. Causality
 * answers *why* the position was lost-enough-to-blunder-in in the first
 * place. Many "missed tactic on move 27" errors trace back to a plan
 * that went wrong 10 moves earlier.
 *
 * Method:
 *   1. Group user moves by gameId, sorted by ply.
 *   2. For each blunder (classification === 'blunder' || wpLoss ≥ 25),
 *      walk backward through the same game's user moves accumulating
 *      the WP cost.
 *   3. The *causality origin* is the earliest user move in a contiguous
 *      losing trajectory — the last move with userEvalBeforeCp ≥ -30cp
 *      *and* where the user's play itself started the drift (wpLoss > 3).
 *   4. Aggregate origins across blunders: recurring plies, recurring
 *      phases, recurring clock buckets.
 *
 * We expose the origin move so the user can see the causality visually
 * (the move that preceded the losing trajectory), plus summary
 * distributions for severity cards.
 */

import type { EvalMoveResult } from './evalAxes';

export interface CausalityOrigin {
	gameId: string;
	ply: number;
	san: string;
	fenBefore: string;
	wpLossAtOrigin: number;
	/** Distance in user plies from the origin to the blunder. */
	distanceToBlunder: number;
	/** Phase the origin happened in, not the blunder. */
	originPhase: 'opening' | 'middle' | 'end';
	blunderPly: number;
	blunderSan: string;
}

export interface BlunderCausalitySummary {
	totalBlunders: number;
	originsFound: number;
	origins: CausalityOrigin[];
	byOriginPhase: Record<'opening' | 'middle' | 'end', number>;
	/**
	 * Mean plies between origin and blunder. A value > 6 says most
	 * blunders are downstream of strategic mistakes, not independent
	 * tactical lapses — strategic training pays more than tactics drills.
	 */
	avgDistanceToBlunder: number;
	/**
	 * Fraction of blunders whose origin sits in the opening. Flags when
	 * the opening is setting up losses further down the line.
	 */
	openingInducedFraction: number;
}

/** User-facing threshold to define "drift move" (3% WP loss). */
const DRIFT_WP_LOSS = 3;
/** Max walkback horizon in plies — 20 plies = 10 user moves. */
const MAX_HORIZON = 20;
/** Threshold to identify the "start of trouble" when walking back. */
const OK_EVAL_CP = -30;

export function buildBlunderCausality(
	moves: EvalMoveResult[] | null | undefined
): BlunderCausalitySummary {
	if (!moves || moves.length === 0) {
		return {
			totalBlunders: 0,
			originsFound: 0,
			origins: [],
			byOriginPhase: { opening: 0, middle: 0, end: 0 },
			avgDistanceToBlunder: 0,
			openingInducedFraction: 0
		};
	}

	// Group by game, sort by ply.
	const byGame = new Map<string, EvalMoveResult[]>();
	for (const m of moves) {
		const arr = byGame.get(m.gameId) ?? [];
		arr.push(m);
		byGame.set(m.gameId, arr);
	}
	for (const arr of byGame.values()) arr.sort((a, b) => a.ply - b.ply);

	const origins: CausalityOrigin[] = [];
	let totalBlunders = 0;
	let distanceSum = 0;
	const byOriginPhase: BlunderCausalitySummary['byOriginPhase'] = {
		opening: 0,
		middle: 0,
		end: 0
	};

	for (const arr of byGame.values()) {
		for (let i = 0; i < arr.length; i++) {
			const m = arr[i];
			const isBlunder = m.classification === 'blunder' || m.wpLoss >= 25;
			if (!isBlunder) continue;
			totalBlunders += 1;

			// Walk back to find the origin — the earliest user move in the
			// trajectory that moved the position from "OK" into the danger
			// zone that culminated in this blunder.
			let originIdx = i;
			for (let k = i - 1; k >= 0 && i - k <= MAX_HORIZON; k--) {
				const prev = arr[k];
				// If we reach a position that was clearly OK *and* the
				// subsequent user move started the drift, the origin is
				// *that next move*. This captures the "committed the queen
				// too early on move 14 → blunder on move 23" pattern.
				if (prev.userEvalBeforeCp >= OK_EVAL_CP && prev.wpLoss >= DRIFT_WP_LOSS) {
					originIdx = k;
				}
				// Stop walking once we find a clearly winning / equal
				// position the user held — further back than that can't
				// have caused the blunder.
				if (prev.userEvalBeforeCp >= OK_EVAL_CP && prev.wpLoss < DRIFT_WP_LOSS) {
					// Candidate: if the *next* move (k+1) started the drift,
					// that's our origin; otherwise we've walked past it.
					const next = arr[k + 1];
					if (next && next.wpLoss >= DRIFT_WP_LOSS) originIdx = k + 1;
					break;
				}
			}

			const origin = arr[originIdx];
			// Skip if origin is the blunder itself — means we couldn't
			// trace a clean upstream path (already lost before scan start,
			// or a pure tactical blowup without drift).
			if (origin === m) continue;
			const distance = i - originIdx;
			distanceSum += distance;
			byOriginPhase[origin.phase] += 1;

			origins.push({
				gameId: m.gameId,
				ply: origin.ply,
				san: origin.san,
				fenBefore: origin.fenBefore,
				wpLossAtOrigin: origin.wpLoss,
				distanceToBlunder: distance,
				originPhase: origin.phase,
				blunderPly: m.ply,
				blunderSan: m.san
			});
		}
	}

	const originsFound = origins.length;
	const openingInducedFraction = originsFound > 0 ? byOriginPhase.opening / originsFound : 0;
	return {
		totalBlunders,
		originsFound,
		origins,
		byOriginPhase,
		avgDistanceToBlunder: originsFound > 0 ? distanceSum / originsFound : 0,
		openingInducedFraction
	};
}
