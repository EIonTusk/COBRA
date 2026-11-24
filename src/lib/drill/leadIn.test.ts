import { describe, expect, it } from 'vitest';
import type { Edge, RepertoireNode } from '$lib/types';
import { planLeadIn } from './leadIn';

const e = (to: string): Edge => ({ san: to, uci: to, toFenKey: to });
const n = (fenKey: string, ...kids: string[]): RepertoireNode => ({
	repertoireId: 'r',
	fenKey,
	children: kids.map(e)
});

//   root ─ a ─ b ┬ c ─ d ─ f ─ g
//                └ x ─ y
const nodes = new Map(
	[
		n('root', 'a'),
		n('a', 'b'),
		n('b', 'c', 'x'),
		n('c', 'd'),
		n('d', 'f'),
		n('f', 'g'),
		n('g'),
		n('x', 'y'),
		n('y')
	].map((node) => [node.fenKey, node])
);
const pathTo = (...keys: string[]) => keys.map(e);
const toD = pathTo('a', 'b', 'c', 'd');

describe('planLeadIn', () => {
	it('stays when the board already shows the card', () => {
		expect(planLeadIn(nodes, toD, 'root', 'd', 'd')).toEqual({ kind: 'stay' });
	});

	it('plays only the remaining moves from a position on the way', () => {
		expect(planLeadIn(nodes, toD, 'root', 'd', 'b')).toEqual({ kind: 'tail', from: 2 });
	});

	it('plays the whole line from the root or from an empty board', () => {
		expect(planLeadIn(nodes, toD, 'root', 'd', 'root')).toEqual({ kind: 'full' });
		expect(planLeadIn(nodes, toD, 'root', 'd', null)).toEqual({ kind: 'full' });
	});

	it('steps back when the card was just answered (up to two plies past it)', () => {
		expect(planLeadIn(nodes, toD, 'root', 'd', 'f')).toEqual({ kind: 'rewind' });
		expect(planLeadIn(nodes, toD, 'root', 'd', 'g')).toEqual({ kind: 'rewind' });
	});

	// The bug: a card seen earlier in the session (deferred Train pass) was
	// snapped to with no lead-in, even from an unrelated line.
	it('plays the line in full when the board is on another line', () => {
		expect(planLeadIn(nodes, toD, 'root', 'd', 'y')).toEqual({ kind: 'full' });
	});

	it('plays the line in full when the board is far past the card on the same line', () => {
		expect(planLeadIn(nodes, pathTo('a', 'b'), 'root', 'b', 'f')).toEqual({ kind: 'full' });
	});
});
