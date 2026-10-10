// Issue #97: a move prepared in several repertoires shares one learning
// record. Runs against fake-indexeddb so the real stores and joins are used.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Rating } from 'ts-fsrs';
import type { Card } from '$lib/types';
import { createFreshCard, reviewCard } from '$lib/fsrs/scheduler';
import { defaultSettings } from './settings';
import { getDB } from './db';
import {
	addCard,
	cardForMove,
	countSharedCards,
	deleteCard,
	getCard,
	listUniqueCards,
	resetAllFsrs,
	upsertCard
} from './cards';
import { exportAll, importAll } from './bulk';
import {
	applyRepBundle,
	applyRepCoreBundleMerge,
	BUNDLE_VERSION,
	type RepCoreBundle
} from '$lib/sync/bundle';

const T = new Date('2026-01-01T00:00:00Z').getTime();
const params = defaultSettings().fsrsParams;

function graded(rep: string, fenKey: string, san: string, at: number): Card {
	const fresh = createFreshCard(rep, fenKey, san, at);
	return { ...reviewCard(fresh, Rating.Good, params, new Date(at)), lastRating: Rating.Good };
}

beforeEach(async () => {
	const db = await getDB();
	for (const s of ['repertoires', 'nodes', 'cards', 'move_progress', 'idea_cards'] as const) {
		await db.clear(s);
	}
});

describe('shared move progress', () => {
	it('grading a move in one repertoire updates every repertoire that has it', async () => {
		await addCard('A', 'pos', 'Nf3', T);
		await addCard('B', 'pos', 'Nf3', T);
		await upsertCard(graded('A', 'pos', 'Nf3', T + 1000));

		const b = await getCard('B', 'pos');
		expect(b?.repertoireId).toBe('B');
		expect(b?.lastReview).toBe(T + 1000);
		expect(b?.dueAt).toBeGreaterThan(T + 1000);
	});

	it('keeps a different move in the same position separate', async () => {
		await addCard('A', 'pos', 'Nf3', T);
		await addCard('B', 'pos', 'c4', T);
		await upsertCard(graded('A', 'pos', 'Nf3', T + 1000));

		expect((await getCard('B', 'pos'))?.lastReview).toBeUndefined();
	});

	it('a move added to a new repertoire arrives with the progress it already has', async () => {
		await upsertCard(graded('A', 'pos', 'Nf3', T + 1000));
		await addCard('B', 'pos', 'Nf3', T + 5000);

		expect((await getCard('B', 'pos'))?.lastReview).toBe(T + 1000);
		expect((await cardForMove('C', 'pos', 'Nf3')).lastReview).toBe(T + 1000);
	});

	it('removing a card from one repertoire keeps the progress for the others', async () => {
		await addCard('A', 'pos', 'Nf3', T);
		await upsertCard(graded('B', 'pos', 'Nf3', T + 1000));
		await deleteCard('B', 'pos');

		expect(await getCard('B', 'pos')).toBeUndefined();
		expect((await getCard('A', 'pos'))?.lastReview).toBe(T + 1000);
	});

	it('starting over resets only the moves no other repertoire shares', async () => {
		await upsertCard(graded('A', 'shared', 'e4', T + 1000));
		await upsertCard(graded('B', 'shared', 'e4', T + 1000));
		await upsertCard(graded('A', 'own', 'd4', T + 1000));

		expect(await countSharedCards('A')).toBe(1);
		expect(await resetAllFsrs('A')).toEqual({ reset: 1, kept: 1 });
		expect((await getCard('A', 'own'))?.lastReview).toBeUndefined();
		expect((await getCard('A', 'shared'))?.lastReview).toBe(T + 1000);
		expect((await getCard('B', 'shared'))?.lastReview).toBe(T + 1000);
	});

	it('counts a shared move once in library-wide totals', async () => {
		await addCard('A', 'pos', 'Nf3', T);
		await addCard('B', 'pos', 'Nf3', T);
		await addCard('B', 'other', 'g3', T);

		expect(await listUniqueCards()).toHaveLength(2);
	});
});

