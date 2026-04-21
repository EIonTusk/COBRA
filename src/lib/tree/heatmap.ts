/**
 * Mistake heatmap for a repertoire. For each fenKey in the tree we track:
 *   - `own`: how many pending StoredMistake rows sit exactly at this
 *     position (the user's real games deviated from the tree here).
 *   - `subtree`: `own` plus the sum of `own` across every descendant —
 *     tells you which *branch* is bleeding, not just which leaf.
 *
 * Subtree is computed DFS-memoized so transpositions (where two parents
 * reach the same child) don't inflate the count: each node's own weight
 * is credited exactly once regardless of how many parents link to it.
 */
import { listMistakes } from '$lib/storage/mistakes';
import type { RepertoireNode, StoredMistake } from '$lib/types';

export interface HeatmapEntry {
	own: number;
	subtree: number;
}

export type Heatmap = Map<string, HeatmapEntry>;

export async function computeMistakeHeatmap(
	repertoireId: string,
	nodes: Map<string, RepertoireNode>,
	opts: { includeCorrected?: boolean } = {}
): Promise<Heatmap> {
	const mistakes = await listMistakes({ repertoireId });
	return buildHeatmap(nodes, mistakes, opts);
}

export function buildHeatmap(
	nodes: Map<string, RepertoireNode>,
	mistakes: StoredMistake[],
	opts: { includeCorrected?: boolean } = {}
): Heatmap {
	const own = new Map<string, number>();
	for (const m of mistakes) {
		if (m.status === 'dismissed') continue;
		if (!opts.includeCorrected && m.status !== 'pending') continue;
		own.set(m.fenKey, (own.get(m.fenKey) ?? 0) + 1);
	}

	const subtree = new Map<string, number>();
	// Visiting is set-based memoization; combined with the set we also
	// avoid cycles (three-fold-repetition graphs are possible).
	const visited = new Set<string>();
	function walk(key: string): number {
		if (subtree.has(key)) return subtree.get(key)!;
		if (visited.has(key)) return own.get(key) ?? 0;
		visited.add(key);
		let total = own.get(key) ?? 0;
		const node = nodes.get(key);
		if (node) {
			for (const edge of node.children) total += walk(edge.toFenKey);
		}
		subtree.set(key, total);
		return total;
	}

	const out: Heatmap = new Map();
	for (const key of nodes.keys()) {
		const s = walk(key);
		const o = own.get(key) ?? 0;
		if (s === 0 && o === 0) continue;
		out.set(key, { own: o, subtree: s });
	}
	return out;
}

/**
 * Top `limit` subtrees by weight, skipping the root. Each entry is the
 * shallowest fenKey of its hotspot cluster: we walk the tree BFS from
 * root and, once we reach a node whose subtree count is "the bulk" of
 * the weight, stop descending down that branch for further picks.
 *
 * In practice this prevents the list from being dominated by deep
 * leaves that are all symptoms of the same bleeding branch higher up.
 */
export function topHotSpots(
	heatmap: Heatmap,
	nodes: Map<string, RepertoireNode>,
	rootKey: string,
	limit: number = 5
): Array<{ fenKey: string; own: number; subtree: number }> {
	const picked: Array<{ fenKey: string; own: number; subtree: number }> = [];
	const claimed = new Set<string>();
	// Candidates sorted by subtree count desc.
	const candidates = [...heatmap.entries()]
		.filter(([key]) => key !== rootKey)
		.map(([fenKey, e]) => ({ fenKey, own: e.own, subtree: e.subtree }))
		.sort((a, b) => b.subtree - a.subtree);

	for (const c of candidates) {
		if (picked.length >= limit) break;
		// Skip if an ancestor has already been picked — the hot spot is
		// already represented by the shallower node.
		if (isDescendantOfAny(c.fenKey, claimed, nodes, rootKey)) continue;
		picked.push(c);
		claimBranch(c.fenKey, claimed, nodes);
	}
	return picked;
}

function claimBranch(rootKey: string, claimed: Set<string>, nodes: Map<string, RepertoireNode>) {
	const stack = [rootKey];
	while (stack.length) {
		const k = stack.pop()!;
		if (claimed.has(k)) continue;
		claimed.add(k);
		const n = nodes.get(k);
		if (!n) continue;
		for (const e of n.children) stack.push(e.toFenKey);
	}
}

function isDescendantOfAny(
	target: string,
	roots: Set<string>,
	nodes: Map<string, RepertoireNode>,
	startKey: string
): boolean {
	// BFS from each claimed root; early-out if we ever hit `target`.
	if (roots.has(target)) return true;
	for (const r of roots) {
		const seen = new Set<string>([r]);
		const queue = [r];
		while (queue.length) {
			const k = queue.shift()!;
			const n = nodes.get(k);
			if (!n) continue;
			for (const e of n.children) {
				if (e.toFenKey === target) return true;
				if (seen.has(e.toFenKey)) continue;
				seen.add(e.toFenKey);
				queue.push(e.toFenKey);
			}
		}
	}
	void startKey;
	return false;
}
