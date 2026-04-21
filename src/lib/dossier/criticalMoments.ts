/**
 * Critical-moments audit. Walks the v2 per-move results grouped by game
 * and surfaces three rates that are cheap to compute but very hard to
 * infer from raw game results:
 *
 *  - **conversion**: of games where the user's eval reached ≥ +150 cp
 *    at any point, what fraction ended in a win.
 *  - **defense**: of games where the eval fell to ≤ −150 cp at any
 *    point, what fraction the user saved (draw or win).
 *  - **equality**: of games that stayed within ±30 cp through move 15
 *    (ply 30), what win / loss / draw distribution followed.
 *
 * Peer deltas come from the picked baseline bucket's
 * `criticalMoments` field when present.
 */
import type { EvalMoveResult } from './evalAxes';
import type { BaselineCriticalMomentsJson } from './fingerprint';

export interface CriticalMoments {
	conversion: { games: number; wins: number; rate: number; peerRate: number | null };
	defense: { games: number; saves: number; rate: number; peerRate: number | null };
	equality: {
		games: number;
		wins: number;
		losses: number;
		draws: number;
		winRate: number;
		lossRate: number;
		peerWinRate: number | null;
		peerLossRate: number | null;
	};
	sampledGames: number;
}

const ADVANTAGE_CP = 150;
const EQUALITY_WINDOW_CP = 30;
const EQUALITY_THROUGH_PLY = 30;

export function buildCriticalMoments(
	moves: EvalMoveResult[],
	peer: BaselineCriticalMomentsJson | null | undefined
): CriticalMoments {
	const byGame = new Map<string, EvalMoveResult[]>();
	for (const m of moves) {
		const arr = byGame.get(m.gameId) ?? [];
		arr.push(m);
		byGame.set(m.gameId, arr);
	}

	let convGames = 0;
	let convWins = 0;
	let defGames = 0;
	let defSaves = 0;
	let equalityGames = 0;
	let equalityWins = 0;
	let equalityLosses = 0;
	let equalityDraws = 0;

	for (const arr of byGame.values()) {
		// Each `m.userEvalBeforeCp` is the eval on the position the user
		// is about to move in, from their POV. That's the eval the user
		// saw; using `After` would double-count their own mistakes.
		const trace = [...arr].sort((a, b) => a.ply - b.ply);
		if (trace.length === 0) continue;
		const result = trace[0].gameResult;

		const maxAdvantage = Math.max(...trace.map((m) => m.userEvalBeforeCp));
		const minAdvantage = Math.min(...trace.map((m) => m.userEvalBeforeCp));

		if (maxAdvantage >= ADVANTAGE_CP) {
			convGames += 1;
			if (result === 'win') convWins += 1;
		}
		if (minAdvantage <= -ADVANTAGE_CP) {
			defGames += 1;
			if (result === 'win' || result === 'draw') defSaves += 1;
		}

		// Equality window: every user-move before ply 30 stayed inside ±30 cp.
		const earlyMoves = trace.filter((m) => m.ply <= EQUALITY_THROUGH_PLY);
		if (earlyMoves.length >= 5) {
			const stayedEqual = earlyMoves.every(
				(m) => Math.abs(m.userEvalBeforeCp) <= EQUALITY_WINDOW_CP
			);
			if (stayedEqual) {
				equalityGames += 1;
				if (result === 'win') equalityWins += 1;
				else if (result === 'loss') equalityLosses += 1;
				else equalityDraws += 1;
			}
		}
	}

	return {
		conversion: {
			games: convGames,
			wins: convWins,
			rate: convGames > 0 ? convWins / convGames : 0,
			peerRate: peer?.conversionRate ?? null
		},
		defense: {
			games: defGames,
			saves: defSaves,
			rate: defGames > 0 ? defSaves / defGames : 0,
			peerRate: peer?.defenseRate ?? null
		},
		equality: {
			games: equalityGames,
			wins: equalityWins,
			losses: equalityLosses,
			draws: equalityDraws,
			winRate: equalityGames > 0 ? equalityWins / equalityGames : 0,
			lossRate: equalityGames > 0 ? equalityLosses / equalityGames : 0,
			peerWinRate: peer?.equalityWinRate ?? null,
			peerLossRate: peer?.equalityLossRate ?? null
		},
		sampledGames: byGame.size
	};
}
