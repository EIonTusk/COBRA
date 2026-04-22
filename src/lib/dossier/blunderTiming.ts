/**
 * Blunder-by-move-number histogram. Every blunder and mistake from the
 * eval pass is bucketed by the move number it occurred on, exposing the
 * "move 20 cliff" pattern where focus breaks down partway through.
 */

import type { EvalMoveResult } from './evalAxes';
import { wilsonInterval, type Interval } from './stats';

export interface BlunderTimingBucket {
	label: string;
	plyMin: number;
	plyMax: number;
	moves: number;
	blunders: number;
	mistakes: number;
	inaccuracies: number;
	rate: number; // (blunders + mistakes) / moves
	rateCI95: Interval;
}

export interface BlunderTimingSummary {
	totalMoves: number;
	totalBlunders: number;
	peakBucketLabel: string | null;
	buckets: BlunderTimingBucket[];
}

const MOVE_BUCKETS = [
	{ label: 'Moves 1–10', plyMin: 0, plyMax: 19 },
	{ label: 'Moves 11–20', plyMin: 20, plyMax: 39 },
	{ label: 'Moves 21–30', plyMin: 40, plyMax: 59 },
	{ label: 'Moves 31–40', plyMin: 60, plyMax: 79 },
	{ label: 'Moves 41–50', plyMin: 80, plyMax: 99 },
	{ label: 'Moves 51+', plyMin: 100, plyMax: 9999 }
];

export function analyseBlunderTiming(
	evalMoves: EvalMoveResult[] | null | undefined
): BlunderTimingSummary {
	if (!evalMoves || evalMoves.length === 0)
		return { totalMoves: 0, totalBlunders: 0, peakBucketLabel: null, buckets: [] };

	const buckets: BlunderTimingBucket[] = MOVE_BUCKETS.map((b) => ({
		...b,
		moves: 0,
		blunders: 0,
		mistakes: 0,
		inaccuracies: 0,
		rate: 0,
		rateCI95: { lo: 0, hi: 0 }
	}));

	for (const m of evalMoves) {
		for (const b of buckets) {
			if (m.ply >= b.plyMin && m.ply <= b.plyMax) {
				b.moves += 1;
				if (m.classification === 'blunder') b.blunders += 1;
				else if (m.classification === 'mistake') b.mistakes += 1;
				else if (m.classification === 'inaccuracy') b.inaccuracies += 1;
				break;
			}
		}
	}

	let totalBlunders = 0;
	let peak: BlunderTimingBucket | null = null;
	for (const b of buckets) {
		const bad = b.blunders + b.mistakes;
		b.rate = b.moves > 0 ? bad / b.moves : 0;
		b.rateCI95 = wilsonInterval(bad, b.moves);
		totalBlunders += b.blunders;
		// Only declare a peak if the bucket's CI lower bound clears the
		// overall rate — prevents calling a noisy move-51+ bucket "peak"
		// on 12 moves when the headline is really just sampling noise.
		if (b.moves >= 20 && (!peak || b.rate > peak.rate)) peak = b;
	}

	return {
		totalMoves: evalMoves.length,
		totalBlunders,
		peakBucketLabel: peak?.label ?? null,
		buckets
	};
}
