import { ensureStore } from './db';
import type { Card, CardSlot, MoveProgress } from '$lib/types';
import { markRepsDirty } from '$lib/sync/dirtyMark';
import {
	freshProgress,
	joinCard,
	moveId,
	progressKey,
	toProgress,
	toSlot,
	type ProgressStore
} from './moveProgress';

/*
 * Move cards are stored in two halves (issue #97): a `CardSlot` per
 * (repertoire, position) in `cards`, and a `MoveProgress` per (position,
 * move) in `move_progress`. Everything here hands out the joined `Card`, so
 * callers see the same shape as before, but a move prepared in several
 * repertoires shares one learning record: grade it in one and it is graded
 * in all of them.
 */

/**
 * DB handle that's guaranteed to have `move_progress`, the newest store
 * every function here touches — the same stale-handle repair
 * `purgeRepertoireLocal` does for `plan_cards`.
 */
function getDB() {
	return ensureStore('move_progress');
}

async function joinSlots(
	progress: Pick<ProgressStore, 'get'>,
	slots: CardSlot[],
	now: number = Date.now()
): Promise<Card[]> {
	const rows = await Promise.all(
		slots.map((s) => progress.get(progressKey(s.fenKey, s.expectedSan)))
	);
	// A slot always gets a progress row when it's created; the fresh fallback
	// only covers a row lost to some path that bypassed this module.
	return slots.map((s, i) => joinCard(s, rows[i] ?? freshProgress(s.fenKey, s.expectedSan, now)));
}

/** Every repertoire whose card points at this move's progress record. */
async function repsSharingMove(fenKey: string, expectedSan: string): Promise<string[]> {
	const db = await getDB();
	const slots = await db.getAllFromIndex('cards', 'by-fenKey', fenKey);
	return slots.filter((s) => s.expectedSan === expectedSan).map((s) => s.repertoireId);
}

export async function getCard(repertoireId: string, fenKey: string): Promise<Card | undefined> {
	const db = await getDB();
	const tx = db.transaction(['cards', 'move_progress'], 'readonly');
	const slot = await tx.objectStore('cards').get([repertoireId, fenKey]);
	if (!slot) return undefined;
	const [card] = await joinSlots(tx.objectStore('move_progress'), [slot]);
	return card;
}

/**
 * The card `repertoireId` would have for this move: the move's shared
 * progress, or fresh progress if no repertoire has trained it yet. Nothing
 * is written.
 */
export async function cardForMove(
	repertoireId: string,
	fenKey: string,
	expectedSan: string,
	now: number = Date.now()
): Promise<Card> {
	const db = await getDB();
	const progress = await db.get('move_progress', progressKey(fenKey, expectedSan));
	return joinCard(
		{ repertoireId, fenKey, expectedSan },
		progress ?? freshProgress(fenKey, expectedSan, now)
	);
}

/**
 * Write a card: its slot, and its progress as the move's shared record. Use
 * for grades and other progress changes. To put a move into a repertoire
 * without touching progress the user may have earned elsewhere, use
 * `addCard`.
 */
export async function upsertCard(card: Card): Promise<void> {
	const db = await getDB();
	const tx = db.transaction(['cards', 'move_progress'], 'readwrite');
	await tx.objectStore('cards').put(toSlot(card));
	await tx.objectStore('move_progress').put(toProgress(card));
	await tx.done;
	markRepsDirty([card.repertoireId, ...(await repsSharingMove(card.fenKey, card.expectedSan))]);
}

/**
 * Put `expectedSan` at `fenKey` into a repertoire. The move keeps whatever
 * progress it already has from other repertoires; only a move nobody has
 * trained starts fresh. An existing slot at the position is replaced.
 */
export async function addCard(
	repertoireId: string,
	fenKey: string,
	expectedSan: string,
	now: number = Date.now()
): Promise<void> {
	const db = await getDB();
	const tx = db.transaction(['cards', 'move_progress'], 'readwrite');
	await tx.objectStore('cards').put({ repertoireId, fenKey, expectedSan });
	const progress = tx.objectStore('move_progress');
	const key = progressKey(fenKey, expectedSan);
	if (!(await progress.get(key))) await progress.put(freshProgress(fenKey, expectedSan, now));
	await tx.done;
	markRepsDirty([repertoireId]);
}

/**
 * Remove a card from a repertoire. Its progress record stays: other
 * repertoires may share it, and re-adding the line later picks it back up.
 */
export async function deleteCard(repertoireId: string, fenKey: string): Promise<void> {
	const db = await getDB();
	await db.delete('cards', [repertoireId, fenKey]);
	markRepsDirty([repertoireId]);
}

