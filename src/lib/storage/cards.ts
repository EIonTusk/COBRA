import { getDB } from './db';
import type { Card } from '$lib/types';
import { markRepDirty } from '$lib/sync/dirtyMark';

export async function getCard(repertoireId: string, fenKey: string): Promise<Card | undefined> {
	const db = await getDB();
	return db.get('cards', [repertoireId, fenKey]);
}

export async function upsertCard(card: Card): Promise<void> {
	const db = await getDB();
	await db.put('cards', card);
	markRepDirty(card.repertoireId);
}

export async function deleteCard(repertoireId: string, fenKey: string): Promise<void> {
	const db = await getDB();
	await db.delete('cards', [repertoireId, fenKey]);
	markRepDirty(repertoireId);
}

export async function dueCards(
	repertoireId: string,
	now: number = Date.now(),
	limit: number = 30
): Promise<Card[]> {
	const db = await getDB();
	const range = IDBKeyRange.bound([repertoireId, 0], [repertoireId, now]);
	return db.getAllFromIndex('cards', 'by-repertoire-due', range, limit);
}

/**
 * Split a due-card pool into review-first, new-capped.
 *
 * "New" = never reviewed (`lastReview` is undefined). A freshly-imported
 * repertoire otherwise produces sessions that are 100% new cards and starves
 * relearning of positions the user is already struggling with.
 *
 *  - Reviews come first, in the order `cards` was handed in (callers should
 *    pass a dueAt-asc pool so the most-overdue reviews surface first).
 *  - New cards fill the remaining slots up to `newCap`.
 *  - If reviews ran out before the session cap, leftover slots are filled
 *    with more new cards so a brand-new repertoire still drills at capacity
 *    instead of stalling at `newCap`.
 *
 * Pure helper: no DB access. Callers fetch the pool with `dueCards` at a
 * larger limit (≈ sessionCap * 5 is plenty) so this function has enough
 * reviews to pick from when new cards would otherwise dominate by dueAt.
 */
export function pickBalancedDueCards(cards: Card[], sessionCap: number, newCap: number): Card[] {
	const newCards: Card[] = [];
	const reviewCards: Card[] = [];
	for (const c of cards) {
		if (c.lastReview) reviewCards.push(c);
		else newCards.push(c);
	}

	const cap = Math.max(0, sessionCap);
	const newBudget = Math.min(newCards.length, Math.max(0, newCap), cap);
	const reviewBudget = Math.min(reviewCards.length, cap - newBudget);
	const leftover = cap - newBudget - reviewBudget;
	const extraNew = Math.min(newCards.length - newBudget, Math.max(0, leftover));

	return [...reviewCards.slice(0, reviewBudget), ...newCards.slice(0, newBudget + extraNew)];
}

export async function countDue(repertoireId: string, now: number = Date.now()): Promise<number> {
	const db = await getDB();
	const range = IDBKeyRange.bound([repertoireId, 0], [repertoireId, now]);
	return db.countFromIndex('cards', 'by-repertoire-due', range);
}

export async function listCards(repertoireId: string): Promise<Card[]> {
	const db = await getDB();
	return db.getAllFromIndex('cards', 'by-repertoire', repertoireId);
}

export async function countCards(repertoireId: string): Promise<number> {
	const db = await getDB();
	return db.countFromIndex('cards', 'by-repertoire', repertoireId);
}

/**
 * Cards that the user has struggled with at some point: lapsed at least once,
 * OR still in the Learning/Relearning FSRS state. Sorted with most-recently-
 * reviewed first so a "drill mistakes" session has the freshest mistakes at
 * the top of the queue.
 *
 * FSRS State enum (from ts-fsrs): 0=New, 1=Learning, 2=Review, 3=Relearning.
 */
export async function mistakeCards(repertoireId: string, limit: number = 50): Promise<Card[]> {
	const all = await listCards(repertoireId);
	const hits = all.filter((c) => {
		const lapses = c.fsrs.lapses ?? 0;
		const state = c.fsrs.state;
		return lapses > 0 || state === 1 || state === 3;
	});
	hits.sort((a, b) => (b.lastReview ?? 0) - (a.lastReview ?? 0));
	return hits.slice(0, limit);
}

export async function countMistakeCards(repertoireId: string): Promise<number> {
	const all = await listCards(repertoireId);
	let n = 0;
	for (const c of all) {
		const lapses = c.fsrs.lapses ?? 0;
		const state = c.fsrs.state;
		if (lapses > 0 || state === 1 || state === 3) n += 1;
	}
	return n;
}

/**
 * Reset FSRS state on every card in a repertoire so they're all due now with
 * a fresh learning history. "Start over" for the spaced-repetition schedule
 * without losing any of the position data in the tree.
 */
export async function resetAllFsrs(repertoireId: string): Promise<void> {
	const { createEmptyCard } = await import('ts-fsrs');
	const db = await getDB();
	const tx = db.transaction('cards', 'readwrite');
	const store = tx.objectStore('cards');
	const index = store.index('by-repertoire');
	const now = Date.now();
	const fresh = createEmptyCard(new Date(now));
	let cursor = await index.openCursor(repertoireId);
	while (cursor) {
		const card = cursor.value;
		card.fsrs = fresh;
		card.dueAt = now;
		card.lastReview = undefined;
		await cursor.update(card);
		cursor = await cursor.continue();
	}
	await tx.done;
	markRepDirty(repertoireId);
}
