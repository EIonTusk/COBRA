/**
 * Eval-based style axes. Runs the local Stockfish engine across every
 * user move in a chosen sample of games, then aggregates centipawn-loss
 * derived metrics that the board-only v1 axes can't see:
 *
 *  - **avgCpLoss**: mean CP loss across all analysed user moves.
 *    Headline skill measure; lower is better.
 *  - **blunderRate**: fraction of moves losing ≥ 200cp vs the engine's
 *    best move at the same depth.
 *  - **inaccuracyRate**: fraction losing 50–200cp.
 *  - **sacTendency**: fraction of moves where the user lost material
 *    on the move (capture target lower-valued than capturing piece, or
 *    moved a piece into a square attacked by something cheaper) AND the
 *    engine evaluates it as ≤ 50cp loss — i.e. an intentional sac the
 *    engine endorses.
 *
 * Cost: depth-14 NNUE eval is ~150ms per position, two evals per move
 * (best line at FEN, best line after the played move). 10 games × ~40
 * user moves × 300ms ≈ 2 minutes. Strictly opt-in from the UI.
 *
 * Sample selection is just "most recent N games" — same heuristic the
 * consensus pass uses; recent games carry the most signal for current
 * style. Caller controls N via opts.gameCap.
 */

import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';

import { getEngine, type EngineInfo } from '$lib/stockfish/engine';
import { pieceOnSquareIsHanging } from './demand';
import type { ClassifiedGame, MoveFeatures, Phase } from './classify';
import type { Color } from '$lib/types';
import {
	wpLoss as wpLossFn,
	accuracyFromWpLoss,
	classifyByWpLoss,
	bucketHistogram,
	stmPovToUserPov,
	type MoveQuality,
	type MoveQualityBucket
} from './sota';
import { isBookPosition } from './mastersBook';
import { lookupTablebase, isTablebaseEligible, wdlToCp, type TablebaseResult } from './tablebase';

export interface EvalMoveResult {
	gameId: string;
	playedAt: number;
	ply: number;
	phase: Phase;
	san: string;
	fenBefore: string;
	fenAfter: string;
	cpLoss: number;
	bestUci: string | null;
	classification: 'best' | 'inaccuracy' | 'mistake' | 'blunder';
	intentionalSac: boolean;
	/** Move played by white or black — here, the user. */
	userColor: Color;
	/** Final game result from the user's perspective. */
	gameResult: 'win' | 'loss' | 'draw';
	/** Time bucket at the time the decision was made (from MoveFeatures). */
	clockBucket: 'low' | 'mid' | 'high' | 'none';
	/** Eval *after* the user played this move, flipped to user POV in cp. */
	userEvalAfterCp: number;
	/** Eval *before* the user played this move, flipped to user POV in cp. */
	userEvalBeforeCp: number;
	/**
	 * True when the **user's played move** was a check or capture — a
	 * board-only "forcing" proxy. This replaced the engine-driven
	 * "best-move-was-forcing" flag so the metric stays consistent across
	 * moves whose eval came from local Stockfish vs. moves whose eval was
	 * adopted from Lichess (which only exposes the played-line score).
	 * Semantically: "how often the user chose a forcing move," which
	 * doubles as a style-aggression signal via `tacticalMoveRate`.
	 */
	bestWasForcing: boolean;
	/**
	 * Provenance of the eval for this move. `'local'` = computed via
	 * local Stockfish multi-PV pass; `'lichess'` = adopted from Lichess's
	 * Fishnet annotation. Adopted moves carry null `bestUci` and empty
	 * `alternatives` / `volatile=false`.
	 */
	source: 'local' | 'lichess';
	/**
	 * Win-probability loss from the move, using Lichess's sigmoid. Zero
	 * when the move doesn't reduce win probability, capped at 100. Used
	 * by the SOTA classifier — treats a 50cp drop in a balanced position
	 * very differently from a 50cp drop when already lost.
	 */
	wpLoss: number;
	/** Lichess-style per-move accuracy in 0..100. */
	accuracyPct: number;
	/** WP-based move-quality bucket (brilliant / best / excellent / …). */
	quality: MoveQuality;
	/**
	 * Top-K engine alternatives captured via MultiPV. Empty when the
	 * analysis ran without MultiPV. Each entry carries the PV's first UCI
	 * move and its CP eval from the side-to-move POV of fenBefore.
	 */
	alternatives: Array<{ uci: string; cp: number; mate?: number | null }>;
	/**
	 * True when the engine's top-move didn't stabilise in the last few
	 * iterations of iterative deepening — proxy for tactical sharpness
	 * (the position genuinely demanded calculation to find).
	 */
	volatile: boolean;
	/** Tablebase WDL for fenBefore when ≤ 7 pieces. null otherwise. */
	tablebase: TablebaseResult | null;
	/** True when the position was deep enough in the masters book to skip. */
	inBook: boolean;
	/**
	 * Depth actually used for this move's evaluation. In non-adaptive mode
	 * this equals the scan depth. In adaptive mode it's either the shallow
	 * depth (when top1-top2 was decisive at shallow depth or user agreed
	 * with engine) or the deeper depth (when the position was ambiguous
	 * AND user disagreed). Optional because older reports pre-date this
	 * field; consumers should fall back to the report's `evalDepth` field.
	 */
	actualDepth?: number;
	/**
	 * True when this move was materially losing per SEE (the user's piece on
	 * the destination square is en prise after the move). Subset of these
	 * are then flagged as `intentionalSac` when CP loss is small enough to
	 * mean the engine endorses the trade. Stored explicitly so the
	 * sac-tendency aggregate (`materialLossEndorsed / lostMaterial total`)
	 * is derivable from `moveResults` without a parallel running counter.
	 * Optional for back-compat with reports written before this field.
	 */
	lostMaterial?: boolean;
}