export async function dueCards(
	repertoireId: string,
	now: number = Date.now(),
	limit: number = 30
): Promise<Card[]> {
	const due = (await listCards(repertoireId)).filter((c) => c.dueAt <= now);
	due.sort((a, b) => a.dueAt - b.dueAt);
	return due.slice(0, limit);
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

/**
 * Push every card whose position is in `fenKeys` out to `dueAt` (a "defer this
 * subtree" snooze from the drill). Only cards currently due sooner than the
 * target move — a card already scheduled further out keeps its later date, so
 * deferring can never pull a review forward. FSRS stability/state are left
 * untouched: this reschedules the *next look*, it doesn't grade the card.
 * The snooze lands on the shared record, so a move this repertoire shares
 * with another is deferred there too. Returns the number of cards moved.
 */
export async function deferSubtree(
	repertoireId: string,
	fenKeys: Set<string>,
	dueAt: number
): Promise<number> {
	const db = await getDB();
	const tx = db.transaction(['cards', 'move_progress'], 'readwrite');
	const slots = await tx.objectStore('cards').index('by-repertoire').getAll(repertoireId);
	const progress = tx.objectStore('move_progress');
	const touched: CardSlot[] = [];
	for (const slot of slots) {
		if (!fenKeys.has(slot.fenKey)) continue;
		const p = await progress.get(progressKey(slot.fenKey, slot.expectedSan));
		if (!p || p.dueAt >= dueAt) continue;
		p.dueAt = dueAt;
		p.fsrs = { ...p.fsrs, due: new Date(dueAt) };
		await progress.put(p);
		touched.push(slot);
	}
	await tx.done;
	if (touched.length > 0) {
		const reps = [repertoireId];
		for (const s of touched) reps.push(...(await repsSharingMove(s.fenKey, s.expectedSan)));
		markRepsDirty(reps);
	}
	return touched.length;
}

export async function countDue(repertoireId: string, now: number = Date.now()): Promise<number> {
	return (await listCards(repertoireId)).filter((c) => c.dueAt <= now).length;
}

export async function listCards(repertoireId: string): Promise<Card[]> {
	const db = await getDB();
	const tx = db.transaction(['cards', 'move_progress'], 'readonly');
	const slots = await tx.objectStore('cards').index('by-repertoire').getAll(repertoireId);
	return joinSlots(tx.objectStore('move_progress'), slots);
}

/**
 * Every move card across all repertoires, one per shared progress record.
 * Library-wide totals and stats use this, so a move that sits in three
 * repertoires is counted once, not three times.
 */
export async function listUniqueCards(): Promise<Card[]> {
	const db = await getDB();
	const tx = db.transaction(['cards', 'move_progress'], 'readonly');
	const slots = await tx.objectStore('cards').getAll();
	return uniqueByMove(await joinSlots(tx.objectStore('move_progress'), slots));
}

/** Keep the first card per (position, move). */
export function uniqueByMove(cards: Card[]): Card[] {
	const seen = new Set<string>();
	return cards.filter((c) => {
		const id = moveId(c);
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
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
 * How many of a repertoire's cards share their progress with another
 * repertoire. "Forget progress" leaves these alone, so its confirmation
 * dialog says how many it will keep.
 */
export async function countSharedCards(repertoireId: string): Promise<number> {
	return (await sharedMoveIds(repertoireId)).size;
}

/** Sentence appended to the "forget progress" confirmations. */
export function sharedKeptNote(shared: number): string {
	if (shared === 0) return '';
	const moves = shared === 1 ? '1 move' : `${shared} moves`;
	return ` ${moves} you also train in another repertoire keep their progress.`;
}

async function sharedMoveIds(repertoireId: string): Promise<Set<string>> {
	const db = await getDB();
	const tx = db.transaction('cards', 'readonly');
	const index = tx.store.index('by-fenKey');
	const slots = await tx.store.index('by-repertoire').getAll(repertoireId);
	const shared = new Set<string>();
	for (const slot of slots) {
		const others = await index.getAll(slot.fenKey);
		if (others.some((o) => o.repertoireId !== repertoireId && o.expectedSan === slot.expectedSan)) {
			shared.add(moveId(slot));
		}
	}
	return shared;
}

/**
 * Reset FSRS state on every card in a repertoire so they're all due now with
 * a fresh learning history. "Start over" for the spaced-repetition schedule
 * without losing any of the position data in the tree.
 *
 * Moves this repertoire shares with another one keep their progress: the
 * record belongs to both, and starting over here shouldn't wipe what was
 * learned there. Returns how many cards were reset and how many were kept.
 */
export async function resetAllFsrs(repertoireId: string): Promise<{ reset: number; kept: number }> {
	const { createEmptyCard } = await import('ts-fsrs');
	const shared = await sharedMoveIds(repertoireId);
	const db = await getDB();
	const tx = db.transaction(['cards', 'move_progress'], 'readwrite');
	const slots = await tx.objectStore('cards').index('by-repertoire').getAll(repertoireId);
	const progress = tx.objectStore('move_progress');
	const now = Date.now();
	let reset = 0;
	for (const slot of slots) {
		if (shared.has(moveId(slot))) continue;
		const fresh: MoveProgress = {
			fenKey: slot.fenKey,
			expectedSan: slot.expectedSan,
			fsrs: createEmptyCard(new Date(now)),
			dueAt: now
		};
		await progress.put(fresh);
		reset += 1;
	}
	await tx.done;
	markRepsDirty([repertoireId]);
	return { reset, kept: shared.size };
}