describe('sync apply folds incoming progress into the shared record', () => {
	async function coreBundle(rep: string, cards: Card[]): Promise<RepCoreBundle> {
		const db = await getDB();
		await db.put('repertoires', { id: rep, name: rep, updatedAt: 1 } as never);
		return {
			version: BUNDLE_VERSION,
			kind: 'rep-core',
			repertoireId: rep,
			exportedAt: T,
			repertoire: { id: rep, name: rep, updatedAt: 1 } as never,
			nodes: [],
			cards,
			ideaCards: []
		};
	}

	it('a newer review in another repertoire’s bundle wins', async () => {
		await upsertCard(graded('A', 'pos', 'Nf3', T + 1000));
		await addCard('B', 'pos', 'Nf3', T);
		const stats = await applyRepCoreBundleMerge(
			await coreBundle('B', [graded('B', 'pos', 'Nf3', T + 9000)])
		);

		expect(stats.cards).toBe(1);
		expect((await getCard('A', 'pos'))?.lastReview).toBe(T + 9000);
	});

	it('a stale copy loses and changes nothing', async () => {
		await upsertCard(graded('A', 'pos', 'Nf3', T + 9000));
		await addCard('B', 'pos', 'Nf3', T);
		const stats = await applyRepCoreBundleMerge(
			await coreBundle('B', [graded('B', 'pos', 'Nf3', T + 1000)])
		);

		expect(stats.cards).toBe(0);
		expect((await getCard('B', 'pos'))?.lastReview).toBe(T + 9000);
	});

	it('keeps the local move when the remote one was reviewed earlier', async () => {
		await upsertCard(graded('A', 'pos', 'Nf3', T + 9000));
		await applyRepCoreBundleMerge(await coreBundle('A', [graded('A', 'pos', 'c4', T + 1000)]));

		expect((await getCard('A', 'pos'))?.expectedSan).toBe('Nf3');
		expect((await cardForMove('A', 'pos', 'c4')).lastReview).toBe(T + 1000);
	});

	it('takes the remote move when it was reviewed more recently', async () => {
		await upsertCard(graded('A', 'pos', 'Nf3', T + 1000));
		await applyRepCoreBundleMerge(await coreBundle('A', [graded('A', 'pos', 'c4', T + 9000)]));

		expect((await getCard('A', 'pos'))?.expectedSan).toBe('c4');
	});

	it('the v1 wipe-and-restore path merges progress instead of overwriting it', async () => {
		await upsertCard(graded('A', 'pos', 'Nf3', T + 9000));
		await applyRepBundle({
			...(await coreBundle('B', [graded('B', 'pos', 'Nf3', T + 1000)])),
			kind: 'rep',
			mistakes: [],
			empiricalGaps: [],
			sparGames: [],
			positionWdl: []
		});

		expect((await getCard('B', 'pos'))?.lastReview).toBe(T + 9000);
	});
});

describe('library export and import', () => {
	it('round-trips cards with their progress', async () => {
		const db = await getDB();
		await db.put('repertoires', { id: 'A', name: 'A', updatedAt: 1 } as never);
		await upsertCard(graded('A', 'pos', 'Nf3', T + 1000));
		const file = await exportAll();
		expect(file.cards[0].lastReview).toBe(T + 1000);

		await importAll(file);
		expect((await getCard('A', 'pos'))?.lastReview).toBe(T + 1000);
	});

	it('folds an old file’s per-repertoire copies of one move by most recent review', async () => {
		await importAll({
			version: 2,
			exportedAt: T,
			repertoires: [],
			nodes: [],
			cards: [graded('A', 'pos', 'Nf3', T + 9000), graded('B', 'pos', 'Nf3', T + 1000)],
			settings: null
		});

		expect((await getCard('B', 'pos'))?.lastReview).toBe(T + 9000);
	});
});
