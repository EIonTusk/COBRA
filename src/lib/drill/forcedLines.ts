import { colorToMove } from '$lib/chess/fen';
import { chessFromFen } from '$lib/chess/position';
import type { Color, Edge, RepertoireNode } from '$lib/types';

/**
 * Forced lines (issue #86 follow-up): a run of the user's moves joined by
 * opponent replies that are forced, drilled as one unit — unlocked together,
 * reviewed together, and replayed from the start when any move in it is
 * missed. The point of a move is often the forced sequence it starts, and
 * cutting the line after the first move hides it.
 *
 * An opponent reply counts as forced when it's the only reply prepared at
 * its position AND one of:
 *  - it's the only legal move;
 *  - the opponent plays it in at least FORCED_SHARE of games
 *    (`Edge.frequency`, with enough games behind the number);
 *  - the PGN marks it □ (NAG 7, "only move");
 *  - the engine found every other move losing or much worse
 *    (`Edge.onlyMove`, see onlyMove.ts).
 */

/** Share of games above which the opponent's reply counts as forced. */
export const FORCED_SHARE = 0.85;
/** Games the share must rest on. */
export const FORCED_MIN_GAMES = 50;
/** PGN NAG for "only move" (□). */
export const NAG_ONLY_MOVE = 7;
/**
 * Most user moves drilled as one forced run. Longer chains are cut into
 * consecutive runs, so a long forcing line doesn't swallow a whole session.
 */
export const MAX_FORCED_RUN = 6;

function fenFromKey(key: string): string {
	return key.split(' ').length === 4 ? `${key} 0 1` : key;
}

function legalMoveCount(fenKey: string): number {
	try {
		const pos = chessFromFen(fenFromKey(fenKey));
		let n = 0;
		for (const [, dests] of pos.allDests()) n += dests.size();
		return n;
	} catch {
		return Infinity;
	}
}

/**
 * Is `edge` — the single live opponent reply at `node` — forced? `child` is
 * the node it leads to (carries the □ NAG when the PGN marked it).
 */
export function isForcedReply(
	node: RepertoireNode,
	edge: Edge,
	child: RepertoireNode | undefined
): boolean {
	if (edge.onlyMove?.forced) return true;
	if (child?.nags?.includes(NAG_ONLY_MOVE)) return true;
	const f = edge.frequency;
	if (f && f.total >= FORCED_MIN_GAMES && f.games / f.total >= FORCED_SHARE) return true;
	return legalMoveCount(node.fenKey) === 1;
}

function liveChildren(node: RepertoireNode | undefined): Edge[] {
	return node ? node.children.filter((e) => !e.disabled) : [];
}

/**
 * The user's next card position when the opponent's reply to `userEdge` is
 * forced, else null. Pure.
 */
export function forcedNextKey(nodes: Map<string, RepertoireNode>, userEdge: Edge): string | null {
	const oppNode = nodes.get(userEdge.toFenKey);
	const replies = liveChildren(oppNode);
	if (!oppNode || replies.length !== 1) return null;
	const reply = replies[0];
	const next = nodes.get(reply.toFenKey);
	if (!isForcedReply(oppNode, reply, next)) return null;
	// Only a position where the user has a prepared move holds a card.
	if (liveChildren(next).length === 0) return null;
	return reply.toFenKey;
}

export interface ForcedRuns {
	/** User card position → the next card position in its forced run. */
	next: Map<string, string>;
	/** Reverse of `next`. */
	prev: Map<string, string>;
}

/**
 * Forced links between the user's card positions reachable from `rootKey`.
 * A card links forward only when the user has a single live prepared move
 * there (with several there's no single line to follow). Runs are cut every
 * MAX_FORCED_RUN moves and never loop on a transposition. Pure.
 */
export function forcedRuns(
	nodes: Map<string, RepertoireNode>,
	rootKey: string,
	userColor: Color
): ForcedRuns {
	const next = new Map<string, string>();
	const prev = new Map<string, string>();
	const seen = new Set<string>([rootKey]);
	const queue = [rootKey];
	for (let i = 0; i < queue.length; i++) {
		const node = nodes.get(queue[i]);
		if (!node) continue;
		const live = liveChildren(node);
		if (colorToMove(node.fenKey) === userColor && live.length === 1) {
			const to = forcedNextKey(nodes, live[0]);
			if (to && to !== node.fenKey && !prev.has(to)) {
				next.set(node.fenKey, to);
				prev.set(to, node.fenKey);
			}
		}
		for (const e of node.children) {
			if (seen.has(e.toFenKey)) continue;
			seen.add(e.toFenKey);
			queue.push(e.toFenKey);
		}
	}
	// Break any cycle (transpositions back into the run) and cap run length.
	// A cut makes the cut-off remainder a run of its own, with a new head.
	const heads = [...next.keys()].filter((k) => !prev.has(k));
	const visited = new Set<string>();
	for (let h = 0; h < heads.length; h++) {
		let len = 1;
		let k = heads[h];
		visited.add(k);
		for (let to = next.get(k); to !== undefined; to = next.get(k)) {
			if (visited.has(to) || len >= MAX_FORCED_RUN) {
				next.delete(k);
				prev.delete(to);
				if (!visited.has(to)) heads.push(to);
				break;
			}
			visited.add(to);
			len++;
			k = to;
		}
	}
	// Whatever is left unvisited sits on a pure cycle with no head: unlink.
	for (const k of [...next.keys()]) {
		if (visited.has(k)) continue;
		const to = next.get(k)!;
		next.delete(k);
		prev.delete(to);
	}
	return { next, prev };
}

/** Card positions after `key` in its forced run, in order. */
export function runAfter(runs: ForcedRuns, key: string): string[] {
	const out: string[] = [];
	for (let k = runs.next.get(key); k !== undefined; k = runs.next.get(k)) out.push(k);
	return out;
}

/** Card positions before `key` in its forced run, nearest first. */
export function runBefore(runs: ForcedRuns, key: string): string[] {
	const out: string[] = [];
	for (let k = runs.prev.get(key); k !== undefined; k = runs.prev.get(k)) out.push(k);
	return out;
}
