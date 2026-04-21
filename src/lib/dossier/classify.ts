/**
 * Per-move feature extraction. Walks a PGN's mainline and emits one
 * MoveFeatures row per *user* move (not opponent). Pure function, no IO.
 *
 * v1 features are deliberately cheap — derivable from board state alone,
 * no engine eval required. The point of v1 is to confirm signal exists in
 * features anyone can compute. v2 will layer in eval-based axes (sac
 * tendency, blunder-by-phase, etc.).
 */

import { parsePgn, parseComment, startingPosition } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import type { Role } from 'chessops/types';
import type { Position } from 'chessops/chess';

import { makeFen } from 'chessops/fen';
import { pawnAttacks } from 'chessops/attacks';
import { SquareSet } from 'chessops/squareSet';

import type { Color } from '$lib/types';
import type { LichessGameMeta } from '$lib/lichess/games';
import { parseEvalComments, type PlyEval } from '$lib/lichess/evalTags';
import { positionDemand, type PositionDemand } from './demand';

export type Phase = 'opening' | 'middle' | 'end';

export interface MoveFeatures {
	ply: number;
	phase: Phase;
	pieceRole: Role;
	isCapture: boolean;
	isCheck: boolean;
	isPawnMove: boolean;
	isCastle: boolean;
	isPromotion: boolean;
	/** 0 = a-file, 7 = h-file. */
	toFile: number;
	/** 0..7. From-square's rank (advancement proxy for the player). */
	fromRank: number;
	toRank: number;
	/** What the position rewarded, computed before the move was played. */
	demand: PositionDemand;
	/** SAN of the move, kept so mismatch positions can surface a label. */
	san: string;
	/** FEN before this move — used to render mismatch positions in the UI. */
	fenBefore: string;
	/** Pawn-pawn contact pairs in the position before the move. */
	tensionBefore: number;
	/** Pairs after the move; difference reveals tension management. */
	tensionAfter: number;
	/**
	 * What the user did with tension this move:
	 *  - released: tension existed and the user captured a pawn that was
	 *    part of a tense pair, lowering tensionBefore → tensionAfter.
	 *  - kept: tension existed and the user neither resolved nor created
	 *    pawn contact (a non-pawn-capture that left the skeleton alone).
	 *  - created: a pawn move that introduced a new tense pair.
	 *  - none: no tension before and none introduced.
	 */
	tensionAction: 'released' | 'kept' | 'created' | 'none';
	/**
	 * User's clock in seconds *after* this move (the value Lichess emits in
	 * the [%clk] tag attached to the move). To bucket "what did they do
	 * with little time remaining" we look at how much was on the clock
	 * when the decision was made — see `clockBucket`. null = no clock data
	 * (correspondence, or PGN without [%clk] tags).
	 */
	clockSecondsAfter: number | null;
	/** Bucket of remaining time post-move: 'low' <10s, 'mid' <60s, 'high' otherwise. */
	clockBucket: 'low' | 'mid' | 'high' | 'none';
	/** Role captured by this move (null if non-capture). Powers trade/piece-affinity analysis. */
	capturedRole: Role | null;
	/** Legal-move count in the position before the user moved. Complexity proxy. */
	legalMovesBefore: number;
	/**
	 * Non-pawn material difference from user's perspective at the *start* of
	 * the move (user minus opponent, in standard piece values). Lets the
	 * exchange/simplification analyses bucket moves by whether the user was
	 * up, down, or equal in material when deciding.
	 */
	materialDiff: number;
	/**
	 * Server-side centipawn eval of the position *before* this move, from
	 * the user's POV. Present only when the game was streamed with
	 * `evals=true` AND Lichess has Fishnet-analysis on file for this ply.
	 * Lets the bulk eval pass skip the local engine for this move.
	 */
	serverEvalBeforeCp?: number;
	/** Companion to `serverEvalBeforeCp` for the position after this move. */
	serverEvalAfterCp?: number;
	/**
	 * True when the server-side eval before this move was a mate score
	 * (or after, respectively). Separated from the CP fields because a
	 * sentinel mate CP like ±100000 should not be mixed with regular
	 * CP arithmetic outside the CP-loss / WP-loss helpers.
	 */
	serverMateBefore?: boolean;
	serverMateAfter?: boolean;
}

