/**
 * Advisory style-fit scoring for opening moves.
 *
 * Takes the user's DossierFingerprint + OpeningFitSummary and a list of
 * explorer candidates at a given position, and returns a per-move fit
 * score + human-readable reasons. Purely advisory — no mutation, no
 * storage, no re-ranking. Callers decide how to surface it.
 *
 * The fit formula is deliberately simple for v1:
 *
 *   axisFit    = 1 - mean(|moveValue[axis] - userRate[axis]|)  across
 *                {forcing, capture, pawnPlay, queenside}
 *   familyBias = +0.15 when move transitions into a family the user's
 *                OpeningFitSummary flags as a 'fit'; -0.15 for 'misfit'.
 *   popularity = min(1, totalGames/500)  — trust stabiliser, dampens
 *                noisy low-sample lines regardless of style match.
 *   score      = clamp01(0.6 * axisFit + familyBias + 0.2 * popularity)
 *
 * Reasons surface the axes this move aligns with, the family verdict if
 * any, and a small set of behavioural caveats (tension release, forcing
 * rate in losses, clock panic) drawn from the fingerprint's non-axis
 * slices so the user gets both "why this move fits" *and* "watch out."
 */

import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';

import type { Color } from '$lib/types';
import type { ExplorerMove } from '$lib/explorer/client';
import type { DossierFingerprint, AxisRates } from './fingerprint';
import type { OpeningFitSummary, FitRow } from './openingFit';
import { ecoFamily } from './openings';
import type { Phase } from './classify';

export interface StyleAdvice {
	uci: string;
	san: string;
	/** 0..1 — higher = better alignment with the user's fingerprint. */
	fit: number;
	/** Positive signals stack-ranked by strength. */
	reasons: string[];
	/** Negative signals the UI can show as warnings. */
	caveats: string[];
}

const FAMILY_BIAS = 0.15;
const AXIS_WEIGHT = 0.6;
const POPULARITY_WEIGHT = 0.2;
const POPULARITY_FLOOR = 500;

type AxisKey = 'forcing' | 'capture' | 'pawnPlay' | 'queenside';
const AXES: AxisKey[] = ['forcing', 'capture', 'pawnPlay', 'queenside'];

interface MoveAxisVector {
	/** 1 if move is a capture or check. */
	forcing: number;
	/** 1 if move is a capture. */
	capture: number;
	/** 1 if the piece moved is a pawn. */
	pawnPlay: number;
	/** 1 if destination file is a–d. */
	queenside: number;
}

/**
 * Score every candidate move against the user's fingerprint. Missing
 * or malformed inputs fall through safely: candidates whose SAN we
 * can't replay are returned with fit=0 and no reasons.
 */
export function adviseMoves(
	fenBefore: string,
	userColor: Color,
	candidates: ExplorerMove[],
	fp: DossierFingerprint,
	fit: OpeningFitSummary | null
): StyleAdvice[] {
	const phase = detectPhase(fenBefore);
	const phaseAxes = fp.byPhase[phase];
	const overallAxes = fp.overall;
	// Phase-specific axes are noisy below ~40 moves of sample; fall back
	// to overall so the user still gets advice from their first scan.
	const refAxes: AxisRates & { moves: number } = phaseAxes.moves >= 40 ? phaseAxes : overallAxes;

	return candidates.map((m) => adviseOne(fenBefore, userColor, m, refAxes, fp, fit));
}

function adviseOne(
	fenBefore: string,
	userColor: Color,
	m: ExplorerMove,
	refAxes: AxisRates,
	fp: DossierFingerprint,
	fit: OpeningFitSummary | null
): StyleAdvice {
	const delta = moveAxisVector(fenBefore, m.san);
	if (!delta) {
		return { uci: m.uci, san: m.san, fit: 0, reasons: [], caveats: [] };
	}
	const axisFit = axisFitScore(delta, refAxes);
	const famBias = familyBias(m, fit);
	const games = m.white + m.draws + m.black;
	const popularity = Math.min(1, games / POPULARITY_FLOOR);
	const raw = AXIS_WEIGHT * axisFit + famBias + POPULARITY_WEIGHT * popularity;
	const score = clamp01(raw);

	const reasons = explain(delta, refAxes, m, fit);
	const caveats = caveatsFor(delta, fp, userColor);

	return { uci: m.uci, san: m.san, fit: score, reasons, caveats };
}

