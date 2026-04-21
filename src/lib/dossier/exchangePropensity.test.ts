import { describe, expect, it } from 'vitest';
import type { Role } from 'chessops/types';

import { analyseExchangePropensity } from './exchangePropensity';
import type { ClassifiedGame } from './classify';

/**
 * Build a minimal ClassifiedGame shaped move for testing. Only the fields
 * read by analyseExchangePropensity are populated; the rest are stubbed so
 * that future MoveFeatures additions don't force a cascade of test updates.
 */
function move(
	materialDiff: number,
	isCapture: boolean,
	pieceRole: Role,
	capturedRole: Role | null
) {
	return {
		materialDiff,
		isCapture,
		pieceRole,
		capturedRole
	} as unknown as ClassifiedGame['moves'][number];
}

function game(...moves: ReturnType<typeof move>[]): ClassifiedGame {
	return { moves } as unknown as ClassifiedGame;
}

describe('analyseExchangePropensity', () => {
	it('buckets equal material by default', () => {
		const r = analyseExchangePropensity([
			game(move(0, false, 'knight', null), move(0, false, 'knight', null))
		]);
		expect(r.byState.equal.moves).toBe(2);
		expect(r.byState.ahead.moves).toBe(0);
		expect(r.byState.behind.moves).toBe(0);
	});

	it('classifies bucket boundaries correctly (|diff|>1.5)', () => {
		// 1.5 is equal (strict >), 1.6 is ahead, -2 is behind.
		const r = analyseExchangePropensity([
			game(
				move(1.5, false, 'knight', null),
				move(1.6, false, 'knight', null),
				move(-2, false, 'knight', null)
			)
		]);
		expect(r.byState.equal.moves).toBe(1);
		expect(r.byState.ahead.moves).toBe(1);
		expect(r.byState.behind.moves).toBe(1);
	});

	it('counts piece trades, pawn trades, piece-for-pawn and pawn-for-piece', () => {
		const r = analyseExchangePropensity([
			game(
				move(0, true, 'knight', 'bishop'), // piece trade (both 3)
				move(0, true, 'pawn', 'pawn'), // pawn trade
				move(0, true, 'bishop', 'pawn'), // piece-for-pawn (sac)
				move(0, true, 'pawn', 'knight'), // pawn-for-piece (gain)
				move(0, false, 'knight', null) // non-capture
			)
		]);
		const eq = r.byState.equal;
		expect(eq.moves).toBe(5);
		expect(eq.pieceTrades).toBe(1);
		expect(eq.pawnTrades).toBe(1);
		expect(eq.pieceForPawn).toBe(1);
		expect(eq.pawnForPiece).toBe(1);
		// Rates: 4 captures / 5 moves, 1 piece-trade / 5 moves.
		expect(eq.captureRate).toBeCloseTo(4 / 5);
		expect(eq.pieceTradeRate).toBeCloseTo(1 / 5);
	});

	it('surfaces simplify/cling deltas', () => {
		// Ahead: trade piece on every move. Equal: never. Behind: every move.
		const r = analyseExchangePropensity([
			game(move(3, true, 'knight', 'bishop'), move(3, true, 'knight', 'bishop')),
			game(move(0, false, 'knight', null), move(0, false, 'knight', null)),
			game(move(-3, true, 'knight', 'bishop'), move(-3, true, 'knight', 'bishop'))
		]);
		// Ahead rate = 1, equal rate = 0, behind rate = 1.
		expect(r.simplifyWhenAheadDelta).toBeCloseTo(1);
		expect(r.clingWhenBehindDelta).toBeCloseTo(1);
	});

	it('handles empty input without dividing by zero', () => {
		const r = analyseExchangePropensity([]);
		for (const s of ['ahead', 'equal', 'behind'] as const) {
			expect(r.byState[s].moves).toBe(0);
			expect(r.byState[s].captureRate).toBe(0);
			expect(r.byState[s].pieceTradeRate).toBe(0);
		}
		expect(r.simplifyWhenAheadDelta).toBe(0);
		expect(r.clingWhenBehindDelta).toBe(0);
	});
});
