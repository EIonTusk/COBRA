import { describe, expect, it } from 'vitest';
import { Rating, generatorParameters } from 'ts-fsrs';

import { createFreshCard, outcomeToRating, reviewCard } from './scheduler';

const params = generatorParameters({ enable_fuzz: false });

describe('outcomeToRating', () => {
	it('maps each drill outcome to the FSRS rating', () => {
		expect(outcomeToRating('correct')).toBe(Rating.Good);
		expect(outcomeToRating('peeked')).toBe(Rating.Hard);
		expect(outcomeToRating('wrong')).toBe(Rating.Again);
		expect(outcomeToRating('easy')).toBe(Rating.Easy);
	});
});

describe('createFreshCard', () => {
	it('returns a card that is due now', () => {
		const t = Date.parse('2026-01-01T00:00:00Z');
		const c = createFreshCard('rep-1', 'fenkey', 'e4', t);
		expect(c.repertoireId).toBe('rep-1');
		expect(c.fenKey).toBe('fenkey');
		expect(c.expectedSan).toBe('e4');
		expect(c.dueAt).toBe(t);
		expect(c.lastReview).toBeUndefined();
	});
});

describe('reviewCard', () => {
	it('pushes the due date forward on a Good rating', () => {
		const t0 = new Date('2026-01-01T00:00:00Z');
		const fresh = createFreshCard('rep-1', 'fenkey', 'e4', t0.getTime());
		const reviewed = reviewCard(fresh, Rating.Good, params, t0);

		expect(reviewed.lastReview).toBe(t0.getTime());
		expect(reviewed.dueAt).toBeGreaterThan(t0.getTime());
	});

	it('produces a later due date for Easy than for Again', () => {
		const t0 = new Date('2026-01-01T00:00:00Z');
		const fresh = createFreshCard('rep-1', 'fenkey', 'e4', t0.getTime());
		const easy = reviewCard(fresh, Rating.Easy, params, t0);
		const again = reviewCard(fresh, Rating.Again, params, t0);
		expect(easy.dueAt).toBeGreaterThan(again.dueAt);
	});

	it('preserves fields it does not control', () => {
		const t0 = new Date('2026-01-01T00:00:00Z');
		const fresh = createFreshCard('rep-1', 'fenkey', 'e4', t0.getTime());
		const reviewed = reviewCard(fresh, Rating.Good, params, t0);
		expect(reviewed.repertoireId).toBe('rep-1');
		expect(reviewed.fenKey).toBe('fenkey');
		expect(reviewed.expectedSan).toBe('e4');
	});
});