/**
 * Mean absolute distance between move axis values (0 or 1) and user's
 * typical rate on each axis. Fit = 1 - distance.
 *
 * Geometric intuition: a user who castles at 0.6 rate is "half-castle-ish";
 * a move with forcing=1 vs user.forcing=0.25 is 0.75 away on that axis.
 * Averaging four axes keeps scale stable even if one is skewed.
 */
function axisFitScore(v: MoveAxisVector, ref: AxisRates): number {
	let sum = 0;
	for (const k of AXES) sum += Math.abs(v[k] - ref[k]);
	return 1 - sum / AXES.length;
}

/**
 * +FAMILY_BIAS when the move transitions into a family the user already
 * scores well in; -FAMILY_BIAS for a misfit family; 0 otherwise. Only
 * fires on moves Lichess tagged with an ECO opening (ExplorerMove.opening),
 * so quiet developing moves inside an existing family don't double-dip.
 */
function familyBias(m: ExplorerMove, fit: OpeningFitSummary | null): number {
	if (!m.opening || !fit) return 0;
	const fam = ecoFamily(m.opening.eco);
	const row = fit.rows.find((r) => r.family === fam);
	if (!row) return 0;
	if (row.verdict === 'fit') return FAMILY_BIAS;
	if (row.verdict === 'misfit') return -FAMILY_BIAS;
	return 0;
}

/**
 * Replay SAN on the pre-move FEN and read off the four binary axes.
 * Returns null for anything we can't parse — caller treats that as "no
 * advice" rather than crashing.
 */
function moveAxisVector(fenBefore: string, san: string): MoveAxisVector | null {
	try {
		const setupR = parseFen(fenBefore);
		if (setupR.isErr) return null;
		const posR = Chess.fromSetup(setupR.value);
		if (posR.isErr) return null;
		const pos = posR.value;
		const move = parseSan(pos, san);
		if (!move || !('to' in move) || !('from' in move)) return null;

		const board = pos.board;
		const fromPiece = board.get(move.from);
		if (!fromPiece) return null;
		const toPiece = board.get(move.to);
		const isCapture = toPiece !== undefined;
		const isPawnMove = fromPiece.role === 'pawn';
		const toFile = move.to % 8; // 0 = a, 7 = h
		const queenside = toFile <= 3 ? 1 : 0;

		// Checks: play the move on a clone, see if the resulting position
		// has the side-to-move in check.
		const clone = pos.clone();
		clone.play(move);
		const isCheck = clone.isCheck();

		return {
			forcing: isCapture || isCheck ? 1 : 0,
			capture: isCapture ? 1 : 0,
			pawnPlay: isPawnMove ? 1 : 0,
			queenside
		};
	} catch {
		return null;
	}
}

/**
 * Opening: plies 0–23 (first 12 full moves). Endgame: light total non-pawn
 * material. Matches the thresholds used by classify.ts so fingerprint
 * phases line up with advisory phases.
 */
function detectPhase(fen: string): Phase {
	try {
		const setupR = parseFen(fen);
		if (setupR.isErr) return 'middle';
		const setup = setupR.value;
		const fullmoves = setup.fullmoves;
		const ply = (fullmoves - 1) * 2 + (setup.turn === 'black' ? 1 : 0);
		if (ply < 24) return 'opening';
		const posR = Chess.fromSetup(setup);
		if (posR.isErr) return 'middle';
		const pos = posR.value;
		const npm = nonPawnMaterial(pos);
		if (npm <= 13) return 'end';
		return 'middle';
	} catch {
		return 'middle';
	}
}

function nonPawnMaterial(pos: Chess): number {
	let total = 0;
	for (const sq of pos.board.occupied) {
		const piece = pos.board.get(sq);
		if (!piece) continue;
		if (piece.role === 'pawn' || piece.role === 'king') continue;
		total += VALUES[piece.role as 'knight' | 'bishop' | 'rook' | 'queen'] ?? 0;
	}
	return total;
}

