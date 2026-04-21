/**
 * Time-of-day and day-of-week patterns. Uses the hourOfDay and dayOfWeek
 * fields stamped on each ClassifiedGame (derived from Lichess/chess.com
 * game timestamps in the user's local timezone).
 */

import type { ClassifiedGame } from './classify';
import type { EvalMoveResult } from './evalAxes';

export interface HourBucket {
	hour: number;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	winRate: number;
	avgCpLoss: number | null;
}

export interface DayBucket {
	day: number; // 0=Sunday..6=Saturday
	games: number;
	wins: number;
	losses: number;
	draws: number;
	winRate: number;
	avgCpLoss: number | null;
}

export interface TimeOfDaySummary {
	byHour: HourBucket[];
	byDay: DayBucket[];
	bestHour: number | null;
	worstHour: number | null;
	bestDay: number | null;
	worstDay: number | null;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayLabel(d: number): string {
	return DAY_LABELS[d] ?? '?';
}

export function analyseTimeOfDay(
	games: ClassifiedGame[],
	evalMoves: EvalMoveResult[] | null | undefined
): TimeOfDaySummary {
	const cpByGame = new Map<string, { sum: number; n: number }>();
	if (evalMoves) {
		for (const m of evalMoves) {
			const prev = cpByGame.get(m.gameId) ?? { sum: 0, n: 0 };
			prev.sum += m.cpLoss;
			prev.n += 1;
			cpByGame.set(m.gameId, prev);
		}
	}

	const byHour: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
		hour,
		games: 0,
		wins: 0,
		losses: 0,
		draws: 0,
		winRate: 0,
		avgCpLoss: null
	}));
	const byDay: DayBucket[] = Array.from({ length: 7 }, (_, day) => ({
		day,
		games: 0,
		wins: 0,
		losses: 0,
		draws: 0,
		winRate: 0,
		avgCpLoss: null
	}));
	const cpAccHour = byHour.map(() => ({ sum: 0, n: 0 }));
	const cpAccDay = byDay.map(() => ({ sum: 0, n: 0 }));

	for (const g of games) {
		const h = byHour[g.hourOfDay];
		const d = byDay[g.dayOfWeek];
		if (!h || !d) continue;
		h.games += 1;
		d.games += 1;
		if (g.result === 'win') {
			h.wins += 1;
			d.wins += 1;
		} else if (g.result === 'loss') {
			h.losses += 1;
			d.losses += 1;
		} else {
			h.draws += 1;
			d.draws += 1;
		}
		const cp = cpByGame.get(g.gameId);
		if (cp && cp.n > 0) {
			const avg = cp.sum / cp.n;
			cpAccHour[g.hourOfDay].sum += avg;
			cpAccHour[g.hourOfDay].n += 1;
			cpAccDay[g.dayOfWeek].sum += avg;
			cpAccDay[g.dayOfWeek].n += 1;
		}
	}

	for (const h of byHour) {
		h.winRate = h.games > 0 ? h.wins / h.games : 0;
		const acc = cpAccHour[h.hour];
		h.avgCpLoss = acc.n > 0 ? acc.sum / acc.n : null;
	}
	for (const d of byDay) {
		d.winRate = d.games > 0 ? d.wins / d.games : 0;
		const acc = cpAccDay[d.day];
		d.avgCpLoss = acc.n > 0 ? acc.sum / acc.n : null;
	}

	const hoursWithData = byHour.filter((h) => h.games >= 5);
	const daysWithData = byDay.filter((d) => d.games >= 3);
	const bestHour = hoursWithData.length
		? hoursWithData.reduce((a, b) => (a.winRate > b.winRate ? a : b)).hour
		: null;
	const worstHour = hoursWithData.length
		? hoursWithData.reduce((a, b) => (a.winRate < b.winRate ? a : b)).hour
		: null;
	const bestDay = daysWithData.length
		? daysWithData.reduce((a, b) => (a.winRate > b.winRate ? a : b)).day
		: null;
	const worstDay = daysWithData.length
		? daysWithData.reduce((a, b) => (a.winRate < b.winRate ? a : b)).day
		: null;

	return { byHour, byDay, bestHour, worstHour, bestDay, worstDay };
}