export interface ClassifiedGame {
	gameId: string;
	playedAt: number;
	speed: string;
	color: Color;
	opponentRating: number | null;
	userRating: number | null;
	/** Opponent's username — needed to seed self-calibration snowballs. */
	opponentUsername: string | null;
	result: 'win' | 'loss' | 'draw';
	moves: MoveFeatures[];
	totalPlies: number;
	/** ECO code from PGN header, e.g. "B33". null if absent. */
	eco: string | null;
	/** Human opening name from PGN header, e.g. "Sicilian Defense: Najdorf". */
	openingName: string | null;
	/**
	 * Compact material signature at the moment the game first entered the
	 * endgame phase (see `classifyPhase`). Formatted as `userPieces-vs-oppPieces`
	 * using single-letter codes (K Q R B N P), e.g. `KR5P-vs-KR4P` for a
	 * rook-and-pawn endgame. null when the game never reached the endgame.
	 */
	endgameMaterial: string | null;
	/**
	 * High-level endgame family — used by the subtypes page to bucket
	 * conversion rate. null if the game didn't reach an endgame, or if the
	 * material mix doesn't match a recognised family.
	 */
	endgameFamily: EndgameFamily | null;
	/**
	 * Hour of day the game started, in the user's local timezone. 0..23.
	 * Powers the time-of-day tendency page.
	 */
	hourOfDay: number;
	/** Day of week the game started, 0=Sun..6=Sat (user's local tz). */
	dayOfWeek: number;
}

export type EndgameFamily =
	| 'king-pawn'
	| 'rook-pawn'
	| 'rook-endgame'
	| 'minor-pawn'
	| 'opposite-bishops'
	| 'same-bishops'
	| 'knight-pawn'
	| 'queen-endgame'
	| 'queen-vs-rook'
	| 'heavy-pieces'
	| 'mixed';

const NON_PAWN_VALUES: Record<Role, number> = {
	pawn: 0,
	knight: 3,
	bishop: 3,
	rook: 5,
	queen: 9,
	king: 0
};

function nonPawnMaterial(pos: Position): number {
	let total = 0;
	for (const sq of pos.board.occupied) {
		const piece = pos.board.get(sq);
		if (!piece) continue;
		total += NON_PAWN_VALUES[piece.role];
	}
	return total;
}

function classifyPhase(ply: number, pos: Position): Phase {
	// Opening: first ~12 full moves.
	if (ply < 24) return 'opening';
	// Endgame: low non-pawn material across both sides (≤ 13 ≈ Q vs R+R or similar).
	const npm = nonPawnMaterial(pos);
	if (npm <= 13) return 'end';
	return 'middle';
}

/**
 * Classify one game's user-side moves. Returns null if the user isn't a
 * player or the PGN is unparseable.
 */
