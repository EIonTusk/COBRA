/**
 * IDB CRUD for `plan_cards`. One auto-generated plan card per
 * (repertoireId, fenKey) — the card's prompt + answer are baked from a
 * `SavedMiddlegameGuide.aggregate` at save time so drilling doesn't
 * re-query masters.
 *
 * Plan cards live in a separate store from move cards (`cards`) and
 * idea cards (`idea_cards`) because they're drilled in their own mode:
 * the structural-plan drill is intentionally separate from the move-
 * recall drill to avoid interleaving distinct cognitive tasks.
 *
 * Store added at DB_VERSION 19; access goes through `ensureStore` so a
 * stale-tab/SW serving older code can still upgrade in place rather
 * than throwing on the first read.
 *
 * Sync: plan cards are local-only for now (mirrors `middlegame_guides`,
 * which is also outside the sync bundle). We deliberately don't call
 * `markRepDirty` from writes — marking dirty without an actual bundle
 * entry would cause "I synced and nothing changed" UX. When plan-card
 * sync ships, add to `lib/sync/bundle.ts` + re-enable the dirty mark.
 */
import { createEmptyCard } from 'ts-fsrs';

import { ensureStore } from './db';
import type { Color, PlanCard } from '$lib/types';

export async function getPlanCard(
	repertoireId: string,
	fenKey: string
): Promise<PlanCard | undefined> {
	const db = await ensureStore('plan_cards');
	return db.get('plan_cards', [repertoireId, fenKey]);
}

export async function upsertPlanCard(card: PlanCard): Promise<void> {
	const db = await ensureStore('plan_cards');
	await db.put('plan_cards', JSON.parse(JSON.stringify(card)));
}

export async function deletePlanCard(repertoireId: string, fenKey: string): Promise<void> {
	const db = await ensureStore('plan_cards');
	await db.delete('plan_cards', [repertoireId, fenKey]);
}

export async function listPlanCards(repertoireId: string): Promise<PlanCard[]> {
	const db = await ensureStore('plan_cards');
	return db.getAllFromIndex('plan_cards', 'by-repertoire', repertoireId);
}

export async function duePlanCards(
	repertoireId: string,
	now: number = Date.now(),
	limit: number = 30
): Promise<PlanCard[]> {
	const db = await ensureStore('plan_cards');
	const range = IDBKeyRange.bound([repertoireId, 0], [repertoireId, now]);
	return db.getAllFromIndex('plan_cards', 'by-repertoire-due', range, limit);
}

export async function countDuePlanCards(
	repertoireId: string,
	now: number = Date.now()
): Promise<number> {
	const db = await ensureStore('plan_cards');
	const range = IDBKeyRange.bound([repertoireId, 0], [repertoireId, now]);
	return db.countFromIndex('plan_cards', 'by-repertoire-due', range);
}

export async function countPlanCards(repertoireId: string): Promise<number> {
	const db = await ensureStore('plan_cards');
	return db.countFromIndex('plan_cards', 'by-repertoire', repertoireId);
}

/**
 * Build a fresh `PlanCard` for a position, due immediately. FSRS state
 * starts empty so the first review schedules from scratch. Callers
 * preserve scheduling on regeneration by merging the new content with
 * the existing card's `fsrs` / `dueAt` / `lastReview` rather than
 * minting a new one.
 */
export function freshPlanCard(
	repertoireId: string,
	fenKey: string,
	planForColor: Color,
	prompt: string,
	answer: string,
	openingName: string | null,
	now: number = Date.now()
): PlanCard {
	return {
		repertoireId,
		fenKey,
		planForColor,
		prompt: prompt.trim(),
		answer: answer.trim(),
		openingName,
		fsrs: createEmptyCard(new Date(now)),
		dueAt: now,
		createdAt: now
	};
}