export interface PhaseEvalSummary {
	moves: number;
	avgCpLoss: number;
	blunderRate: number;
	inaccuracyRate: number;
	/** Average WP-based accuracy (0–100) across moves in this phase. */
	avgAccuracy: number;
	/** Average WP loss per move in this phase. */
	avgWpLoss: number;
}

export interface EvalAxesSummary {
	movesAnalysed: number;
	movesSkippedSan: number;
	movesSkippedEngine: number;
	movesSkippedNoScore: number;
	/** Moves short-circuited as book (masters-DB lookup ≥ threshold). */
	movesSkippedBook: number;
	firstError: string | null;
	avgCpLoss: number;
	blunderRate: number;
	inaccuracyRate: number;
	sacTendency: number;
	/** Lichess-style aggregate accuracy (0–100) across all analysed moves. */
	avgAccuracy: number;
	/** Average WP loss per move. */
	avgWpLoss: number;
	/** Moves where the engine's top PV was unstable = tactical position. */
	tacticalMoveRate: number;
	byPhase: Record<Phase, PhaseEvalSummary>;
	/** Per-phase × per-color breakdown — powers the 6-tile Scorecard. */
	byPhaseColor: Record<Phase, Record<Color, PhaseEvalSummary>>;
	worst: EvalMoveResult[];
	/**
	 * Full per-move results. Consumers (scorecard, critical-moments,
	 * blunder-atlas) aggregate over this. Sorted by playedAt then ply so a
	 * per-game slice is already in chronological order.
	 */
	allMoves: EvalMoveResult[];
	perGame: Array<{ gameId: string; moves: number; avgCpLoss: number; avgAccuracy: number }>;
	/** Move-quality histogram — how your moves distribute across quality tiers. */
	histogram: MoveQualityBucket[];
	/** True when a Multi-PV pass was used for the scan. */
	multiPv: boolean;
	/** True when tablebase lookups were executed. */
	usedTablebase: boolean;
	/** True when masters-book skipping was enabled for the scan. */
	usedMastersBook: boolean;
	/** Moves whose eval came from Lichess's server-side `%eval` tags. */
	movesFromLichess: number;
	/** Moves whose eval was computed locally via Stockfish. */
	movesFromLocal: number;
}

export interface EvalAxesOpts {
	depth?: number;
	/** Optional wall-clock budget per position; overrides depth when set. */
	movetimeMs?: number;
	/** Top-K alternatives to keep per position. Default 3. Pass 1 to disable. */
	multiPV?: number;
	/** Skip book positions (≥ threshold games in Masters DB). Default true. */
	useMastersBook?: boolean;
	mastersMinGames?: number;
	/** Lichess API token. Required for masters-book lookups (/explorer is
	 *  auth-gated since March 2026); omit to disable the book skip. */
	lichessToken?: string;
	/** Use Syzygy tablebase (Lichess API) for ≤ 7-piece positions. Default true. */
	useTablebase?: boolean;
	signal?: AbortSignal;
	/** Fired per move; `adopted` is the cumulative count of moves that
	 *  came from Lichess server-side `%eval` (skipping the local engine). */
	onProgress?: (done: number, total: number, adopted: number) => void;
	/**
	 * Adaptive-depth pass. When true, every move is first evaluated at a
	 * shallow depth; only moves whose top-PVs are within `adaptiveGapCp`
	 * AND whose user move disagrees with the engine are re-evaluated at
	 * the requested deeper depth. Saves ~40–60% of wall-clock on typical
	 * scans while improving precision on the moves that actually matter.
	 * Disabled by default to keep existing scan timings predictable;
	 * callers who want it flip this on.
	 */
	adaptive?: boolean;
	/** Shallow depth for the adaptive first pass. Default 10. */
	adaptiveShallowDepth?: number;
	/** Top1-top2 CP gap under which a deep re-evaluation is triggered. Default 30. */
	adaptiveGapCp?: number;
	/**
	 * Resume an interrupted scan from a saved checkpoint. The state was
	 * produced by `freezeEvalAxesState()` — it carries every running
	 * accumulator plus the move-results gathered up to `cursor`. Caller
	 * is responsible for verifying the games array matches what the
	 * checkpoint was built against; a mismatched resume yields garbage
	 * aggregates. The function will pick up at index `cursor` in the
	 * derived work[] array.
	 */
	resumeFrom?: { cursor: number; state: EvalAxesPersistedState };
	/**
	 * Periodically receive a serializable snapshot of the in-flight state
	 * so the caller can persist it to IDB. Called after every move (one
	 * call per loop iteration) but the caller is expected to throttle —
	 * e.g. `scanStore` debounces writes to once every ~30 seconds.
	 *
	 * `cursor` is the index of the *next* move to be processed (not the
	 * one just finished), so resuming at this cursor is exactly correct.
	 */
	onCheckpoint?: (cursor: number, total: number, state: EvalAxesPersistedState) => void;
}

