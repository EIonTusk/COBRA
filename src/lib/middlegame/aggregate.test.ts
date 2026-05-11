import { describe, it, expect } from 'vitest';

import { aggregateLines } from './aggregate';
import { STARTPOS_FEN } from '$lib/chess/fen';

// All UCI; from the standard starting position.
const e4_e5_Nf3_Nc6_Bb5_a6 = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'];
const e4_e5_Nf3_Nc6_Bb5_Nf6 = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'g8f6'];
const e4_c5_Nf3_d6 = ['e2e4', 'c7c5', 'g1f3', 'd7d6'];

describe('aggregateLines', () => {
	it('counts top first moves across lines', () => {
		const agg = aggregateLines(STARTPOS_FEN, [
			e4_e5_Nf3_Nc6_Bb5_a6,
			e4_e5_Nf3_Nc6_Bb5_Nf6,
			e4_c5_Nf3_d6
		]);
		// All three lines start with e4.
		expect(agg.topNextMoves[0]).toEqual({ san: 'e4', uci: 'e2e4', count: 3 });
		expect(agg.totalLines).toBe(3);
	});

	it('records pawn moves with starting square so breaks aggregate by file', () => {
		const agg = aggregateLines(STARTPOS_FEN, [e4_e5_Nf3_Nc6_Bb5_a6, e4_e5_Nf3_Nc6_Bb5_Nf6], {
			maxPlies: 6
		});
		// Both lines play 1.e4 and 1...e5.
		const e4 = agg.pawnMoves.find((p) => p.color === 'white' && p.from === 'e2' && p.to === 'e4');
		const e5 = agg.pawnMoves.find((p) => p.color === 'black' && p.from === 'e7' && p.to === 'e5');
		expect(e4?.count).toBe(2);
		expect(e5?.count).toBe(2);
		// 6th line has Black playing a6 in one and Nf6 in the other; only the
		// a6 line should record a pawn move on the black side at ply 6.
		const a6 = agg.pawnMoves.find((p) => p.color === 'black' && p.from === 'a7' && p.to === 'a6');
		expect(a6?.count).toBe(1);
	});

	it('tracks piece journeys: white knight from g1 to f3 in every line', () => {
		const agg = aggregateLines(STARTPOS_FEN, [
			e4_e5_Nf3_Nc6_Bb5_a6,
			e4_e5_Nf3_Nc6_Bb5_Nf6,
			e4_c5_Nf3_d6
		]);
		const knight = agg.pieceJourneys.find(
			(j) => j.color === 'white' && j.role === 'knight' && j.from === 'g1' && j.to === 'f3'
		);
		expect(knight?.count).toBe(3);
	});

	it('captures rerouting (multi-move journey)', () => {
		// Nf3 → Nh4 → Nf5 inside a 6-ply window (white moves only count odd plies).
		// Use a synthetic line from the starting position: e4 e5 Nf3 Nc6 Nh4 a6
		const reroute = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f3h4', 'a7a6'];
		const agg = aggregateLines(STARTPOS_FEN, [reroute], { maxPlies: 6 });
		// The g1-knight ends on h4 by the end of the window.
		const journey = agg.pieceJourneys.find(
			(j) => j.color === 'white' && j.role === 'knight' && j.from === 'g1' && j.to === 'h4'
		);
		expect(journey?.count).toBe(1);
	});

	it('counts castling per side and per side-of-board', () => {
		// 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O Nf6 = white short castle on ply 7.
		const shortLine = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'e1h1', 'g8f6'];
		const agg = aggregateLines(STARTPOS_FEN, [shortLine, shortLine], { maxPlies: 8 });
		expect(agg.castling.white.short).toBe(2);
		expect(agg.castling.white.long).toBe(0);
		expect(agg.castling.black.short).toBe(0);
	});

	it('skips lines with illegal moves and keeps the rest', () => {
		const broken = ['e2e4', 'e7e5', 'a1a8']; // illegal rook move
		const agg = aggregateLines(STARTPOS_FEN, [broken, e4_c5_Nf3_d6]);
		expect(agg.totalLines).toBe(1);
	});

	it('respects maxPlies', () => {
		// Same line but only walk 2 plies; piece journey for the knight should
		// not yet exist (it moves on ply 3 in this line).
		const agg = aggregateLines(STARTPOS_FEN, [e4_e5_Nf3_Nc6_Bb5_a6], { maxPlies: 2 });
		const knight = agg.pieceJourneys.find(
			(j) => j.color === 'white' && j.role === 'knight' && j.from === 'g1' && j.to === 'f3'
		);
		expect(knight).toBeUndefined();
	});

	it('tallies attack squares once per line, regardless of how many times the piece bounces in', () => {
		// White's knight visits f3 only once across the line, but the f-square
		// landings should count as one line — not three (e4, Nf3, Bb5 ply
		// destinations are e4/f3/b5).
		const agg = aggregateLines(STARTPOS_FEN, [e4_e5_Nf3_Nc6_Bb5_a6], { maxPlies: 6 });
		const f3 = agg.attackSquares.find((s) => s.attacker === 'white' && s.square === 'f3');
		expect(f3?.count).toBe(1);
	});

	it('aggregates attack squares across lines', () => {
		const agg = aggregateLines(STARTPOS_FEN, [
			e4_e5_Nf3_Nc6_Bb5_a6,
			e4_e5_Nf3_Nc6_Bb5_Nf6,
			e4_c5_Nf3_d6
		]);
		// All three lines play Nf3 → white lands a piece on f3 in all three.
		const f3 = agg.attackSquares.find((s) => s.attacker === 'white' && s.square === 'f3');
		expect(f3?.count).toBe(3);
		// Two of three lines play Nc6 → black lands on c6 in two.
		const c6 = agg.attackSquares.find((s) => s.attacker === 'black' && s.square === 'c6');
		expect(c6?.count).toBe(2);
	});
});