const VALUES: Record<'knight' | 'bishop' | 'rook' | 'queen', number> = {
	knight: 3,
	bishop: 3,
	rook: 5,
	queen: 9
};

/**
 * Surface the axes the move aligns with strongly. Only reports an axis
 * when the user's rate is meaningfully off-neutral (≥ 0.1 from 0.5 for
 * queenside, or notable absolute values for the others) AND the move's
 * binary value is on the same side — that keeps the reasons list free
 * of trivial "forcing=0 matches your 0.3 rate" noise.
 */
function explain(
	v: MoveAxisVector,
	ref: AxisRates,
	m: ExplorerMove,
	fit: OpeningFitSummary | null
): string[] {
	const out: string[] = [];

	if (v.forcing === 1 && ref.forcing >= 0.35)
		out.push(`Forcing move — matches your ${pct(ref.forcing)} forcing rate.`);
	else if (v.forcing === 0 && ref.forcing <= 0.22)
		out.push(`Quiet move — fits your low ${pct(ref.forcing)} forcing rate.`);

	if (v.capture === 1 && ref.capture >= 0.2)
		out.push(`Capture — you reach for exchanges (${pct(ref.capture)}).`);

	if (v.pawnPlay === 1 && ref.pawnPlay >= 0.45)
		out.push(`Pawn move — you lean structural (${pct(ref.pawnPlay)} pawn play).`);
	else if (v.pawnPlay === 0 && ref.pawnPlay <= 0.35)
		out.push(`Piece move — matches your piece-first preference.`);

	if (v.queenside === 1 && ref.queenside >= 0.55)
		out.push(`Queenside target — matches your side-of-board bias.`);
	else if (v.queenside === 0 && ref.queenside <= 0.4)
		out.push(`Kingside target — fits your board bias.`);

	if (m.opening && fit) {
		const fam = ecoFamily(m.opening.eco);
		const row = fit.rows.find((r: FitRow) => r.family === fam);
		if (row?.verdict === 'fit') {
			out.push(`Enters ${fam} — your best family (+${pct(row.winRateDelta)} win rate vs overall).`);
		}
	}

	return out;
}

/**
 * Behavioural warnings derived from the non-axis slices of the
 * fingerprint. Each caveat ties a move property (e.g. "this creates
 * pawn tension") to a known weakness (e.g. "you release tension 80% of
 * the time"). None of these block the move — they just annotate it.
 */
function caveatsFor(v: MoveAxisVector, fp: DossierFingerprint, userColor: Color): string[] {
	const out: string[] = [];

	// Tension-release leak: forcing / capture moves skip a decision point
	// the user typically mishandles. Only flag when the user's release
	// rate is high *and* they've faced enough tensioned positions for the
	// rate to mean anything.
	if (v.forcing === 1 && fp.tension.tensionedMoves >= 20 && fp.tension.releaseRate >= 0.75) {
		out.push(
			`You release tension ${pct(fp.tension.releaseRate)} of the time — forcing moves here may simplify into a weaker structure.`
		);
	}

	// Forcing-in-losses leak: if the user's forcing rate is markedly
	// higher in losses than wins, a forcing move aligns with a losing
	// behavioural pattern.
	const losses = fp.byResult.loss;
	const wins = fp.byResult.win;
	if (
		v.forcing === 1 &&
		losses.moves >= 100 &&
		wins.moves >= 100 &&
		losses.forcing - wins.forcing >= 0.05
	) {
		out.push(
			`Your forcing rate is +${pct(losses.forcing - wins.forcing)} in losses — double-check before committing.`
		);
	}

	// Clock-panic leak: forcing rate spikes under low time.
	const low = fp.byClock.low;
	const high = fp.byClock.high;
	if (
		v.forcing === 1 &&
		low.moves >= 50 &&
		high.moves >= 50 &&
		low.forcing - high.forcing >= 0.08
	) {
		out.push(
			`You play +${pct(low.forcing - high.forcing)} more forcing moves under time pressure — make sure this isn't a reflex.`
		);
	}

	void userColor;
	return out;
}

function pct(r: number): string {
	return `${Math.round(r * 100)}%`;
}

function clamp01(x: number): number {
	if (x < 0) return 0;
	if (x > 1) return 1;
	return x;
}
