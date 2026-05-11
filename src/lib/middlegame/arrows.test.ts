import { describe, it, expect } from 'vitest';

import { aggregateToArrows } from './arrows';
import type { MiddlegameAggregate } from './aggregate';

const baseAgg: MiddlegameAggregate = {
	totalLines: 10,
	pliesWindow: 12,
	topNextMoves: [],
	pawnMoves: [],
	pieceJourneys: [],
	castling: { white: { short: 0, long: 0 }, black: { short: 0, long: 0 } },
	attackSquares: []
};

describe('aggregateToArrows', () => {
	it('returns empty array when there are no lines', () => {
		const empty = { ...baseAgg, totalLines: 0 };
		expect(aggregateToArrows(empty)).toEqual([]);
	});

	it('paints the top continuation in green with thickest line', () => {
		const agg = {
			...baseAgg,
			topNextMoves: [
				{ san: 'e4', uci: 'e2e4', count: 9 },
				{ san: 'd4', uci: 'd2d4', count: 1 }
			]
		};
		const shapes = aggregateToArrows(agg);
		expect(shapes[0]).toMatchObject({ orig: 'e2', dest: 'e4', brush: 'green' });
		expect(shapes[0].modifiers?.lineWidth).toBe(14);
	});

	it('normalises castling continuations to king→g/c destination', () => {
		const agg = {
			...baseAgg,
			topNextMoves: [{ san: 'O-O', uci: 'e1h1', count: 8 }]
		};
		const shapes = aggregateToArrows(agg);
		expect(shapes[0]).toMatchObject({ orig: 'e1', dest: 'g1', brush: 'green' });
	});

	it('paints pawn moves yellow and piece reroutings paleBlue', () => {
		const agg = {
			...baseAgg,
			pawnMoves: [
				{ color: 'white', san: 'e4', from: 'e2', to: 'e4', isCapture: false, count: 8 }
			] as MiddlegameAggregate['pawnMoves'],
			pieceJourneys: [
				{ color: 'white', role: 'knight', from: 'g1', to: 'f3', count: 7 }
			] as MiddlegameAggregate['pieceJourneys']
		};
		const shapes = aggregateToArrows(agg);
		const pawn = shapes.find((s) => s.brush === 'yellow');
		const piece = shapes.find((s) => s.brush === 'paleBlue');
		expect(pawn).toMatchObject({ orig: 'e2', dest: 'e4' });
		expect(piece).toMatchObject({ orig: 'g1', dest: 'f3' });
	});

	it('drops rows below count and pct thresholds', () => {
		const agg = {
			...baseAgg,
			pawnMoves: [
				{ color: 'white', san: 'a3', from: 'a2', to: 'a3', isCapture: false, count: 1 }
			] as MiddlegameAggregate['pawnMoves']
		};
		expect(aggregateToArrows(agg)).toEqual([]);
	});

	it('skips piece journeys where the piece never moved or was captured', () => {
		const agg = {
			...baseAgg,
			pieceJourneys: [
				{ color: 'white', role: 'rook', from: 'a1', to: 'a1', count: 9 },
				{ color: 'black', role: 'queen', from: 'd8', to: 'captured', count: 5 }
			] as MiddlegameAggregate['pieceJourneys']
		};
		expect(aggregateToArrows(agg)).toEqual([]);
	});

	it('dedupes when a pawn move equals a top continuation', () => {
		const agg = {
			...baseAgg,
			topNextMoves: [{ san: 'e4', uci: 'e2e4', count: 9 }],
			pawnMoves: [
				{ color: 'white', san: 'e4', from: 'e2', to: 'e4', isCapture: false, count: 9 }
			] as MiddlegameAggregate['pawnMoves']
		};
		const shapes = aggregateToArrows(agg);
		expect(shapes.length).toBe(1);
		expect(shapes[0].brush).toBe('green');
	});

	it('paints weakness circles only inside the defender half of the board', () => {
		const agg = {
			...baseAgg,
			attackSquares: [
				// White lands on f5 in 8/10 lines — squarely in black's territory.
				{ square: 'f5', attacker: 'white', count: 8, captureCount: 0 },
				// White also lands on e3 in 7/10 lines, but that's white's own
				// territory so it shouldn't paint as a weakness on black.
				{ square: 'e3', attacker: 'white', count: 7, captureCount: 0 },
				// Black lands on d4 in 7/10 lines — inside white's territory.
				{ square: 'd4', attacker: 'black', count: 7, captureCount: 1 }
			] as MiddlegameAggregate['attackSquares']
		};
		const shapes = aggregateToArrows(agg, { userColor: 'white' });
		const f5 = shapes.find((s) => s.orig === 'f5' && !s.dest);
		const d4 = shapes.find((s) => s.orig === 'd4' && !s.dest);
		const e3 = shapes.find((s) => s.orig === 'e3' && !s.dest);
		// User is white. f5: white (user) attacks → purple ("press here").
		// d4: black (opponent) attacks → paleRed ("defend here").
		expect(f5?.brush).toBe('purple');
		expect(d4?.brush).toBe('paleRed');
		// e3 is in white's own half, not the defender's half from white's
		// attacker perspective → skipped.
		expect(e3).toBeUndefined();
	});

	it('flips weakness colours by userColor', () => {
		const agg = {
			...baseAgg,
			attackSquares: [
				{ square: 'f5', attacker: 'white', count: 8, captureCount: 0 },
				{ square: 'd4', attacker: 'black', count: 7, captureCount: 0 }
			] as MiddlegameAggregate['attackSquares']
		};
		// User as black: white attacker = opponent (paleRed), black attacker = user (purple).
		const shapes = aggregateToArrows(agg, { userColor: 'black' });
		const f5 = shapes.find((s) => s.orig === 'f5' && !s.dest);
		const d4 = shapes.find((s) => s.orig === 'd4' && !s.dest);
		expect(f5?.brush).toBe('paleRed');
		expect(d4?.brush).toBe('purple');
	});

	it('drops weakness squares below the percentage threshold', () => {
		const agg = {
			...baseAgg,
			attackSquares: [
				{ square: 'f5', attacker: 'white', count: 1, captureCount: 0 }
			] as MiddlegameAggregate['attackSquares']
		};
		expect(aggregateToArrows(agg, { userColor: 'white' })).toEqual([]);
	});

	it('shows multiple destinations for the same piece up to per-origin cap', () => {
		// The g1-knight goes to f3 in 5 lines and to e2 in 3 lines — both
		// above threshold (≥15% of 10 lines). Both should render.
		const agg = {
			...baseAgg,
			pieceJourneys: [
				{ color: 'white', role: 'knight', from: 'g1', to: 'f3', count: 5 },
				{ color: 'white', role: 'knight', from: 'g1', to: 'e2', count: 3 }
			] as MiddlegameAggregate['pieceJourneys']
		};
		const shapes = aggregateToArrows(agg);
		const f3 = shapes.find((s) => s.orig === 'g1' && s.dest === 'f3');
		const e2 = shapes.find((s) => s.orig === 'g1' && s.dest === 'e2');
		expect(f3).toBeDefined();
		expect(e2).toBeDefined();
	});

	it('respects per-origin cap when a single piece has many destinations', () => {
		const agg = {
			...baseAgg,
			pieceJourneys: [
				{ color: 'white', role: 'knight', from: 'g1', to: 'f3', count: 5 },
				{ color: 'white', role: 'knight', from: 'g1', to: 'e2', count: 4 },
				{ color: 'white', role: 'knight', from: 'g1', to: 'h3', count: 3 },
				{ color: 'white', role: 'knight', from: 'g1', to: 'd2', count: 2 }
			] as MiddlegameAggregate['pieceJourneys']
		};
		// Default per-origin cap is 3 — d2 (lowest) is dropped even though
		// it clears the threshold.
		const shapes = aggregateToArrows(agg, { maxDestsPerOrigin: 3 });
		const dests = shapes.filter((s) => s.orig === 'g1').map((s) => s.dest);
		expect(dests).toContain('f3');
		expect(dests).toContain('e2');
		expect(dests).toContain('h3');
		expect(dests).not.toContain('d2');
	});

	it('keeps every piece represented instead of crowding one piece out', () => {
		// Knight has two strong destinations; bishop has one. Every piece
		// should keep its primary arrow even when one piece dominates.
		const agg = {
			...baseAgg,
			pieceJourneys: [
				{ color: 'white', role: 'knight', from: 'g1', to: 'f3', count: 8 },
				{ color: 'white', role: 'knight', from: 'g1', to: 'e2', count: 7 },
				{ color: 'white', role: 'bishop', from: 'f1', to: 'b5', count: 4 },
				{ color: 'white', role: 'bishop', from: 'c1', to: 'g5', count: 3 }
			] as MiddlegameAggregate['pieceJourneys']
		};
		const shapes = aggregateToArrows(agg);
		const origs = new Set(shapes.map((s) => s.orig));
		expect(origs.has('g1')).toBe(true);
		expect(origs.has('f1')).toBe(true);
		expect(origs.has('c1')).toBe(true);
	});
});
