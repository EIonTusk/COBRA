import { describe, expect, it } from 'vitest';
import { Rating } from 'ts-fsrs';
import { normalizeFsrsParams } from '$lib/storage/settings';
import { createFreshCard, reviewCard } from '$lib/fsrs/scheduler';
import type { Card } from '$lib/types';
import { isShaky } from './buildSegment';
import { SessionGrader, type GradeContext } from './sessionGrading';

const params = normalizeFsrsParams();
const T = new Date(Date.UTC(2026, 0, 1, 9));
const due: GradeContext = {
	isLineWalkStep: false,
	isMistakeReview: false,
	isIntroductionPass: false
};

/** A card that has been answered right a few times, weeks apart. */
function matureCard(): Card {
	let c = createFreshCard('r', 'k', 'e4', T.getTime());
	let t = T.getTime();
	for (let i = 0; i < 4; i++) {
		c = reviewCard(c, Rating.Good, params, new Date(t));
		t = c.dueAt;
	}
	return { ...c, lastRating: Rating.Good };
}

describe('SessionGrader', () => {
	it('keeps a miss when the same card is answered right later in the session', () => {
		const g = new SessionGrader();
		const card = matureCard();
		const now = new Date(card.dueAt);
		const miss = g.grade('k', card, 'wrong', due, params, now);
		expect(miss!.fsrs.lapses).toBe(1);
		expect(miss!.lastRating).toBe(Rating.Again);
		expect(g.grade('k', card, 'correct', due, params, now)).toBeNull();
	});

	it('lets the recall replace a hinted introduction', () => {
		const g = new SessionGrader();
		const card = createFreshCard('r', 'k', 'e4', T.getTime());
		const intro = { ...due, isIntroductionPass: true };
		expect(g.grade('k', card, 'peeked', intro, params, T)!.lastRating).toBe(Rating.Hard);
		expect(g.grade('k', card, 'correct', due, params, T)!.lastRating).toBe(Rating.Good);
	});

	it('does not treat a wrong hinted introduction as a lapse', () => {
		const g = new SessionGrader();
		const card = createFreshCard('r', 'k', 'e4', T.getTime());
		g.grade('k', card, 'wrong', { ...due, isIntroductionPass: true }, params, T);
		expect(g.grade('k', card, 'correct', due, params, T)).not.toBeNull();
	});

	it('grades a line-walk prefix step once per session', () => {
		const g = new SessionGrader();
		const card = matureCard();
		const step = { ...due, isLineWalkStep: true };
		expect(g.grade('k', card, 'correct', step, params, new Date(card.dueAt))).not.toBeNull();
		expect(g.grade('k', card, 'wrong', step, params, new Date(card.dueAt))).toBeNull();
	});

	it('never grades mistake review, and reset starts a new session', () => {
		const g = new SessionGrader();
		const card = matureCard();
		expect(
			g.grade('k', card, 'correct', { ...due, isMistakeReview: true }, params, new Date(card.dueAt))
		).toBeNull();
		g.grade('k', card, 'wrong', due, params, new Date(card.dueAt));
		g.reset();
		expect(g.grade('k', card, 'correct', due, params, new Date(card.dueAt))).not.toBeNull();
	});
});

describe('isShaky', () => {
	it('flags a lapsed mature card even when its stability stays above a day', () => {
		const g = new SessionGrader();
		const card = matureCard();
		const lapsed = g.grade('k', card, 'wrong', due, params, new Date(card.dueAt))!;
		expect(lapsed.fsrs.stability).toBeGreaterThan(1);
		expect(isShaky(lapsed)).toBe(true);
		expect(isShaky(card)).toBe(false);
	});

	it('falls back to stability for cards graded before lastRating existed', () => {
		const { lastRating: _drop, ...legacy } = matureCard();
		expect(isShaky(legacy)).toBe(false);
		expect(isShaky({ ...legacy, fsrs: { ...legacy.fsrs, stability: 0.4 } })).toBe(true);
	});
});
