/**
 * Tactical motif detection on blunders. For each user blunder move from
 * evalAxes, we parse the FEN before the move and the engine's best line,
 * then check simple geometry heuristics to label the motif the user was
 * *blind to* (i.e. what the best move exploited, or what the opponent
 * will exploit after the bad move).
 *
 * Heuristics are intentionally cheap — no engine. A real motif detector
 * needs multi-line eval + tree walking, but for a style dashboard the
 * rough buckets are enough to say "you blunder pins more than forks".
 */

import { parseFen } from 'chessops/fen';
import { setupPosition } from 'chessops/variant';
import { parseUci } from 'chessops/util';
import { attacks } from 'chessops/attacks';
import { SquareSet } from 'chessops/squareSet';
import type { Position } from 'chessops/chess';
import type { Color, Role, Square } from 'chessops/types';

import type { EvalMoveResult } from './evalAxes';

export type Motif =
	| 'pin'
	| 'fork'
	| 'skewer'
	| 'discovered-check'
	| 'discovered-attack'
	| 'back-rank'
	| 'hanging-piece'
	| 'double-attack'
	| 'unclassified';

const PIECE_VALUES: Record<Role, number> = {
	pawn: 1,
	knight: 3,
	bishop: 3,
	rook: 5,
	queen: 9,
	king: 100
};

const MOTIF_LABEL: Record<Motif, string> = {
	pin: 'Pin',
	fork: 'Fork',
	skewer: 'Skewer',
	'discovered-check': 'Discovered check',
	'discovered-attack': 'Discovered attack',
	'back-rank': 'Back-rank',
	'hanging-piece': 'Hanging piece',
	'double-attack': 'Double attack',
	unclassified: 'Unclassified'
};

export function motifLabel(m: Motif): string {
	return MOTIF_LABEL[m];
}

export interface MotifInstance {
	gameId: string;
	ply: number;
	san: string;
	motifs: Motif[];
	cpLoss: number;
	playedAt: number;
	fenBefore: string;
}

export interface MotifSummary {
	total: number;
	byMotif: { motif: Motif; count: number; avgCpLoss: number; samples: MotifInstance[] }[];
	instances: MotifInstance[];
}

export function analyseTacticalMotifs(moves: EvalMoveResult[] | null | undefined): MotifSummary {
	const all: MotifInstance[] = [];
	if (!moves) return { total: 0, byMotif: [], instances: [] };

	for (const m of moves) {
		if (m.classification !== 'blunder' && m.classification !== 'mistake') continue;
		if (!m.bestUci) continue;
		const setup = parseFen(m.fenBefore);
		if (setup.isErr) continue;
		const posR = setupPosition('chess', setup.value);
		if (posR.isErr) continue;
		const pos = posR.value;
		const bestMove = parseUci(m.bestUci);
		if (!bestMove || !('from' in bestMove)) continue;

		const motifs = detectMotifs(pos, bestMove.from, bestMove.to);
		if (motifs.length === 0) motifs.push('unclassified');
		all.push({
			gameId: m.gameId,
			ply: m.ply,
			san: m.san,
			motifs,
			cpLoss: m.cpLoss,
			playedAt: m.playedAt,
			fenBefore: m.fenBefore
		});
	}

	const counts = new Map<Motif, { count: number; cpSum: number; samples: MotifInstance[] }>();
	for (const inst of all) {
		for (const motif of inst.motifs) {
			const c = counts.get(motif) ?? { count: 0, cpSum: 0, samples: [] };
			c.count += 1;
			c.cpSum += inst.cpLoss;
			if (c.samples.length < 5) c.samples.push(inst);
			counts.set(motif, c);
		}
	}
	const byMotif = Array.from(counts.entries())
		.map(([motif, c]) => ({
			motif,
			count: c.count,
			avgCpLoss: c.count > 0 ? c.cpSum / c.count : 0,
			samples: c.samples
		}))
		.sort((a, b) => b.count - a.count);

	return { total: all.length, byMotif, instances: all };
}

