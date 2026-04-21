import { FSRS, createEmptyCard, Rating, type FSRSParameters } from 'ts-fsrs';
import type { Card } from '$lib/types';

export type DrillOutcome = 'correct' | 'peeked' | 'wrong' | 'easy';

export function outcomeToRating(outcome: DrillOutcome): Rating {
	switch (outcome) {
		case 'correct':
			return Rating.Good;
		case 'peeked':
			return Rating.Hard;
		case 'wrong':
			return Rating.Again;
		case 'easy':
			return Rating.Easy;
	}
}

export function createFreshCard(
	repertoireId: string,
	fenKey: string,
	expectedSan: string,
	now: number = Date.now()
): Card {
	return {
		repertoireId,
		fenKey,
		expectedSan,
		fsrs: createEmptyCard(new Date(now)),
		dueAt: now
	};
}

export function reviewCard<T extends Pick<Card, 'fsrs' | 'dueAt' | 'lastReview'>>(
	card: T,
	rating: Rating,
	params: FSRSParameters,
	now: Date = new Date()
): T {
	const engine = new FSRS(params);
	const outcomes = engine.repeat(card.fsrs, now);
	const nextFsrs = outcomes[rating as 1 | 2 | 3 | 4].card;
	return {
		...card,
		fsrs: nextFsrs,
		lastReview: now.getTime(),
		dueAt: nextFsrs.due.getTime()
	};
}
