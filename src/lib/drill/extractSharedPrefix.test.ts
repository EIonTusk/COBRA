import { describe, expect, it } from 'vitest';

import { extractSharedPrefixWalks } from './buildSegment';
import type { Card } from '$lib/types';

/**
 * Trie-based shared-prefix extraction is the load-bearing change behind
 * "drill the trunk first, then each line's unique tail." The cases below
 * pin the expected walk decomposition for representative repertoire
 * shapes — straight line, simple fork, nested fork, fully-disjoint
 * lines — so a future refactor that breaks the decomposition fails
 * loudly with a recognisable diff.
 */

function card(fenKey: string, isNew = false): Card {
	return {
		repertoireId: 'r',
		fenKey,
		expectedSan: 'x',
		fsrs: {
			due: new Date(0),
			stability: 0,
			difficulty: 0,
			elapsed_days: 0,
			scheduled_days: 0,
			reps: 0,
			lapses: 0,
			state: 0,
			last_review: undefined
		} as unknown as Card['fsrs'],
		lastReview: isNew ? undefined : 1,
		dueAt: 0
	};
}

function walkKeys(walk: Card[]): string[] {
	return walk.map((c) => c.fenKey);
}

function walks(result: { cards: Card[]; walkStarts: number[] }): string[][] {
	const out: string[][] = [];
	for (let w = 0; w < result.walkStarts.length; w++) {
		const start = result.walkStarts[w];
		const end = w + 1 < result.walkStarts.length ? result.walkStarts[w + 1] : result.cards.length;
		out.push(walkKeys(result.cards.slice(start, end)));
	}
	return out;
}

describe('extractSharedPrefixWalks', () => {
	it('returns nothing for an empty admit list', () => {
		const r = extractSharedPrefixWalks([], new Set());
		expect(r.cards).toEqual([]);
		expect(r.walkStarts).toEqual([]);
		expect(r.walkFenKeys).toEqual([]);
		expect(r.dueOriginalKeys.size).toBe(0);
	});

	it('emits a single-walk admit verbatim', () => {
		const w1 = [card('A'), card('B'), card('C')];
		const r = extractSharedPrefixWalks([w1], new Set(['C']));
		expect(walks(r)).toEqual([['A', 'B', 'C']]);
		expect([...r.dueOriginalKeys]).toEqual(['C']);
	});

	it('factors the shared prefix out of a simple two-walk fork', () => {
		// W1: A B C D       W2: A B C E F        →   [A,B,C] · [D] · [E,F]
		const w1 = [card('A'), card('B'), card('C'), card('D')];
		const w2 = [card('A'), card('B'), card('C'), card('E'), card('F')];
		const r = extractSharedPrefixWalks([w1, w2], new Set(['D', 'F']));
		expect(walks(r)).toEqual([['A', 'B', 'C'], ['D'], ['E', 'F']]);
		// Trunk cards aren't in the pool here, only the leaves are.
		expect([...r.dueOriginalKeys].sort()).toEqual(['D', 'F']);
	});

	it('handles nested forks — three walks, two depths of sharing', () => {
		// W1: A B C D       W2: A B C E F        W3: A B G H
		// Shared by all 3: A B
		// Shared by W1+W2 (after the fork at B): C
		// Unique tails: [D], [E,F], [G,H]
		const w1 = [card('A'), card('B'), card('C'), card('D')];
		const w2 = [card('A'), card('B'), card('C'), card('E'), card('F')];
		const w3 = [card('A'), card('B'), card('G'), card('H')];
		const r = extractSharedPrefixWalks([w1, w2, w3], new Set(['D', 'F', 'H']));
		expect(walks(r)).toEqual([['A', 'B'], ['C'], ['D'], ['E', 'F'], ['G', 'H']]);
	});

	it('shared branches drill before unique branches at the same fork', () => {
		// W1: A X Y       W2: A X Z       W3: A Q
		// At A's children: X (count=2) before Q (count=1)
		// Then at X's children: Y (count=1), Z (count=1) — emitted in
		// insertion order (sort is stable for equal counts).
		const w1 = [card('A'), card('X'), card('Y')];
		const w2 = [card('A'), card('X'), card('Z')];
		const w3 = [card('A'), card('Q')];
		const r = extractSharedPrefixWalks([w1, w2, w3], new Set(['Y', 'Z', 'Q']));
		expect(walks(r)).toEqual([['A'], ['X'], ['Y'], ['Z'], ['Q']]);
	});

	it('two fully-disjoint lines emit as two walks (no shared trunk)', () => {
		const w1 = [card('A'), card('B')];
		const w2 = [card('C'), card('D')];
		const r = extractSharedPrefixWalks([w1, w2], new Set(['B', 'D']));
		expect(walks(r).sort()).toEqual(
			[
				['A', 'B'],
				['C', 'D']
			].sort()
		);
	});

	it('walkFenKeys mirrors each emitted walk', () => {
		const w1 = [card('A'), card('B'), card('C')];
		const w2 = [card('A'), card('B'), card('D')];
		const r = extractSharedPrefixWalks([w1, w2], new Set(['C', 'D']));
		expect(r.walkFenKeys.length).toBe(r.walkStarts.length);
		expect([...r.walkFenKeys[0]].sort()).toEqual(['A', 'B']);
		expect([...r.walkFenKeys[1]]).toEqual(['C']);
		expect([...r.walkFenKeys[2]]).toEqual(['D']);
	});

	it('dueOriginalKeys covers every emitted card that was in the pool', () => {
		// Every card here is in the pool — including the shared trunk.
		const w1 = [card('A'), card('B'), card('C')];
		const w2 = [card('A'), card('B'), card('D')];
		const pool = new Set(['A', 'B', 'C', 'D']);
		const r = extractSharedPrefixWalks([w1, w2], pool);
		expect([...r.dueOriginalKeys].sort()).toEqual(['A', 'B', 'C', 'D']);
	});

	it('a card appears in exactly one emitted walk (no duplication)', () => {
		const w1 = [card('A'), card('B'), card('C'), card('D')];
		const w2 = [card('A'), card('B'), card('E')];
		const w3 = [card('A'), card('F')];
		const r = extractSharedPrefixWalks([w1, w2, w3], new Set());
		const seen = new Set<string>();
		for (const c of r.cards) {
			expect(seen.has(c.fenKey)).toBe(false);
			seen.add(c.fenKey);
		}
		expect(r.cards.length).toBe(6);
	});
});
