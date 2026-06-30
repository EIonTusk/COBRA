// Integration test for the editor's delete-and-prune path (issue #64):
// deleting a move in the Edit Tree must drop the orphaned line's nodes AND
// its FSRS move/idea cards, or the drill keeps serving the deleted variation
// (the drill pool reads cards by index, not by walking the tree).
//
// Runs against a real IndexedDB provided by fake-indexeddb, so it exercises
// the actual transaction in `removeEdgeAndPrune` rather than a stand-in.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Card, IdeaCard, RepertoireNode } from '$lib/types';
import { getDB } from './db';
import { addEdge, removeEdge, removeEdgeAndPrune } from './nodes';

async function getNode(fenKey: string): Promise<RepertoireNode | undefined> {
	const db = await getDB();
	return db.get('nodes', [REP, fenKey]);
}

const REP = 'rep-1';
const ROOT = 'root';

function node(fenKey: string, children: Array<{ toFenKey: string; san?: string }>): RepertoireNode {
	return {
		repertoireId: REP,
		fenKey,
		children: children.map((c) => ({ san: c.san ?? 'x', uci: 'xxxx', toFenKey: c.toFenKey }))
	};
}

function card(fenKey: string): Card {
	return { repertoireId: REP, fenKey, expectedSan: 'x', fsrs: {} as Card['fsrs'], dueAt: 0 };
}

function idea(fenKey: string): IdeaCard {
	return {
		repertoireId: REP,
		fenKey,
		prompt: '?',
		fsrs: {} as IdeaCard['fsrs'],
		dueAt: 0,
		createdAt: 0
	};
}

async function seed(nodes: RepertoireNode[], cards: Card[], ideas: IdeaCard[]) {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards', 'idea_cards'], 'readwrite');
	for (const n of nodes) await tx.objectStore('nodes').put(n);
	for (const c of cards) await tx.objectStore('cards').put(c);
	for (const i of ideas) await tx.objectStore('idea_cards').put(i);
	await tx.done;
}

async function liveKeys(store: 'nodes' | 'cards' | 'idea_cards'): Promise<string[]> {
	const db = await getDB();
	const keys = await db.getAllKeysFromIndex(store, 'by-repertoire', REP);
	return (keys as Array<[string, string]>).map(([, fenKey]) => fenKey).sort();
}

async function wipe() {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards', 'idea_cards'], 'readwrite');
	await tx.objectStore('nodes').clear();
	await tx.objectStore('cards').clear();
	await tx.objectStore('idea_cards').clear();
	await tx.done;
}

