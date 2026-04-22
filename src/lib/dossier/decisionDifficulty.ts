/**
 * Decision-difficulty analysis.
 *
 * A position's *decision difficulty* is well-approximated by the gap
 * between the engine's top move and its runner-up. When top-1 and top-2
 * are within a few centipawns, any of several moves is fine — a forgiving
 * position. When top-1 is 100cp better than top-2, the user has to find
 * *the* move.
 *
 * The EvalMoveResult already captures the top-K alternatives via MultiPV.
 * This module buckets the user's moves by difficulty and reports CP loss
 * + accuracy per bucket. Reveals the pattern that raw averages hide:
 * many amateurs look steady on forgiving positions but collapse on
 * single-solution ones.
 *
 * Difficulty is undefined for moves where the engine didn't run with
 * MultiPV — adopted Lichess-server moves don't carry alternatives, and
 * the depth-20 leak re-eval may or may not depending on caller. Those
 * moves are excluded from this analysis (tracked via `excluded`).
 */

import type { EvalMoveResult } from './evalAxes';
import { normalMeanCI, wilsonInterval, type Interval } from './stats';

export type DifficultyBucket = 'forgiving' | 'moderate' | 'sharp' | 'single-solution';

export interface DifficultyRow {
	bucket: DifficultyBucket;
	label: string;
	/** CP gap range [gapMin, gapMax). Units: cp from user's POV (unsigned). */
	gapMin: number;
	gapMax: number;
	moves: number;
	avgCpLoss: number;
	avgCpLossCI95: Interval;
	avgAccuracy: number;
	blunders: number;
	blunderRate: number;
	blunderRateCI95: Interval;
}

export interface DecisionDifficultySummary {
	totalMoves: number;
	excluded: number;
	byBucket: DifficultyRow[];
	/**
	 * Contrast metric: CP-loss gap between the easiest and hardest bucket.
	 * Positive value is the canonical "collapses under pressure" signature
	 * — user does well in forgiving positions but accumulates CP loss in
	 * single-solution ones. Null when either bucket is too thin.
	 */
	difficultyGap: number | null;
	/**
	 * Standard-error gated signal: true when the gap's rough CI excludes
	 * zero. Driven by pooled SEs on the two endpoint buckets.
	 */
	gapSignificant: boolean;
}

const BUCKET_DEFS: Array<
	Omit<
		DifficultyRow,
		| 'moves'
		| 'avgCpLoss'
		| 'avgCpLossCI95'
		| 'avgAccuracy'
		| 'blunders'
		| 'blunderRate'
		| 'blunderRateCI95'
	>
> = [
	{ bucket: 'forgiving', label: 'Forgiving (top-2 within 20cp)', gapMin: 0, gapMax: 20 },
	{ bucket: 'moderate', label: 'Moderate (20–60cp)', gapMin: 20, gapMax: 60 },
	{ bucket: 'sharp', label: 'Sharp (60–150cp)', gapMin: 60, gapMax: 150 },
	{ bucket: 'single-solution', label: 'Single solution (>150cp)', gapMin: 150, gapMax: Infinity }
];

const MIN_MOVES_PER_BUCKET = 10;

export function analyseDecisionDifficulty(
	moves: EvalMoveResult[] | null | undefined
): DecisionDifficultySummary {
	if (!moves || moves.length === 0) {
		return emptySummary();
	}

	// Per-bucket accumulators.
	const acc: Record<
		DifficultyBucket,
		{
			cpSamples: number[];
			accSum: number;
			blunders: number;
		}
	> = {
		forgiving: { cpSamples: [], accSum: 0, blunders: 0 },
		moderate: { cpSamples: [], accSum: 0, blunders: 0 },
		sharp: { cpSamples: [], accSum: 0, blunders: 0 },
		'single-solution': { cpSamples: [], accSum: 0, blunders: 0 }
	};

	let excluded = 0;
	for (const m of moves) {
		// Skip moves without multi-PV alternatives (adopted Lichess evals,
		// analyse failed, or book/tablebase short-circuit).
		if (!m.alternatives || m.alternatives.length === 0) {
			excluded += 1;
			continue;
		}
		const top2 = m.alternatives[0];
		if (top2 == null) {
			excluded += 1;
			continue;
		}
		// `userEvalBeforeCp` is the top-1 eval from user POV. `top2.cp` is
		// the alternative from the same POV (already sign-flipped). The gap
		// in CP is abs of the difference — direction doesn't matter for
		// difficulty, only magnitude.
		const gap = Math.abs(m.userEvalBeforeCp - top2.cp);
		const bucket = classifyGap(gap);
		const a = acc[bucket];
		a.cpSamples.push(m.cpLoss);
		a.accSum += m.accuracyPct;
		if (m.classification === 'blunder') a.blunders += 1;
	}

	const byBucket: DifficultyRow[] = BUCKET_DEFS.map((def) => {
		const a = acc[def.bucket];
		const n = a.cpSamples.length;
		const sum = n > 0 ? a.cpSamples.reduce((s, x) => s + x, 0) : 0;
		return {
			...def,
			moves: n,
			avgCpLoss: n > 0 ? sum / n : 0,
			avgCpLossCI95: normalMeanCI(a.cpSamples),
			avgAccuracy: n > 0 ? a.accSum / n : 0,
			blunders: a.blunders,
			blunderRate: n > 0 ? a.blunders / n : 0,
			blunderRateCI95: wilsonInterval(a.blunders, n)
		};
	});

	const forgiving = byBucket.find((b) => b.bucket === 'forgiving');
	const single = byBucket.find((b) => b.bucket === 'single-solution');
	const gap =
		forgiving &&
		single &&
		forgiving.moves >= MIN_MOVES_PER_BUCKET &&
		single.moves >= MIN_MOVES_PER_BUCKET
			? single.avgCpLoss - forgiving.avgCpLoss
			: null;

	// Rough significance test on the gap: |gap| must exceed 2 × pooled SE.
	// Driven by per-bucket Normal-SE on the mean. This is an approximation
	// — a proper Welch's t-test would be cleaner — but the coarse gate is
	// all the downstream severity classification needs.
	let gapSignificant = false;
	if (gap != null && forgiving && single) {
		const seF = halfWidth(forgiving.avgCpLossCI95);
		const seS = halfWidth(single.avgCpLossCI95);
		const pooledHalfWidth = Math.sqrt(seF * seF + seS * seS);
		gapSignificant = Math.abs(gap) > pooledHalfWidth;
	}

	return {
		totalMoves: moves.length - excluded,
		excluded,
		byBucket,
		difficultyGap: gap,
		gapSignificant
	};
}

function classifyGap(gap: number): DifficultyBucket {
	if (gap < 20) return 'forgiving';
	if (gap < 60) return 'moderate';
	if (gap < 150) return 'sharp';
	return 'single-solution';
}

function halfWidth(ci: Interval): number {
	return (ci.hi - ci.lo) / 2;
}

function emptySummary(): DecisionDifficultySummary {
	return {
		totalMoves: 0,
		excluded: 0,
		byBucket: BUCKET_DEFS.map((def) => ({
			...def,
			moves: 0,
			avgCpLoss: 0,
			avgCpLossCI95: { lo: 0, hi: 0 },
			avgAccuracy: 0,
			blunders: 0,
			blunderRate: 0,
			blunderRateCI95: { lo: 0, hi: 0 }
		})),
		difficultyGap: null,
		gapSignificant: false
	};
}
