/**
 * Calculation-depth proxy. We can't measure how deep a user actually
 * calculates from game data, but we *can* measure whether their accuracy
 * holds up as position complexity rises.
 *
 * Complexity proxies:
 *  - Branching factor: count of legal moves in the position (stamped by
 *    classify.ts). Higher = more candidate moves = bigger search tree.
 *  - Tactical tension: pawn-pawn contact pairs + whether there's a
 *    hanging capture in the position (from demand).
 *
 * For each complexity bucket we report avg CP loss and blunder rate.
 * A cliff-shape (accuracy flat at low complexity, dropping sharply at
 * high) says "you solve easy positions but collapse under branching
 * pressure". A flat curve says "you play consistently — or you're
 * already near your ceiling".
 */

import type { ClassifiedGame, MoveFeatures } from './classify';
import type { EvalMoveResult } from './evalAxes';

export interface ComplexityBucket {
	label: string;
	min: number;
	max: number;
	moves: number;
	avgCpLoss: number;
	blunderRate: number;
	inaccuracyRate: number;
}

export interface CalculationSummary {
	byBranching: ComplexityBucket[];
	byTension: ComplexityBucket[];
	byHangingThreat: ComplexityBucket[];
	avgCpLoss: number;
	overallMoves: number;
}

const BRANCH_BUCKETS = [
	{ label: '1–20 moves', min: 1, max: 20 },
	{ label: '21–30 moves', min: 21, max: 30 },
	{ label: '31–40 moves', min: 31, max: 40 },
	{ label: '41+ moves', min: 41, max: 999 }
];

const TENSION_BUCKETS = [
	{ label: '0 tense pairs', min: 0, max: 0 },
	{ label: '1 tense pair', min: 1, max: 1 },
	{ label: '2 tense pairs', min: 2, max: 2 },
	{ label: '3+ tense pairs', min: 3, max: 99 }
];

const THREAT_BUCKETS = [
	{ label: 'No hanging threat', min: 0, max: 0 },
	{ label: 'Hanging threat active', min: 1, max: 99 }
];

export function analyseCalculationDepth(
	games: ClassifiedGame[],
	evalMoves: EvalMoveResult[] | null | undefined
): CalculationSummary {
	if (!evalMoves || evalMoves.length === 0)
		return { byBranching: [], byTension: [], byHangingThreat: [], avgCpLoss: 0, overallMoves: 0 };

	// Build an index of MoveFeatures by gameId+ply for O(1) lookup.
	const feats = new Map<string, MoveFeatures>();
	for (const g of games) {
		for (const m of g.moves) feats.set(`${g.gameId}:${m.ply}`, m);
	}

	const bucketStats = (defs: { label: string; min: number; max: number }[]): ComplexityBucket[] =>
		defs.map((d) => ({ ...d, moves: 0, avgCpLoss: 0, blunderRate: 0, inaccuracyRate: 0 }));

	const branching = bucketStats(BRANCH_BUCKETS);
	const tension = bucketStats(TENSION_BUCKETS);
	const hanging = bucketStats(THREAT_BUCKETS);

	const inc = (b: ComplexityBucket, cpLoss: number, cls: EvalMoveResult['classification']) => {
		b.moves += 1;
		b.avgCpLoss += cpLoss;
		if (cls === 'blunder') b.blunderRate += 1;
		if (cls === 'inaccuracy' || cls === 'mistake') b.inaccuracyRate += 1;
	};

	let totalCp = 0;
	for (const m of evalMoves) {
		const f = feats.get(`${m.gameId}:${m.ply}`);
		if (!f) continue;
		totalCp += m.cpLoss;
		// Branching
		for (const b of branching) {
			if (f.legalMovesBefore >= b.min && f.legalMovesBefore <= b.max) {
				inc(b, m.cpLoss, m.classification);
				break;
			}
		}
		// Tension
		for (const b of tension) {
			if (f.tensionBefore >= b.min && f.tensionBefore <= b.max) {
				inc(b, m.cpLoss, m.classification);
				break;
			}
		}
		// Hanging threat
		const hangingIdx = f.demand.hangingCapture ? 1 : 0;
		inc(hanging[hangingIdx], m.cpLoss, m.classification);
	}

	const finalize = (b: ComplexityBucket) => {
		if (b.moves > 0) {
			b.avgCpLoss /= b.moves;
			b.blunderRate /= b.moves;
			b.inaccuracyRate /= b.moves;
		}
	};
	branching.forEach(finalize);
	tension.forEach(finalize);
	hanging.forEach(finalize);

	return {
		byBranching: branching,
		byTension: tension,
		byHangingThreat: hanging,
		avgCpLoss: evalMoves.length > 0 ? totalCp / evalMoves.length : 0,
		overallMoves: evalMoves.length
	};
}