describe('removeEdgeAndPrune', () => {
	beforeEach(wipe);

	it('drops the orphaned line, including its cards and idea cards', async () => {
		// root -e4-> a -e5-> b -Nf3-> c  (a linear line under 'a')
		await seed(
			[
				node(ROOT, [{ toFenKey: 'a', san: 'e4' }]),
				node('a', [{ toFenKey: 'b', san: 'e5' }]),
				node('b', [{ toFenKey: 'c', san: 'Nf3' }]),
				node('c', [])
			],
			[card('a'), card('b'), card('c')],
			[idea('b'), idea('c')]
		);

		// Delete the e4 move at the root → the whole a/b/c line is orphaned.
		await removeEdgeAndPrune(REP, ROOT, ROOT, 'a');

		expect(await liveKeys('nodes')).toEqual(['root']);
		expect(await liveKeys('cards')).toEqual([]);
		expect(await liveKeys('idea_cards')).toEqual([]);
	});

	it('prunes only the cut subtree, leaving sibling lines intact', async () => {
		// root branches: e4->a (a->c) and d4->b (b->d)
		await seed(
			[
				node(ROOT, [
					{ toFenKey: 'a', san: 'e4' },
					{ toFenKey: 'b', san: 'd4' }
				]),
				node('a', [{ toFenKey: 'c', san: 'e5' }]),
				node('b', [{ toFenKey: 'd', san: 'd5' }]),
				node('c', []),
				node('d', [])
			],
			[card('a'), card('b'), card('c'), card('d')],
			[idea('c'), idea('d')]
		);

		await removeEdgeAndPrune(REP, ROOT, ROOT, 'a');

		expect(await liveKeys('nodes')).toEqual(['b', 'd', 'root']);
		expect(await liveKeys('cards')).toEqual(['b', 'd']);
		expect(await liveKeys('idea_cards')).toEqual(['d']);
	});

	it('keeps a position that still transposes in via another live edge', async () => {
		// root -e4-> a -...-> shared, and root -d4-> b -...-> shared.
		// Cutting e4 leaves 'shared' reachable through the d4 line.
		await seed(
			[
				node(ROOT, [
					{ toFenKey: 'a', san: 'e4' },
					{ toFenKey: 'b', san: 'd4' }
				]),
				node('a', [{ toFenKey: 'shared', san: 'm1' }]),
				node('b', [{ toFenKey: 'shared', san: 'm2' }]),
				node('shared', [])
			],
			[card('a'), card('b'), card('shared')],
			[]
		);

		await removeEdgeAndPrune(REP, ROOT, ROOT, 'a');

		// 'a' is orphaned and pruned; 'shared' survives via b.
		expect(await liveKeys('nodes')).toEqual(['b', 'root', 'shared']);
		expect(await liveKeys('cards')).toEqual(['b', 'shared']);
	});

	it('no-ops when the parent node does not exist', async () => {
		await seed([node(ROOT, [])], [], []);
		await expect(removeEdgeAndPrune(REP, ROOT, 'ghost', 'a')).resolves.toBeUndefined();
		expect(await liveKeys('nodes')).toEqual(['root']);
	});

	it('records an edge tombstone on the parent so the deletion can sync', async () => {
		await seed([node(ROOT, [{ toFenKey: 'a', san: 'e4' }]), node('a', [])], [], []);
		const before = Date.now();
		await removeEdgeAndPrune(REP, ROOT, ROOT, 'a');

		const root = await getNode(ROOT);
		expect(root?.deletedChildren).toHaveLength(1);
		expect(root?.deletedChildren?.[0].toFenKey).toBe('a');
		expect(root?.deletedChildren?.[0].deletedAt).toBeGreaterThanOrEqual(before);
	});
});

describe('edge tombstone producer wiring', () => {
	beforeEach(wipe);

	it('removeEdge records a tombstone without pruning', async () => {
		await seed([node(ROOT, [{ toFenKey: 'a', san: 'e4' }]), node('a', [])], [], []);
		await removeEdge(REP, ROOT, 'a');

		const root = await getNode(ROOT);
		expect(root?.children).toEqual([]);
		expect(root?.deletedChildren?.map((t) => t.toFenKey)).toEqual(['a']);
		// removeEdge intentionally does not prune — 'a' stays as an orphan node.
		expect(await getNode('a')).toBeDefined();
	});

	it('re-adding a deleted edge clears its tombstone', async () => {
		await seed([node(ROOT, [{ toFenKey: 'a', san: 'e4' }]), node('a', [])], [], []);
		await removeEdge(REP, ROOT, 'a');
		expect((await getNode(ROOT))?.deletedChildren).toHaveLength(1);

		await addEdge(REP, ROOT, { san: 'e4', uci: 'e2e4', toFenKey: 'a' });
		const root = await getNode(ROOT);
		expect(root?.children.map((e) => e.toFenKey)).toEqual(['a']);
		expect(root?.deletedChildren).toBeUndefined();
	});

	it('refreshes an existing tombstone rather than duplicating it', async () => {
		await seed([node(ROOT, [{ toFenKey: 'a', san: 'e4' }]), node('a', [])], [], []);
		await removeEdge(REP, ROOT, 'a');
		// Re-add then delete again — the tombstone list must not grow.
		await addEdge(REP, ROOT, { san: 'e4', uci: 'e2e4', toFenKey: 'a' });
		await removeEdge(REP, ROOT, 'a');

		expect((await getNode(ROOT))?.deletedChildren).toHaveLength(1);
	});
});
