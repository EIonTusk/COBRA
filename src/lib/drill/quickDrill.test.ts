// Issue #97: a move two repertoires both prepare shares one progress record,
// so the merged quick drill plans it once, not once per repertoire.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Card, Repertoire, RepertoireNode } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { defaultSettings } from '$lib/storage/settings';
import { addCard } from '$lib/storage/cards';
import { buildQuickDrillSegments } from './quickDrill';

function node(repertoireId: string, fenKey: string, children: string[]): RepertoireNode {
	return {
		repertoireId,
		fenKey,
		children: children.map((toFenKey) => ({ san: 'x', uci: 'xxxx', toFenKey }))
	};
}

function rep(id: string): Repertoire {
	return {
		id,
		name: id,
		color: 'white',
		rootFen: 'startpos',
		rootFenKey: 'root',
		createdAt: 0,
		updatedAt: 0
	};
}

const keys = (cards: Card[]) => cards.map((c) => c.fenKey).sort();

describe('buildQuickDrillSegments', () => {
	it('plans a move shared by two repertoires only once', async () => {
		const db = await getDB();
		await db.put('nodes', node('one', 'root', ['A']));
		await db.put('nodes', node('one', 'A', []));
		await db.put('nodes', node('two', 'root', ['A', 'B']));
		await db.put('nodes', node('two', 'A', []));
		await db.put('nodes', node('two', 'B', []));
		await addCard('one', 'A', 'x', 0);
		await addCard('two', 'A', 'x', 0);
		await addCard('two', 'B', 'x', 0);

		const segments = await buildQuickDrillSegments([rep('one'), rep('two')], {
			...defaultSettings(),
			drillIntermediateMoves: 'auto',
			drillSessionCap: 100,
			dailyNewCardCap: 100
		});

		expect(segments.map((s) => [s.rep.id, keys(s.cards)])).toEqual([
			['one', ['A']],
			['two', ['B']]
		]);
	});
});