export function classifyGame(game: LichessGameMeta, username: string): ClassifiedGame | null {
	if (!game.pgn) return null;
	const lower = username.toLowerCase();
	const userIsWhite = (game.players.white.user?.name ?? '').toLowerCase() === lower;
	const userIsBlack = (game.players.black.user?.name ?? '').toLowerCase() === lower;
	if (!userIsWhite && !userIsBlack) return null;
	const userColor: Color = userIsWhite ? 'white' : 'black';

	const parsed = parsePgn(game.pgn);
	if (parsed.length === 0) return null;
	const pgn = parsed[0];
	const startR = startingPosition(pgn.headers);
	if (startR.isErr) return null;
	const pos = startR.value;

	// Pre-parse any `[%eval ...]` PGN comments. The returned array is
	// ply-indexed: entry `k` is the eval of the position AFTER ply k. For
	// a user move at ply `p`, "eval before" = entry at p-1 (or startpos =
	// 0 cp when p === 0), "eval after" = entry at p. Missing entries are
	// null and the downstream eval pass falls back to local Stockfish.
	const serverEvals = parseEvalComments(game.pgn);
	const hasAnyServerEvals = serverEvals.some((e) => e != null);

	const moves: MoveFeatures[] = [];
	let ply = 0;
	let endgameMaterial: string | null = null;
	let endgameFamily: EndgameFamily | null = null;

	for (const node of pgn.moves.mainline()) {
		const move = parseSan(pos, node.san);
		if (!move) break;
		const isUserTurn = pos.turn === userColor;

		if (isUserTurn) {
			const feat = featuresForMove(
				pos,
				node.san,
				move,
				ply,
				extractClockSeconds(node.comments),
				userColor
			);
			if (feat) {
				if (hasAnyServerEvals) {
					attachServerEvals(feat, serverEvals, ply, userColor);
				}
				moves.push(feat);
				if (feat.phase === 'end' && endgameMaterial === null) {
					endgameMaterial = materialSignature(pos, userColor);
					endgameFamily = materialFamily(pos);
				}
			}
		}

		pos.play(move);
		ply += 1;
	}

	const userRating = userIsWhite ? game.players.white.rating : game.players.black.rating;
	const opponentRating = userIsWhite ? game.players.black.rating : game.players.white.rating;
	const opponentUsername = userIsWhite
		? (game.players.black.user?.name ?? null)
		: (game.players.white.user?.name ?? null);
	const result: 'win' | 'loss' | 'draw' = !game.winner
		? 'draw'
		: game.winner === userColor
			? 'win'
			: 'loss';

	const d = new Date(game.createdAt);
	return {
		gameId: game.id,
		playedAt: game.createdAt,
		speed: game.speed,
		color: userColor,
		userRating: userRating ?? null,
		opponentRating: opponentRating ?? null,
		opponentUsername,
		result,
		moves,
		totalPlies: ply,
		eco: pgn.headers.get('ECO') ?? null,
		openingName: pgn.headers.get('Opening') ?? null,
		endgameMaterial,
		endgameFamily,
		hourOfDay: d.getHours(),
		dayOfWeek: d.getDay()
	};
}

function featuresForMove(
	posBefore: Position,
	san: string,
	move: ReturnType<typeof parseSan>,
	ply: number,
	clockSecondsAfter: number | null,
	userColor: Color
): MoveFeatures | null {
	if (!move || !('from' in move)) return null; // only normal moves (no drops in standard chess)
	const piece = posBefore.board.get(move.from);
	if (!piece) return null;

	const target = posBefore.board.get(move.to);
	const isEnPassant = piece.role === 'pawn' && move.to === posBefore.epSquare && !target;
	const isCapture = !!target || isEnPassant;
	const isCastle = san.startsWith('O-O');
	const isPromotion = !!move.promotion;
	const capturedRole: Role | null = target?.role ?? (isEnPassant ? 'pawn' : null);

	// Cheap check detection: clone, play, ask isCheck. Avoids reconstructing
	// attack tables manually.
	const after = posBefore.clone();
	after.play(move);
	const isCheck = after.isCheck();

	const phase = classifyPhase(ply, posBefore);
	const demand = positionDemand(posBefore);
	const fenBefore = makeFen(posBefore.toSetup());

	const tensionBefore = countPawnTension(posBefore);
	const tensionAfter = countPawnTension(after);
	const tensionAction = classifyTension({
		tensionBefore,
		tensionAfter,
		isCapture,
		isPawnMove: piece.role === 'pawn',
		capturedRole
	});

	const legalMovesBefore = countLegalMoves(posBefore);
	const materialDiff = nonPawnMaterialDiff(posBefore, userColor);

	return {
		ply,
		phase,
		pieceRole: piece.role,
		isCapture,
		isCheck,
		isPawnMove: piece.role === 'pawn',
		isCastle,
		isPromotion,
		toFile: move.to & 7,
		fromRank: move.from >> 3,
		toRank: move.to >> 3,
		demand,
		san,
		fenBefore,
		tensionBefore,
		tensionAfter,
		tensionAction,
		clockSecondsAfter,
		clockBucket: bucketClock(clockSecondsAfter),
		capturedRole,
		legalMovesBefore,
		materialDiff
	};
}

/**
 * Enumerate legal moves via `allDests()`. Cheap enough to run per user move
 * because chessops precomputes attack tables once per position.
 */
