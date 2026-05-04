import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseSan, makeSan, makeSanAndPlay } from 'chessops/san';
import { makeUci, parseSquare } from 'chessops/util';
import type { Move, Role } from 'chessops';

import type { Edge } from '$lib/types';

const PROMO_ROLES: Record<string, Role> = {
	q: 'queen',
	r: 'rook',
	b: 'bishop',
	n: 'knight'
};

export function chessFromFen(fen: string): Chess {
	const setup = parseFen(fen).unwrap();
	return Chess.fromSetup(setup).unwrap();
}

export function fenFromChess(pos: Chess): string {
	return makeFen(pos.toSetup());
}

export function epdFromChess(pos: Chess): string {
	return makeFen(pos.toSetup(), { epd: true });
}

export function edgeFromUci(
	fromFen: string,
	orig: string,
	dest: string,
	promotion?: 'q' | 'r' | 'b' | 'n'
): Edge | null {
	const pos = chessFromFen(fromFen);
	const from = parseSquare(orig);
	let to = parseSquare(dest);
	if (from === undefined || to === undefined) return null;
	// Castling: chessops represents it as king→rook (Chess960 form).
	// If the caller drops the king on its canonical final square (g/c),
	// remap to the rook's square so isLegal recognises it.
	const piece = pos.board.get(from);
	if (
		piece?.role === 'king' &&
		orig === 'e' + orig[1] &&
		(dest === 'g' + orig[1] || dest === 'c' + orig[1])
	) {
		const rookSq = parseSquare((dest[0] === 'g' ? 'h' : 'a') + orig[1]);
		if (rookSq !== undefined) {
			const rook = pos.board.get(rookSq);
			if (rook?.role === 'rook' && rook.color === piece.color) to = rookSq;
		}
	}
	const move: Move = { from, to, promotion: promotion ? PROMO_ROLES[promotion] : undefined };
	if (!pos.isLegal(move)) return null;
	const san = makeSanAndPlay(pos, move);
	const uci = makeUci(move);
	const toFenKey = epdFromChess(pos);
	return { san, uci, toFenKey };
}

export function edgeFromSan(fromFen: string, san: string): Edge | null {
	const pos = chessFromFen(fromFen);
	const move = parseSan(pos, san);
	if (!move) return null;
	const sanOut = makeSanAndPlay(pos, move);
	return { san: sanOut, uci: makeUci(move), toFenKey: epdFromChess(pos) };
}

export function sanAtFen(fromFen: string, move: Move): string | null {
	const pos = chessFromFen(fromFen);
	if (!pos.isLegal(move)) return null;
	return makeSan(pos, move);
}

export function fenAfterMove(fromFen: string, edge: Edge): string {
	const pos = chessFromFen(fromFen);
	const move = parseSan(pos, edge.san);
	if (!move) throw new Error(`Illegal SAN in edge: ${edge.san}`);
	makeSanAndPlay(pos, move);
	return fenFromChess(pos);
}

export function squareToKey(sq: number): string {
	const file = 'abcdefgh'[sq & 7];
	const rank = '12345678'[sq >> 3];
	return file + rank;
}

export function legalDests(fen: string): Map<string, string[]> {
	const chess = chessFromFen(fen);
	const map = new Map<string, string[]>();
	const ctx = chess.ctx();
	const ourPieces = chess.board[chess.turn];
	for (const sq of ourPieces) {
		const targets = chess.dests(sq, ctx);
		if (targets.isEmpty()) continue;
		const origKey = squareToKey(sq);
		const destKeys: string[] = [];
		for (const t of targets) destKeys.push(squareToKey(t));
		// chessops returns castling as king→rook (Chess960-style).
		// Also accept the king's canonical final square (c/g file) so
		// users can drop on g1/c1 (etc.) instead of the rook.
		const piece = chess.board.get(sq);
		if (piece?.role === 'king') {
			const rank = origKey[1];
			if (origKey === 'e' + rank) {
				if (destKeys.includes('h' + rank) && !destKeys.includes('g' + rank)) {
					destKeys.push('g' + rank);
				}
				if (destKeys.includes('a' + rank) && !destKeys.includes('c' + rank)) {
					destKeys.push('c' + rank);
				}
			}
		}
		map.set(origKey, destKeys);
	}
	return map;
}

export function isPromotionMove(fen: string, orig: string, dest: string): boolean {
	const pos = chessFromFen(fen);
	const from = parseSquare(orig);
	if (from === undefined) return false;
	const piece = pos.board.get(from);
	if (piece?.role !== 'pawn') return false;
	const destRank = dest.charCodeAt(1) - '0'.charCodeAt(0);
	return destRank === 1 || destRank === 8;
}

