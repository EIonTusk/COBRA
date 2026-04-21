/**
 * Position-demand heuristics: cheap board-only signals describing what
 * kind of move the position rewards, *before* the user moves. Pairs with
 * `mismatch.ts` to detect leaks (user response ≠ position demand).
 *
 * v1 demand axes:
 *  - hangingCapture: is there a user capture with strictly positive
 *    Static Exchange Evaluation (≥2 pawns of material)? Uses real
 *    recursive SEE — handles full trade sequences and x-ray attackers,
 *    so single-tactic traps no longer slip through.
 *  - closedCenter: are the d/e-file pawns blocked into an interlocked
 *    skeleton? Closed positions reward patience and pawn breaks.
 *  - kingExposed: opponent king has fewer than 2 friendly pawns within
 *    the immediate king zone (and is on its back two ranks). Demands
 *    attacking play.
 *
 * Engine-eval-grade demand will come in v2 — these stay heuristic.
 */

import { attacks, knightAttacks, kingAttacks, pawnAttacks } from 'chessops/attacks';
import { SquareSet } from 'chessops/squareSet';
import type { Position } from 'chessops/chess';
import type { Color, Piece, Role, Square } from 'chessops/types';

const PIECE_VALUE: Record<Role, number> = {
	pawn: 1,
	knight: 3,
	bishop: 3,
	rook: 5,
	queen: 9,
	king: 100
};

const ROLE_ORDER: Role[] = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

export interface PositionDemand {
	/** Material gain (in pawns) from the best winning capture available, or 0. */
	bestCaptureGain: number;
	/** Convenience: bestCaptureGain >= 2. */
	hangingCapture: boolean;
	/** d/e-file pawn skeleton is interlocked. */
	closedCenter: boolean;
	/** Opponent king has thin pawn shield — attacking play is rewarded. */
	kingExposed: boolean;
}

/**
 * Compute demand for the side to move. Caller is responsible for ensuring
 * `pos.turn` is the user's color.
 */
export function positionDemand(pos: Position): PositionDemand {
	const us = pos.turn;
	const them: Color = us === 'white' ? 'black' : 'white';
	const occupied = pos.board.occupied;
	const ourPieces = pos.board[us];
	const theirPieces = pos.board[them];

	// For each potential capture, run real SEE.
	let best = 0;
	for (const from of ourPieces) {
		const piece = pos.board.get(from);
		if (!piece) continue;
		const attackBB = attacks(piece, from, occupied).intersect(theirPieces);
		for (const to of attackBB) {
			const target = pos.board.get(to);
			if (!target || target.role === 'king') continue;
			const gain = see(pos, to, from);
			if (gain > best) best = gain;
		}
	}

	return {
		bestCaptureGain: best,
		hangingCapture: best >= 2,
		closedCenter: isClosedCenter(pos),
		kingExposed: isKingExposed(pos, them)
	};
}

/**
 * Static Exchange Evaluation. Returns the side-to-move's material balance
 * after the optimal sequence of captures on `targetSquare`, starting with
 * the attacker on `attackerSquare`. Handles x-ray attackers via the
 * occupied-bitboard threading; lets each side stop the trade if continuing
 * loses material.
 */
function see(pos: Position, targetSquare: Square, attackerSquare: Square): number {
	const target = pos.board.get(targetSquare);
	const attacker = pos.board.get(attackerSquare);
	if (!target || !attacker) return 0;
	const them: Color = attacker.color === 'white' ? 'black' : 'white';
	// First capture: attacker takes target. Now the trade continues with
	// `them` to recapture, attacker piece sitting on targetSquare, and
	// attacker's original square vacated (which may unmask x-ray pieces).
	const occAfter = pos.board.occupied.without(attackerSquare);
	const recur = seeContinue(pos, targetSquare, them, occAfter, PIECE_VALUE[attacker.role]);
	return PIECE_VALUE[target.role] - recur;
}

/**
 * "Is the piece on `square` hanging?" — runs SEE from the side-to-move's
 * perspective for the smallest attacker on the square. Returns the
 * material the side-to-move would gain by initiating the exchange (in
 * pawns; >0 means the piece is en prise). Used by the eval-axes module
 * to filter false-positive material-loss flags.
 */
export function pieceOnSquareIsHanging(pos: Position, square: Square): number {
	const piece = pos.board.get(square);
	if (!piece) return 0;
	const attacker = smallestAttacker(pos, square, pos.turn, pos.board.occupied);
	if (!attacker) return 0;
	const occAfter = pos.board.occupied.without(attacker.from);
	const them: Color = pos.turn === 'white' ? 'black' : 'white';
	const recur = seeContinue(pos, square, them, occAfter, PIECE_VALUE[attacker.role]);
	return PIECE_VALUE[piece.role] - recur;
}

