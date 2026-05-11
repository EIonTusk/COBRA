/**
 * Aggregate a set of master-game continuation lines from a shared base
 * position into structured stats: which next moves are most common, where
 * pawns advance (the candidate breaks), where each non-pawn piece tends
 * to end up (rerouting), and how often each side castles short or long.
 *
 * Pure: no IO, no engine, no fetch. The caller is expected to have already
 * fetched and parsed PGNs into UCI move lists. Pieces are identified by
 * their starting square in the base position, so "the c1-bishop reroutes
 * to b2" is captured even when it takes two moves to get there.
 */
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { makeSanAndPlay } from 'chessops/san';
import { parseSquare } from 'chessops/util';
import type { Color, Move, Role, Square } from 'chessops';

import { squareToKey } from '$lib/chess/position';

export interface NextMoveStat {
	san: string;
	uci: string;
	count: number;
}

export interface PawnMoveStat {
	color: Color;
	san: string;
	from: string;
	to: string;
	isCapture: boolean;
	count: number;
}

export interface PieceJourneyStat {
	color: Color;
	role: Role;
	from: string;
	/** Final square at end of window, or 'captured' if the piece was taken. */
	to: string | 'captured';
	count: number;
}

export interface CastlingCounts {
	white: { short: number; long: number };
	black: { short: number; long: number };
}

/**
 * Per-square pressure from one side. `count` is number of master lines
 * (not plies) in which the attacker's pieces landed on this square inside
 * the window — capping repetition within a single line keeps a flailing
 * back-and-forth from drowning out a stable outpost.
 */
export interface AttackSquareStat {
	square: string;
	attacker: Color;
	count: number;
	/** Lines where landing on this square was a capture (true subset of count). */
	captureCount: number;
}

export interface MiddlegameAggregate {
	totalLines: number;
	pliesWindow: number;
	topNextMoves: NextMoveStat[];
	pawnMoves: PawnMoveStat[];
	pieceJourneys: PieceJourneyStat[];
	castling: CastlingCounts;
	/** Squares an attacker frequently lands on. Sorted by count desc. */
	attackSquares: AttackSquareStat[];
}

export interface AggregateOptions {
	/** How many plies forward to walk in each line. Default 12. */
	maxPlies?: number;
}

/**
 * Walk each line forward up to `maxPlies` plies from `baseFen` and tally
 * stats. Lines with illegal moves are skipped silently — master DB data
 * occasionally has odd entries, and one bad line shouldn't poison the
 * whole aggregate.
 */
export function aggregateLines(
	baseFen: string,
	lines: string[][],
	options: AggregateOptions = {}
): MiddlegameAggregate {
	const maxPlies = options.maxPlies ?? 12;

	const baseSetup = parseFen(baseFen).unwrap();
	const baseChess = Chess.fromSetup(baseSetup).unwrap();

	const nextMove = new Map<string, NextMoveStat>();
	const pawnAgg = new Map<string, PawnMoveStat>();
	const pieceAgg = new Map<string, PieceJourneyStat>();
	const castling: CastlingCounts = {
		white: { short: 0, long: 0 },
		black: { short: 0, long: 0 }
	};
	const attackAgg = new Map<string, AttackSquareStat>();

	let kept = 0;

	for (const line of lines) {
		const sub = walkLine(baseChess, line, maxPlies);
		if (!sub) continue;
		kept++;

		if (sub.firstMove) {
			const key = sub.firstMove.uci;
			const existing = nextMove.get(key);
			if (existing) existing.count++;
			else nextMove.set(key, { ...sub.firstMove, count: 1 });
		}

		// Per-line dedup of attack squares: a pendulum (Nf3-h4-f3-h4…) inside
		// a single game shouldn't be counted four times. We tally the line
		// once per (attacker, square), and separately record whether any of
		// those landings were captures.
		const seen = new Map<string, { attacker: Color; square: string; capture: boolean }>();

		for (const m of sub.moves) {
			if (m.role === 'pawn') {
				const k = `${m.color}|${m.from}|${m.to}|${m.isCapture ? 'x' : ''}`;
				const cur = pawnAgg.get(k);
				if (cur) cur.count++;
				else
					pawnAgg.set(k, {
						color: m.color,
						san: m.san,
						from: m.from,
						to: m.to,
						isCapture: m.isCapture,
						count: 1
					});
			}
			if (m.castle) {
				castling[m.color][m.castle]++;
			}
			// Castling's "destination" in chessops's encoding is the rook
			// square — not meaningful as an attack square. Skip it.
			if (!m.castle) {
				const sk = `${m.color}|${m.to}`;
				const prev = seen.get(sk);
				if (!prev) seen.set(sk, { attacker: m.color, square: m.to, capture: m.isCapture });
				else if (m.isCapture) prev.capture = true;
			}
		}

		for (const v of seen.values()) {
			const k = `${v.attacker}|${v.square}`;
			const cur = attackAgg.get(k);
			if (cur) {
				cur.count++;
				if (v.capture) cur.captureCount++;
			} else {
				attackAgg.set(k, {
					square: v.square,
					attacker: v.attacker,
					count: 1,
					captureCount: v.capture ? 1 : 0
				});
			}
		}

		for (const j of sub.journeys) {
			const k = `${j.color}|${j.role}|${j.from}|${j.to}`;
			const cur = pieceAgg.get(k);
			if (cur) cur.count++;
			else pieceAgg.set(k, { ...j, count: 1 });
		}
	}

	return {
		totalLines: kept,
		pliesWindow: maxPlies,
		topNextMoves: [...nextMove.values()].sort((a, b) => b.count - a.count),
		pawnMoves: [...pawnAgg.values()].sort((a, b) => b.count - a.count),
		pieceJourneys: [...pieceAgg.values()].sort((a, b) => b.count - a.count),
		castling,
		attackSquares: [...attackAgg.values()].sort((a, b) => b.count - a.count)
	};
}

