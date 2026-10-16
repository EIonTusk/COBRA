// Issue #97: the v20 upgrade moves each card's FSRS state into the shared
// `move_progress` store. Builds a v19-shaped database by hand, then opens it
// through `getDB` the way the app does after an update.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createEmptyCard } from 'ts-fsrs';

function legacyCard(rep: string, fenKey: string, san: string, lastReview?: number) {
	const fsrs = createEmptyCard(new Date(0));
	return {
		repertoireId: rep,
		fenKey,
		expectedSan: san,
		fsrs: lastReview ? { ...fsrs, reps: 3 } : fsrs,
		dueAt: lastReview ? lastReview + 86_400_000 : 0,
		lastReview
	};
}

async function seedV19(rows: ReturnType<typeof legacyCard>[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const req = indexedDB.open('openingtrainer', 19);
		req.onupgradeneeded = () => {
			const cards = req.result.createObjectStore('cards', { keyPath: ['repertoireId', 'fenKey'] });
			cards.createIndex('by-repertoire', 'repertoireId');
			cards.createIndex('by-due', 'dueAt');
			cards.createIndex('by-repertoire-due', ['repertoireId', 'dueAt']);
			for (const r of rows) cards.put(r);
		};
		req.onsuccess = () => {
			req.result.close();
			resolve();
		};
		req.onerror = () => reject(req.error);
	});
}

describe('v20 upgrade', () => {
	it('folds per-repertoire progress into one record per move, newest review winning', async () => {
		await seedV19([
			legacyCard('A', 'pos', 'Nf3', 5000),
			legacyCard('B', 'pos', 'Nf3', 9000),
			legacyCard('C', 'pos', 'Nf3'),
			legacyCard('C', 'other', 'c4', 1000)
		]);

		const { getDB } = await import('./db');
		const { getCard } = await import('./cards');
		const db = await getDB();

		expect(await db.count('move_progress')).toBe(2);
		expect((await db.get('move_progress', ['pos', 'Nf3']))?.lastReview).toBe(9000);
		expect((await getCard('A', 'pos'))?.lastReview).toBe(9000);
		expect((await getCard('C', 'pos'))?.lastReview).toBe(9000);
		expect((await getCard('C', 'other'))?.lastReview).toBe(1000);
		// Slots are untouched, and the new index finds them by position.
		expect(await db.countFromIndex('cards', 'by-fenKey', 'pos')).toBe(3);
	});
});
