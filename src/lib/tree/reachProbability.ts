import { colorToMove } from '$lib/chess/fen';
import type { Color, Edge, RepertoireNode } from '$lib/types';

/**
 * Pseudo-games added to every observed frequency, split evenly across the
 * position's prepared replies. Keeps a handful of games deep in the tree
 * (e.g. 1 of 2) from swinging a whole subtree to 0 or 100%.
 */
const SMOOTHING_GAMES = 20;

/**
 * Estimated share of games in which the opponent plays each prepared reply
 * at `node`:
 *  - with counts: (games + k/n) / (total + k), n = prepared replies;
 *  - without counts: an even split of whatever share the replies that do
 *    have counts leave over (all of it when none do) — so a repertoire with
 *    no data at all ranks exactly breadth-first.
 * Shares needn't sum to 1: the opponent can play moves you haven't prepared.
 */
export function opponentMoveShares(node: RepertoireNode): Map<Edge, number> {
	const n = node.children.length;
	const shares = new Map<Edge, number>();
	let knownSum = 0;
	const unknown: Edge[] = [];
	for (const e of node.children) {
		const f = e.frequency;
		if (f && f.total > 0) {
			const s = (f.games + SMOOTHING_GAMES / n) / (f.total + SMOOTHING_GAMES);
			shares.set(e, s);
			knownSum += s;
		} else {
			unknown.push(e);
		}
	}
	if (unknown.length > 0) {
		const each = knownSum === 0 ? 1 / n : Math.max(0, 1 - knownSum) / unknown.length;
		for (const e of unknown) shares.set(e, each);
	}
	return shares;
}

/**
 * Probability of reaching each position from `rootKey` if you play your
 * prepared moves: the product of opponent-reply shares along the most
 * likely route (a transposition counts via its best route). Your own moves
 * multiply by 1. Positions not reachable from the root are absent.
 *
 * Max-product paths (every factor ≤ 1), so a Dijkstra-style search: a
 * position is final once it's the most likely unsettled one.
 */
export function reachProbabilities(
	nodes: Map<string, RepertoireNode>,
	rootKey: string,
	userColor: Color
): Map<string, number> {
	const best = new Map<string, number>([[rootKey, 1]]);
	const settled = new Set<string>();
	const heap: [number, string][] = [[1, rootKey]];
	const push = (item: [number, string]) => {
		heap.push(item);
		let i = heap.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (heap[p][0] >= heap[i][0]) break;
			[heap[p], heap[i]] = [heap[i], heap[p]];
			i = p;
		}
	};
	const pop = (): [number, string] => {
		const top = heap[0];
		const last = heap.pop()!;
		if (heap.length > 0) {
			heap[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < heap.length && heap[l][0] > heap[m][0]) m = l;
				if (r < heap.length && heap[r][0] > heap[m][0]) m = r;
				if (m === i) break;
				[heap[m], heap[i]] = [heap[i], heap[m]];
				i = m;
			}
		}
		return top;
	};

	while (heap.length > 0) {
		const [p, key] = pop();
		if (settled.has(key)) continue;
		settled.add(key);
		const node = nodes.get(key);
		if (!node || node.children.length === 0) continue;
		const opponent = colorToMove(key) !== userColor;
		const shares = opponent ? opponentMoveShares(node) : null;
		for (const e of node.children) {
			const q = p * (shares ? (shares.get(e) ?? 0) : 1);
			if (q > (best.get(e.toFenKey) ?? -1)) {
				best.set(e.toFenKey, q);
				push([q, e.toFenKey]);
			}
		}
	}
	return best;
}