function countLegalMoves(pos: Position): number {
	let count = 0;
	const dests = pos.allDests();
	for (const [, targets] of dests) {
		count += targets.size();
	}
	return count;
}

function nonPawnMaterialDiff(pos: Position, userColor: Color): number {
	let diff = 0;
	for (const sq of pos.board.occupied) {
		const piece = pos.board.get(sq);
		if (!piece || piece.role === 'pawn' || piece.role === 'king') continue;
		const val = NON_PAWN_VALUES[piece.role];
		diff += piece.color === userColor ? val : -val;
	}
	return diff;
}

/** Compact "KR5P-vs-KR4P"-style tag from user's perspective. */
function materialSignature(pos: Position, userColor: Color): string {
	const order: Role[] = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
	const codes: Record<Role, string> = {
		king: 'K',
		queen: 'Q',
		rook: 'R',
		bishop: 'B',
		knight: 'N',
		pawn: 'P'
	};
	const counts = (color: Color) => {
		const c: Record<Role, number> = {
			king: 0,
			queen: 0,
			rook: 0,
			bishop: 0,
			knight: 0,
			pawn: 0
		};
		for (const sq of pos.board.occupied) {
			const p = pos.board.get(sq);
			if (!p || p.color !== color) continue;
			c[p.role] += 1;
		}
		return c;
	};
	const render = (c: Record<Role, number>) =>
		order.map((r) => (c[r] > 0 ? (c[r] === 1 ? codes[r] : `${c[r]}${codes[r]}`) : '')).join('');
	const userSide = render(counts(userColor));
	const oppColor: Color = userColor === 'white' ? 'black' : 'white';
	const oppSide = render(counts(oppColor));
	return `${userSide}-vs-${oppSide}`;
}

const LIGHT_SQUARES = SquareSet.lightSquares();

function materialFamily(pos: Position): EndgameFamily {
	const roles = (color: Color): Record<Role, number> => {
		const c: Record<Role, number> = {
			king: 0,
			queen: 0,
			rook: 0,
			bishop: 0,
			knight: 0,
			pawn: 0
		};
		for (const sq of pos.board.occupied) {
			const p = pos.board.get(sq);
			if (!p || p.color !== color) continue;
			c[p.role] += 1;
		}
		return c;
	};
	const w = roles('white');
	const b = roles('black');
	const total = (r: Role) => w[r] + b[r];
	const majors = total('queen') + total('rook');
	const minors = total('bishop') + total('knight');

	if (total('queen') === 0 && total('rook') === 0 && minors === 0) return 'king-pawn';
	if (total('queen') === 0 && total('rook') === 2 && minors === 0) return 'rook-pawn';
	if (
		total('queen') === 0 &&
		total('rook') === 0 &&
		total('bishop') === 2 &&
		total('knight') === 0
	) {
		// Determine square color to distinguish OCB from same-color.
		let lightBishops = 0;
		let darkBishops = 0;
		for (const sq of pos.board.bishop) {
			if (LIGHT_SQUARES.has(sq)) lightBishops += 1;
			else darkBishops += 1;
		}
		if (lightBishops === 1 && darkBishops === 1) return 'opposite-bishops';
		return 'same-bishops';
	}
	if (total('queen') === 0 && total('rook') === 0 && total('knight') >= 1 && total('bishop') === 0)
		return 'knight-pawn';
	if (total('queen') === 0 && total('rook') >= 1 && minors === 0) return 'rook-endgame';
	if (total('queen') === 0 && total('rook') === 0 && minors <= 2) return 'minor-pawn';
	if (total('queen') >= 1 && total('rook') === 0 && minors === 0) return 'queen-endgame';
	if (
		total('queen') + total('rook') >= 1 &&
		Math.abs(total('queen') - total('rook')) >= 1 &&
		minors === 0
	)
		return 'queen-vs-rook';
	if (majors >= 1 && minors === 0) return 'heavy-pieces';
	return 'mixed';
}

