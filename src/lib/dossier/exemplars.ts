/**
 * Exemplars — the games that most represent (or contradict) your archetype.
 *
 * For each game we compute a per-game axis vector (forcing/capture/
 * pawnPlay/queenside) and score it against the overall fingerprint:
 *  - Alignment score = negative L1 distance from overall axes. Closer = more
 *    representative of your style.
 *  - Contradiction score = positive L1 distance. Farther = the most "unlike
 *    you" games — good for noticing when you play in a foreign gear.
 *
 * We pick 3 best + 3 worst. Alignment also requires the game to have at
 * least 15 user moves so a 5-move capitulation doesn't sneak in.
 */

import type { ClassifiedGame, MoveFeatures } from './classify';

export interface Exemplar {
	gameId: string;
	playedAt: number;
	result: 'win' | 'loss' | 'draw';
	color: 'white' | 'black';
	opponentUsername: string | null;
	opponentRating: number | null;
	eco: string | null;
	openingName: string | null;
	axes: AxisVec;
	distance: number;
	moves: number;
}

export interface ExemplarSummary {
	yourAxes: AxisVec;
	representative: Exemplar[];
	contradictory: Exemplar[];
}

interface AxisVec {
	forcing: number;
	capture: number;
	pawnPlay: number;
	queenside: number;
}

export function buildExemplars(games: ClassifiedGame[]): ExemplarSummary {
	const yourAxes = gameAxes(games.flatMap((g) => g.moves));
	const scored: Exemplar[] = [];
	for (const g of games) {
		if (g.moves.length < 15) continue;
		const axes = gameAxes(g.moves);
		const distance = l1(axes, yourAxes);
		scored.push({
			gameId: g.gameId,
			playedAt: g.playedAt,
			result: g.result,
			color: g.color,
			opponentUsername: g.opponentUsername,
			opponentRating: g.opponentRating,
			eco: g.eco,
			openingName: g.openingName,
			axes,
			distance,
			moves: g.moves.length
		});
	}
	const byDistance = [...scored].sort((a, b) => a.distance - b.distance);
	return {
		yourAxes,
		representative: byDistance.slice(0, 3),
		contradictory: byDistance.slice(-3).reverse()
	};
}

function gameAxes(moves: MoveFeatures[]): AxisVec {
	if (moves.length === 0) return { forcing: 0, capture: 0, pawnPlay: 0, queenside: 0 };
	let forcing = 0;
	let capture = 0;
	let pawnPlay = 0;
	let queenside = 0;
	for (const m of moves) {
		if (m.isCapture || m.isCheck) forcing += 1;
		if (m.isCapture) capture += 1;
		if (m.isPawnMove) pawnPlay += 1;
		if (m.toFile <= 3) queenside += 1;
	}
	const n = moves.length;
	return {
		forcing: forcing / n,
		capture: capture / n,
		pawnPlay: pawnPlay / n,
		queenside: queenside / n
	};
}

function l1(a: AxisVec, b: AxisVec): number {
	return (
		Math.abs(a.forcing - b.forcing) +
		Math.abs(a.capture - b.capture) +
		Math.abs(a.pawnPlay - b.pawnPlay) +
		Math.abs(a.queenside - b.queenside)
	);
}
