import type { FSRSParameters } from 'ts-fsrs';
import type { Card } from '$lib/types';
import { outcomeToRating, reviewCard, type DrillOutcome } from '$lib/fsrs/scheduler';

export interface GradeContext {
	/** Line-walk prefix step (not FSRS-due itself, pulled in by a walk). */
	isLineWalkStep: boolean;
	/** Mistakes / retrain drills: practice only, never touch the schedule. */
	isMistakeReview: boolean;
	/** First, hinted presentation of a brand-new card (auto mode). */
	isIntroductionPass: boolean;
}

/**
 * Per-session FSRS grading rules shared by DrillRunner and the multi-session
 * simulation tests, so the tests exercise the same decisions the UI makes.
 *
 * A card can be presented several times in one session (Train pass, failed-
 * walk retry, wrong-answer re-queue, leaves cycle). Every grade is computed
 * from the card as it stood when the session was built, so each later grade
 * *replaces* the earlier one. That is intended for a new card (hinted intro,
 * then a real recall — the recall is what counts), but it used to let a
 * retry erase a miss: answer a due move wrong, get it right on the retry a
 * minute later with the answer fresh on screen, and FSRS recorded a clean
 * pass — no lapse, full interval. The move was never really recalled, and
 * both progressive unlock (issue #86) and the mistakes drill (which keys off
 * `lapses`) lost track of it.
 *
 * Rules:
 *  - Mistake review never grades.
 *  - A line-walk prefix step grades at most once per session (issue #84).
 *  - Once a card lapses in a session (a wrong answer outside a hinted
 *    introduction), later presentations don't re-grade it: the miss stands.
 */
export class SessionGrader {
	#prefixRated = new Set<string>();
	#lapsed = new Set<string>();

	reset(): void {
		this.#prefixRated.clear();
		this.#lapsed.clear();
	}

	/**
	 * Grade one presentation. Returns the card to persist, or `null` when the
	 * stored card must stay as it is. `key` must be unique per (segment, card).
	 */
	grade(
		key: string,
		card: Card,
		outcome: DrillOutcome,
		ctx: GradeContext,
		params: FSRSParameters,
		now: Date = new Date()
	): Card | null {
		if (ctx.isMistakeReview) return null;
		if (this.#lapsed.has(key)) return null;
		if (ctx.isLineWalkStep) {
			if (this.#prefixRated.has(key)) return null;
			this.#prefixRated.add(key);
		}
		if (outcome === 'wrong' && !ctx.isIntroductionPass) this.#lapsed.add(key);
		const rating = outcomeToRating(outcome);
		return { ...reviewCard(card, rating, params, now), lastRating: rating };
	}
}
