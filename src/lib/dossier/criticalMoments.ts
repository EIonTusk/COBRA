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
import {
	wilsonInterval,
	betaBinomialPosterior,
	intervalsOverlap,
	type Interval,
	type PosteriorRate
} from './stats';

export interface CriticalMoments {
	conversion: {
		games: number;
		wins: number;
		rate: number;
		ci95: Interval;
		peerRate: number | null;
		peerGames: number | null;
		peerCI95: Interval | null;
		/**
		 * Beta-Binomial posterior of the user's conversion rate using the
		 * peer rate as prior. Present when a peer rate is available and
		 * produces a shrunk mean + 80% credible interval.
		 */
		posterior: PosteriorRate | null;
		/**
		 * True when user CI95 does not overlap peer CI95 — the statistical
		 * ground for saying "meaningfully different from peers."
		 */
		peerSeparated: boolean | null;
	};
	defense: {
		games: number;
		saves: number;
		rate: number;
		ci95: Interval;
		peerRate: number | null;
		peerGames: number | null;
		peerCI95: Interval | null;
		posterior: PosteriorRate | null;
		peerSeparated: boolean | null;
	};
	equality: {
		games: number;
		wins: number;
		losses: number;
		draws: number;
		winRate: number;
		winCI95: Interval;
		lossRate: number;
		lossCI95: Interval;
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

	const convRate = convGames > 0 ? convWins / convGames : 0;
	const defRate = defGames > 0 ? defSaves / defGames : 0;
	const equalityWinRate = equalityGames > 0 ? equalityWins / equalityGames : 0;
	const equalityLossRate = equalityGames > 0 ? equalityLosses / equalityGames : 0;

	// Peer CIs when we have both a rate and a sample size on the peer.
	const peerConvCI = peerCI(peer?.conversionRate, peer?.conversionGames);
	const peerDefCI = peerCI(peer?.defenseRate, peer?.defenseGames);

	return {
		conversion: {
			games: convGames,
			wins: convWins,
			rate: convRate,
			ci95: wilsonInterval(convWins, convGames),
			peerRate: peer?.conversionRate ?? null,
			peerGames: peer?.conversionGames ?? null,
			peerCI95: peerConvCI,
			posterior:
				peer && peer.conversionRate != null
					? betaBinomialPosterior(
							convWins,
							convGames,
							peer.conversionRate,
							priorWeight(peer.conversionGames)
						)
					: null,
			peerSeparated:
				peerConvCI != null
					? !intervalsOverlap(wilsonInterval(convWins, convGames), peerConvCI)
					: null
		},
		defense: {
			games: defGames,
			saves: defSaves,
			rate: defRate,
			ci95: wilsonInterval(defSaves, defGames),
			peerRate: peer?.defenseRate ?? null,
			peerGames: peer?.defenseGames ?? null,
			peerCI95: peerDefCI,
			posterior:
				peer && peer.defenseRate != null
					? betaBinomialPosterior(
							defSaves,
							defGames,
							peer.defenseRate,
							priorWeight(peer.defenseGames)
						)
					: null,
			peerSeparated:
				peerDefCI != null ? !intervalsOverlap(wilsonInterval(defSaves, defGames), peerDefCI) : null
		},
		equality: {
			games: equalityGames,
			wins: equalityWins,
			losses: equalityLosses,
			draws: equalityDraws,
			winRate: equalityWinRate,
			winCI95: wilsonInterval(equalityWins, equalityGames),
			lossRate: equalityLossRate,
			lossCI95: wilsonInterval(equalityLosses, equalityGames),
			peerWinRate: peer?.equalityWinRate ?? null,
			peerLossRate: peer?.equalityLossRate ?? null
		},
		sampledGames: byGame.size
	};
}

/**
 * Wilson CI for a peer rate whose sample size is known. Reconstructs the
 * success count from rate × n, rounded. Exact success count isn't on the
 * baseline (we only carry the rate + n), so there's a ±1 sample of noise
 * in the interval — immaterial at the sample sizes we use (hundreds of
 * games) but worth noting if ever seen as suspicious.
 */
function peerCI(rate: number | undefined, games: number | undefined): Interval | null {
	if (rate == null || games == null || games <= 0) return null;
	return wilsonInterval(Math.round(rate * games), games);
}

/**
 * Prior weight for Beta-Binomial shrinkage: clamp peer sample size to a
 * reasonable range so a huge peer bucket doesn't totally overwhelm the
 * user's own data, and a tiny peer bucket still provides some prior.
 */
function priorWeight(peerGames: number | undefined): number {
	if (peerGames == null) return 20;
	return Math.max(10, Math.min(200, peerGames));
}
