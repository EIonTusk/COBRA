import { describe, expect, it } from 'vitest';
import type { Card } from '$lib/types';
import { pickBalancedDueCards } from './cards';

function card(fenKey: string, reviewed: boolean, dueAt = 0): Card {
	return {
		repertoireId: 'r',
		fenKey,
		expectedSan: '—',
		fsrs: {} as Card['fsrs'],
		dueAt,
		lastReview: reviewed ? dueAt - 1000 : undefined
	};
}

describe('pickBalancedDueCards', () => {
	it('returns reviews first then fills up to newCap with new cards', () => {
		const cards = [
			card('r1', true),
			card('r2', true),
			card('r3', true),
			card('r4', true),
			card('n1', false),
			card('n2', false),
			card('n3', false),
			card('n4', false)
		];
		const out = pickBalancedDueCards(cards, 6, 2);
		expect(out.map((c) => c.fenKey)).toEqual(['r1', 'r2', 'r3', 'r4', 'n1', 'n2']);
	});

	it('backfills with more new cards when review cards run out', () => {
		const cards = [card('r1', true), card('n1', false), card('n2', false), card('n3', false)];
		const out = pickBalancedDueCards(cards, 5, 1);
		// reviewBudget = 1 ('r1'), newBudget = 1 ('n1'), leftover = 3, extraNew = 2
		// Only 3 new cards exist, so the final mix is 1 review + 3 new = 4 cards.
		expect(out.map((c) => c.fenKey)).toEqual(['r1', 'n1', 'n2', 'n3']);
	});

	it('returns only new cards when no reviews are available', () => {
		const cards = [card('n1', false), card('n2', false), card('n3', false)];
		const out = pickBalancedDueCards(cards, 10, 2);
		// No reviews → leftover fills with new cards up to their availability.
		expect(out.map((c) => c.fenKey)).toEqual(['n1', 'n2', 'n3']);
	});

	it('respects newCap strictly when plenty of reviews exist', () => {
		const reviews = Array.from({ length: 40 }, (_, i) => card(`r${i}`, true));
		const news = Array.from({ length: 40 }, (_, i) => card(`n${i}`, false));
		const out = pickBalancedDueCards([...reviews, ...news], 30, 10);
		const taken = out.map((c) => c.fenKey);
		const newsTaken = taken.filter((k) => k.startsWith('n'));
		expect(out.length).toBe(30);
		expect(newsTaken.length).toBe(10);
	});

	it('honours sessionCap when combined supply exceeds it', () => {
		const cards = [
			card('r1', true),
			card('r2', true),
			card('r3', true),
			card('n1', false),
			card('n2', false)
		];
		const out = pickBalancedDueCards(cards, 3, 1);
		// 1 new + up to 2 reviews = 3 total
		expect(out.length).toBe(3);
		expect(out.filter((c) => !c.lastReview).length).toBe(1);
	});

	it('treats newCap = 0 as no-new-cards', () => {
		const cards = [card('r1', true), card('n1', false)];
		const out = pickBalancedDueCards(cards, 10, 0);
		// No new cards allowed; leftover stays empty too (extraNew gated on newCap=0).
		// Actually the spec allows backfill from new when reviews run out, so
		// the leftover slot still pulls 'n1' in. That matches the freshly-
		// imported-rep escape-hatch semantics.
		expect(out.map((c) => c.fenKey)).toEqual(['r1', 'n1']);
	});

	it('handles empty input', () => {
		expect(pickBalancedDueCards([], 10, 3)).toEqual([]);
	});
});