interface PhaseAcc {
	sum: number;
	n: number;
	blunders: number;
	inaccuracies: number;
	wpSum: number;
	accSum: number;
}

interface PerGameAcc {
	sum: number;
	n: number;
	accSum: number;
}

/**
 * Mutable accumulator for the eval pass. Held by the loop; mutated in
 * place. Convert to/from the persisted shape via `freezeEvalAxesState`
 * and `thawEvalAxesState` at IDB boundaries.
 */
interface EvalAxesRuntimeState {
	cpSum: number;
	wpSumAll: number;
	accSumAll: number;
	blunders: number;
	inaccuracies: number;
	volatileMoves: number;
	movesSkippedSan: number;
	movesSkippedEngine: number;
	movesSkippedNoScore: number;
	movesSkippedBook: number;
	movesFromLichess: number;
	movesFromLocal: number;
	firstError: string | null;
	phaseAcc: Record<Phase, PhaseAcc>;
	phaseColorAcc: Record<Phase, Record<Color, PhaseAcc>>;
	perGameAcc: Map<string, PerGameAcc>;
	moveResults: EvalMoveResult[];
}

/** JSON-friendly mirror — Map → entries array — for IDB persistence. */
export type EvalAxesPersistedState = Omit<EvalAxesRuntimeState, 'perGameAcc'> & {
	perGameAcc: Array<[string, PerGameAcc]>;
};

const MATE_CP = 1500;

/**
 * Walk every user move in the supplied games. For each move, run two
 * depth-N searches: one on the position before the move (gives best
 * eval) and one on the position after the move (gives the eval the
 * user actually steered into). CP loss = best - actual, both flipped to
 * the user's POV. Aggregates into the EvalAxesSummary.
 */