export interface WalkedMove {
	color: Color;
	role: Role;
	san: string;
	from: string;
	to: string;
	isCapture: boolean;
	castle?: 'short' | 'long';
}

export interface JourneyEnd {
	color: Color;
	role: Role;
	from: string;
	to: string | 'captured';
}

export interface WalkedLine {
	firstMove: { san: string; uci: string } | null;
	moves: WalkedMove[];
	journeys: JourneyEnd[];
}

/**
 * Public wrapper around the internal `walkLine` so consumers outside
 * the aggregator (notably the plan-adherence scorer) can walk a
 * continuation from a FEN without setting up a chessops `Chess` themselves.
 *
 * Returns null if the line contains an illegal move (the same defensive
 * behaviour `walkLine` already had — one bad UCI shouldn't poison the
 * caller's batch).
 */
export function walkContinuation(
	baseFen: string,
	line: string[],
	maxPlies = 12
): WalkedLine | null {
	const setup = parseFen(baseFen).unwrap();
	const chess = Chess.fromSetup(setup).unwrap();
	return walkLine(chess, line, maxPlies);
}

function walkLine(baseChess: Chess, line: string[], maxPlies: number): WalkedLine | null {
	const pos = baseChess.clone();

	// Track each non-pawn piece by **current** square so `tracked.get(from)`
	// finds the right piece on every move, even after multi-move reroutes.
	// Each track preserves its `startSquareKey` so we can report "g1 → h4"
	// at the end of the window. Pawns are excluded — rerouting isn't a
	// useful concept for them; pawn moves are aggregated separately.
	interface Track {
		color: Color;
		role: Role;
		startSquareKey: string;
	}
	const tracked = new Map<Square, Track>();
	const captured: Track[] = [];
	for (const sq of pos.board.occupied) {
		const piece = pos.board.get(sq);
		if (!piece || piece.role === 'pawn') continue;
		tracked.set(sq, {
			color: piece.color,
			role: piece.role,
			startSquareKey: squareToKey(sq)
		});
	}

	const moves: WalkedMove[] = [];
	let firstMove: { san: string; uci: string } | null = null;

	const limit = Math.min(line.length, maxPlies);
	for (let i = 0; i < limit; i++) {
		const uci = line[i];
		if (!uci || uci.length < 4) return null;

		const from = parseSquare(uci.slice(0, 2));
		const to = parseSquare(uci.slice(2, 4));
		if (from === undefined || to === undefined) return null;

		const promotion = uci.length > 4 ? promoRole(uci[4]) : undefined;
		const move: Move = { from, to, promotion };
		if (!pos.isLegal(move)) return null;

		const piece = pos.board.get(from);
		if (!piece) return null;
		const color = piece.color;
		const role = piece.role;

		const directVictim = pos.board.get(to);
		// En passant: pawn moves diagonally to an empty square.
		const isEnPassant = role === 'pawn' && (from & 7) !== (to & 7) && directVictim === undefined;
		const isCapture = directVictim !== undefined || isEnPassant;

		// Castling, in chessops's Chess960-style encoding, is king→own-rook.
		let castle: 'short' | 'long' | undefined;
		if (role === 'king' && directVictim?.role === 'rook' && directVictim.color === color) {
			const toFile = to & 7;
			castle = toFile === 7 ? 'short' : toFile === 0 ? 'long' : undefined;
		}

		// SAN must be computed before play; clone so chessops doesn't mutate `pos`.
		const san = makeSanAndPlay(pos.clone(), move);

		// Update piece tracking *before* playing the move so `tracked` and
		// the position stay in lockstep. Capture: remove the victim's track.
		if (castle === undefined && directVictim) {
			const victimTrack = tracked.get(to);
			if (victimTrack) {
				captured.push(victimTrack);
				tracked.delete(to);
			}
		}
		// Move the active piece: re-key from `from` to its new square.
		const activeTrack = tracked.get(from);
		const newSq: Square = castle ? ((castle === 'short' ? from + 2 : from - 2) as Square) : to;
		if (activeTrack) {
			tracked.delete(from);
			tracked.set(newSq, activeTrack);
		}
		// Castling also relocates the rook (from `to` → newRookSq), but for
		// journey purposes it's already the right type/colour and keeping
		// it in `tracked` would clobber the king we just placed there in
		// king-on-h1 layouts. The rook tracker is dropped silently — we
		// don't currently report rook journeys with castling-aware finals,
		// and master-game aggregation isn't sensitive enough for that
		// distinction to matter for an opening guide.
		if (castle) {
			tracked.delete(to);
		}

		pos.play(move);

		if (i === 0) firstMove = { san, uci };

		moves.push({
			color,
			role,
			san,
			from: squareToKey(from),
			to: squareToKey(newSq),
			isCapture,
			castle
		});
	}

	const journeys: JourneyEnd[] = [];
	for (const [sq, t] of tracked) {
		journeys.push({
			color: t.color,
			role: t.role,
			from: t.startSquareKey,
			to: squareToKey(sq)
		});
	}
	for (const t of captured) {
		journeys.push({
			color: t.color,
			role: t.role,
			from: t.startSquareKey,
			to: 'captured'
		});
	}

	return { firstMove, moves, journeys };
}

function promoRole(c: string): Role | undefined {
	switch (c) {
		case 'q':
			return 'queen';
		case 'r':
			return 'rook';
		case 'b':
			return 'bishop';
		case 'n':
			return 'knight';
		default:
			return undefined;
	}
}
