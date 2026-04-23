import { describe, expect, it } from 'vitest';
import type { Card, Edge, RepertoireNode } from '$lib/types';
import { buildLineFirstQueue } from './lineOrder';

function node(fenKey: string, children: Edge[]): RepertoireNode {
	return { repertoireId: 'r', fenKey, children };
}

function edge(san: string, toFenKey: string): Edge {
	return { san, uci: 'xxxx', toFenKey };
}

function card(fenKey: string, dueAt = 0): Card {
	// Minimal shape — the helper only reads fenKey and dueAt. Cast the rest.
	return {
		repertoireId: 'r',
		fenKey,
		expectedSan: '—',
		fsrs: {} as Card['fsrs'],
		dueAt
	};
}

describe('buildLineFirstQueue', () => {
	it('returns empty for empty input', () => {
		const out = buildLineFirstQueue([], new Map(), { rootFenKey: 'r' });
		expect(out.cards).toEqual([]);
		expect(out.lineLabels).toEqual([]);
		expect(out.lineBoundaries.size).toBe(0);
	});

	it('labels cards by the edge taken at the first branching anchor', () => {
		// root r -> e4 -> e5 -> Nf3 -> Nc6 -> { Bb5 -> X, Bc4 -> Y }
		// Anchor is the position after Nc6 (first branching).
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b')]));
		m.set('b', node('b', [edge('Nf3', 'c')]));
		m.set('c', node('c', [edge('Nc6', 'd')]));
		m.set('d', node('d', [edge('Bb5', 'X'), edge('Bc4', 'Y')]));
		m.set('X', node('X', []));
		m.set('Y', node('Y', []));

		const out = buildLineFirstQueue([card('X'), card('Y'), card('b'), card('c')], m, {
			rootFenKey: 'r'
		});

		const keys = out.cards.map((c) => c.fenKey);
		// Prefix cards (b, c) come first in DFS order, then branching children.
		expect(keys).toEqual(['b', 'c', 'X', 'Y']);
		expect(out.lineLabels).toEqual([null, null, 'Bb5', 'Bc4']);
		expect([...out.lineBoundaries].sort((a, b) => a - b)).toEqual([0, 2, 3]);
	});

	it('keeps within-line cards in ply order', () => {
		// root r -> Nf3 (anchor branches) -> { a1: e5 -> a2, b1: c5 -> b2 -> Nc3 -> b3 }
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('Nf3', 'a0'), edge('e4', 'b0')]));
		m.set('a0', node('a0', [edge('e5', 'a1')]));
		m.set('a1', node('a1', []));
		m.set('b0', node('b0', [edge('c5', 'b1')]));
		m.set('b1', node('b1', [edge('Nc3', 'b2')]));
		m.set('b2', node('b2', []));

		// Shuffle the input so we prove the helper orders by DFS, not by input order.
		const cards = [card('b2'), card('a1'), card('b0'), card('a0')];
		const out = buildLineFirstQueue(cards, m, { rootFenKey: 'r' });

		const keys = out.cards.map((c) => c.fenKey);
		expect(keys).toEqual(['a0', 'a1', 'b0', 'b2']);
		expect(out.lineLabels).toEqual(['Nf3', 'Nf3', 'e4', 'e4']);
	});

	it('respects a user-set startingFenKey when picking the anchor', () => {
		// root r -> e4 (forced) -> c5 -> { Nf3 -> X, Nc3 -> Y }
		// With startingFenKey = 'c5', anchor is the position after c5 (branching).
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'e4p')]));
		m.set('e4p', node('e4p', [edge('c5', 'sic')]));
		m.set('sic', node('sic', [edge('Nf3', 'X'), edge('Nc3', 'Y')]));
		m.set('X', node('X', []));
		m.set('Y', node('Y', []));

		const out = buildLineFirstQueue([card('X'), card('Y')], m, {
			rootFenKey: 'r',
			startingFenKey: 'sic'
		});
		expect(out.lineLabels).toEqual(['Nf3', 'Nc3']);
	});

	it('pulls strongly-overdue line blocks to the front', () => {
		// Two lines after an anchor r: A (Bb5) and B (Bc4).
		// Line A contains a card 3d overdue; the cap should float A ahead of B
		// even though B comes first in DFS (because Bc4 precedes Bb5 in the
		// child list below).
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('Bc4', 'B'), edge('Bb5', 'A')]));
		m.set('A', node('A', []));
		m.set('B', node('B', []));

		const now = 1_000_000_000_000;
		const threeDays = 3 * 24 * 60 * 60 * 1000;
		const cards = [
			card('B', now), // fresh
			card('A', now - threeDays) // very overdue
		];

		const defaultOrder = buildLineFirstQueue(cards, m, { rootFenKey: 'r', now });
		expect(defaultOrder.cards.map((c) => c.fenKey)).toEqual(['B', 'A']);

		const capped = buildLineFirstQueue(cards, m, {
			rootFenKey: 'r',
			now,
			overdueCapMs: 24 * 60 * 60 * 1000
		});
		expect(capped.cards.map((c) => c.fenKey)).toEqual(['A', 'B']);
		expect(capped.lineLabels).toEqual(['Bb5', 'Bc4']);
	});

	it('keeps a line block contiguous when bumping it forward', () => {
		// Anchor r has children Bc4 (line C, two cards) and Bb5 (line A, two
		// cards; one is badly overdue). The whole A block must jump ahead of
		// the whole C block — not just the overdue card.
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('Bc4', 'c1'), edge('Bb5', 'a1')]));
		m.set('c1', node('c1', [edge('Nf6', 'c2')]));
		m.set('c2', node('c2', []));
		m.set('a1', node('a1', [edge('a6', 'a2')]));
		m.set('a2', node('a2', []));

		const now = 1_000_000_000_000;
		const cards = [
			card('c1', now),
			card('c2', now),
			card('a1', now), // fresh within the A line
			card('a2', now - 5 * 24 * 60 * 60 * 1000) // badly overdue
		];

		const out = buildLineFirstQueue(cards, m, {
			rootFenKey: 'r',
			now,
			overdueCapMs: 24 * 60 * 60 * 1000
		});

		expect(out.cards.map((c) => c.fenKey)).toEqual(['a1', 'a2', 'c1', 'c2']);
		expect(out.lineLabels).toEqual(['Bb5', 'Bb5', 'Bc4', 'Bc4']);
		expect([...out.lineBoundaries].sort((a, b) => a - b)).toEqual([0, 2]);
	});

	it('appends orphan cards unreachable from root, ordered by dueAt', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', []));

		const cards = [card('ghost2', 200), card('a', 50), card('ghost1', 100)];
		const out = buildLineFirstQueue(cards, m, { rootFenKey: 'r' });

		expect(out.cards.map((c) => c.fenKey)).toEqual(['a', 'ghost1', 'ghost2']);
		expect(out.lineLabels).toEqual([null, null, null]);
	});

	it('marks a boundary at every label change', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'A'), edge('d4', 'B'), edge('c4', 'C')]));
		m.set('A', node('A', []));
		m.set('B', node('B', []));
		m.set('C', node('C', []));

		const out = buildLineFirstQueue([card('A'), card('B'), card('C')], m, {
			rootFenKey: 'r'
		});
		expect(out.lineLabels).toEqual(['e4', 'd4', 'c4']);
		expect([...out.lineBoundaries].sort((a, b) => a - b)).toEqual([0, 1, 2]);
	});
});