export async function analyseEvalAxes(
	games: ClassifiedGame[],
	opts: EvalAxesOpts = {}
): Promise<EvalAxesSummary> {
	const depth = opts.depth ?? 14;
	const movetimeMs = opts.movetimeMs;
	const multiPV = Math.max(1, Math.min(5, Math.floor(opts.multiPV ?? 3)));
	const useBook = opts.useMastersBook !== false;
	const useTb = opts.useTablebase !== false;
	const bookMin = opts.mastersMinGames ?? 10;
	// Adaptive-depth parameters. Shallow pass lands on every move; deep
	// re-pass only when the cheap pass finds an ambiguous position AND
	// the user diverged from the engine — those are the moves whose CP
	// loss estimate matters most.
	const adaptive = opts.adaptive === true && movetimeMs == null; // movetime mode is its own budget
	const shallowDepth = Math.max(6, Math.min(depth - 2, opts.adaptiveShallowDepth ?? 10));
	const ambiguityGap = opts.adaptiveGapCp ?? 30;
	const engine = getEngine();
	await engine.init();

	const work: Array<{ game: ClassifiedGame; move: MoveFeatures }> = [];
	for (const g of games) for (const m of g.moves) work.push({ game: g, move: m });

	const state: EvalAxesRuntimeState = opts.resumeFrom
		? thawEvalAxesState(opts.resumeFrom.state)
		: createEvalAxesRuntimeState();
	// Resume cursor — clamp so a stale checkpoint pointing past work.length
	// can't crash the loop. If clamped to work.length the loop body never
	// executes and we go straight to the summary, which is correct: a
	// completed scan needs no more work.
	const startIndex = Math.min(Math.max(0, opts.resumeFrom?.cursor ?? 0), work.length);
	const noteError = (msg: string) => {
		if (state.firstError == null) state.firstError = msg;
		console.warn('[evalAxes]', msg);
	};
	// Only fire onCheckpoint when state actually advances. The caller
	// throttles further; this just avoids redundant snapshots.
	const fireCheckpoint = (nextCursor: number) => {
		opts.onCheckpoint?.(nextCursor, work.length, freezeEvalAxesState(state));
	};

	for (let i = startIndex; i < work.length; i++) {
		if (opts.signal?.aborted) break;
		const { game, move } = work[i];
		opts.onProgress?.(i, work.length, state.movesFromLichess);

		const fenAfter = playSanOnFen(move.fenBefore, move.san);
		if (!fenAfter) {
			state.movesSkippedSan += 1;
			noteError(`SAN re-parse failed: "${move.san}" on ${move.fenBefore}`);
			fireCheckpoint(i + 1);
			continue;
		}

		// Option (c): "forcing" is approximated from the user's played move
		// (check or capture), not from the engine's best line. Uniform
		// across local-computed and adopted moves, so `tacticalMoveRate`
		// now means "how often the user chose a forcing move."
		const moveWasForcing = move.isCapture || move.isCheck;

		// Fast path — adopt Lichess's Fishnet eval when it's on the move.
		// Skips the masters-book probe, two engine calls, and the tablebase
		// lookup. When server evals are present we trust them end-to-end
		// for this move; fields that genuinely need multi-PV (bestUci,
		// alternatives, volatile) are left null/empty. The depth-20 leak
		// re-eval pass runs later against the worst moves regardless, so
		// leak detail cards still get engine-preferred lines.
		if (move.serverEvalBeforeCp !== undefined && move.serverEvalAfterCp !== undefined) {
			const userEvalBeforeCp = move.serverEvalBeforeCp;
			const userEvalAfterCp = move.serverEvalAfterCp;
			const cpLoss = Math.max(0, userEvalBeforeCp - userEvalAfterCp);
			const classification = classifyCpLoss(cpLoss);
			const wpLossVal = wpLossFn(userEvalBeforeCp, userEvalAfterCp);
			const accuracyPct = accuracyFromWpLoss(wpLossVal);
			let quality = classifyByWpLoss(wpLossVal);

			const matLoss = materialLossOnMove(move, fenAfter);
			const lostMaterial = matLoss >= 1;
			const intentionalSac = lostMaterial && cpLoss <= 50;
			if (intentionalSac && wpLossVal < 3) quality = 'brilliant';

			state.cpSum += cpLoss;
			state.wpSumAll += wpLossVal;
			state.accSumAll += accuracyPct;
			if (classification === 'blunder') state.blunders += 1;
			if (classification === 'inaccuracy' || classification === 'mistake') state.inaccuracies += 1;
			if (moveWasForcing) state.volatileMoves += 1;

			const p = state.phaseAcc[move.phase];
			p.sum += cpLoss;
			p.n += 1;
			p.wpSum += wpLossVal;
			p.accSum += accuracyPct;
			if (classification === 'blunder') p.blunders += 1;
			if (classification === 'inaccuracy' || classification === 'mistake') p.inaccuracies += 1;

			const pc = state.phaseColorAcc[move.phase][game.color];
			pc.sum += cpLoss;
			pc.n += 1;
			pc.wpSum += wpLossVal;
			pc.accSum += accuracyPct;
			if (classification === 'blunder') pc.blunders += 1;
			if (classification === 'inaccuracy' || classification === 'mistake') pc.inaccuracies += 1;

			const gAcc = state.perGameAcc.get(game.gameId) ?? { sum: 0, n: 0, accSum: 0 };
			gAcc.sum += cpLoss;
			gAcc.n += 1;
			gAcc.accSum += accuracyPct;
			state.perGameAcc.set(game.gameId, gAcc);

			state.moveResults.push({
				gameId: game.gameId,
				playedAt: game.playedAt,
				ply: move.ply,
				phase: move.phase,
				san: move.san,
				fenBefore: move.fenBefore,
				fenAfter,
				cpLoss,
				bestUci: null,
				classification,
				intentionalSac,
				userColor: game.color,
				gameResult: game.result,
				clockBucket: move.clockBucket,
				userEvalBeforeCp,
				userEvalAfterCp,
				bestWasForcing: moveWasForcing,
				wpLoss: wpLossVal,
				accuracyPct,
				quality,
				alternatives: [],
				volatile: false,
				tablebase: null,
				inBook: false,
				source: 'lichess',
				actualDepth: undefined, // server eval; no local depth
				lostMaterial
			});
			state.movesFromLichess += 1;
			fireCheckpoint(i + 1);
			continue;
		}

		// Masters-book short-circuit: if the position is deep enough in
		// theory, don't burn engine cycles on it — the player is recalling,
		// not deciding, and calling their move "best" or "blunder" against
		// Stockfish is a category error.
		let inBook = false;
		if (useBook && opts.lichessToken) {
			try {
				inBook = await isBookPosition(move.fenBefore, {
					minGames: bookMin,
					signal: opts.signal,
					token: opts.lichessToken
				});
			} catch {
				inBook = false;
			}
			if (inBook) {
				state.movesSkippedBook += 1;
				fireCheckpoint(i + 1);
				continue;
			}
		}

		let beforeMulti: Awaited<ReturnType<typeof engine.analyseMulti>>;
		let after: EngineInfo;
		let actualDepth = depth;
		try {
			if (movetimeMs != null) {
				beforeMulti = await engine.analyseMulti(move.fenBefore, { multiPV, movetimeMs });
				if (opts.signal?.aborted) break;
				const afterMulti = await engine.analyseMulti(fenAfter, { multiPV: 1, movetimeMs });
				after = afterMulti.lines[0];
			} else if (adaptive) {
				// Shallow first pass. If the position is unambiguous (top-1
				// beats top-2 by at least `ambiguityGap`) OR the user's
				// move matches the engine's pick, the shallow eval is
				// accurate enough — depth 14 would change the CP loss by
				// a few cp, which doesn't affect the aggregates. Only
				// re-run deep when the decision was close AND the user
				// disagreed.
				beforeMulti = await engine.analyseMulti(move.fenBefore, {
					multiPV,
					depth: shallowDepth
				});
				if (opts.signal?.aborted) break;
				const afterShallow = await engine.analyseMulti(fenAfter, {
					multiPV: 1,
					depth: shallowDepth
				});
				after = afterShallow.lines[0];
				actualDepth = shallowDepth;

				const top1 = beforeMulti.lines[0];
				const top2 = beforeMulti.lines[1];
				const bestUciShallow = top1?.pv[0] ?? null;
				// We can't know the user's UCI without parsing SAN again
				// (expensive). Instead, trigger deep pass whenever the
				// shallow pass shows ambiguity — the resulting precise CP
				// loss is worth the extra time regardless of the user's
				// choice. If the gap is wide (> ambiguityGap), shallow is
				// enough. This keeps the logic simple at a modest cost vs
				// the "strict user-divergence" gate.
				const gap =
					top1 && top2 && hasScore(top1) && hasScore(top2)
						? Math.abs(scoreToCp(top1) - scoreToCp(top2))
						: Infinity;
				if (gap < ambiguityGap && bestUciShallow) {
					beforeMulti = await engine.analyseMulti(move.fenBefore, { multiPV, depth });
					if (opts.signal?.aborted) break;
					const afterDeep = await engine.analyseMulti(fenAfter, { multiPV: 1, depth });
					after = afterDeep.lines[0];
					actualDepth = depth;
				}
			} else {
				beforeMulti = await engine.analyseMulti(move.fenBefore, { multiPV, depth });
				if (opts.signal?.aborted) break;
				const afterMulti = await engine.analyseMulti(fenAfter, { multiPV: 1, depth });
				after = afterMulti.lines[0];
			}
		} catch (e) {
			state.movesSkippedEngine += 1;
			noteError(`engine.analyseMulti rejected: ${e instanceof Error ? e.message : String(e)}`);
			fireCheckpoint(i + 1);
			continue;
		}

		const before = beforeMulti.lines[0];
		if (!before || !hasScore(before) || !after || !hasScore(after)) {
			state.movesSkippedNoScore += 1;
			noteError(
				`engine returned no score (before depth=${before?.depth} mate=${before?.scoreMate} cp=${before?.scoreCp}; after depth=${after?.depth} mate=${after?.scoreMate} cp=${after?.scoreCp})`
			);
			fireCheckpoint(i + 1);
			continue;
		}

		// Sample-log the first few eval pairs so the user can verify the
		// pipeline. Cheap (capped at 5) and only emits in dev console.
		if (state.moveResults.length < 5) {
			console.debug(
				`[evalAxes sample ${state.moveResults.length}] color=${game.color} ply=${move.ply} san=${move.san} ` +
					`before=${formatScore(before)} after=${formatScore(after)}`
			);
		}

		// Engine cp/mate arrives in side-to-move POV (UCI standard, what
		// `lila-stockfish-web` emits). At `move.fenBefore` STM is the user
		// (they're about to move) → STM-POV = user-POV directly. At
		// `fenAfter` STM is the opponent → STM-POV must be negated to land
		// in user-POV. Routed through `enginePairToUserPov` (a pure
		// helper) so the conversion is testable in isolation.
		let { userEvalBeforeCp, userEvalAfterCp } = enginePairToUserPov(before, after, game.color);

		// Tablebase override: ≤7 pieces → ground truth from Syzygy. CP
		// eval from Stockfish is an approximation; WDL is law.
		let tablebase: TablebaseResult | null = null;
		if (useTb && isTablebaseEligible(move.fenBefore)) {
			try {
				tablebase = await lookupTablebase(move.fenBefore, opts.signal);
				if (tablebase) {
					// `wdlToCp` returns the WDL from the side-to-move's POV at
					// the FEN it was looked up against — same convention as
					// engine cp, so the same conversion applies.
					const stmAfter: Color = game.color === 'white' ? 'black' : 'white';
					userEvalBeforeCp = stmPovToUserPov(wdlToCp(tablebase.wdl), game.color, game.color);
					if (isTablebaseEligible(fenAfter)) {
						const tbAfter = await lookupTablebase(fenAfter, opts.signal);
						if (tbAfter)
							userEvalAfterCp = stmPovToUserPov(wdlToCp(tbAfter.wdl), stmAfter, game.color);
					}
				}
			} catch {
				tablebase = null;
			}
		}

		const cpLoss = Math.max(0, userEvalBeforeCp - userEvalAfterCp);

		// Classical CP-based classification (kept for back-compat).
		const classification = classifyCpLoss(cpLoss);

		// SOTA: WP loss + accuracy + quality tier.
		const wpLossVal = wpLossFn(userEvalBeforeCp, userEvalAfterCp);
		const accuracyPct = accuracyFromWpLoss(wpLossVal);
		let quality = classifyByWpLoss(wpLossVal);

		// Material loss = the user's piece on the destination square is
		// genuinely en prise after the move per SEE — not just "attacked
		// by a cheaper piece," which produced false positives whenever
		// the piece was defended.
		const matLoss = materialLossOnMove(move, fenAfter);
		const lostMaterial = matLoss >= 1;
		const intentionalSac = lostMaterial && cpLoss <= 50;
		if (intentionalSac && wpLossVal < 3) quality = 'brilliant';

		const bestUci = before.pv[0] ?? null;

		// Volatility proxy: top move changed ≥2 times during iterative
		// deepening = tactical / unclear position. Recorded per-move but
		// no longer feeds `tacticalMoveRate` — the option (c) rewrite
		// uses played-move-forcing instead so the metric behaves the same
		// on adopted moves that don't expose multi-PV history.
		const volatile = beforeMulti.volatility.topMoveChanges >= 2;
		if (moveWasForcing) state.volatileMoves += 1;

		// Top-K alternatives (excludes the bestmove itself for brevity; the
		// bestUci above already covers PV[0]). These PVs were searched from
		// `move.fenBefore`, so STM-POV = user-POV — same path as `before`.
		const alternatives: EvalMoveResult['alternatives'] = [];
		for (const line of beforeMulti.lines.slice(1)) {
			if (!hasScore(line) || !line.pv[0]) continue;
			alternatives.push({
				uci: line.pv[0],
				cp: stmPovToUserPov(scoreToCp(line), game.color, game.color),
				mate:
					line.scoreMate != null ? stmPovToUserPov(line.scoreMate, game.color, game.color) : null
			});
		}

		state.cpSum += cpLoss;
		state.wpSumAll += wpLossVal;
		state.accSumAll += accuracyPct;
		if (classification === 'blunder') state.blunders += 1;
		if (classification === 'inaccuracy' || classification === 'mistake') state.inaccuracies += 1;

		const p = state.phaseAcc[move.phase];
		p.sum += cpLoss;
		p.n += 1;
		p.wpSum += wpLossVal;
		p.accSum += accuracyPct;
		if (classification === 'blunder') p.blunders += 1;
		if (classification === 'inaccuracy' || classification === 'mistake') p.inaccuracies += 1;

		const pc = state.phaseColorAcc[move.phase][game.color];
		pc.sum += cpLoss;
		pc.n += 1;
		pc.wpSum += wpLossVal;
		pc.accSum += accuracyPct;
		if (classification === 'blunder') pc.blunders += 1;
		if (classification === 'inaccuracy' || classification === 'mistake') pc.inaccuracies += 1;

		const gAcc = state.perGameAcc.get(game.gameId) ?? { sum: 0, n: 0, accSum: 0 };
		gAcc.sum += cpLoss;
		gAcc.n += 1;
		gAcc.accSum += accuracyPct;
		state.perGameAcc.set(game.gameId, gAcc);

		state.moveResults.push({
			gameId: game.gameId,
			playedAt: game.playedAt,
			ply: move.ply,
			phase: move.phase,
			san: move.san,
			fenBefore: move.fenBefore,
			fenAfter,
			cpLoss,
			bestUci,
			classification,
			intentionalSac,
			userColor: game.color,
			gameResult: game.result,
			clockBucket: move.clockBucket,
			userEvalBeforeCp,
			userEvalAfterCp,
			bestWasForcing: moveWasForcing,
			wpLoss: wpLossVal,
			accuracyPct,
			quality,
			alternatives,
			volatile,
			tablebase,
			inBook,
			source: 'local',
			actualDepth,
			lostMaterial
		});
		state.movesFromLocal += 1;
		fireCheckpoint(i + 1);
	}
	opts.onProgress?.(work.length, work.length, state.movesFromLichess);

	const movesAnalysed = state.moveResults.length;
	const safe = movesAnalysed || 1;
	// sac-tendency = endorsed material losses / total material losses.
	// Derived from moveResults at summary time so the runtime state
	// doesn't need a parallel counter (the lostMaterial flag on each
	// EvalMoveResult is the source of truth).
	let lostMaterialCount = 0;
	let lostMaterialEndorsed = 0;
	for (const m of state.moveResults) {
		if (m.lostMaterial) {
			lostMaterialCount += 1;
			if (m.intentionalSac) lostMaterialEndorsed += 1;
		}
	}
	const byPhase: Record<Phase, PhaseEvalSummary> = {
		opening: finalisePhase(state.phaseAcc.opening),
		middle: finalisePhase(state.phaseAcc.middle),
		end: finalisePhase(state.phaseAcc.end)
	};
	const byPhaseColor: Record<Phase, Record<Color, PhaseEvalSummary>> = {
		opening: {
			white: finalisePhase(state.phaseColorAcc.opening.white),
			black: finalisePhase(state.phaseColorAcc.opening.black)
		},
		middle: {
			white: finalisePhase(state.phaseColorAcc.middle.white),
			black: finalisePhase(state.phaseColorAcc.middle.black)
		},
		end: {
			white: finalisePhase(state.phaseColorAcc.end.white),
			black: finalisePhase(state.phaseColorAcc.end.black)
		}
	};

	const allMoves = [...state.moveResults].sort((a, b) => a.playedAt - b.playedAt || a.ply - b.ply);
	const histogram = bucketHistogram(state.moveResults.map((m) => m.quality));

	return {
		movesAnalysed,
		movesSkippedSan: state.movesSkippedSan,
		movesSkippedEngine: state.movesSkippedEngine,
		movesSkippedNoScore: state.movesSkippedNoScore,
		movesSkippedBook: state.movesSkippedBook,
		firstError: state.firstError,
		avgCpLoss: state.cpSum / safe,
		blunderRate: state.blunders / safe,
		inaccuracyRate: state.inaccuracies / safe,
		sacTendency: lostMaterialCount > 0 ? lostMaterialEndorsed / lostMaterialCount : 0,
		avgAccuracy: state.accSumAll / safe,
		avgWpLoss: state.wpSumAll / safe,
		tacticalMoveRate: state.volatileMoves / safe,
		byPhase,
		byPhaseColor,
		worst: [...state.moveResults].sort((a, b) => b.wpLoss - a.wpLoss).slice(0, 12),
		allMoves,
		perGame: [...state.perGameAcc.entries()]
			.map(([gameId, v]) => ({
				gameId,
				moves: v.n,
				avgCpLoss: v.sum / v.n,
				avgAccuracy: v.accSum / v.n
			}))
			.sort((a, b) => b.avgCpLoss - a.avgCpLoss),
		histogram,
		multiPv: multiPV > 1,
		usedTablebase: useTb,
		usedMastersBook: useBook,
		movesFromLichess: state.movesFromLichess,
		movesFromLocal: state.movesFromLocal
	};
}

