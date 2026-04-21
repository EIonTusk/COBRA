/**
 * Opening-fit score. For each opening family in which the user has ≥5
 * games, compute:
 *
 *  - Win-rate delta vs the user's overall win rate.
 *  - Average CP loss (from evalAxes.allMoves) delta vs overall.
 *  - Axis mismatch: how different the user's per-family style axes are
 *    from the user's overall axes (proxy for "does this opening steer
 *    you into positions that play to your strengths?").
 *
 * A family is a "fit" when win rate and CP-loss go the right direction
 * (better) *and* the axis mismatch is small (you play the positions
 * naturally). A "misfit" when win rate drops and CP loss rises.
 */

import type { ClassifiedGame } from './classify';
import type { EvalMoveResult } from './evalAxes';
import { ecoFamily, type OpeningFamily } from './openings';

export interface FitRow {
	family: OpeningFamily;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	winRate: number;
	winRateDelta: number;
	avgCpLoss: number;
	avgCpLossDelta: number;
	axisMismatch: number;
	verdict: 'fit' | 'neutral' | 'misfit';
}

export interface OpeningFitSummary {
	overallWinRate: number;
	overallCpLoss: number;
	rows: FitRow[];
}

interface AxisVec {
	forcing: number;
	capture: number;
	pawnPlay: number;
	queenside: number;
}

export function analyseOpeningFit(
	games: ClassifiedGame[],
	evalMoves: EvalMoveResult[] | null
): OpeningFitSummary {
	const movesByGame = new Map<string, EvalMoveResult[]>();
	if (evalMoves) {
		for (const m of evalMoves) {
			const prev = movesByGame.get(m.gameId);
			if (prev) prev.push(m);
			else movesByGame.set(m.gameId, [m]);
		}
	}

	// Overall user axes + outcomes.
	const overall = collectAxes(games);
	const overallEval = collectEval(games.flatMap((g) => movesByGame.get(g.gameId) ?? []));

	const byFamily = new Map<OpeningFamily, ClassifiedGame[]>();
	for (const g of games) {
		const fam = ecoFamily(g.eco);
		const prev = byFamily.get(fam) ?? [];
		prev.push(g);
		byFamily.set(fam, prev);
	}

	const rows: FitRow[] = [];
	for (const [family, famGames] of byFamily) {
		if (famGames.length < 5) continue;
		const wins = famGames.filter((g) => g.result === 'win').length;
		const losses = famGames.filter((g) => g.result === 'loss').length;
		const draws = famGames.length - wins - losses;
		const winRate = wins / famGames.length;

		const famAxes = collectAxes(famGames);
		const famEval = collectEval(famGames.flatMap((g) => movesByGame.get(g.gameId) ?? []));
		const axisMismatch = axisDistance(overall.axes, famAxes.axes);
		const winRateDelta = winRate - overall.winRate;
		const cpLossDelta = famEval.avgCpLoss - overallEval.avgCpLoss;

		let verdict: FitRow['verdict'] = 'neutral';
		if (winRateDelta >= 0.05 && cpLossDelta <= -5) verdict = 'fit';
		else if (winRateDelta <= -0.05 && cpLossDelta >= 5) verdict = 'misfit';

		rows.push({
			family,
			games: famGames.length,
			wins,
			losses,
			draws,
			winRate,
			winRateDelta,
			avgCpLoss: famEval.avgCpLoss,
			avgCpLossDelta: cpLossDelta,
			axisMismatch,
			verdict
		});
	}
	rows.sort((a, b) => b.games - a.games);

	return {
		overallWinRate: overall.winRate,
		overallCpLoss: overallEval.avgCpLoss,
		rows
	};
}

function collectAxes(games: ClassifiedGame[]): { axes: AxisVec; winRate: number } {
	let forcing = 0;
	let capture = 0;
	let pawnPlay = 0;
	let queenside = 0;
	let moves = 0;
	let wins = 0;
	for (const g of games) {
		if (g.result === 'win') wins += 1;
		for (const m of g.moves) {
			moves += 1;
			if (m.isCapture || m.isCheck) forcing += 1;
			if (m.isCapture) capture += 1;
			if (m.isPawnMove) pawnPlay += 1;
			if (m.toFile <= 3) queenside += 1;
		}
	}
	return {
		axes: {
			forcing: moves > 0 ? forcing / moves : 0,
			capture: moves > 0 ? capture / moves : 0,
			pawnPlay: moves > 0 ? pawnPlay / moves : 0,
			queenside: moves > 0 ? queenside / moves : 0
		},
		winRate: games.length > 0 ? wins / games.length : 0
	};
}

function collectEval(moves: EvalMoveResult[]): { avgCpLoss: number } {
	if (moves.length === 0) return { avgCpLoss: 0 };
	let sum = 0;
	for (const m of moves) sum += m.cpLoss;
	return { avgCpLoss: sum / moves.length };
}

function axisDistance(a: AxisVec, b: AxisVec): number {
	return (
		Math.abs(a.forcing - b.forcing) +
		Math.abs(a.capture - b.capture) +
		Math.abs(a.pawnPlay - b.pawnPlay) +
		Math.abs(a.queenside - b.queenside)
	);
}
