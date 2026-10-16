/**
 * Engine "only move" verdicts for forced lines (issue #86 follow-up). An
 * opponent reply is forced when every other move loses or is much worse; we
 * read that off a Lichess cloud eval with two principal variations and
 * record it on the edge (`Edge.onlyMove`), so the drill can treat the line
 * through it as one unit (see forcedLines.ts).
 *
 * Only positions where the user prepared a single opponent reply are
 * checked, and only when nothing cheaper (one legal move, the game share,
 * a □ mark) already settles it. Cloud evals cover common opening positions;
 * a miss is recorded too, so the pass doesn't re-ask until the verdict ages
 * out.
 */
import { colorToMove } from '$lib/chess/fen';
import { sanAtFen } from '$lib/chess/position';
import { getDB } from '$lib/storage/db';
import { markRepDirty } from '$lib/sync/dirtyMark';
import { cloudEvalCoolingDown, fetchCloudEval, type CloudEval } from '$lib/lichess/cloudEval';
import type { OnlyMoveVerdict, Repertoire, RepertoireNode } from '$lib/types';
import { parseUci } from 'chessops/util';
import { isForcedReply } from './forcedLines';

/** Second-best move at least this much worse (mover's view) = forced. */
export const ONLY_MOVE_GAP_CP = 150;
/** Verdicts older than this are re-checked. */
export const ONLY_MOVE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Pause between cloud-eval requests: it's a shared, rate-limited API. */
const REQUEST_SPACING_MS = 400;

const MATE_CP = 10_000;

/** A PV's score in centipawns from the mover's side; mates clamped. */
function moverScore(pv: CloudEval['pvs'][number], mover: 'white' | 'black'): number | null {
	let white: number;
	if (typeof pv.scoreMate === 'number') {
		// Sooner mates score higher; mate 0 can't occur in a cloud eval.
		white = pv.scoreMate > 0 ? MATE_CP - pv.scoreMate : -MATE_CP - pv.scoreMate;
	} else if (typeof pv.scoreCp === 'number') {
		white = pv.scoreCp;
	} else {
		return null;
	}
	return mover === 'white' ? white : -white;
}

/**
 * Verdict for the prepared reply `san` at `fen` from a cloud eval (null =
 * no eval). Forced when it's the engine's best move and the second-best is
 * at least ONLY_MOVE_GAP_CP worse for the side playing it. Pure.
 */
export function onlyMoveVerdict(
	fen: string,
	san: string,
	ev: CloudEval | null,
	now: number
): OnlyMoveVerdict {
	const miss: OnlyMoveVerdict = { forced: false, gapCp: null, fetchedAt: now };
	if (!ev || ev.pvs.length < 2) return miss;
	const mover = fen.split(' ')[1] === 'w' ? 'white' : 'black';
	const sanOf = (uci: string | undefined) => {
		const m = uci ? parseUci(uci) : undefined;
		return m ? sanAtFen(fen, m) : null;
	};
	if (sanOf(ev.pvs[0].moves[0]) !== san) return miss;
	const best = moverScore(ev.pvs[0], mover);
	const second = moverScore(ev.pvs[1], mover);
	if (best === null || second === null) return miss;
	const gapCp = best - second;
	return { forced: gapCp >= ONLY_MOVE_GAP_CP, gapCp, fetchedAt: now };
}

interface Todo {
	node: RepertoireNode;
	san: string;
}

/** Opponent positions with a single live prepared reply still to check. */
function todoNodes(
	rep: Pick<Repertoire, 'rootFenKey' | 'color'>,
	nodes: Map<string, RepertoireNode>,
	now: number
): Todo[] {
	const out: Todo[] = [];
	const seen = new Set<string>([rep.rootFenKey]);
	const queue = [rep.rootFenKey];
	for (let i = 0; i < queue.length; i++) {
		const node = nodes.get(queue[i]);
		if (!node) continue;
		const live = node.children.filter((e) => !e.disabled);
		if (colorToMove(node.fenKey) !== rep.color && live.length === 1) {
			const edge = live[0];
			const fresh = edge.onlyMove && now - edge.onlyMove.fetchedAt < ONLY_MOVE_MAX_AGE_MS;
			const userMovesAfter = (nodes.get(edge.toFenKey)?.children.length ?? 0) > 0;
			if (
				!fresh &&
				userMovesAfter &&
				!isForcedReply(node, { ...edge, onlyMove: undefined }, nodes.get(edge.toFenKey))
			) {
				out.push({ node, san: edge.san });
			}
		}
		for (const e of node.children) {
			if (e.disabled || seen.has(e.toFenKey)) continue;
			seen.add(e.toFenKey);
			queue.push(e.toFenKey);
		}
	}
	return out;
}

async function storeVerdict(
	repId: string,
	fenKey: string,
	san: string,
	verdict: OnlyMoveVerdict
): Promise<void> {
	const db = await getDB();
	const node = await db.get('nodes', [repId, fenKey]);
	const edge = node?.children.find((e) => e.san === san);
	if (!node || !edge) return;
	edge.onlyMove = verdict;
	await db.put('nodes', node);
	markRepDirty(repId);
}

export interface OnlyMoveBackfillResult {
	checked: number;
	remaining: number;
	stoppedBy?: 'rate-limit' | 'aborted';
}

/**
 * Check every unsettled single opponent reply against the Lichess cloud eval,
 * shallowest first. Resumable: verdicts are stored as they come in, and a
 * rate limit or abort stops the run for the next visit to pick up.
 */
export async function backfillOnlyMoves(
	rep: Pick<Repertoire, 'id' | 'color' | 'rootFen' | 'rootFenKey'>,
	nodes: Map<string, RepertoireNode>,
	opts: { token?: string; signal?: AbortSignal } = {}
): Promise<OnlyMoveBackfillResult> {
	const todo = todoNodes(rep, nodes, Date.now());
	for (let i = 0; i < todo.length; i++) {
		if (opts.signal?.aborted)
			return { checked: i, remaining: todo.length - i, stoppedBy: 'aborted' };
		const { node, san } = todo[i];
		const fen = node.fenKey === rep.rootFenKey ? rep.rootFen : `${node.fenKey} 0 1`;
		const ev = await fetchCloudEval(fen, 2, { token: opts.token, signal: opts.signal });
		if (opts.signal?.aborted)
			return { checked: i, remaining: todo.length - i, stoppedBy: 'aborted' };
		// A null during a 429 cool-down isn't a miss: stop and retry later.
		if (!ev && cloudEvalCoolingDown()) {
			return { checked: i, remaining: todo.length - i, stoppedBy: 'rate-limit' };
		}
		await storeVerdict(rep.id, node.fenKey, san, onlyMoveVerdict(fen, san, ev, Date.now()));
		if (i + 1 < todo.length) await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
	}
	return { checked: todo.length, remaining: 0 };
}
