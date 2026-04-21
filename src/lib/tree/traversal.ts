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
