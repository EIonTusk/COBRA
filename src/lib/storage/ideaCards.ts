import { createEmptyCard } from 'ts-fsrs';
import { getDB } from './db';
import type { IdeaCard } from '$lib/types';
import { markRepDirty } from '$lib/sync/dirtyMark';

export async function getIdeaCard(
	repertoireId: string,
	fenKey: string
): Promise<IdeaCard | undefined> {
	const db = await getDB();
	return db.get('idea_cards', [repertoireId, fenKey]);
}

export async function upsertIdeaCard(card: IdeaCard): Promise<void> {
	const db = await getDB();
	await db.put('idea_cards', JSON.parse(JSON.stringify(card)));
	markRepDirty(card.repertoireId);
}

export async function deleteIdeaCard(repertoireId: string, fenKey: string): Promise<void> {
	const db = await getDB();
	await db.delete('idea_cards', [repertoireId, fenKey]);
	markRepDirty(repertoireId);
}

export async function listIdeaCards(repertoireId: string): Promise<IdeaCard[]> {
	const db = await getDB();
	return db.getAllFromIndex('idea_cards', 'by-repertoire', repertoireId);
}

export async function dueIdeaCards(
	repertoireId: string,
	now: number = Date.now(),
	limit: number = 30
): Promise<IdeaCard[]> {
	const db = await getDB();
	const range = IDBKeyRange.bound([repertoireId, 0], [repertoireId, now]);
	return db.getAllFromIndex('idea_cards', 'by-repertoire-due', range, limit);
}

export async function countDueIdeaCards(
	repertoireId: string,
	now: number = Date.now()
): Promise<number> {
	const db = await getDB();
	const range = IDBKeyRange.bound([repertoireId, 0], [repertoireId, now]);
	return db.countFromIndex('idea_cards', 'by-repertoire-due', range);
}

export async function countIdeaCards(repertoireId: string): Promise<number> {
	const db = await getDB();
	return db.countFromIndex('idea_cards', 'by-repertoire', repertoireId);
}

/**
 * Create a new idea card with a freshly-minted FSRS state, due immediately.
 */
export function freshIdeaCard(
	repertoireId: string,
	fenKey: string,
	prompt: string,
	answer?: string,
	now: number = Date.now()
): IdeaCard {
	return {
		repertoireId,
		fenKey,
		prompt: prompt.trim(),
		answer: answer?.trim() || undefined,
		fsrs: createEmptyCard(new Date(now)),
		dueAt: now,
		createdAt: now
	};
}
