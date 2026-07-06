// Integration test for the "Train from this position" feature (issue #75):
// buildSegment with a `startFenKey` must scope the drill to the subtree rooted
// at that position — every prepared move below it, regardless of FSRS due date
// — rather than replaying the whole repertoire from the root.
//
// Runs against a real IndexedDB via fake-indexeddb so it exercises the actual
// nodesMap / listCards / dueCards reads inside buildSegment.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Card, Repertoire, RepertoireNode } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { defaultSettings } from '$lib/storage/settings';
import { buildSegment } from './buildSegment';

const REP = 'rep-1';
const ROOT = 'root';

// Tree (edges are user→opponent→user, but scoping is color-agnostic):
//   root → A → B → { C, D → E }
// Cards live at the user-to-move positions A, C, E. The subtree rooted at B
// contains C, D, E; A and root sit above it.
function node(fenKey: string, children: string[]): RepertoireNode {
	return {
		repertoireId: REP,
		fenKey,
		children: children.map((toFenKey) => ({ san: 'x', uci: 'xxxx', toFenKey }))
	};
}

function card(fenKey: string): Card {
	// dueAt in the past so `due` mode surfaces it; no lastReview → treated as new.
	return { repertoireId: REP, fenKey, expectedSan: 'x', fsrs: {} as Card['fsrs'], dueAt: 0 };
}

const rep: Repertoire = {
	id: REP,
	name: 'Test',
	color: 'white',
	rootFen: 'startpos',
	rootFenKey: ROOT,
	createdAt: 0,
	updatedAt: 0
};

async function seed() {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards'], 'readwrite');
	const nodes = [
		node(ROOT, ['A']),
		node('A', ['B']),
		node('B', ['C', 'D']),
		node('C', []),
		node('D', ['E']),
		node('E', [])
	];
	for (const n of nodes) await tx.objectStore('nodes').put(n);
	for (const c of [card('A'), card('C'), card('E')]) await tx.objectStore('cards').put(c);
	await tx.done;
}

async function wipe() {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards'], 'readwrite');
	await tx.objectStore('nodes').clear();
	await tx.objectStore('cards').clear();
	await tx.done;
}

function settings() {
	// 'auto' (non-line-walk) keeps the assertion focused on pool scoping; caps
	// set high so nothing is trimmed for budget reasons.
	return {
		...defaultSettings(),
		drillIntermediateMoves: 'auto' as const,
		drillSessionCap: 100,
		dailyNewCardCap: 100
	};
}

function keys(cards: Card[]): string[] {
	return cards.map((c) => c.fenKey).sort();
}

describe('buildSegment train-from-position', () => {
	beforeEach(async () => {
		await wipe();
		await seed();
	});

	it('scopes the queue to the subtree rooted at startFenKey', async () => {
		const seg = await buildSegment(rep, 'due', settings(), { startFenKey: 'B' });
		// B's subtree holds C, D, E; only C and E have cards. A sits above B.
		expect(keys(seg.cards)).toEqual(['C', 'E']);
	});

	it('drills the whole repertoire when no startFenKey is given', async () => {
		const seg = await buildSegment(rep, 'due', settings());
		expect(keys(seg.cards)).toEqual(['A', 'C', 'E']);
	});

	it('ignores a startFenKey that is not a node in the repertoire', async () => {
		const seg = await buildSegment(rep, 'due', settings(), { startFenKey: 'not-a-real-key' });
		// Stale/unknown anchor falls back to a normal full-repertoire drill.
		expect(keys(seg.cards)).toEqual(['A', 'C', 'E']);
	});

	it('drills a due-empty subtree because scoping ignores due dates', async () => {
		// Push every card's due date far into the future: a normal `due` drill
		// would be empty, but train-from-position still surfaces the subtree.
		const db = await getDB();
		const tx = db.transaction('cards', 'readwrite');
		const future = 8640000000000; // well beyond any test `now`
		for (const c of [card('A'), card('C'), card('E')]) {
			await tx.objectStore('cards').put({ ...c, dueAt: future });
		}
		await tx.done;

		const scoped = await buildSegment(rep, 'due', settings(), { startFenKey: 'B' });
		expect(keys(scoped.cards)).toEqual(['C', 'E']);

		const normal = await buildSegment(rep, 'due', settings());
		expect(normal.cards).toEqual([]);
	});
});

// Soft-disabled lines (issue #80): a disabled edge shelves its move and the
// continuation reachable only through it from drilling, while keeping the
// cards in storage. Tree (from seed): root → A → B → { C, D → E }.
async function disableEdge(fromFenKey: string, toFenKey: string) {
	const db = await getDB();
	const node = await db.get('nodes', [REP, fromFenKey]);
	if (!node) throw new Error(`no node ${fromFenKey}`);
	const child = node.children.find((e) => e.toFenKey === toFenKey);
	if (!child) throw new Error(`no edge ${fromFenKey}->${toFenKey}`);
	child.disabled = true;
	await db.put('nodes', node);
}

describe('buildSegment disabled lines', () => {
	beforeEach(async () => {
		await wipe();
		await seed();
	});

	it('drops a continuation reachable only through a disabled edge', async () => {
		// Disable B→D: E sits solely under D, so it leaves the trainable pool;
		// C (via B→C) and A stay.
		await disableEdge('B', 'D');
		const seg = await buildSegment(rep, 'due', settings());
		expect(keys(seg.cards)).toEqual(['A', 'C']);
	});

	it('drops the move itself when the head edge is disabled', async () => {
		// Disable A→B: the card at A plays that edge's move, and B/C/E hang off
		// it, so the whole thing goes — an empty drill.
		await disableEdge('A', 'B');
		const seg = await buildSegment(rep, 'due', settings());
		expect(seg.cards).toEqual([]);
	});

	it('keeps everything when the disabled flag is cleared again', async () => {
		await disableEdge('B', 'D');
		// Re-enable by flipping it back off.
		const db = await getDB();
		const node = await db.get('nodes', [REP, 'B']);
		node!.children.find((e) => e.toFenKey === 'D')!.disabled = undefined;
		await db.put('nodes', node!);
		const seg = await buildSegment(rep, 'due', settings());
		expect(keys(seg.cards)).toEqual(['A', 'C', 'E']);
	});

	it('honours disabled edges under a train-from-position anchor', async () => {
		await disableEdge('B', 'D');
		const seg = await buildSegment(rep, 'due', settings(), { startFenKey: 'B' });
		// Subtree of B is {C, D, E}; D→E is disabled, so only C remains.
		expect(keys(seg.cards)).toEqual(['C']);
	});
});
