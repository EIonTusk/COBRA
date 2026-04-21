/**
 * Session / tilt profile. Groups games by wall-clock session (≤ 30 min
 * between consecutive games) and surfaces two patterns:
 *
 *  - **byIndex**: how avg CP loss trends across game-in-session index.
 *    Typical signal: CP loss creeps up from game 3 onwards as
 *    concentration drops. Rendered as a small line/bar.
 *
 *  - **postLossDelta / postWinDelta**: the game immediately following a
 *    loss (or win) in the same session — is CP loss higher after a
 *    loss? (Usually yes, and often dramatically so.)
 *
 * Works off `ClassifiedGame[]` (for session grouping + results) and
 * `EvalMoveResult[]` (for CP loss per game). Degrades gracefully when v2
 * eval wasn't run — CP-loss stats are null; byIndex still shows blunder
 * counts if we only have v1 data, otherwise the whole report is null.
 */
import type { ClassifiedGame } from './classify';
import type { EvalMoveResult } from './evalAxes';

export interface SessionIndexBucket {
	index: number;
	games: number;
	avgCpLoss: number | null;
	blunderRate: number | null;
	winRate: number;
}

export interface SessionDelta {
	games: number;
	avgCpLoss: number | null;
	avgCpLossBaseline: number | null;
	delta: number | null;
}

export interface SessionProfile {
	sessions: number;
	multiGameSessions: number;
	byIndex: SessionIndexBucket[];
	postLoss: SessionDelta;
	postWin: SessionDelta;
	headline: string | null;
}

const SESSION_GAP_MS = 30 * 60 * 1000;
const MAX_INDEX_TRACKED = 6;

export function buildSessionProfile(
	games: ClassifiedGame[],
	moves: EvalMoveResult[] | null
): SessionProfile | null {
	if (games.length === 0) return null;

	const sorted = [...games].sort((a, b) => a.playedAt - b.playedAt);
	const perGameCp = computePerGameCp(moves);

	// Group into sessions.
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

	const indexAcc: Array<{
		cpSum: number;
		cpN: number;
		blunderSum: number;
		blunderN: number;
		games: number;
		wins: number;
		decided: number;
	}> = [];
	for (let i = 0; i < MAX_INDEX_TRACKED; i++) {
		indexAcc.push({ cpSum: 0, cpN: 0, blunderSum: 0, blunderN: 0, games: 0, wins: 0, decided: 0 });
	}

	const postLoss = { cpSum: 0, cpN: 0, baselineSum: 0, baselineN: 0, games: 0 };
	const postWin = { cpSum: 0, cpN: 0, baselineSum: 0, baselineN: 0, games: 0 };

	for (const session of sessions) {
		for (let i = 0; i < session.length; i++) {
			const g = session[i];
			const bucket = indexAcc[Math.min(i, MAX_INDEX_TRACKED - 1)];
			bucket.games += 1;
			if (g.result !== 'draw') {
				bucket.decided += 1;
				if (g.result === 'win') bucket.wins += 1;
			}
			const perGame = perGameCp.get(g.gameId);
			if (perGame) {
				bucket.cpSum += perGame.avgCpLoss;
				bucket.cpN += 1;
				bucket.blunderSum += perGame.blunderRate;
				bucket.blunderN += 1;
			}

			if (i > 0) {
				const prev = session[i - 1];
				const prevCp = perGameCp.get(prev.gameId);
				const curCp = perGame;
				if (prev.result === 'loss' && curCp) {
					postLoss.games += 1;
					postLoss.cpSum += curCp.avgCpLoss;
					postLoss.cpN += 1;
					if (prevCp) {
						postLoss.baselineSum += prevCp.avgCpLoss;
						postLoss.baselineN += 1;
					}
				} else if (prev.result === 'win' && curCp) {
					postWin.games += 1;
					postWin.cpSum += curCp.avgCpLoss;
					postWin.cpN += 1;
					if (prevCp) {
						postWin.baselineSum += prevCp.avgCpLoss;
						postWin.baselineN += 1;
					}
				}
			}
		}
	}

	const byIndex: SessionIndexBucket[] = indexAcc
		.map((a, i) => ({
			index: i,
			games: a.games,
			avgCpLoss: a.cpN > 0 ? a.cpSum / a.cpN : null,
			blunderRate: a.blunderN > 0 ? a.blunderSum / a.blunderN : null,
			winRate: a.decided > 0 ? a.wins / a.decided : 0
		}))
		.filter((r) => r.games > 0);

	const multiGameSessions = sessions.filter((s) => s.length > 1).length;

	const report: SessionProfile = {
		sessions: sessions.length,
		multiGameSessions,
		byIndex,
		postLoss: toDelta(postLoss),
		postWin: toDelta(postWin),
		headline: null
	};

	report.headline = buildHeadline(report);
	return report;
}

function toDelta(acc: {
	cpSum: number;
	cpN: number;
	baselineSum: number;
	baselineN: number;
	games: number;
}): SessionDelta {
	const avgCp = acc.cpN > 0 ? acc.cpSum / acc.cpN : null;
	const baselineCp = acc.baselineN > 0 ? acc.baselineSum / acc.baselineN : null;
	return {
		games: acc.games,
		avgCpLoss: avgCp,
		avgCpLossBaseline: baselineCp,
		delta: avgCp != null && baselineCp != null ? avgCp - baselineCp : null
	};
}

function computePerGameCp(
	moves: EvalMoveResult[] | null
): Map<string, { avgCpLoss: number; blunderRate: number }> {
	const out = new Map<string, { avgCpLoss: number; blunderRate: number }>();
	if (!moves) return out;
	const acc = new Map<string, { sum: number; n: number; blunders: number }>();
	for (const m of moves) {
		const a = acc.get(m.gameId) ?? { sum: 0, n: 0, blunders: 0 };
		a.sum += m.cpLoss;
		a.n += 1;
		if (m.classification === 'blunder') a.blunders += 1;
		acc.set(m.gameId, a);
	}
	for (const [gameId, a] of acc.entries()) {
		if (a.n === 0) continue;
		out.set(gameId, { avgCpLoss: a.sum / a.n, blunderRate: a.blunders / a.n });
	}
	return out;
}

function buildHeadline(r: SessionProfile): string | null {
	if (r.multiGameSessions < 3) return null;
	const first = r.byIndex[0];
	const late = r.byIndex.find((b) => b.index >= 3);
	if (first && late && first.avgCpLoss != null && late.avgCpLoss != null) {
		const delta = late.avgCpLoss - first.avgCpLoss;
		if (delta >= 15) {
			return `Your 4th+ game in a session averages ${Math.round(delta)} cp worse than your 1st. Consider capping sessions at three games.`;
		}
	}
	if (r.postLoss.delta != null && r.postLoss.delta >= 20 && r.postLoss.games >= 5) {
		return `After a loss in the same session, your CP loss jumps +${Math.round(r.postLoss.delta)} cp on average — a cool-down before the next game is worth it.`;
	}
	return null;
}
