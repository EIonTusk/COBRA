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
	convertedAhead: number;
	missedAhead: number;
	heldBehind: number;
	flippedBehind: number;
	lostBehind: number;
	enteredAhead: number;
	enteredBehind: number;
	enteredEqual: number;
	conversionRate: number;
	defenseRate: number;
}

export interface EndgameSummary {
	totalWithEndgame: number;
	overallConversionRate: number;
	overallDefenseRate: number;
	buckets: EndgameBucket[];
}

export function analyseEndgameSubtypes(
	games: ClassifiedGame[],
	evalMoves: EvalMoveResult[] | null
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
				convertedAhead: 0,
				missedAhead: 0,
				heldBehind: 0,
				flippedBehind: 0,
				lostBehind: 0,
				enteredAhead: 0,
				enteredBehind: 0,
				enteredEqual: 0,
				conversionRate: 0,
				defenseRate: 0
			};
			bucketMap.set(fam, bucket);
		}
		bucket.games += 1;
		if (g.result === 'win') bucket.wins += 1;
		else if (g.result === 'loss') bucket.losses += 1;
		else bucket.draws += 1;

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
	for (const b of buckets) {
		b.winRate = b.games > 0 ? b.wins / b.games : 0;
		b.conversionRate = b.enteredAhead > 0 ? b.convertedAhead / b.enteredAhead : 0;
		b.defenseRate = b.enteredBehind > 0 ? (b.heldBehind + b.flippedBehind) / b.enteredBehind : 0;
	}
	buckets.sort((a, b) => b.games - a.games);

	return {
		totalWithEndgame: totalEndgames,
		overallConversionRate: totalConvDenom > 0 ? totalConv / totalConvDenom : 0,
		overallDefenseRate: totalDefDenom > 0 ? totalDef / totalDefDenom : 0,
		buckets
	};
}
