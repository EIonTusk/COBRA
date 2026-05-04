/**
 * Space Control: per-square attacker-count heatmaps comparing the user's
 * footprint to opponents' footprint **when both are playing the same
 * colour**.
 *
 * The naive comparison (user's army vs opponent's army at the same
 * position) just measures the position's natural asymmetry — white attacks
 * the lower ranks, black attacks the upper ranks. That tells us nothing
 * about the user's style. The like-for-like comparison instead asks: "when
 * the user plays white, how does their white army deploy compared to how
 * opponents deploy *their* white army?" — sampled from the user's black
 * games where the opponent is white.
 *
 * One sample per `fenBefore` (positions where it was the user's turn):
 *   - user-as-white footprint ← white-army attackers from user-as-white games
 *   - opp-as-white footprint  ← white-army attackers from user-as-black games
 *   - user-as-black footprint ← black-army attackers from user-as-black games
 *   - opp-as-black footprint  ← black-army attackers from user-as-white games
 *
 * Each colour comparison is also bucketed by game phase (opening / middle
 * / end, using the phase already attached to every classified user move).
 * The phase split surfaces middlegame patterns that the all-phase aggregate
 * dilutes — opening footprints are dominated by your repertoire, endgames
 * by what material is left.
 *
 * Per-colour perspectives are returned independently. All arrays are
 * indexed in canonical chess-board coordinates (a1=0 .. h8=63). The
 * display layer is responsible for orientation — the same data renders
 * white-perspective for the white footprint and 180°-rotated for the
 * black footprint, with coordinate labels flipped to match.
 *
 * Caveat: opp-as-white samples are taken at "black-to-move" positions
 * (your black games) while user-as-white samples are at "white-to-move"
 * positions, so there is a half-tempo offset between the two pools.
 * Position distributions also differ — your 1.d4 white games reach
 * different structures than your opponents' 1.e4 white games when you
 * face them as black. Both effects are noted in the page methodology.
 */

import { parseFen } from 'chessops/fen';
import { Chess } from 'chessops/chess';
import { attacks } from 'chessops/attacks';
import type { Position } from 'chessops/chess';
import type { Color, Square } from 'chessops/types';

import type { ClassifiedGame, Phase } from './classify';

export interface SpaceControlSquare {
	/** 0..1 — fraction of sampled positions where this side has strictly
	 *  more attackers on the square than its in-game opponent. */
	controls: number;
	/** Mean attacker count for this side, averaged over sampled positions. */
	avgAttackers: number;
}

export interface SpaceControlSide {
	/** Length-64 array indexed in canonical chessops layout (a1=0 .. h8=63).
	 *  Display orientation is the visualiser's responsibility. */
	squares: SpaceControlSquare[];
	samples: number;
}

export interface SpaceControlSlice {
	user: SpaceControlSide;
	opponent: SpaceControlSide;
	/** Per-square `user.controls − opponent.controls`. Range −1..+1. */
	diff: number[];
	/** Per-square `user.avgAttackers − opponent.avgAttackers`. */
	diffAvgAttackers: number[];
}

export interface SpaceControlPerspective extends SpaceControlSlice {
	/** Same comparison split by game phase. A bucket is null when either
	 *  the user or opponent pool drops below MIN_PER_PHASE samples in that
	 *  phase. */
	byPhase: Record<Phase, SpaceControlSlice | null>;
}

export interface SpaceControlReport {
	/** "When you play white" comparison. null if either side has < MIN_PER_COLOR samples. */
	white: SpaceControlPerspective | null;
	/** "When you play black" comparison. null if either side has < MIN_PER_COLOR samples. */
	black: SpaceControlPerspective | null;
	totalPositions: number;
	/** Games that contributed at least one parseable position. */
	games: number;
}

const MIN_TOTAL = 50;
const MIN_PER_COLOR = 25;
const MIN_PER_PHASE = 15;
const PHASES: Phase[] = ['opening', 'middle', 'end'];

interface SideAcc {
	sum: Float64Array;
	controlled: Float64Array;
	samples: number;
}

interface PhaseAcc {
	opening: SideAcc;
	middle: SideAcc;
	end: SideAcc;
}

function makeAcc(): SideAcc {
	return { sum: new Float64Array(64), controlled: new Float64Array(64), samples: 0 };
}

function makePhaseAcc(): PhaseAcc {
	return { opening: makeAcc(), middle: makeAcc(), end: makeAcc() };
}

export interface BuildSpaceControlOpts {
	/**
	 * Optional pool of games to use for the *opponent* footprint instead of
	 * the in-scan opposite-colour user games. Each comparison game contributes
	 * to the colour matching `g.color` (its "user" colour after classifyGame).
	 * Used for the masters overlay: pass a `ClassifiedGame[]` of masters
	 * playing each colour and the diff becomes "you vs masters" rather than
	 * "you vs your peers".
	 */
	comparison?: ClassifiedGame[];
}

