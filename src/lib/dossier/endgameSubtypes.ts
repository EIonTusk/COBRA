/**
 * Endgame subtype analysis. Uses the endgameFamily tag that classify.ts
 * stamps on every game that reached a low-material phase. For each family
 * we report:
 *
 *  - Games reached.
 *  - Conversion rate when entering ahead (avg CP before first endgame
 *    move > +150 cp from user's POV).
 *  - Defense rate when entering behind (< −150 cp).
 *  - Plain win/loss/draw breakdown.
 *
 * "Entering" eval is taken from the first evalAxes move in the endgame
 * phase for that game; if none, the endgame was considered but wasn't
 * eval'd (skipped for entry-state metrics).
 */

import type { ClassifiedGame, EndgameFamily } from './classify';
import type { EvalMoveResult } from './evalAxes';
import type { BaselineCriticalMomentsJson } from './fingerprint';
import { wilsonInterval, betaBinomialPosterior, type Interval, type PosteriorRate } from './stats';

const FAMILY_LABELS: Record<EndgameFamily, string> = {
	'king-pawn': 'King + pawns',
	'rook-pawn': 'Rook + pawns',
	'rook-endgame': 'Rook ending (mixed)',
	'minor-pawn': 'Minor piece + pawns',
	'opposite-bishops': 'Opposite-color bishops',
	'same-bishops': 'Same-color bishops',
	'knight-pawn': 'Knight ending',
	'queen-endgame': 'Queen ending',
	'queen-vs-rook': 'Queen vs Rook',
	'heavy-pieces': 'Heavy-piece ending',
	mixed: 'Mixed material'
};

export function endgameFamilyLabel(f: EndgameFamily): string {
	return FAMILY_LABELS[f];
}

export interface EndgameBucket {
	family: EndgameFamily;
	games: number;
	wins: number;
	losses: number;
	draws: number;
	winRate: number;
	winRateCI95: Interval;
	convertedAhead: number;
	missedAhead: number;
	heldBehind: number;
	flippedBehind: number;
	lostBehind: number;
	enteredAhead: number;
	enteredBehind: number;
	enteredEqual: number;
	conversionRate: number;
	conversionCI95: Interval;
	defenseRate: number;
	defenseCI95: Interval;
	/**
	 * Beta-Binomial posterior for conversion rate, using the overall
	 * peer (or user-wide) conversion rate as a prior. Pulls thin slices
	 * (e.g. 3 opposite-bishop endings) toward the prior so the reader
	 * doesn't see a shout finding off a tiny sample.
	 */
	conversionPosterior: PosteriorRate | null;
	defensePosterior: PosteriorRate | null;
}

export interface EndgameSummary {
	totalWithEndgame: number;
	overallConversionRate: number;
	overallConversionCI95: Interval;
	overallDefenseRate: number;
	overallDefenseCI95: Interval;
	buckets: EndgameBucket[];
}