function seeContinue(
	pos: Position,
	targetSquare: Square,
	side: Color,
	occupied: SquareSet,
	pieceOnTargetValue: number
): number {
	const next = smallestAttacker(pos, targetSquare, side, occupied);
	if (!next) return 0;
	const newOcc = occupied.without(next.from);
	const them: Color = side === 'white' ? 'black' : 'white';
	const recur = seeContinue(pos, targetSquare, them, newOcc, PIECE_VALUE[next.role]);
	// `side` may decline to recapture if doing so loses material.
	return Math.max(0, pieceOnTargetValue - recur);
}

function smallestAttacker(
	pos: Position,
	square: Square,
	side: Color,
	occupied: SquareSet
): { from: Square; role: Role } | null {
	const sideMask = pos.board[side];
	const opposite: Color = side === 'white' ? 'black' : 'white';

	// Pawns: a `side` pawn on `from` attacks `square` iff `from` lies in
	// the squares an opposite-color pawn on `square` would attack.
	const pawnFrom = first(
		pawnAttacks(opposite, square).intersect(pos.board.pawn).intersect(sideMask).intersect(occupied)
	);
	if (pawnFrom !== null) return { from: pawnFrom, role: 'pawn' };

	const knightFrom = first(
		knightAttacks(square).intersect(pos.board.knight).intersect(sideMask).intersect(occupied)
	);
	if (knightFrom !== null) return { from: knightFrom, role: 'knight' };

	const fakeBishop: Piece = { color: side, role: 'bishop' };
	const bishopRay = attacks(fakeBishop, square, occupied);
	const bishopFrom = first(
		bishopRay.intersect(pos.board.bishop).intersect(sideMask).intersect(occupied)
	);
	if (bishopFrom !== null) return { from: bishopFrom, role: 'bishop' };

	const fakeRook: Piece = { color: side, role: 'rook' };
	const rookRay = attacks(fakeRook, square, occupied);
	const rookFrom = first(rookRay.intersect(pos.board.rook).intersect(sideMask).intersect(occupied));
	if (rookFrom !== null) return { from: rookFrom, role: 'rook' };

	const queenFrom = first(
		bishopRay.union(rookRay).intersect(pos.board.queen).intersect(sideMask).intersect(occupied)
	);
	if (queenFrom !== null) return { from: queenFrom, role: 'queen' };

	const kingFrom = first(
		kingAttacks(square).intersect(pos.board.king).intersect(sideMask).intersect(occupied)
	);
	if (kingFrom !== null) return { from: kingFrom, role: 'king' };

	return null;
}

function first(set: SquareSet): Square | null {
	for (const sq of set) return sq;
	return null;
}

function isClosedCenter(pos: Position): boolean {
	let blockedPairs = 0;
	for (const file of [3, 4]) {
		for (let rank = 1; rank < 6; rank++) {
			const sqLow = file + rank * 8;
			const sqHigh = file + (rank + 1) * 8;
			const low = pos.board.get(sqLow);
			const high = pos.board.get(sqHigh);
			if (low?.role === 'pawn' && high?.role === 'pawn' && low.color !== high.color) {
				blockedPairs += 1;
			}
		}
	}
	return blockedPairs >= 2;
}

/**
 * "Exposed" if the enemy king is on its back two ranks (i.e., still the
 * castled / starting zone) AND has fewer than 2 friendly pawns within
 * `kingAttacks(kingSq)` ∪ {kingSq}. In an endgame the king walks freely
 * and this signal stops being meaningful — we suppress it when total
 * non-pawn material is low.
 */
function isKingExposed(pos: Position, kingColor: Color): boolean {
	const kingSq = pos.board.kingOf(kingColor);
	if (kingSq === undefined) return false;
	const rank = kingSq >> 3;
	const onCastledRanks = kingColor === 'white' ? rank <= 1 : rank >= 6;
	if (!onCastledRanks) return false;

	// Suppress in deep endgame.
	const npm = nonPawnMaterial(pos);
	if (npm <= 13) return false;

	const zone = kingAttacks(kingSq).with(kingSq);
	const shieldPawns = zone.intersect(pos.board.pawn).intersect(pos.board[kingColor]).size();
	return shieldPawns < 2;
}

function nonPawnMaterial(pos: Position): number {
	let total = 0;
	for (const sq of pos.board.occupied) {
		const piece = pos.board.get(sq);
		if (!piece) continue;
		if (piece.role === 'pawn' || piece.role === 'king') continue;
		total += PIECE_VALUE[piece.role];
	}
	return total;
}

// Re-export so other modules can read PIECE_VALUE without duplicating.
export { PIECE_VALUE, ROLE_ORDER };