export function buildSpaceControl(
	games: ClassifiedGame[],
	opts: BuildSpaceControlOpts = {}
): SpaceControlReport | null {
	const userWhite = makePhaseAcc();
	const oppBlack = makePhaseAcc();
	const userBlack = makePhaseAcc();
	const oppWhite = makePhaseAcc();

	let totalSamples = 0;
	let contributing = 0;
	const useExternalComparison = !!opts.comparison;

	for (const g of games) {
		let gContrib = 0;
		for (const m of g.moves) {
			const setupR = parseFen(m.fenBefore);
			if (setupR.isErr) continue;
			const posR = Chess.fromSetup(setupR.value);
			if (posR.isErr) continue;
			const pos = posR.value;

			const wCounts = attackerCounts(pos, 'white');
			const bCounts = attackerCounts(pos, 'black');

			if (g.color === 'white') {
				accumulate(userWhite[m.phase], wCounts, bCounts);
				if (!useExternalComparison) accumulate(oppBlack[m.phase], bCounts, wCounts);
			} else {
				accumulate(userBlack[m.phase], bCounts, wCounts);
				if (!useExternalComparison) accumulate(oppWhite[m.phase], wCounts, bCounts);
			}
			totalSamples += 1;
			gContrib += 1;
		}
		if (gContrib > 0) contributing += 1;
	}

	if (opts.comparison) {
		for (const g of opts.comparison) {
			for (const m of g.moves) {
				const setupR = parseFen(m.fenBefore);
				if (setupR.isErr) continue;
				const posR = Chess.fromSetup(setupR.value);
				if (posR.isErr) continue;
				const pos = posR.value;

				const wCounts = attackerCounts(pos, 'white');
				const bCounts = attackerCounts(pos, 'black');

				// Comparison game's "user" colour matches the opp side we want.
				if (g.color === 'white') {
					accumulate(oppWhite[m.phase], wCounts, bCounts);
				} else {
					accumulate(oppBlack[m.phase], bCounts, wCounts);
				}
			}
		}
	}

	if (totalSamples < MIN_TOTAL) return null;

	const userWhiteAll = mergePhases(userWhite);
	const oppWhiteAll = mergePhases(oppWhite);
	const userBlackAll = mergePhases(userBlack);
	const oppBlackAll = mergePhases(oppBlack);

	const white =
		userWhiteAll.samples >= MIN_PER_COLOR && oppWhiteAll.samples >= MIN_PER_COLOR
			? buildPerspective(userWhiteAll, oppWhiteAll, userWhite, oppWhite)
			: null;
	const black =
		userBlackAll.samples >= MIN_PER_COLOR && oppBlackAll.samples >= MIN_PER_COLOR
			? buildPerspective(userBlackAll, oppBlackAll, userBlack, oppBlack)
			: null;

	if (!white && !black) return null;

	return { white, black, totalPositions: totalSamples, games: contributing };
}

function accumulate(agg: SideAcc, myCounts: Uint8Array, oppCounts: Uint8Array): void {
	for (let sq = 0; sq < 64; sq++) {
		agg.sum[sq] += myCounts[sq];
		if (myCounts[sq] > oppCounts[sq]) agg.controlled[sq] += 1;
	}
	agg.samples += 1;
}

function mergePhases(p: PhaseAcc): SideAcc {
	const out = makeAcc();
	for (const phase of PHASES) {
		const a = p[phase];
		for (let sq = 0; sq < 64; sq++) {
			out.sum[sq] += a.sum[sq];
			out.controlled[sq] += a.controlled[sq];
		}
		out.samples += a.samples;
	}
	return out;
}

function buildPerspective(
	user: SideAcc,
	opp: SideAcc,
	userPhase: PhaseAcc,
	oppPhase: PhaseAcc
): SpaceControlPerspective {
	const overall = buildSlice(user, opp);
	const byPhase: Record<Phase, SpaceControlSlice | null> = {
		opening: null,
		middle: null,
		end: null
	};
	for (const phase of PHASES) {
		const u = userPhase[phase];
		const o = oppPhase[phase];
		if (u.samples >= MIN_PER_PHASE && o.samples >= MIN_PER_PHASE) {
			byPhase[phase] = buildSlice(u, o);
		}
	}
	return { ...overall, byPhase };
}

function buildSlice(user: SideAcc, opp: SideAcc): SpaceControlSlice {
	const userSquares: SpaceControlSquare[] = new Array(64);
	const oppSquares: SpaceControlSquare[] = new Array(64);
	const diff = new Array<number>(64);
	const diffAvg = new Array<number>(64);
	for (let sq = 0; sq < 64; sq++) {
		const u: SpaceControlSquare = {
			controls: user.controlled[sq] / user.samples,
			avgAttackers: user.sum[sq] / user.samples
		};
		const o: SpaceControlSquare = {
			controls: opp.controlled[sq] / opp.samples,
			avgAttackers: opp.sum[sq] / opp.samples
		};
		userSquares[sq] = u;
		oppSquares[sq] = o;
		diff[sq] = u.controls - o.controls;
		diffAvg[sq] = u.avgAttackers - o.avgAttackers;
	}
	return {
		user: { squares: userSquares, samples: user.samples },
		opponent: { squares: oppSquares, samples: opp.samples },
		diff,
		diffAvgAttackers: diffAvg
	};
}

function attackerCounts(pos: Position, side: Color): Uint8Array {
	const counts = new Uint8Array(64);
	const pieces = pos.board[side];
	const occupied = pos.board.occupied;
	for (const sq of pieces) {
		const piece = pos.board.get(sq);
		if (!piece) continue;
		const atk = attacks(piece, sq as Square, occupied);
		for (const t of atk) counts[t] += 1;
	}
	return counts;
}
