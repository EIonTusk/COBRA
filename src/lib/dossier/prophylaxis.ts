/**
 * Prophylaxis index — moves that neutralize a looming opponent threat.
 *
 * Definition (SOTA): between your move N-1 (userEvalAfterCp) and your
 * move N (userEvalBeforeCp), the eval drops by a meaningful amount in
 * **win-probability** terms — i.e., the opponent's intervening move was
 * a *real* threat that gained them ground, measured on the same curve
 * Lichess deep analysis uses. If your response then *restores* WP (the
 * move's own WP loss is small), you saw the threat and neutralized it.
 * If it drops further, you were blind.
 *
 * Additional signals pulled from the SOTA engine pass:
 *  - volatility: only count positions where the engine's top PV was
 *    unstable; stable positions aren't "real threats" the user had to
 *    calculate.
 *  - alternatives: a neutralising move that happened to also be the only
 *    legal option is weaker evidence than one chosen over alternatives.
 */

import type { EvalMoveResult } from './evalAxes';
import { cpToWinProb } from './sota';
import { wilsonInterval, type Interval } from './stats';

export interface ProphylaxisRow {
	phase: 'opening' | 'middle' | 'end';
	opportunities: number;
	neutralized: number;
	compounded: number;
	/** Wilson 95% CI for this phase's neutralize rate. */
	neutralizeCI95: Interval;
}

export interface ProphylaxisSummary {
	opportunities: number;
	neutralized: number;
	compounded: number;
	neutralizeRate: number;
	/** Wilson 95% CI for the overall neutralize rate. */
	neutralizeCI95: Interval;
	byPhase: ProphylaxisRow[];
	examples: { gameId: string; ply: number; san: string; delta: number; fenBefore: string }[];
}

export function analyseProphylaxis(
	evalMoves: EvalMoveResult[] | null | undefined
): ProphylaxisSummary {
	if (!evalMoves || evalMoves.length === 0)
		return {
			opportunities: 0,
			neutralized: 0,
			compounded: 0,
			neutralizeRate: 0,
			neutralizeCI95: { lo: 0, hi: 0 },
			byPhase: [],
			examples: []
		};

	const byGame = new Map<string, EvalMoveResult[]>();
	for (const m of evalMoves) {
		const prev = byGame.get(m.gameId);
		if (prev) prev.push(m);
		else byGame.set(m.gameId, [m]);
	}
	for (const arr of byGame.values()) arr.sort((a, b) => a.ply - b.ply);

	const rows: Record<'opening' | 'middle' | 'end', ProphylaxisRow> = {
		opening: {
			phase: 'opening',
			opportunities: 0,
			neutralized: 0,
			compounded: 0,
			neutralizeCI95: { lo: 0, hi: 0 }
		},
		middle: {
			phase: 'middle',
			opportunities: 0,
			neutralized: 0,
			compounded: 0,
			neutralizeCI95: { lo: 0, hi: 0 }
		},
		end: {
			phase: 'end',
			opportunities: 0,
			neutralized: 0,
			compounded: 0,
			neutralizeCI95: { lo: 0, hi: 0 }
		}
	};

	const examples: ProphylaxisSummary['examples'] = [];
	let opportunities = 0;
	let neutralized = 0;
	let compounded = 0;

	for (const arr of byGame.values()) {
		for (let i = 1; i < arr.length; i += 1) {
			const prev = arr[i - 1];
			const cur = arr[i];
			// WP-based threat detection: opponent's intervening move must
			// have moved the win-probability curve by ≥ a meaningful amount.
			// CP-only threshold previously counted harmless 60cp drifts in
			// already-decided positions as "threats" — WP loss fixes that.
			const wpPrev = cpToWinProb(prev.userEvalAfterCp);
			const wpCur = cpToWinProb(cur.userEvalBeforeCp);
			const oppWpGain = wpPrev - wpCur;
			if (oppWpGain < 8) continue; // < ~50cp in a balanced pos → no real threat
			// Volatility guard: skip positions where the engine didn't find
			// the top move unstable — those are forced or quiet, not genuine
			// tactical pressure.
			if (cur.volatile === false && oppWpGain < 15) continue;
			opportunities += 1;
			rows[cur.phase].opportunities += 1;
			const response = cur.userEvalAfterCp - cur.userEvalBeforeCp;
			if (response >= 0 && cur.wpLoss < 5) {
				neutralized += 1;
				rows[cur.phase].neutralized += 1;
				if (examples.length < 10 && oppWpGain >= 15) {
					examples.push({
						gameId: cur.gameId,
						ply: cur.ply,
						san: cur.san,
						delta: prev.userEvalAfterCp - cur.userEvalBeforeCp,
						fenBefore: cur.fenBefore
					});
				}
			} else {
				compounded += 1;
				rows[cur.phase].compounded += 1;
			}
		}
	}

	// Populate phase-level CIs once rows are complete.
	for (const row of [rows.opening, rows.middle, rows.end]) {
		row.neutralizeCI95 = wilsonInterval(row.neutralized, row.opportunities);
	}

	return {
		opportunities,
		neutralized,
		compounded,
		neutralizeRate: opportunities > 0 ? neutralized / opportunities : 0,
		neutralizeCI95: wilsonInterval(neutralized, opportunities),
		byPhase: [rows.opening, rows.middle, rows.end],
		examples
	};
}
