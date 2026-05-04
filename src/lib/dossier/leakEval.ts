/**
 * Run Stockfish over a list of leak positions to compute centipawn loss
 * per leak. CP loss = (best eval at FEN before the user's move) − (eval
 * after the user's move), expressed from the user's perspective and
 * clamped to non-negative (capping at 1500cp because mate-in-N positions
 * blow up linearly otherwise).
 *
 * Depth 20 NNUE eval is ~500ms per position, two positions per leak. The
 * 12 worst leaks ≈ 12s. This is the "verify the big ones" pass — the
 * bulk scan runs at a lower depth (configurable, default 14), and leaks
 * get re-evaluated here at higher depth because a sharp diagnosis on a
 * specific blunder is worth the extra time.
 */

import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';

import { getEngine, type EngineInfo } from '$lib/stockfish/engine';
import { stmPovToUserPov } from './sota';
import type { LeakInstance } from './mismatch';

export interface AnalysedLeak extends LeakInstance {
	/** Centipawn loss from the user's POV. Mate scores rendered as 1500. */
	cpLoss: number;
	/** Best move SAN at the position (Stockfish's PV[0]), if available. */
	bestUci: string | null;
	/** True if Stockfish thought the user's move was at most 20cp worse. */
	negligible: boolean;
}

const MATE_CP = 1500;

export interface AnalyseOpts {
	depth?: number;
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
}

export async function analyseLeaks(
	leaks: LeakInstance[],
	opts: AnalyseOpts = {}
): Promise<AnalysedLeak[]> {
	const depth = opts.depth ?? 20;
	const engine = getEngine();
	await engine.init();

	const out: AnalysedLeak[] = [];
	for (let i = 0; i < leaks.length; i++) {
		if (opts.signal?.aborted) break;
		const leak = leaks[i];
		const fenAfter = playSanOnFen(leak.fenBefore, leak.san);
		if (!fenAfter) {
			out.push({ ...leak, cpLoss: 0, bestUci: null, negligible: true });
			opts.onProgress?.(i + 1, leaks.length);
			continue;
		}

		const before = await engine.analyse(leak.fenBefore, depth);
		if (opts.signal?.aborted) break;
		const after = await engine.analyse(fenAfter, depth);

		// Engine cp arrives in side-to-move POV (UCI standard). At
		// `leak.fenBefore` STM is the user (it's their move); at `fenAfter`
		// STM is the opponent. Convert both into user-POV via stmPovToUserPov
		// so the subtraction is apples-to-apples.
		const stmAfter: 'white' | 'black' = leak.color === 'white' ? 'black' : 'white';
		const bestCpUser = stmPovToUserPov(scoreToCp(before), leak.color, leak.color);
		const playedCpUser = stmPovToUserPov(scoreToCp(after), stmAfter, leak.color);
		const cpLoss = Math.max(0, bestCpUser - playedCpUser);

		out.push({
			...leak,
			cpLoss,
			bestUci: before.pv[0] ?? null,
			negligible: cpLoss <= 20
		});
		opts.onProgress?.(i + 1, leaks.length);
	}
	return out;
}

/** Pull a centipawn reading out of an engine info, with mate scores
 *  capped to ±MATE_CP. The value is in whatever POV the engine emitted —
 *  side-to-move POV for `lila-stockfish-web` — and callers must convert
 *  to user-POV (or whatever target POV) before differencing. */
function scoreToCp(info: EngineInfo): number {
	if (info.scoreMate !== undefined) {
		return info.scoreMate > 0 ? MATE_CP : -MATE_CP;
	}
	return info.scoreCp ?? 0;
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

/**
 * Aggregate CP loss by leak type to give the "missed_capture costs you
 * 1.2 pawns avg" headline. Returns averages in centipawns; UI converts.
 */
export function avgCpLossByType(analysed: AnalysedLeak[]): Record<string, number> {
	const sums: Record<string, { sum: number; n: number }> = {};
	for (const l of analysed) {
		const s = (sums[l.type] ??= { sum: 0, n: 0 });
		s.sum += l.cpLoss;
		s.n += 1;
	}
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(sums)) {
		out[k] = v.n > 0 ? v.sum / v.n : 0;
	}
	return out;
}
