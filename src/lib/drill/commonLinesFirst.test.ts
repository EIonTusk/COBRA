// "Learn the most common lines first" (issue #86 follow-up): new moves are
// introduced by how likely you are to reach them, from the opponent-move
// frequencies stored on the tree.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Card, Edge, MoveFrequency, Repertoire, RepertoireNode } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { defaultSettings } from '$lib/storage/settings';
import { createFreshCard } from '$lib/fsrs/scheduler';
import { replaceRepertoireTree, nodesMap } from '$lib/storage/nodes';
import { buildSegment } from './buildSegment';

const REP = 'rep-common';
const f = (games: number): MoveFrequency => ({
	games,
	total: 1000,
	source: 'lichess',
	fetchedAt: 0
});
const e = (to: string, frequency?: MoveFrequency): Edge => ({
	san: to,
	uci: to,
	toFenKey: to,
	frequency
});

// White repertoire. After 1.e4 the opponent plays `c` (common, 80%) or `s`
// (rare, 2%); the common line continues one move deeper.
//   root w ─ o b ┬ c w ─ c2 b ─ cc w ─ c3 b
//                └ s w ─ s2 b ─ ss w ─ s3 b
const tree: RepertoireNode[] = [
	{ repertoireId: REP, fenKey: 'root w', children: [e('o b')] },
	{ repertoireId: REP, fenKey: 'o b', children: [e('c w', f(800)), e('s w', f(20))] },
	{ repertoireId: REP, fenKey: 'c w', children: [e('c2 b')] },
	{ repertoireId: REP, fenKey: 'c2 b', children: [e('cc w', f(500))] },
	{ repertoireId: REP, fenKey: 'cc w', children: [e('c3 b')] },
	{ repertoireId: REP, fenKey: 's w', children: [e('s2 b')] },
	{ repertoireId: REP, fenKey: 's2 b', children: [e('ss w', f(500))] },
	{ repertoireId: REP, fenKey: 'ss w', children: [e('s3 b')] },
	{ repertoireId: REP, fenKey: 'c3 b', children: [] },
	{ repertoireId: REP, fenKey: 's3 b', children: [] }
];
// Created shallow-rare-first, so import order alone would favour `s`.
const cardKeys = ['root w', 's w', 'ss w', 'c w', 'cc w'];

const rep: Repertoire = {
	id: REP,
	name: 'c',
	color: 'white',
	rootFen: 'startpos',
	rootFenKey: 'root w',
	createdAt: 0,
	updatedAt: 0
};

async function seed() {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards'], 'readwrite');
	await tx.objectStore('nodes').clear();
	await tx.objectStore('cards').clear();
	for (const n of tree) await tx.objectStore('nodes').put(structuredClone(n));
	cardKeys.forEach((k, i) => tx.objectStore('cards').put(createFreshCard(REP, k, 'x', 1 + i)));
	await tx.done;
}

const settings = (over: Record<string, unknown> = {}) => ({
	...defaultSettings(),
	drillSessionCap: 100,
	dailyNewCardCap: 3,
	...over
});
const keys = (cards: Card[]) => [...new Set(cards.map((c) => c.fenKey))].sort();

describe('learn the most common lines first', () => {
	beforeEach(seed);

	it.each(['play', 'auto'] as const)(
		'introduces a common deep move before a rare shallow one (walk=%s)',
		async (walk) => {
			// Line walk off tops a review-less session up with extra new moves,
			// so bound it by the session cap there.
			const cap = walk === 'auto' ? { drillSessionCap: 3 } : {};
			const seg = await buildSegment(
				rep,
				'due',
				settings({ drillIntermediateMoves: walk, ...cap })
			);
			expect(keys(seg.cards)).toEqual(['c w', 'cc w', 'root w']);
		}
	);

	it('goes shallowest-first when the setting is off', async () => {
		const seg = await buildSegment(
			rep,
			'due',
			settings({ drillIntermediateMoves: 'auto', drillSessionCap: 3, drillPrioritizeCommon: false })
		);
		expect(keys(seg.cards)).toEqual(['c w', 'root w', 's w']);
	});

	it('orders new moves the same way when training from a position', async () => {
		const seg = await buildSegment(
			rep,
			'due',
			settings({ drillIntermediateMoves: 'auto', drillSessionCap: 2 }),
			{ startFenKey: 'o b' }
		);
		expect(keys(seg.cards)).toEqual(['c w', 'cc w']);
	});

	it('keeps stored frequencies when a study pull rebuilds the tree', async () => {
		const edges = tree.flatMap((n) =>
			n.children.map((c) => ({ fromFenKey: n.fenKey, edge: { ...c, frequency: undefined } }))
		);
		await replaceRepertoireTree(REP, 'root w', edges);
		const nodes = await nodesMap(REP);
		expect(nodes.get('o b')!.children.map((c) => c.frequency?.games)).toEqual([800, 20]);
	});
});
