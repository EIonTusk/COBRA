/**
 * Pure helpers for the card/progress split (issue #97).
 *
 * A `Card` is a `CardSlot` (repertoire membership, `cards` store) joined with
 * a `MoveProgress` (FSRS state, `move_progress` store). Progress is keyed by
 * `[fenKey, expectedSan]`, so a move prepared in several repertoires has one
 * learning record: reviewing it anywhere counts everywhere.
 *
 * No DB import here — `db.ts` uses `newerProgress` during the upgrade that
 * creates the store, and the sync merge uses it for incoming cards.
 */
import { createEmptyCard } from 'ts-fsrs';
import type { Card, CardProgress, CardSlot, MoveProgress } from '$lib/types';

export function progressKey(fenKey: string, expectedSan: string): [string, string] {
	return [fenKey, expectedSan];
}

/** Map key for de-duplicating cards that share one progress record. */
export function moveId(c: { fenKey: string; expectedSan: string }): string {
	return `${c.fenKey}\u0000${c.expectedSan}`;
}

export function toSlot(card: CardSlot): CardSlot {
	return { repertoireId: card.repertoireId, fenKey: card.fenKey, expectedSan: card.expectedSan };
}

export function toProgress(card: Card | MoveProgress): MoveProgress {
	const p: MoveProgress = {
		fenKey: card.fenKey,
		expectedSan: card.expectedSan,
		fsrs: card.fsrs,
		dueAt: card.dueAt
	};
	if (card.lastReview !== undefined) p.lastReview = card.lastReview;
	if (card.lastRating !== undefined) p.lastRating = card.lastRating;
	return p;
}

export function freshProgress(fenKey: string, expectedSan: string, now: number): MoveProgress {
	return { fenKey, expectedSan, fsrs: createEmptyCard(new Date(now)), dueAt: now };
}

export function joinCard(slot: CardSlot, progress: CardProgress): Card {
	const card: Card = {
		...toSlot(slot),
		fsrs: progress.fsrs,
		dueAt: progress.dueAt
	};
	if (progress.lastReview !== undefined) card.lastReview = progress.lastReview;
	if (progress.lastRating !== undefined) card.lastRating = progress.lastRating;
	return card;
}

/**
 * Pick the record that should win when two copies of one move's progress
 * meet — two devices in sync, or two repertoires folded together by the
 * v20 upgrade. Last-write-wins by `lastReview`: the winner's full FSRS state
 * comes along, so a card is never frankensteined from one side's stability
 * and the other's lapse count.
 *
 * Tiebreaker: a record that's been reviewed at all beats one that hasn't,
 * then the one whose FSRS state has been touched (higher reps + lapses),
 * then the higher dueAt — a deterministic, near-never-hit edge case.
 */
export function newerProgress<T extends CardProgress>(local: T, remote: T): T {
	const ls = local.lastReview ?? 0;
	const rs = remote.lastReview ?? 0;
	if (rs > ls) return remote;
	if (ls > rs) return local;
	const lWeight = (local.fsrs?.reps ?? 0) + (local.fsrs?.lapses ?? 0);
	const rWeight = (remote.fsrs?.reps ?? 0) + (remote.fsrs?.lapses ?? 0);
	if (rWeight > lWeight) return remote;
	if (lWeight > rWeight) return local;
	return remote.dueAt >= local.dueAt ? remote : local;
}

/** Minimal store surface `foldProgress` needs, so it runs in any transaction. */
export interface ProgressStore {
	get: (key: [string, string]) => Promise<MoveProgress | undefined>;
	put: (row: MoveProgress) => Promise<unknown>;
}

/**
 * Merge one incoming copy of a move's progress into the shared store by
 * `newerProgress`. Returns true when the stored record changed.
 */
export async function foldProgress(store: ProgressStore, incoming: MoveProgress): Promise<boolean> {
	if (!incoming.fsrs || typeof incoming.dueAt !== 'number') return false;
	const local = await store.get(progressKey(incoming.fenKey, incoming.expectedSan));
	if (!local) {
		await store.put(toProgress(incoming));
		return true;
	}
	if (newerProgress(local, incoming) === local) return false;
	const next = toProgress(incoming);
	if (JSON.stringify(next) === JSON.stringify(toProgress(local))) return false;
	await store.put(next);
	return true;
}