export function isGameEnd(fen: string): { checkmate: boolean; stalemate: boolean } {
	const chess = chessFromFen(fen);
	return { checkmate: chess.isCheckmate(), stalemate: chess.isStalemate() };
}

/**
 * Richer end-state probe used when explaining how a game ended (resigned,
 * stalemate, mate, 50-move, insufficient material …). All flags read off the
 * single `Chess` instance so the cost is one parse + the rules check, not five.
 */
export function endState(fen: string): {
	checkmate: boolean;
	stalemate: boolean;
	insufficientMaterial: boolean;
	inCheck: boolean;
	/** Halfmove clock from the FEN (resets on pawn moves and captures). */
	halfmoves: number;
} {
	const chess = chessFromFen(fen);
	return {
		checkmate: chess.isCheckmate(),
		stalemate: chess.isStalemate(),
		insufficientMaterial: chess.isInsufficientMaterial(),
		inCheck: chess.isCheck(),
		halfmoves: chess.halfmoves
	};
}

const PIECE_VALUE: Record<Role, number> = {
	pawn: 1,
	knight: 3,
	bishop: 3,
	rook: 5,
	queen: 9,
	king: 0
};

function materialOf(pos: Chess, color: 'white' | 'black'): number {
	let total = 0;
	for (const sq of pos.board[color]) {
		const p = pos.board.get(sq);
		if (p) total += PIECE_VALUE[p.role];
	}
	return total;
}

/**
 * Decide how many plies of the engine's refutation PV to show before the
 * "counter attack" animation can stop without losing the point.
 *
 * Two signals combine:
 *   1. Material realization — keep playing plies until the refuting side has
 *      actually won material (or delivered mate) equal to roughly the engine's
 *      evaluation. This handles tactics where the win materialises a few plies
 *      deep (intermezzo, discovered attacks).
 *   2. Quiescence — once the material target is hit, keep extending while the
 *      very next PV move is still a capture, check, or promotion, so chained
 *      tactical sequences (trades, forcing lines) finish cleanly instead of
 *      cutting mid-combination.
 *
 * When the engine's advantage is positional (no material ever falls in the
 * PV), we cap at 2 plies — showing six quiet developing moves doesn't teach
 * the user anything and feels laggy.
 *
 * Returns the number of plies (>= 1, <= maxPlies) to animate.
 */
export function planRefutationPlies(
	wrongFen: string,
	pv: string[],
	stmCp: number,
	maxPlies: number
): number {
	const cap = Math.min(maxPlies, pv.length);
	if (cap === 0) return 0;

	let pos: Chess;
	try {
		pos = chessFromFen(wrongFen);
	} catch {
		return Math.min(1, cap);
	}

	const refuting = pos.turn;
	const victim = refuting === 'white' ? 'black' : 'white';
	const baseDelta = materialOf(pos, refuting) - materialOf(pos, victim);
	// Target material swing to "realize" the engine's eval. Roughly a pawn per
	// 150 cp — a hanging piece (~300cp) needs ~2 pawns shown, a hanging rook
	// (~500cp) needs ~3, etc. Capped so queen sacs don't demand the whole PV.
	const target = Math.min(9, Math.max(1, Math.floor(Math.abs(stmCp) / 150)));

	const loud: boolean[] = [];
	const reachedTarget: boolean[] = [];

	for (let i = 0; i < cap; i++) {
		const uci = pv[i];
		if (!uci || uci.length < 4) break;
		const from = parseSquare(uci.slice(0, 2));
		const to = parseSquare(uci.slice(2, 4));
		if (from === undefined || to === undefined) break;
		const promotion = uci.length > 4 ? PROMO_ROLES[uci[4]] : undefined;
		const move: Move = { from, to, promotion };
		if (!pos.isLegal(move)) break;

		const victimBefore = materialOf(pos, victim);
		pos.play(move);
		const victimAfter = materialOf(pos, victim);
		const wasCapture = victimAfter < victimBefore;
		const delivers = pos.isCheckmate();
		if (delivers) return i + 1;

		loud.push(wasCapture || pos.isCheck() || promotion !== undefined);
		const delta = materialOf(pos, refuting) - materialOf(pos, victim) - baseDelta;
		reachedTarget.push(delta >= target);
	}

	const n = loud.length;
	if (n === 0) return 0;

	const minIdx = reachedTarget.findIndex((r) => r);
	if (minIdx < 0) {
		// Purely positional refutation — the PV doesn't net material in the
		// window we looked at. Show a brief taste and stop.
		return Math.min(2, n);
	}

	let plies = minIdx + 1;
	while (plies < n && loud[plies]) plies++;
	return Math.max(1, Math.min(plies, n));
}