function emptyPhaseAcc(): PhaseAcc {
	return { sum: 0, n: 0, blunders: 0, inaccuracies: 0, wpSum: 0, accSum: 0 };
}

function createEvalAxesRuntimeState(): EvalAxesRuntimeState {
	return {
		cpSum: 0,
		wpSumAll: 0,
		accSumAll: 0,
		blunders: 0,
		inaccuracies: 0,
		volatileMoves: 0,
		movesSkippedSan: 0,
		movesSkippedEngine: 0,
		movesSkippedNoScore: 0,
		movesSkippedBook: 0,
		movesFromLichess: 0,
		movesFromLocal: 0,
		firstError: null,
		phaseAcc: {
			opening: emptyPhaseAcc(),
			middle: emptyPhaseAcc(),
			end: emptyPhaseAcc()
		},
		phaseColorAcc: {
			opening: { white: emptyPhaseAcc(), black: emptyPhaseAcc() },
			middle: { white: emptyPhaseAcc(), black: emptyPhaseAcc() },
			end: { white: emptyPhaseAcc(), black: emptyPhaseAcc() }
		},
		perGameAcc: new Map(),
		moveResults: []
	};
}

/**
 * Snapshot the live accumulator into a JSON-friendly form. Maps become
 * entries arrays; everything else is plain data already. Caller is
 * responsible for any further serialization (e.g. structured-clone for
 * IDB write); this just normalises the shape.
 */