function detectMotifs(pos: Position, from: Square, to: Square): Motif[] {
	const found = new Set<Motif>();
	const mover = pos.board.get(from);
	if (!mover) return [];
	// Clone and play to examine the resulting position.
	const after = pos.clone();
	try {
		after.play({ from, to });
	} catch {
		return [];
	}

	const oppColor: Color = mover.color === 'white' ? 'black' : 'white';
	const theirSideAfter = after.board[oppColor];

	// Fork: mover on `to` attacks 2+ enemy pieces worth ≥1 each (excluding king for now, then separately).
	const attackedByMover = attacks(mover, to, after.board.occupied);
	const attackedTargets = attackedByMover.intersect(theirSideAfter);
	let highValueTargets = 0;
	let attacksKing = false;
	for (const sq of attackedTargets) {
		const piece = after.board.get(sq);
		if (!piece) continue;
		if (piece.role === 'king') {
			attacksKing = true;
			continue;
		}
		if (PIECE_VALUES[piece.role] >= PIECE_VALUES[mover.role] || piece.role === 'queen') {
			highValueTargets += 1;
		}
	}
	if ((attacksKing && highValueTargets >= 1) || highValueTargets >= 2) found.add('fork');

	// Pin / skewer: the move creates a line attack through an enemy piece onto
	// a more valuable enemy piece behind. We look for enemy pieces aligned
	// from the mover's new square along a sliding direction consistent with
	// the moving piece's movement rules (bishops/rooks/queens only).
	if (mover.role === 'bishop' || mover.role === 'rook' || mover.role === 'queen') {
		for (const dir of slideDirs(mover.role)) {
			const line = scanLine(after, to, dir);
			if (line.length >= 2) {
				const first = after.board.get(line[0]);
				const second = after.board.get(line[1]);
				if (first && second && first.color === oppColor && second.color === oppColor) {
					const vFirst = PIECE_VALUES[first.role];
					const vSecond = PIECE_VALUES[second.role];
					if (vSecond > vFirst || second.role === 'king') found.add('pin');
					if (vFirst > vSecond) found.add('skewer');
				}
			}
		}
	}

	// Back-rank: the move (or subsequent threat) delivers mate-like threats
	// on the back rank. Approximation: mover is a rook or queen that lands
	// on the opponent's back rank with no escape squares for the king.
	if (mover.role === 'rook' || mover.role === 'queen') {
		const backRank = oppColor === 'black' ? 7 : 0;
		if (to >> 3 === backRank) {
			const kingSq = after.board.king.intersect(theirSideAfter).singleSquare();
			if (kingSq !== undefined && kingSq >> 3 === backRank) {
				const escape = kingEscapeSquares(after, kingSq, oppColor);
				if (escape === 0) found.add('back-rank');
			}
		}
	}

	// Discovered check/attack: the mover's departure opens a line from a
	// friendly slider on the from-square's direction to an enemy piece.
	for (const dir of ALL_DIRS) {
		// Scan *backwards* from `from` in direction dir to find a friendly slider.
		const behind = scanLine(after, from, negate(dir));
		if (behind.length === 0) continue;
		const friendly = after.board.get(behind[0]);
		if (!friendly || friendly.color !== mover.color) continue;
		if (!sliderMatches(friendly.role, dir)) continue;
		// Now scan forward from `from` to find an enemy target.
		const forward = scanLine(after, from, dir);
		if (forward.length === 0) continue;
		const enemy = after.board.get(forward[0]);
		if (!enemy || enemy.color !== oppColor) continue;
		if (enemy.role === 'king') found.add('discovered-check');
		else found.add('discovered-attack');
	}

	// Hanging piece: after the move, there's an opponent piece that can be
	// captured for free (no defender, and attacker ≤ target value).
	for (const sq of theirSideAfter) {
		const target = after.board.get(sq);
		if (!target) continue;
		const attackersByUs = computeAttackersOn(after, sq, mover.color);
		const defenders = computeAttackersOn(after, sq, oppColor);
		if (attackersByUs.size() > 0 && defenders.size() === 0 && target.role !== 'king') {
			found.add('hanging-piece');
			break;
		}
	}

	// Double attack: mover attacks two enemy pieces, at least one of which is
	// undefended. Fires independently of the fork rule.
	let undefendedAttacks = 0;
	for (const sq of attackedTargets) {
		const defenders = computeAttackersOn(after, sq, oppColor);
		if (defenders.size() === 0) undefendedAttacks += 1;
	}
	if (undefendedAttacks >= 2) found.add('double-attack');

	return Array.from(found);
}

type Dir = { df: number; dr: number };
const ALL_DIRS: Dir[] = [
	{ df: 1, dr: 0 },
	{ df: -1, dr: 0 },
	{ df: 0, dr: 1 },
	{ df: 0, dr: -1 },
	{ df: 1, dr: 1 },
	{ df: 1, dr: -1 },
	{ df: -1, dr: 1 },
	{ df: -1, dr: -1 }
];

function slideDirs(role: Role): Dir[] {
	if (role === 'bishop') return ALL_DIRS.filter((d) => d.df !== 0 && d.dr !== 0);
	if (role === 'rook') return ALL_DIRS.filter((d) => d.df === 0 || d.dr === 0);
	return ALL_DIRS;
}

function sliderMatches(role: Role, dir: Dir): boolean {
	if (role === 'queen') return true;
	if (role === 'rook') return dir.df === 0 || dir.dr === 0;
	if (role === 'bishop') return dir.df !== 0 && dir.dr !== 0;
	return false;
}

function negate(d: Dir): Dir {
	return { df: -d.df, dr: -d.dr };
}

function scanLine(pos: Position, from: Square, dir: Dir): Square[] {
	const hits: Square[] = [];
	let file = (from & 7) + dir.df;
	let rank = (from >> 3) + dir.dr;
	while (file >= 0 && file <= 7 && rank >= 0 && rank <= 7) {
		const sq = (rank * 8 + file) as Square;
		if (pos.board.occupied.has(sq)) {
			hits.push(sq);
			if (hits.length === 2) return hits;
		}
		file += dir.df;
		rank += dir.dr;
	}
	return hits;
}

function kingEscapeSquares(pos: Position, kingSq: Square, kingColor: Color): number {
	const kingPiece = pos.board.get(kingSq);
	if (!kingPiece) return 0;
	const moves = attacks(kingPiece, kingSq, pos.board.occupied);
	let escape = 0;
	for (const sq of moves) {
		const occ = pos.board.get(sq);
		if (occ && occ.color === kingColor) continue;
		// Is the square still attacked? Cheap check: any enemy piece attacks sq.
		let attacked = false;
		const enemy = kingColor === 'white' ? pos.board.black : pos.board.white;
		for (const enemySq of enemy) {
			const epiece = pos.board.get(enemySq);
			if (!epiece) continue;
			if (attacks(epiece, enemySq, pos.board.occupied).has(sq)) {
				attacked = true;
				break;
			}
		}
		if (!attacked) escape += 1;
	}
	return escape;
}

function computeAttackersOn(pos: Position, sq: Square, byColor: Color): SquareSet {
	let out = SquareSet.empty();
	const side = byColor === 'white' ? pos.board.white : pos.board.black;
	for (const s of side) {
		const p = pos.board.get(s);
		if (!p) continue;
		if (attacks(p, s, pos.board.occupied).has(sq)) out = out.with(s);
	}
	return out;
}
