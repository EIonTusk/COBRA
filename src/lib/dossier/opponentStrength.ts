/**
 * Opponent-strength normalization. Buckets your games by opponent rating
 * bands and surfaces how your CP loss / win rate shift across them.
 * Doesn't pull peer data — works purely off your own games (rating
 * delta is opponent − you), so the page tells you how you scale up and
 * down against stronger/weaker players.
 *
 * For a richer "is opp X stronger than typical for their rating" we'd
 * need per-opponent peer CP loss, which is already available via the
 * calibrated baseline. That's plumbed in as an optional baseline overlay.
 */

import type { ClassifiedGame } from './classify';
import type { EvalMoveResult } from './evalAxes';
import { wilsonInterval, type Interval } from './stats';

export type RatingGap =
	| 'much-weaker'
	| 'weaker'
	| 'peer'
	| 'stronger'
	| 'much-stronger'
	| 'unknown';

export interface OpponentBucket {
	key: RatingGap;
	label: string;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	avgCpLoss: number | null;
	winRate: number;
	winRateCI95: Interval;
}

export interface OpponentStrengthSummary {
	buckets: OpponentBucket[];
	headline: string | null;
}

const BUCKET_DEFS: { key: RatingGap; label: string; min: number; max: number }[] = [
	{ key: 'much-weaker', label: 'Much weaker (−200+)', min: -10000, max: -200 },
	{ key: 'weaker', label: 'Weaker (−199..−51)', min: -199, max: -51 },
	{ key: 'peer', label: 'Peer (±50)', min: -50, max: 50 },
	{ key: 'stronger', label: 'Stronger (+51..+199)', min: 51, max: 199 },
	{ key: 'much-stronger', label: 'Much stronger (+200+)', min: 200, max: 10000 }
];

export function analyseOpponentStrength(
	games: ClassifiedGame[],
	evalMoves: EvalMoveResult[] | null | undefined
): OpponentStrengthSummary {
	const cpByGame = new Map<string, { sum: number; n: number }>();
	if (evalMoves) {
		for (const m of evalMoves) {
			const prev = cpByGame.get(m.gameId) ?? { sum: 0, n: 0 };
			prev.sum += m.cpLoss;
			prev.n += 1;
			cpByGame.set(m.gameId, prev);
		}
	}

	const buckets: OpponentBucket[] = BUCKET_DEFS.map((d) => ({
		key: d.key,
		label: d.label,
		games: 0,
		wins: 0,
		losses: 0,
		draws: 0,
		avgCpLoss: null,
		winRate: 0,
		winRateCI95: { lo: 0, hi: 0 }
	}));
	const cpAcc = BUCKET_DEFS.map(() => ({ sum: 0, n: 0 }));
	for (const g of games) {
		if (g.userRating == null || g.opponentRating == null) {
			continue;
		}
		const gap = g.opponentRating - g.userRating;
		const idx = BUCKET_DEFS.findIndex((d) => gap >= d.min && gap <= d.max);
		if (idx < 0) continue;
		const b = buckets[idx];
		b.games += 1;
		if (g.result === 'win') b.wins += 1;
		else if (g.result === 'loss') b.losses += 1;
		else b.draws += 1;
		const cp = cpByGame.get(g.gameId);
		if (cp && cp.n > 0) {
			cpAcc[idx].sum += cp.sum / cp.n;
			cpAcc[idx].n += 1;
		}
	}
	for (let i = 0; i < buckets.length; i += 1) {
		const b = buckets[i];
		b.winRate = b.games > 0 ? b.wins / b.games : 0;
		// Wilson CI on wins + 0.5·draws is messier than it needs to be;
		// the Wilson interval treats wins alone as the success count,
		// which matches how the header reports "win rate" (%wins). Draws
		// still contribute to the denominator so the interval tightens.
		b.winRateCI95 = wilsonInterval(b.wins, b.games);
		b.avgCpLoss = cpAcc[i].n > 0 ? cpAcc[i].sum / cpAcc[i].n : null;
	}

	const peer = buckets.find((b) => b.key === 'peer');
	const strong = buckets.find((b) => b.key === 'stronger' || b.key === 'much-stronger');
	let headline: string | null = null;
	if (peer && peer.avgCpLoss != null && strong && strong.avgCpLoss != null && strong.games >= 5) {
		const delta = strong.avgCpLoss - peer.avgCpLoss;
		if (delta >= 15) {
			headline = `Your CP loss rises by ${delta.toFixed(0)}cp against stronger opponents — you're being dragged out of your comfort zone.`;
		} else if (delta <= -5) {
			headline = `You're sharper against stronger players: ${(-delta).toFixed(0)}cp better than against peers.`;
		}
	}

	return { buckets, headline };
}