export function analyseEndgameSubtypes(
	games: ClassifiedGame[],
	evalMoves: EvalMoveResult[] | null,
	peer?: BaselineCriticalMomentsJson | null
): EndgameSummary {
	const firstEndgameEval = new Map<string, number>(); // gameId -> eval before first endgame move
	if (evalMoves) {
		for (const m of evalMoves) {
			if (m.phase !== 'end') continue;
			const prev = firstEndgameEval.get(m.gameId);
			if (prev === undefined) firstEndgameEval.set(m.gameId, m.userEvalBeforeCp);
		}
	}

	const bucketMap = new Map<EndgameFamily, EndgameBucket>();
	let totalEndgames = 0;
	let totalConv = 0;
	let totalConvDenom = 0;
	let totalDef = 0;
	let totalDefDenom = 0;

	for (const g of games) {
		if (!g.endgameFamily) continue;
		totalEndgames += 1;
		const fam = g.endgameFamily;
		let bucket = bucketMap.get(fam);
		if (!bucket) {
			bucket = {
				family: fam,
				games: 0,
				wins: 0,
				losses: 0,
				draws: 0,
				winRate: 0,
				winRateCI95: { lo: 0, hi: 0 },
				convertedAhead: 0,
				missedAhead: 0,
				heldBehind: 0,
				flippedBehind: 0,
				lostBehind: 0,
				enteredAhead: 0,
				enteredBehind: 0,
				enteredEqual: 0,
				conversionRate: 0,
				conversionCI95: { lo: 0, hi: 0 },
				defenseRate: 0,
				defenseCI95: { lo: 0, hi: 0 },
				conversionPosterior: null,
				defensePosterior: null
			};
			bucketMap.set(fam, bucket);
		}
		bucket.games += 1;
		if (g.result === 'win') bucket.wins += 1;
		else if (g.result === 'loss') bucket.losses += 1;
		else bucket.draws += 1;
		// (CIs populated after the aggregation loop.)

		const entryEval = firstEndgameEval.get(g.gameId);
		if (entryEval === undefined) continue;
		if (entryEval > 150) {
			bucket.enteredAhead += 1;
			totalConvDenom += 1;
			if (g.result === 'win') {
				bucket.convertedAhead += 1;
				totalConv += 1;
			} else {
				bucket.missedAhead += 1;
			}
		} else if (entryEval < -150) {
			bucket.enteredBehind += 1;
			totalDefDenom += 1;
			if (g.result === 'draw') {
				bucket.heldBehind += 1;
				totalDef += 1;
			} else if (g.result === 'win') {
				bucket.flippedBehind += 1;
				totalDef += 1;
			} else {
				bucket.lostBehind += 1;
			}
		} else {
			bucket.enteredEqual += 1;
		}
	}

	const buckets = Array.from(bucketMap.values());
	// Use peer priors when available; otherwise the user's own overall
	// rate acts as an empirical prior, which still provides the right
	// shrinkage behaviour on thin family slices.
	const overallConversionRate = totalConvDenom > 0 ? totalConv / totalConvDenom : 0;
	const overallDefenseRate = totalDefDenom > 0 ? totalDef / totalDefDenom : 0;
	const convPriorMean = peer?.conversionRate ?? overallConversionRate;
	const defPriorMean = peer?.defenseRate ?? overallDefenseRate;
	const convPriorWeight = clampPrior(peer?.conversionGames, totalConvDenom);
	const defPriorWeight = clampPrior(peer?.defenseGames, totalDefDenom);

	for (const b of buckets) {
		b.winRate = b.games > 0 ? b.wins / b.games : 0;
		b.winRateCI95 = wilsonInterval(b.wins, b.games);
		b.conversionRate = b.enteredAhead > 0 ? b.convertedAhead / b.enteredAhead : 0;
		b.conversionCI95 = wilsonInterval(b.convertedAhead, b.enteredAhead);
		const defenseSaves = b.heldBehind + b.flippedBehind;
		b.defenseRate = b.enteredBehind > 0 ? defenseSaves / b.enteredBehind : 0;
		b.defenseCI95 = wilsonInterval(defenseSaves, b.enteredBehind);
		b.conversionPosterior =
			b.enteredAhead > 0
				? betaBinomialPosterior(b.convertedAhead, b.enteredAhead, convPriorMean, convPriorWeight)
				: null;
		b.defensePosterior =
			b.enteredBehind > 0
				? betaBinomialPosterior(defenseSaves, b.enteredBehind, defPriorMean, defPriorWeight)
				: null;
	}
	buckets.sort((a, b) => b.games - a.games);

	return {
		totalWithEndgame: totalEndgames,
		overallConversionRate,
		overallConversionCI95: wilsonInterval(totalConv, totalConvDenom),
		overallDefenseRate,
		overallDefenseCI95: wilsonInterval(totalDef, totalDefDenom),
		buckets
	};
}

function clampPrior(peerN: number | undefined, userN: number): number {
	// If no peer sample, scale the user's own total as prior weight so
	// family-level estimates shrink toward the user's global rate. Clamp
	// so a tiny corpus still gives thin slices a meaningful pull.
	const base = peerN ?? Math.max(10, userN);
	return Math.max(10, Math.min(200, base));
}
