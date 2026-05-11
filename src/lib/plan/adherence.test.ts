import { describe, it, expect } from 'vitest';

import { scorePlanAdherence } from './adherence';
import type { SerializedMiddlegameAggregate } from '$lib/types';

// A representative-ish post-1.e4-e5 position. Side to move is White,
// rank 2-7 pawns intact except e4/e5.
const POST_E4E5_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

function emptyAggregate(): SerializedMiddlegameAggregate {
	return {
		totalLines: 0,
		pliesWindow: 4,
		topNextMoves: [],
		pawnMoves: [],
		pieceJourneys: [],
		castling: { white: { short: 0, long: 0 }, black: { short: 0, long: 0 } },
		attackSquares: []
	};
}

describe('scorePlanAdherence', () => {
	it('returns null when the aggregate is empty', () => {
		const out = scorePlanAdherence({
			baseFen: POST_E4E5_FEN,
			line: ['g1f3'],
			aggregate: emptyAggregate(),
			userColor: 'white'
		});
		expect(out).toBeNull();
	});

	it('scores a Ng1→f3 knight reroute as a match', () => {
		const agg: SerializedMiddlegameAggregate = {
			...emptyAggregate(),
			totalLines: 10,
			pliesWindow: 2,
			pieceJourneys: [{ color: 'white', role: 'knight', from: 'g1', to: 'f3', count: 8 }]
		};
		const out = scorePlanAdherence({
			baseFen: POST_E4E5_FEN,
			line: ['g1f3'],
			aggregate: agg,
			userColor: 'white',
			maxPlies: 2
		});
		expect(out).not.toBeNull();
		expect(out!.piece.score).toBe(1);
		expect(out!.piece.matches).toHaveLength(1);
		expect(out!.piece.matches[0].label).toBe('Ng1 → f3');
		expect(out!.overall).toBeGreaterThan(0);
	});

	it('scores a divergent knight move as a miss', () => {
		const agg: SerializedMiddlegameAggregate = {
			...emptyAggregate(),
			totalLines: 10,
			pliesWindow: 2,
			pieceJourneys: [{ color: 'white', role: 'knight', from: 'g1', to: 'f3', count: 8 }]
		};
		// User plays Ng1→h3 instead.
		const out = scorePlanAdherence({
			baseFen: POST_E4E5_FEN,
			line: ['g1h3'],
			aggregate: agg,
			userColor: 'white',
			maxPlies: 2
		});
		expect(out).not.toBeNull();
		expect(out!.piece.score).toBe(0);
		expect(out!.piece.misses).toHaveLength(1);
	});

	it('only scores patterns for the requested colour', () => {
		const agg: SerializedMiddlegameAggregate = {
			...emptyAggregate(),
			totalLines: 10,
			pliesWindow: 4,
			pawnMoves: [{ color: 'black', san: 'd5', from: 'd7', to: 'd5', isCapture: false, count: 8 }]
		};
		// Walk a white-side line — no Black pawn moves played from White's
		// perspective; scoring for white should find no qualifying patterns.
		const out = scorePlanAdherence({
			baseFen: POST_E4E5_FEN,
			line: ['g1f3', 'b8c6'],
			aggregate: agg,
			userColor: 'white',
			maxPlies: 4
		});
		expect(out).not.toBeNull();
		expect(out!.pawn.matches).toHaveLength(0);
		expect(out!.pawn.misses).toHaveLength(0);
	});

	it('drops sub-threshold patterns', () => {
		const agg: SerializedMiddlegameAggregate = {
			...emptyAggregate(),
			totalLines: 10,
			pliesWindow: 2,
			pieceJourneys: [
				// 1/10 = 10% < default 18% threshold → dropped.
				{ color: 'white', role: 'knight', from: 'g1', to: 'h3', count: 1 }
			]
		};
		const out = scorePlanAdherence({
			baseFen: POST_E4E5_FEN,
			line: ['g1h3'],
			aggregate: agg,
			userColor: 'white',
			maxPlies: 2
		});
		expect(out).not.toBeNull();
		expect(out!.piece.matches).toHaveLength(0);
		expect(out!.piece.misses).toHaveLength(0);
	});

	it('returns null on illegal continuation', () => {
		const agg: SerializedMiddlegameAggregate = {
			...emptyAggregate(),
			totalLines: 10
		};
		// e1e8 is not a legal king move from the starting setup.
		const out = scorePlanAdherence({
			baseFen: POST_E4E5_FEN,
			line: ['e1e8'],
			aggregate: agg,
			userColor: 'white'
		});
		expect(out).toBeNull();
	});

	it('weights overall by master frequency', () => {
		const agg: SerializedMiddlegameAggregate = {
			...emptyAggregate(),
			totalLines: 10,
			pliesWindow: 2,
			// One 9/10 piece pattern user matches + one 3/10 pawn pattern user misses.
			pieceJourneys: [{ color: 'white', role: 'knight', from: 'g1', to: 'f3', count: 9 }],
			pawnMoves: [{ color: 'white', san: 'a3', from: 'a2', to: 'a3', isCapture: false, count: 3 }]
		};
		const out = scorePlanAdherence({
			baseFen: POST_E4E5_FEN,
			line: ['g1f3'],
			aggregate: agg,
			userColor: 'white',
			maxPlies: 2
		});
		expect(out).not.toBeNull();
		// matched weight = 0.9 (piece) ; missed weight = 0.3 (pawn).
		// overall = 0.9 / (0.9 + 0.3) = 0.75
		expect(out!.overall).toBeCloseTo(0.75, 2);
	});
});
