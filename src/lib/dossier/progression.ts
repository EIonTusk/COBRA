/**
 * Monthly progression — roll up classified games + eval into month buckets
 * so you can see where your CP loss / blunder rate / axis rates have
 * moved over the calendar. Complements the weekly drift sparklines by
 * going back further and grouping more coarsely.
 */

import type { ClassifiedGame } from './classify';
import type { EvalMoveResult } from './evalAxes';

export interface MonthlyPoint {
	monthKey: string; // YYYY-MM
	label: string;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	winRate: number;
	avgRating: number | null;
	avgCpLoss: number | null;
	blunderRate: number | null;
	forcing: number;
	capture: number;
	pawnPlay: number;
}

export interface ProgressionSummary {
	months: MonthlyPoint[];
	deltaRating: number | null;
	deltaCpLoss: number | null;
	deltaWinRate: number | null;
	direction: 'improving' | 'stable' | 'slipping' | null;
}

export function analyseProgression(
	games: ClassifiedGame[],
	evalMoves: EvalMoveResult[] | null | undefined
): ProgressionSummary {
	const cpByGame = new Map<string, { sum: number; n: number; blunders: number }>();
	if (evalMoves) {
		for (const m of evalMoves) {
			const prev = cpByGame.get(m.gameId) ?? { sum: 0, n: 0, blunders: 0 };
			prev.sum += m.cpLoss;
			prev.n += 1;
			if (m.classification === 'blunder') prev.blunders += 1;
			cpByGame.set(m.gameId, prev);
		}
	}

	const byMonth = new Map<
		string,
		{
			games: ClassifiedGame[];
			cpSum: number;
			cpN: number;
			blunderSum: number;
			blunderN: number;
			ratingSum: number;
			ratingN: number;
			forcing: number;
			capture: number;
			pawnPlay: number;
			moves: number;
		}
	>();

	for (const g of games) {
		const d = new Date(g.playedAt);
		const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
		let entry = byMonth.get(key);
		if (!entry) {
			entry = {
				games: [],
				cpSum: 0,
				cpN: 0,
				blunderSum: 0,
				blunderN: 0,
				ratingSum: 0,
				ratingN: 0,
				forcing: 0,
				capture: 0,
				pawnPlay: 0,
				moves: 0
			};
			byMonth.set(key, entry);
		}
		entry.games.push(g);
		if (g.userRating != null) {
			entry.ratingSum += g.userRating;
			entry.ratingN += 1;
		}
		const cp = cpByGame.get(g.gameId);
		if (cp && cp.n > 0) {
			entry.cpSum += cp.sum / cp.n;
			entry.cpN += 1;
			entry.blunderSum += cp.blunders / cp.n;
			entry.blunderN += 1;
		}
		for (const m of g.moves) {
			entry.moves += 1;
			if (m.isCapture || m.isCheck) entry.forcing += 1;
			if (m.isCapture) entry.capture += 1;
			if (m.isPawnMove) entry.pawnPlay += 1;
		}
	}

	const months: MonthlyPoint[] = Array.from(byMonth.entries())
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([monthKey, e]) => ({
			monthKey,
			label: formatMonthLabel(monthKey),
			games: e.games.length,
			wins: e.games.filter((g) => g.result === 'win').length,
			losses: e.games.filter((g) => g.result === 'loss').length,
			draws: e.games.filter((g) => g.result === 'draw').length,
			winRate:
				e.games.length > 0 ? e.games.filter((g) => g.result === 'win').length / e.games.length : 0,
			avgRating: e.ratingN > 0 ? e.ratingSum / e.ratingN : null,
			avgCpLoss: e.cpN > 0 ? e.cpSum / e.cpN : null,
			blunderRate: e.blunderN > 0 ? e.blunderSum / e.blunderN : null,
			forcing: e.moves > 0 ? e.forcing / e.moves : 0,
			capture: e.moves > 0 ? e.capture / e.moves : 0,
			pawnPlay: e.moves > 0 ? e.pawnPlay / e.moves : 0
		}));

	const first = months[0];
	const last = months[months.length - 1];
	const deltaRating =
		first?.avgRating != null && last?.avgRating != null ? last.avgRating - first.avgRating : null;
	const deltaCpLoss =
		first?.avgCpLoss != null && last?.avgCpLoss != null ? last.avgCpLoss - first.avgCpLoss : null;
	const deltaWinRate = first && last ? last.winRate - first.winRate : null;

	let direction: ProgressionSummary['direction'] = null;
	if (deltaCpLoss != null || deltaRating != null) {
		const ratingSignal = deltaRating ?? 0;
		const cpSignal = -(deltaCpLoss ?? 0); // lower CP loss is improvement
		const combined = ratingSignal / 50 + cpSignal / 10;
		if (combined > 1) direction = 'improving';
		else if (combined < -1) direction = 'slipping';
		else direction = 'stable';
	}

	return { months, deltaRating, deltaCpLoss, deltaWinRate, direction };
}

function formatMonthLabel(key: string): string {
	const [year, month] = key.split('-');
	const names = [
		'Jan',
		'Feb',
		'Mar',
		'Apr',
		'May',
		'Jun',
		'Jul',
		'Aug',
		'Sep',
		'Oct',
		'Nov',
		'Dec'
	];
	return `${names[Number(month) - 1]} ${year}`;
}
