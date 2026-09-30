import { describe, expect, it } from 'vitest';
import type { Edge, MoveFrequency, RepertoireNode } from '$lib/types';
import { opponentMoveShares, reachProbabilities } from './reachProbability';

// Keys end in " w"/" b" so colorToMove reads them. White repertoire: the
// root is ours, " b" positions are the opponent's.
function freq(games: number, total: number): MoveFrequency {
	return { games, total, source: 'lichess', fetchedAt: 0 };
}
function edge(to: string, frequency?: MoveFrequency): Edge {
	return { san: to, uci: to, toFenKey: to, frequency };
}
function nodes(list: [string, Edge[]][]): Map<string, RepertoireNode> {
	return new Map(list.map(([k, c]) => [k, { repertoireId: 'r', fenKey: k, children: c }]));
}

describe('opponentMoveShares', () => {
	it('splits evenly when there is no data', () => {
		const n = { repertoireId: 'r', fenKey: 'x b', children: [edge('a w'), edge('b w')] };
		expect([...opponentMoveShares(n).values()]).toEqual([0.5, 0.5]);
	});

	it('uses smoothed counts, and gives unknown replies the leftover share', () => {
		const n = {
			repertoireId: 'r',
			fenKey: 'x b',
			children: [edge('a w', freq(7000, 10000)), edge('b w')]
		};
		const s = opponentMoveShares(n);
		expect(s.get(n.children[0])).toBeCloseTo(0.7, 2);
		expect(s.get(n.children[1])).toBeCloseTo(0.3, 2);
	});

	it('keeps a few games deep in the tree from dominating', () => {
		const n = {
			repertoireId: 'r',
			fenKey: 'x b',
			children: [edge('a w', freq(2, 2)), edge('b w', freq(0, 2))]
		};
		const s = opponentMoveShares(n);
		expect(s.get(n.children[0])).toBeLessThan(0.6);
		expect(s.get(n.children[1])).toBeGreaterThan(0.4);
	});
});

describe('reachProbabilities', () => {
	it('multiplies opponent shares along the line; own moves count as 1', () => {
		const tree = nodes([
			['r w', [edge('o b')]],
			['o b', [edge('c w', freq(800, 1000)), edge('s w', freq(20, 1000))]],
			['c w', [edge('c2 b')]],
			['c2 b', [edge('cc w', freq(500, 1000))]],
			['s w', []],
			['cc w', []]
		]);
		const p = reachProbabilities(tree, 'r w', 'white');
		expect(p.get('o b')).toBe(1);
		expect(p.get('c w')).toBeCloseTo(0.8, 1);
		expect(p.get('s w')).toBeCloseTo(0.03, 1);
		// A deep common line outranks a shallow rare one.
		expect(p.get('cc w')!).toBeGreaterThan(p.get('s w')!);
	});

	it('takes the best route to a transposed position', () => {
		const tree = nodes([
			['r w', [edge('o b')]],
			['o b', [edge('a w', freq(900, 1000)), edge('b w', freq(50, 1000))]],
			['a w', [edge('a2 b')]],
			['b w', [edge('t b')]],
			['a2 b', [edge('t w', freq(900, 1000))]],
			['t b', [edge('t w', freq(10, 1000))]],
			['t w', []]
		]);
		const p = reachProbabilities(tree, 'r w', 'white');
		expect(p.get('t w')).toBeCloseTo(0.9 * 0.9, 1);
	});

	it('is plain breadth-first without data: never higher below than above', () => {
		const tree = nodes([
			['r w', [edge('o b')]],
			['o b', [edge('a w'), edge('b w')]],
			['a w', [edge('a2 b')]],
			['a2 b', [edge('x w'), edge('y w')]],
			['b w', []],
			['x w', []],
			['y w', []]
		]);
		const p = reachProbabilities(tree, 'r w', 'white');
		expect(p.get('a w')).toBe(0.5);
		expect(p.get('x w')).toBe(0.25);
	});
});
