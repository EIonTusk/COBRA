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
 * Count the edges reachable by descending children from `startKey` —
 * the size of the subtree rooted at that position. Cycle-safe: each
 * (parent → child) edge is counted at most once even when transpositions
 * make the graph cyclic. Used to surface the blast radius of pruning an
 * edge ("delete this and N moves below it").
 *
 * Note: this counts the subtree *as drawn from `startKey`*, not the set
 * of nodes that would become unreachable from the root if a particular
 * incoming edge were cut. A descendant that also transposes into the
 * main line stays reachable in practice; we still include it here
 * because the user mental model is "everything I built under this
 * move", which matches subtree edges.
 */
export function countDescendantEdges(nodes: Map<string, RepertoireNode>, startKey: string): number {
	const visited = new Set<string>([startKey]);
	const queue: string[] = [startKey];
	let edges = 0;
	while (queue.length > 0) {
		const key = queue.shift()!;
		const node = nodes.get(key);
		if (!node) continue;
		for (const edge of node.children) {
			edges++;
			if (visited.has(edge.toFenKey)) continue;
			visited.add(edge.toFenKey);
			queue.push(edge.toFenKey);
		}
	}
	return edges;
}

/**
 * Auto-detected starting position for game analysis: walk the trunk
 * down from the root while each node has exactly one child, stopping
 * at the first node that branches (2+ children) or dead-ends (leaf).
 * That stopping node is the furthest point on the linear trunk —
 * where the repertoire's first real choice appears, or where the
 * trunk simply runs out.
 *
 * Examples:
 *  - A rep whose mainline is 1.e4 e5 2.Nf3 {Nc6,Nf6,d6}: walks
 *    root→e4→e5→Nf3 and returns "after 2.Nf3" (branching).
 *  - A rep built around 1.e4 and 1.d4 at the root: root itself
 *    branches, returns root.
 *  - A rep with a single linear line: returns the leaf.
 *
 * Guards against cycles (three-fold repetition can create loops).
 */
export function furthestNonBranchingFenKey(
	nodes: Map<string, RepertoireNode>,
	rootKey: string
): string {
	const visited = new Set<string>();
	let current = rootKey;
	while (!visited.has(current)) {
		visited.add(current);
		const node = nodes.get(current);
		// Stop at the first node whose children count isn't 1 — either
		// a leaf (0) or a branching node (2+). That *is* the furthest
		// trunk position: you can't make a single-child step past it.
		if (!node || node.children.length !== 1) return current;
		current = node.children[0].toFenKey;
	}
	return current;
}
