/**
 * Engine probe used by drill / walkthrough to grade a wrong move.
 *
 * Runs two sequential `engine.go` searches:
 *   1. `fenBefore` — STM at this FEN is the user (it was their move).
 *      `info.scoreCp` is therefore in user-POV directly.
 *   2. `fenAfter`  — STM is the opponent. `info.scoreCp` is in
 *      opponent-POV; negate to get user-POV. The PV is the engine's
 *      refutation line (opponent's best response, the user's best
 *      reply, …) and is animated by the caller.
 *
 * Two probes (vs. one) is the only way to compute cpLoss directly,
 * which is what powers grading "you gave away your advantage" cases
 * where the absolute eval at fenAfter doesn't trip the old absolute-
 * magnitude threshold.
 */

import { getEngine, type EngineInfo } from '$lib/stockfish/engine';

const MATE_CP = 10000;
const BEFORE_DEPTH = 14;
const AFTER_DEPTH = 16;

export interface ProbedEvals {
	/** User-POV cp at fenBefore — what best play would have given. */
	bestUserPov: number;
	/** User-POV cp at fenAfter — what the user's actual move yielded. */
	playedUserPov: number;
	/** Engine's refutation PV from fenAfter (opp move, user reply, …). */
	refutationPv: string[];
	/** STM-POV (opponent-POV) cp at fenAfter — for the readout. */
	refutationCp: number;
}

/**
 * Probe one position to a depth/time bound. Returns the latest info
 * received before the timeout fires (or null if nothing arrived).
 *
 * Implementation: subscribe to `onInfo`, kick off `engine.go`, settle
 * on a wall-clock timer. Stockfish streams info per iteration, so the
 * latest one is the deepest the engine got within the budget.
 */
function probeOnce(
	fen: string,
	depth: number,
	timeoutMs: number
): Promise<{ pv: string[]; stmCp: number } | null> {
	const engine = getEngine();
	if (!engine.isReady()) {
		void engine.init().catch(() => undefined);
		return Promise.resolve(null);
	}
	return new Promise<{ pv: string[]; stmCp: number } | null>((resolve) => {
		let best: { pv: string[]; stmCp: number } | null = null;
		let settled = false;
		const unsub = engine.onInfo((info: EngineInfo) => {
			if (!info.pv.length) return;
			if (info.scoreMate !== undefined) {
				const mateCp = info.scoreMate > 0 ? MATE_CP : -MATE_CP;
				best = { pv: info.pv.slice(), stmCp: mateCp };
			} else if (info.scoreCp !== undefined) {
				best = { pv: info.pv.slice(), stmCp: info.scoreCp };
			}
		});
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsub();
			try {
				engine.stop();
			} catch {
				/* ignore */
			}
			resolve(best);
		}, timeoutMs);
		engine.go(fen, depth).catch(() => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsub();
			resolve(null);
		});
	});
}

/**
 * Probe both fenBefore and fenAfter, return user-POV evals + the
 * engine's refutation line from fenAfter. Returns null if probing
 * fenAfter fails outright (no PV → nothing to play out, nothing to
 * grade). When fenBefore probe fails but fenAfter succeeded we still
 * return — `bestUserPov` falls back to a neutral 0 so the caller can
 * grade by absolute fenAfter eval as a degraded path.
 *
 * `beforeMs` defaults to a tighter budget than `afterMs` because
 * fenBefore only needs a single cp value; fenAfter needs a usable PV
 * to animate.
 */
export async function probeMoveEvals(
	fenBefore: string,
	fenAfter: string,
	beforeMs: number,
	afterMs: number
): Promise<ProbedEvals | null> {
	const before = await probeOnce(fenBefore, BEFORE_DEPTH, beforeMs);
	const after = await probeOnce(fenAfter, AFTER_DEPTH, afterMs);
	if (!after || after.pv.length === 0) return null;
	return {
		// fenBefore STM = user → STM-POV cp = user-POV cp directly. If
		// the probe failed, fall back to 0; gradeMove still has the
		// fenAfter absolute-eval signal to work with.
		bestUserPov: before?.stmCp ?? 0,
		// fenAfter STM = opponent → negate to land in user-POV.
		playedUserPov: -after.stmCp,
		refutationPv: after.pv,
		refutationCp: after.stmCp
	};
}
