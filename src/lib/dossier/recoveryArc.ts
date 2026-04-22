/**
 * Recovery arc — what your CP loss looks like on the 5 moves immediately
 * *after* your own blunder. Steady up vs cascade.
 *
 * For each blunder move (cpLoss >= 200), find the next N user moves in the
 * same game and record their CP loss. Average across all blunder windows.
 */

import type { EvalMoveResult } from './evalAxes';
import { wilsonInterval, type Interval } from './stats';

export interface RecoveryPoint {
	offset: number; // 0 = the blunder itself, 1..N = subsequent user moves
	moves: number;
	avgCpLoss: number;
	blunderRate: number;
}

export interface RecoveryArcSummary {
	totalBlunders: number;
	points: RecoveryPoint[];
	cascadeRate: number; // fraction of blunders followed by another blunder within 3 moves
	cascadeCI95: Interval;
	steadyRate: number; // fraction followed by 3 consecutive ≤30cp-loss moves
	steadyCI95: Interval;
}

const HORIZON = 5;

export function analyseRecoveryArc(
	evalMoves: EvalMoveResult[] | null | undefined
): RecoveryArcSummary {
	if (!evalMoves || evalMoves.length === 0)
		return {
			totalBlunders: 0,
			points: [],
			cascadeRate: 0,
			cascadeCI95: { lo: 0, hi: 0 },
			steadyRate: 0,
			steadyCI95: { lo: 0, hi: 0 }
		};

	const byGame = new Map<string, EvalMoveResult[]>();
	for (const m of evalMoves) {
		const prev = byGame.get(m.gameId);
		if (prev) prev.push(m);
		else byGame.set(m.gameId, [m]);
	}
	for (const arr of byGame.values()) arr.sort((a, b) => a.ply - b.ply);

	const acc: { sum: number; n: number; blunders: number }[] = Array.from(
		{ length: HORIZON + 1 },
		() => ({ sum: 0, n: 0, blunders: 0 })
	);
	let blunderCount = 0;
	let cascade = 0;
	let steady = 0;

	for (const arr of byGame.values()) {
		for (let i = 0; i < arr.length; i += 1) {
			const m = arr[i];
			if (m.classification !== 'blunder') continue;
			blunderCount += 1;
			for (let k = 0; k <= HORIZON; k += 1) {
				const target = arr[i + k];
				if (!target) break;
				acc[k].sum += target.cpLoss;
				acc[k].n += 1;
				if (target.classification === 'blunder' && k > 0) acc[k].blunders += 1;
			}
			// cascade: another blunder in next 3.
			let cascadeHit = false;
			for (let k = 1; k <= 3; k += 1) {
				const t = arr[i + k];
				if (t && t.classification === 'blunder') {
					cascadeHit = true;
					break;
				}
			}
			if (cascadeHit) cascade += 1;
			// steady: 3 consecutive ≤30cp-loss moves.
			let steadyHit = true;
			for (let k = 1; k <= 3; k += 1) {
				const t = arr[i + k];
				if (!t || t.cpLoss > 30) {
					steadyHit = false;
					break;
				}
			}
			if (steadyHit) steady += 1;
		}
	}

	const points: RecoveryPoint[] = acc.map((a, offset) => ({
		offset,
		moves: a.n,
		avgCpLoss: a.n > 0 ? a.sum / a.n : 0,
		blunderRate: a.n > 0 ? a.blunders / a.n : 0
	}));

	return {
		totalBlunders: blunderCount,
		points,
		cascadeRate: blunderCount > 0 ? cascade / blunderCount : 0,
		cascadeCI95: wilsonInterval(cascade, blunderCount),
		steadyRate: blunderCount > 0 ? steady / blunderCount : 0,
		steadyCI95: wilsonInterval(steady, blunderCount)
	};
}