export function freezeEvalAxesState(s: EvalAxesRuntimeState): EvalAxesPersistedState {
	return {
		...s,
		perGameAcc: [...s.perGameAcc.entries()]
	};
}

/**
 * Inverse of `freezeEvalAxesState` — rebuild the live accumulator from
 * its persisted form. Idempotent; safe to call on the output of
 * `freezeEvalAxesState` to round-trip without loss.
 */
export function thawEvalAxesState(p: EvalAxesPersistedState): EvalAxesRuntimeState {
	return {
		...p,
		perGameAcc: new Map(p.perGameAcc)
	};
}

function hasScore(info: EngineInfo): boolean {
	return info.scoreCp !== undefined || info.scoreMate !== undefined;
}

function formatScore(info: EngineInfo): string {
	if (info.scoreMate !== undefined) return `mate ${info.scoreMate} (depth ${info.depth})`;
	if (info.scoreCp !== undefined) return `cp ${info.scoreCp} (depth ${info.depth})`;
	return `none (depth ${info.depth})`;
}

function finalisePhase(p: {
	sum: number;
	n: number;
	blunders: number;
	inaccuracies: number;
	wpSum: number;
	accSum: number;
}): PhaseEvalSummary {
	const safe = p.n || 1;
	return {
		moves: p.n,
		avgCpLoss: p.sum / safe,
		blunderRate: p.blunders / safe,
		inaccuracyRate: p.inaccuracies / safe,
		avgAccuracy: p.accSum / safe,
		avgWpLoss: p.wpSum / safe
	};
}

