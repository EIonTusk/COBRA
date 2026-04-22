/**
 * Monthly progression — roll up classified games + eval into month buckets
 * so you can see where your CP loss / blunder rate / axis rates have
 * moved over the calendar. Complements the weekly drift sparklines by
 * going back further and grouping more coarsely.
 */

import type { ClassifiedGame } from './classify';
import type { EvalMoveResult } from './evalAxes';
import { shrinkageMean } from './stats';

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
	/**
	 * Empirical-Bayes shrunk CP loss for this month — pulls low-volume
	 * months toward the user's lifetime mean so a 3-game month doesn't
	 * swing the progression chart. `avgCpLoss` is the raw value; prefer
	 * this for headlines and trend comparisons.
	 */
	shrunkCpLoss: number | null;
	blunderRate: number | null;
	shrunkBlunderRate: number | null;
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
	/** Prior weight used by the shrinkage (games). Exposed for methodology. */
	shrinkagePriorGames: number;
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

	const rawMonths = Array.from(byMonth.entries())
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
			cpN: e.cpN,
			blunderRate: e.blunderN > 0 ? e.blunderSum / e.blunderN : null,
			blunderN: e.blunderN,
			forcing: e.moves > 0 ? e.forcing / e.moves : 0,
			capture: e.moves > 0 ? e.capture / e.moves : 0,
			pawnPlay: e.moves > 0 ? e.pawnPlay / e.moves : 0
		}));

	// Empirical-Bayes shrinkage toward the lifetime grand mean.
	//
	// Rationale: a 3-game month with avgCpLoss = 95 is almost all noise —
	// the mean of a 3-sample sample has a very wide CI. By shrinking each
	// month's CP loss toward the user's lifetime mean proportionally to
	// n / (n + n0), we get a trajectory that ignores low-volume months
	// without throwing them away. n0 is chosen as the typical monthly
	// volume for this user (median of nonzero-cpN months), clamped to a
	// reasonable range so one-off outliers don't dominate the prior.
	const cpEligible = rawMonths.filter((m) => m.avgCpLoss != null);
	const blunderEligible = rawMonths.filter((m) => m.blunderRate != null);
	const grandCp =
		cpEligible.length > 0
			? cpEligible.reduce((s, m) => s + (m.avgCpLoss ?? 0) * m.cpN, 0) /
				Math.max(
					1,
					cpEligible.reduce((s, m) => s + m.cpN, 0)
				)
			: null;
	const grandBlunder =
		blunderEligible.length > 0
			? blunderEligible.reduce((s, m) => s + (m.blunderRate ?? 0) * m.blunderN, 0) /
				Math.max(
					1,
					blunderEligible.reduce((s, m) => s + m.blunderN, 0)
				)
			: null;
	const medianCpN = cpEligible.length > 0 ? median(cpEligible.map((m) => m.cpN)) : 20;
	const priorN = Math.max(10, Math.min(50, medianCpN));

	const shrunkCp =
		grandCp != null
			? shrinkageMean(
					rawMonths.map((m) => ({ mean: m.avgCpLoss ?? grandCp, n: m.cpN })),
					grandCp,
					priorN
				)
			: [];
	const shrunkBlunder =
		grandBlunder != null
			? shrinkageMean(
					rawMonths.map((m) => ({ mean: m.blunderRate ?? grandBlunder, n: m.blunderN })),
					grandBlunder,
					priorN
				)
			: [];

	const months: MonthlyPoint[] = rawMonths.map((m, i) => ({
		monthKey: m.monthKey,
		label: m.label,
		games: m.games,
		wins: m.wins,
		losses: m.losses,
		draws: m.draws,
		winRate: m.winRate,
		avgRating: m.avgRating,
		avgCpLoss: m.avgCpLoss,
		shrunkCpLoss: grandCp != null && m.cpN > 0 ? shrunkCp[i] : null,
		blunderRate: m.blunderRate,
		shrunkBlunderRate: grandBlunder != null && m.blunderN > 0 ? shrunkBlunder[i] : null,
		forcing: m.forcing,
		capture: m.capture,
		pawnPlay: m.pawnPlay
	}));

	const first = months[0];
	const last = months[months.length - 1];
	const deltaRating =
		first?.avgRating != null && last?.avgRating != null ? last.avgRating - first.avgRating : null;
	// Use shrunk CP loss for the headline trend so thin months don't
	// dominate. Raw delta stays on each point for users who want it.
	const firstCp = first?.shrunkCpLoss ?? first?.avgCpLoss ?? null;
	const lastCp = last?.shrunkCpLoss ?? last?.avgCpLoss ?? null;
	const deltaCpLoss = firstCp != null && lastCp != null ? lastCp - firstCp : null;
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

	return {
		months,
		deltaRating,
		deltaCpLoss,
		deltaWinRate,
		direction,
		shrinkagePriorGames: priorN
	};
}

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
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