/**
 * Mate-score sentinel used by the evalAxes pass — matches the engine
 * module's own MATE_CP convention (±1500). Keeping the two in sync means
 * adopted mate evals land in the same CP-loss / WP-loss buckets as
 * locally-computed mate evals.
 */
const SERVER_MATE_SENTINEL_CP = 1500;

function plyEvalToUserCp(plyEval: PlyEval, userColor: Color): { cp: number; mate: boolean } {
	const sign = userColor === 'white' ? 1 : -1;
	if (plyEval.mate !== undefined) {
		const cp = plyEval.mate > 0 ? SERVER_MATE_SENTINEL_CP : -SERVER_MATE_SENTINEL_CP;
		return { cp: cp * sign, mate: true };
	}
	return { cp: (plyEval.cp ?? 0) * sign, mate: false };
}

/**
 * Join server-side PGN `%eval` tags onto a user MoveFeatures row.
 *
 * "Eval before" lives at index `ply - 1` (opponent's previous ply's
 * resulting position). When the user plays the very first move of the
 * game, the startpos has no tag; we treat it as cp=0, which is accurate
 * for the standard starting position and lets downstream CP-loss
 * arithmetic behave uniformly.
 *
 * "Eval after" lives at index `ply` (the user's own move's resulting
 * position). If absent, we skip attachment so the eval pass falls back
 * to the local engine for this specific move.
 */
function attachServerEvals(
	feat: MoveFeatures,
	serverEvals: Array<PlyEval | null>,
	ply: number,
	userColor: Color
) {
	const after = serverEvals[ply];
	if (!after) return;

	let beforeCp = 0;
	let mateBefore = false;
	if (ply !== 0) {
		const before = serverEvals[ply - 1];
		if (!before) return;
		const b = plyEvalToUserCp(before, userColor);
		beforeCp = b.cp;
		mateBefore = b.mate;
	}

	const a = plyEvalToUserCp(after, userColor);
	feat.serverEvalBeforeCp = beforeCp;
	feat.serverEvalAfterCp = a.cp;
	feat.serverMateBefore = mateBefore;
	feat.serverMateAfter = a.mate;
}

/**
 * Extract remaining clock (seconds) from PGN move comments. Lichess and
 * chess.com both write `{ [%clk H:MM:SS] }` comments per move when clock
 * data is enabled. Returns null if no `[%clk]` tag is present.
 */
function extractClockSeconds(comments: string[] | undefined): number | null {
	if (!comments || comments.length === 0) return null;
	for (const c of comments) {
		const parsed = parseComment(c);
		if (parsed.clock !== undefined) return parsed.clock;
	}
	return null;
}

function bucketClock(seconds: number | null): 'low' | 'mid' | 'high' | 'none' {
	if (seconds == null) return 'none';
	if (seconds < 10) return 'low';
	if (seconds < 60) return 'mid';
	return 'high';
}

/**
 * Count tense pawn pairs: ordered pairs (whitePawn, blackPawn) where
 * the white pawn attacks the black pawn (which is symmetric — if W
 * attacks B, B also attacks W). One pair per attacking pawn → square,
 * so a single pawn attacking two enemy pawns counts as two.
 */
function countPawnTension(pos: Position): number {
	const whitePawns = pos.board.pawn.intersect(pos.board.white);
	const blackPawns = pos.board.pawn.intersect(pos.board.black);
	let pairs = 0;
	for (const sq of whitePawns) {
		pairs += pawnAttacks('white', sq).intersect(blackPawns).size();
	}
	return pairs;
}

function classifyTension(args: {
	tensionBefore: number;
	tensionAfter: number;
	isCapture: boolean;
	isPawnMove: boolean;
	capturedRole: 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'king' | null;
}): 'released' | 'kept' | 'created' | 'none' {
	const { tensionBefore, tensionAfter, isCapture, isPawnMove, capturedRole } = args;
	if (tensionBefore === 0 && tensionAfter > tensionBefore) return 'created';
	if (tensionBefore > 0 && isCapture && capturedRole === 'pawn' && isPawnMove) return 'released';
	if (tensionBefore > 0 && tensionAfter < tensionBefore) return 'released';
	if (tensionBefore > 0) return 'kept';
	return 'none';
}