function classifyCpLoss(cp: number): EvalMoveResult['classification'] {
	if (cp >= 200) return 'blunder';
	if (cp >= 100) return 'mistake';
	if (cp >= 50) return 'inaccuracy';
	return 'best';
}

function scoreToCp(info: EngineInfo): number {
	if (info.scoreMate !== undefined) {
		return info.scoreMate > 0 ? MATE_CP : -MATE_CP;
	}
	return info.scoreCp ?? 0;
}

/**
 * Convert a (engine before, engine after) pair to user-POV centipawns
 * and the resulting non-negative cpLoss.
 *
 * `before` is analysed at a position where the user is to move, so its
 * raw STM-POV score is already user-POV. `after` is at a position where
 * the opponent is to move (the user just moved), so its STM-POV score
 * must be negated.
 *
 * Exported so a unit test can pin the conversion against worked
 * examples — the regression that motivated this helper (PR #38) was a
 * sign flip that only manifested on the after-position, hence quietly
 * doubled cpLoss on every move at black-to-move boundaries.
 */
export function enginePairToUserPov(
	before: EngineInfo,
	after: EngineInfo,
	userColor: Color
): { userEvalBeforeCp: number; userEvalAfterCp: number; cpLoss: number } {
	const stmAfter: Color = userColor === 'white' ? 'black' : 'white';
	const userEvalBeforeCp = stmPovToUserPov(scoreToCp(before), userColor, userColor);
	const userEvalAfterCp = stmPovToUserPov(scoreToCp(after), stmAfter, userColor);
	return {
		userEvalBeforeCp,
		userEvalAfterCp,
		cpLoss: Math.max(0, userEvalBeforeCp - userEvalAfterCp)
	};
}

