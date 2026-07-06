import { describe, expect, it } from 'vitest';
import type { Edge, RepertoireNode } from '$lib/types';
import { buildGraphLayout } from './graphLayout';

function node(fenKey: string, children: Edge[]): RepertoireNode {
	return { repertoireId: 'r', fenKey, children };
}
function edge(san: string, toFenKey: string, disabled = false): Edge {
	return { san, uci: 'xxxx', toFenKey, ...(disabled ? { disabled: true } : {}) };
}

describe('buildGraphLayout', () => {
	it('is empty for an empty graph', () => {
		const m = new Map<string, RepertoireNode>();
		expect(buildGraphLayout(m, 'r')).toEqual({
			nodes: [],
			edges: [],
			maxPly: 0,
			rows: 1,
			capped: false
		});
	});

	it('places a linear line in one column per ply', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b')]));
		m.set('b', node('b', []));
		const { nodes, maxPly } = buildGraphLayout(m, 'r');
		expect(nodes.map((n) => [n.fenKey, n.ply])).toEqual([
			['r', 0],
			['a', 1],
			['b', 2]
		]);
		expect(maxPly).toBe(2);
		// A pure chain stacks on a single row.
		expect(new Set(nodes.map((n) => n.row))).toEqual(new Set([0]));
	});

	it('centres a parent between its two children', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b'), edge('c5', 'c')]));
		m.set('b', node('b', []));
		m.set('c', node('c', []));
		const { nodes } = buildGraphLayout(m, 'r');
		const byKey = new Map(nodes.map((n) => [n.fenKey, n]));
		expect(byKey.get('b')!.row).toBe(0);
		expect(byKey.get('c')!.row).toBe(1);
		// Parent `a` (and root) sit halfway between rows 0 and 1.
		expect(byKey.get('a')!.row).toBe(0.5);
		expect(byKey.get('r')!.row).toBe(0.5);
	});

	it('flags a transposition edge and places the shared position once', () => {
		// e4 and d4 both reach X; the d4 arrival is a transposition edge.
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'e4p'), edge('d4', 'd4p')]));
		m.set('e4p', node('e4p', [edge('d5', 'X')]));
		m.set('d4p', node('d4p', [edge('e5?!', 'X')]));
		m.set('X', node('X', []));
		const { nodes, edges } = buildGraphLayout(m, 'r');
		expect(nodes.filter((n) => n.fenKey === 'X')).toHaveLength(1);
		const toX = edges.filter((e) => e.toFenKey === 'X');
		expect(toX).toHaveLength(2);
		expect(toX.filter((e) => e.transposition)).toHaveLength(1);
		expect(toX.filter((e) => !e.transposition)).toHaveLength(1);
	});

	it('terminates on a cycle, recording the back edge as a transposition', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('Nf3', 'a')]));
		m.set('a', node('a', [edge('Ng1', 'r')]));
		const { nodes, edges } = buildGraphLayout(m, 'r');
		expect(nodes.map((n) => n.fenKey).sort()).toEqual(['a', 'r']);
		const back = edges.find((e) => e.toFenKey === 'r');
		expect(back?.transposition).toBe(true);
	});

	it('does not report capped when the store holds orphan (unreachable) nodes', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', []));
		// An orphan position not reachable from the root (e.g. left by a delete).
		m.set('orphan', node('orphan', [edge('x', 'y')]));
		m.set('y', node('y', []));
		const { nodes, capped } = buildGraphLayout(m, 'r');
		expect(capped).toBe(false);
		expect(nodes.map((n) => n.fenKey).sort()).toEqual(['a', 'r']);
	});

	it('reorders sibling lines to shorten a transposition link', () => {
		// n1 branches into nb (→ nX) then a big na subtree; n2 transposes into
		// nX. In stored order nX lands far from n2's row; the reorder pass should
		// pull nb's branch down next to n2, shortening the link.
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('m1', 'n1'), edge('m2', 'n2')]));
		m.set('n1', node('n1', [edge('b', 'nb'), edge('a', 'na')]));
		m.set('nb', node('nb', [edge('x', 'nX')]));
		m.set('nX', node('nX', []));
		m.set('na', node('na', [edge('la', 'la'), edge('lb', 'lb'), edge('lc', 'lc')]));
		m.set('la', node('la', []));
		m.set('lb', node('lb', []));
		m.set('lc', node('lc', []));
		m.set('n2', node('n2', [edge('t', 'nX')]));

		const linkLen = (L: ReturnType<typeof buildGraphLayout>) => {
			const rows = new Map(L.nodes.map((n) => [n.fenKey, n.row]));
			let s = 0;
			for (const e of L.edges) {
				if (e.transposition)
					s += Math.abs((rows.get(e.fromFenKey) ?? 0) - (rows.get(e.toFenKey) ?? 0));
			}
			return s;
		};

		const plain = buildGraphLayout(m, 'r', { reorderTranspositions: false });
		const tidy = buildGraphLayout(m, 'r');
		expect(linkLen(tidy)).toBeLessThan(linkLen(plain));
		// Same set of positions either way — only the vertical order changed.
		expect(tidy.nodes.map((n) => n.fenKey).sort()).toEqual(plain.nodes.map((n) => n.fenKey).sort());
	});

	it('never lengthens transposition links relative to the plain layout', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'e4p'), edge('d4', 'd4p')]));
		m.set('e4p', node('e4p', [edge('d5', 'X')]));
		m.set('d4p', node('d4p', [edge('e5?!', 'X')]));
		m.set('X', node('X', []));
		const linkLen = (L: ReturnType<typeof buildGraphLayout>) => {
			const rows = new Map(L.nodes.map((n) => [n.fenKey, n.row]));
			let s = 0;
			for (const e of L.edges) {
				if (e.transposition)
					s += Math.abs((rows.get(e.fromFenKey) ?? 0) - (rows.get(e.toFenKey) ?? 0));
			}
			return s;
		};
		const plain = buildGraphLayout(m, 'r', { reorderTranspositions: false });
		const tidy = buildGraphLayout(m, 'r');
		expect(linkLen(tidy)).toBeLessThanOrEqual(linkLen(plain));
	});

	it('collapses a subtree to a single node and reports the hidden count', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b'), edge('c5', 'c')]));
		m.set('b', node('b', [edge('Nf3', 'd')]));
		m.set('c', node('c', []));
		m.set('d', node('d', []));

		const full = buildGraphLayout(m, 'r');
		expect(full.nodes).toHaveLength(5);
		// Every branching node advertises that it can be collapsed.
		expect(full.nodes.find((n) => n.fenKey === 'a')!.hasChildren).toBe(true);
		expect(full.nodes.find((n) => n.fenKey === 'a')!.collapsed).toBe(false);

		const collapsed = buildGraphLayout(m, 'r', { collapsed: new Set(['a']) });
		// a stays; its subtree (b, c, d) is hidden.
		expect(collapsed.nodes.map((n) => n.fenKey).sort()).toEqual(['a', 'r']);
		const a = collapsed.nodes.find((n) => n.fenKey === 'a')!;
		expect(a.collapsed).toBe(true);
		expect(a.hiddenCount).toBe(3);
		// No dangling edges into the hidden subtree.
		for (const e of collapsed.edges) {
			expect(['r', 'a']).toContain(e.fromFenKey);
			expect(['r', 'a']).toContain(e.toFenKey);
		}
		// Columns shrink to the visible depth.
		expect(collapsed.maxPly).toBe(1);
	});

	it('carries the disabled flag onto edges', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a', true)]));
		m.set('a', node('a', []));
		const { edges } = buildGraphLayout(m, 'r');
		expect(edges[0].disabled).toBe(true);
	});

	it('truncates a large graph at the cap without dangling edges', () => {
		// A wide fan of 20 leaves from the root.
		const kids: Edge[] = [];
		const m = new Map<string, RepertoireNode>();
		for (let i = 0; i < 20; i++) {
			kids.push(edge(`m${i}`, `n${i}`));
			m.set(`n${i}`, node(`n${i}`, []));
		}
		m.set('r', node('r', kids));
		const { nodes, edges, capped } = buildGraphLayout(m, 'r', { maxNodes: 5 });
		// The cap bit — not every leaf was placed, and it's reported.
		expect(nodes.length).toBeLessThan(21);
		expect(capped).toBe(true);
		// Every surviving edge connects two placed nodes.
		const keys = new Set(nodes.map((n) => n.fenKey));
		for (const e of edges) {
			expect(keys.has(e.fromFenKey)).toBe(true);
			expect(keys.has(e.toFenKey)).toBe(true);
		}
	});
});
