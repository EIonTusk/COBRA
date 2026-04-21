/**
 * Exchange propensity — how much you simplify by trading pieces, bucketed
 * by the material state at the moment of the trade. Uses materialDiff
 * (from classify) to know whether you were up, down, or equal.
 *
 * Output: for each state, the fraction of your moves that were piece-for-
 * piece captures (non-pawn on non-pawn), vs the fraction of captures that
 * traded pawns, vs non-captures.
 */

import type { ClassifiedGame } from './classify';

export type MaterialState = 'ahead' | 'equal' | 'behind';

export interface ExchangeBucket {
	moves: number;
	pieceTrades: number;
	pawnTrades: number;
	pieceForPawn: number; // sacrifice
	pawnForPiece: number; // gain
	/** Captures per move ratio in this bucket. */
	captureRate: number;
	/** Piece-trade rate in this bucket. */
	pieceTradeRate: number;
}

export interface ExchangeSummary {
	byState: Record<MaterialState, ExchangeBucket>;
	/** Simplification delta: piece-trade rate when ahead vs equal. */
	simplifyWhenAheadDelta: number;
	/** Cling delta: piece-trade rate when behind vs equal (negative = you avoid trades when losing). */
	clingWhenBehindDelta: number;
}

const PIECE_VALUES: Record<string, number> = {
	pawn: 1,
	knight: 3,
	bishop: 3,
	rook: 5,
	queen: 9,
	king: 0
};

export function analyseExchangePropensity(games: ClassifiedGame[]): ExchangeSummary {
	const empty = (): ExchangeBucket => ({
		moves: 0,
		pieceTrades: 0,
		pawnTrades: 0,
		pieceForPawn: 0,
		pawnForPiece: 0,
		captureRate: 0,
		pieceTradeRate: 0
	});
	const byState: Record<MaterialState, ExchangeBucket> = {
		ahead: empty(),
		equal: empty(),
		behind: empty()
	};

	for (const g of games) {
		for (const m of g.moves) {
			const state: MaterialState =
				m.materialDiff > 1.5 ? 'ahead' : m.materialDiff < -1.5 ? 'behind' : 'equal';
			const b = byState[state];
			b.moves += 1;
			if (!m.isCapture || !m.capturedRole) continue;
			const captorVal = PIECE_VALUES[m.pieceRole];
			const capturedVal = PIECE_VALUES[m.capturedRole];
			if (m.pieceRole !== 'pawn' && m.capturedRole !== 'pawn' && captorVal === capturedVal)
				b.pieceTrades += 1;
			else if (m.pieceRole === 'pawn' && m.capturedRole === 'pawn') b.pawnTrades += 1;
			else if (m.pieceRole !== 'pawn' && m.capturedRole === 'pawn') b.pieceForPawn += 1;
			else if (m.pieceRole === 'pawn' && m.capturedRole !== 'pawn') b.pawnForPiece += 1;
			else if (captorVal < capturedVal) b.pawnForPiece += 1;
			else if (captorVal > capturedVal) b.pieceForPawn += 1;
		}
	}

	for (const s of ['ahead', 'equal', 'behind'] as const) {
		const b = byState[s];
		const captures = b.pieceTrades + b.pawnTrades + b.pieceForPawn + b.pawnForPiece;
		b.captureRate = b.moves > 0 ? captures / b.moves : 0;
		b.pieceTradeRate = b.moves > 0 ? b.pieceTrades / b.moves : 0;
	}

	return {
		byState,
		simplifyWhenAheadDelta: byState.ahead.pieceTradeRate - byState.equal.pieceTradeRate,
		clingWhenBehindDelta: byState.behind.pieceTradeRate - byState.equal.pieceTradeRate
	};
}