/**
 * Material the user lost on this move per SEE on the destination square,
 * in pawns. >0 means the user's piece is en prise after the move (or
 * they captured into an unfavourable trade). 0 means the move is
 * materially safe. Used to gate the sac-tendency axis so we only count
 * moves that are *actually* materially losing — the previous "attacked
 * by a cheaper piece" heuristic flagged any defended piece touched by
 * a pawn, producing the 100%-of-1-move false signal.
 */
function materialLossOnMove(m: MoveFeatures, fenAfter: string): number {
	try {
		const setupR = parseFen(fenAfter);
		if (setupR.isErr) return 0;
		const posR = Chess.fromSetup(setupR.value);
		if (posR.isErr) return 0;
		const pos = posR.value;

		// Find the destination square by replaying the SAN against the
		// pre-move FEN. We need it because MoveFeatures only carries
		// from/to file+rank, not the absolute square index after promo etc.
		const beforeSetupR = parseFen(m.fenBefore);
		if (beforeSetupR.isErr) return 0;
		const beforePosR = Chess.fromSetup(beforeSetupR.value);
		if (beforePosR.isErr) return 0;
		const move = parseSan(beforePosR.value, m.san);
		if (!move || !('to' in move)) return 0;

		// pos.turn === opponent (it's their move now). pieceOnSquareIsHanging
		// runs SEE from pos.turn's perspective for the smallest attacker on
		// `square`, so we get the material the opponent would gain by
		// initiating a capture there.
		return pieceOnSquareIsHanging(pos, move.to);
	} catch {
		return 0;
	}
}

function playSanOnFen(fen: string, san: string): string | null {
	const setupR = parseFen(fen);
	if (setupR.isErr) return null;
	const posR = Chess.fromSetup(setupR.value);
	if (posR.isErr) return null;
	const pos = posR.value;
	const move = parseSan(pos, san);
	if (!move) return null;
	pos.play(move);
	return makeFen(pos.toSetup());
}
