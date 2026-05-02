import { describe, expect, it } from 'vitest';
import type { Edge, RepertoireNode } from '$lib/types';
import { pathToFenKey, furthestNonBranchingFenKey, countDescendantEdges } from './traversal';

function node(fenKey: string, children: Edge[]): RepertoireNode {
	return { repertoireId: 'r', fenKey, children };
}

function edge(san: string, toFenKey: string): Edge {
	return { san, uci: 'xxxx', toFenKey };
}

describe('pathToFenKey', () => {
	it('returns an empty path when target equals root', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('root', node('root', []));
		expect(pathToFenKey(m, 'root', 'root')).toEqual([]);
	});

	it('returns a 3-move mainline in order', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b')]));
		m.set('b', node('b', [edge('Nf3', 'c')]));
		m.set('c', node('c', []));
		const path = pathToFenKey(m, 'r', 'c');
		expect(path?.map((e) => e.san)).toEqual(['e4', 'e5', 'Nf3']);
	});

	it('picks the shorter of two move orders on transposition', () => {
		// r -> A via [1.e4 c5 2.Nf3 d6] (4 plies)
		// r -> A via [1.Nf3 d6 2.e4 c5]  (also 4 plies)
		// r -> A via [1.e4 c5 2.Nf3 d6 3.e5 d5 ...] (longer) — BFS picks 4.
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a1'), edge('Nf3', 'b1')]));
		m.set('a1', node('a1', [edge('c5', 'a2')]));
		m.set('a2', node('a2', [edge('Nf3', 'a3')]));
		m.set('a3', node('a3', [edge('d6', 'A'), edge('Nc6', 'long')]));
		m.set('b1', node('b1', [edge('d6', 'b2')]));
		m.set('b2', node('b2', [edge('e4', 'b3')]));
		m.set('b3', node('b3', [edge('c5', 'A')]));
		m.set('A', node('A', []));
		m.set('long', node('long', [edge('Nc3', 'A')]));
		const path = pathToFenKey(m, 'r', 'A');
		expect(path).not.toBeNull();
		expect(path!.length).toBe(4);
	});

	it('returns null when target is unreachable', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', []));
		expect(pathToFenKey(m, 'r', 'missing')).toBeNull();
	});

	it('does not hang on a cycle', () => {
		const m = new Map<string, RepertoireNode>();
		// r <-> a cycle; target 'z' is unreachable.
		m.set('r', node('r', [edge('m1', 'a')]));
		m.set('a', node('a', [edge('m2', 'r')]));
		expect(pathToFenKey(m, 'r', 'z')).toBeNull();
	});

	it('furthestNonBranchingFenKey returns the first branching node on the trunk', () => {
		const m = new Map<string, RepertoireNode>();
		// r -e4-> a -e5-> b, then b branches into Nf3 and d4.
		// Trunk ends at `b`; that's the furthest step you can reach via
		// a single-child walk from the root.
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b')]));
		m.set('b', node('b', [edge('Nf3', 'c'), edge('d4', 'd')]));
		m.set('c', node('c', []));
		m.set('d', node('d', []));
		expect(furthestNonBranchingFenKey(m, 'r')).toBe('b');
	});

	it('furthestNonBranchingFenKey returns root unchanged when root itself branches', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a'), edge('d4', 'b')]));
		m.set('a', node('a', []));
		m.set('b', node('b', []));
		expect(furthestNonBranchingFenKey(m, 'r')).toBe('r');
	});

	it('furthestNonBranchingFenKey returns the leaf when the tree is a single line', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b')]));
		m.set('b', node('b', []));
		expect(furthestNonBranchingFenKey(m, 'r')).toBe('b');
	});

	it('furthestNonBranchingFenKey does not hang on a cycle', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('m1', 'a')]));
		m.set('a', node('a', [edge('m2', 'r')]));
		// Cycle: root has one child, child has one child back to root.
		// Should terminate and return either node (whichever is visited second).
		expect(furthestNonBranchingFenKey(m, 'r')).toBeDefined();
	});

	it('handles a cycle that still leads to the target', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('m1', 'a')]));
		m.set('a', node('a', [edge('back', 'r'), edge('fwd', 't')]));
		m.set('t', node('t', []));
		const path = pathToFenKey(m, 'r', 't');
		expect(path?.map((e) => e.san)).toEqual(['m1', 'fwd']);
	});
});

describe('countDescendantEdges', () => {
	it('returns 0 for a leaf', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('a', node('a', []));
		expect(countDescendantEdges(m, 'a')).toBe(0);
	});

	it('counts every edge in a linear chain', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('a', node('a', [edge('e4', 'b')]));
		m.set('b', node('b', [edge('e5', 'c')]));
		m.set('c', node('c', [edge('Nf3', 'd')]));
		m.set('d', node('d', []));
		expect(countDescendantEdges(m, 'a')).toBe(3);
	});

	it('counts branching edges', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('a', node('a', [edge('e4', 'b'), edge('d4', 'c')]));
		m.set('b', node('b', [edge('e5', 'd')]));
		m.set('c', node('c', []));
		m.set('d', node('d', []));
		expect(countDescendantEdges(m, 'a')).toBe(3);
	});

	it('counts a transposing edge once even when two parents reach the same child', () => {
		// Two parents both point at 't'; t is reached twice but its outgoing
		// edge should still only be counted once.
		const m = new Map<string, RepertoireNode>();
		m.set('a', node('a', [edge('m1', 'b'), edge('m2', 'c')]));
		m.set('b', node('b', [edge('x', 't')]));
		m.set('c', node('c', [edge('y', 't')]));
		m.set('t', node('t', [edge('z', 'leaf')]));
		m.set('leaf', node('leaf', []));
		// Edges: a→b, a→c, b→t, c→t, t→leaf  → 5
		expect(countDescendantEdges(m, 'a')).toBe(5);
	});

	it('does not hang on a cycle', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('m1', 'a')]));
		m.set('a', node('a', [edge('back', 'r')]));
		// r→a, a→r — both counted, then cycle stops.
		expect(countDescendantEdges(m, 'r')).toBe(2);
	});

	it('returns 0 for an unknown key', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('a', node('a', []));
		expect(countDescendantEdges(m, 'missing')).toBe(0);
	});
});
