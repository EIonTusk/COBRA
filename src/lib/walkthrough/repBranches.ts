import { fenAfterMove } from '$lib/chess/position';
import type { RepertoireNode } from '$lib/types';

interface RepWithFen {
	rootFen: string;
	rootFenKey: string;
	startingFenKey?: string | null;
	nodes: Map<string, RepertoireNode>;
}

/**
 * Walk down from the rep's startingFenKey (or rootFenKey) through any
 * unique-child prefix and stop at the first position with multiple children
 * — that's the position where the rep meaningfully branches into separate
 * lines. Returns null if the start position is missing or the walk loops
 * back on itself (defensive against malformed transpositions).
 */
export function findBranchPoint(rep: {
	nodes: Map<string, RepertoireNode>;
	rootFenKey: string;
	startingFenKey?: string | null;
}): string | null {
	const start = rep.startingFenKey ?? rep.rootFenKey;
	let cur = start;
	const seen = new Set<string>();
	while (!seen.has(cur)) {
		seen.add(cur);
		const node = rep.nodes.get(cur);
		if (!node) return null;
		if (node.children.length !== 1) return cur;
		cur = node.children[0].toFenKey;
	}
	return cur;
}

/**
 * Resolve any tree fenKey to its full FEN by BFS-walking edges from the
 * rep root. Cheap: the explored set is bounded by the rep's tree size,
 * which is already in memory.
 */
export function fenForKeyInRep(rep: RepWithFen, targetKey: string): string | null {
	if (rep.rootFenKey === targetKey) return rep.rootFen;
	const queue: Array<{ fen: string; fenKey: string }> = [
		{ fen: rep.rootFen, fenKey: rep.rootFenKey }
	];
	const visited = new Set<string>();
	while (queue.length) {
		const cur = queue.shift()!;
		if (visited.has(cur.fenKey)) continue;
		visited.add(cur.fenKey);
		const node = rep.nodes.get(cur.fenKey);
		if (!node) continue;
		for (const edge of node.children) {
			let nextFen: string;
			try {
				nextFen = fenAfterMove(cur.fen, edge);
			} catch {
				continue;
			}
			if (edge.toFenKey === targetKey) return nextFen;
			queue.push({ fen: nextFen, fenKey: edge.toFenKey });
		}
	}
	return null;
}
