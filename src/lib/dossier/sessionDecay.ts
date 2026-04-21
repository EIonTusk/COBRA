/**
 * Session decay by phase. Extends sessionProfile with a per-phase
 * breakdown: for each game-in-session index, what's the avg CP loss
 * separately in opening / middle / endgame phases? Identifies which part
 * of your play tires first.
 */

import type { ClassifiedGame, Phase } from './classify';
import type { EvalMoveResult } from './evalAxes';

export interface PhaseCell {
	games: number;
	avgCpLoss: number | null;
	blunderRate: number | null;
}

export interface SessionDecayRow {
	index: number;
	games: number;
	overall: PhaseCell;
	byPhase: Record<Phase, PhaseCell>;
}

export interface SessionDecaySummary {
	sessions: number;
	multiGameSessions: number;
	rows: SessionDecayRow[];
	/** Phase that degrades most from game 1 to game 4+. */
	worstPhase: Phase | null;
	worstPhaseDelta: number | null;
}

const SESSION_GAP_MS = 30 * 60 * 1000;
const MAX_INDEX_TRACKED = 6;

export function analyseSessionDecay(
	games: ClassifiedGame[],
	evalMoves: EvalMoveResult[] | null | undefined
): SessionDecaySummary | null {
	if (games.length === 0 || !evalMoves || evalMoves.length === 0) return null;

	const perGamePhase = new Map<
		string,
		Record<Phase, { sum: number; n: number; blunders: number }>
	>();
	for (const m of evalMoves) {
		let entry = perGamePhase.get(m.gameId);
		if (!entry) {
			entry = {
				opening: { sum: 0, n: 0, blunders: 0 },
				middle: { sum: 0, n: 0, blunders: 0 },
				end: { sum: 0, n: 0, blunders: 0 }
			};
			perGamePhase.set(m.gameId, entry);
		}
		const p = entry[m.phase];
		p.sum += m.cpLoss;
		p.n += 1;
		if (m.classification === 'blunder') p.blunders += 1;
	}

	const sorted = [...games].sort((a, b) => a.playedAt - b.playedAt);
	const sessions: ClassifiedGame[][] = [];
	let current: ClassifiedGame[] = [];
	for (const g of sorted) {
		const last = current[current.length - 1];
		if (!last || g.playedAt - last.playedAt > SESSION_GAP_MS) {
			if (current.length > 0) sessions.push(current);
			current = [g];
		} else {
			current.push(g);
		}
	}
	if (current.length > 0) sessions.push(current);

	type Acc = { sum: number; n: number; blunders: number; games: number };
	const emptyAcc = (): Acc => ({ sum: 0, n: 0, blunders: 0, games: 0 });
	const emptyPhaseAcc = () => ({
		overall: emptyAcc(),
		opening: emptyAcc(),
		middle: emptyAcc(),
		end: emptyAcc()
	});
	const acc = Array.from({ length: MAX_INDEX_TRACKED }, emptyPhaseAcc);

	for (const session of sessions) {
		session.forEach((g, i) => {
			const idx = Math.min(i, MAX_INDEX_TRACKED - 1);
			const bucket = acc[idx];
			bucket.overall.games += 1;
			const entry = perGamePhase.get(g.gameId);
			if (!entry) return;
			for (const phase of ['opening', 'middle', 'end'] as const) {
				const p = entry[phase];
				if (p.n === 0) continue;
				const avg = p.sum / p.n;
				bucket[phase].sum += avg;
				bucket[phase].n += 1;
				bucket[phase].blunders += p.blunders / p.n;
				bucket[phase].games += 1;
				bucket.overall.sum += avg;
				bucket.overall.n += 1;
				bucket.overall.blunders += p.blunders / p.n;
			}
		});
	}

	const toCell = (a: Acc): PhaseCell => ({
		games: a.games,
		avgCpLoss: a.n > 0 ? a.sum / a.n : null,
		blunderRate: a.n > 0 ? a.blunders / a.n : null
	});

	const rows: SessionDecayRow[] = acc
		.map((a, index) => ({
			index,
			games: a.overall.games,
			overall: toCell(a.overall),
			byPhase: {
				opening: toCell(a.opening),
				middle: toCell(a.middle),
				end: toCell(a.end)
			}
		}))
		.filter((r) => r.games > 0);

	// Worst phase decay: first row vs index-3+ row.
	const firstRow = rows[0];
	const lateRow = rows.find((r) => r.index >= 3);
	let worstPhase: Phase | null = null;
	let worstDelta: number | null = null;
	if (firstRow && lateRow) {
		for (const phase of ['opening', 'middle', 'end'] as const) {
			const a = firstRow.byPhase[phase].avgCpLoss;
			const b = lateRow.byPhase[phase].avgCpLoss;
			if (a == null || b == null) continue;
			const delta = b - a;
			if (worstDelta == null || delta > worstDelta) {
				worstDelta = delta;
				worstPhase = phase;
			}
		}
	}

	return {
		sessions: sessions.length,
		multiGameSessions: sessions.filter((s) => s.length > 1).length,
		rows,
		worstPhase,
		worstPhaseDelta: worstDelta
	};
}
