import type { Edge, RepertoireNode } from '$lib/types';

/**
 * Breadth-first search for the shortest path of edges from `rootKey` to
 * `targetKey` through the repertoire's FEN-keyed graph. Returns `null` when
 * the target isn't reachable from the root. Guards against cycles
 * (three-fold repetition positions can make the graph cyclic).
 *
 * Callers supply `nodesMap(rep.id)` — a map keyed by fenKey.
 */
export function pathToFenKey(
	nodes: Map<string, RepertoireNode>,
	rootKey: string,
	targetKey: string
): Edge[] | null {
	if (rootKey === targetKey) return [];

	const visited = new Set<string>([rootKey]);
	const queue: Array<{ key: string; path: Edge[] }> = [{ key: rootKey, path: [] }];

	while (queue.length > 0) {
		const { key, path } = queue.shift()!;
		const node = nodes.get(key);
		if (!node) continue;
		for (const edge of node.children) {
			if (visited.has(edge.toFenKey)) continue;
			const next: Edge[] = [...path, edge];
			if (edge.toFenKey === targetKey) return next;
			visited.add(edge.toFenKey);
			queue.push({ key: edge.toFenKey, path: next });
		}
	}

	return null;
}

/**
 * Walk down from `rootKey` following the unique child as long as exactly one
 * child exists, stopping at the first branching (or leaf) node encountered.
 * Used as the default "starting position" for game analysis: a repertoire
 * whose opening moves are a fixed sequence (e.g. 1.e4 e5 2.Nf3 Nc6 …) should
 * only start flagging mistakes once that prefix is on the board, so games
 * starting from a different opening don't get spurious "off-book" flags.
 *
 * Guards against cycles (three-fold repetition positions can create loops).
 * If the root itself already branches (0 or 2+ children) it is returned
 * unchanged.
 */
export function nearestBranchingFenKey(
	nodes: Map<string, RepertoireNode>,
	rootKey: string
): string {
	const visited = new Set<string>();
	let key = rootKey;
	while (!visited.has(key)) {
		visited.add(key);
		const node = nodes.get(key);
		if (!node || node.children.length !== 1) return key;
		key = node.children[0].toFenKey;
	}
	return key;
}
