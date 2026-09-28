// Issue #86: new cards are introduced breadth-first across the whole tree
// and, with progressive unlock on, only once the path leading to them is
// learned. Also guards the pool split that stops a backlog of never-seen
// cards from crowding due reviews out of the session.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Card, Repertoire, RepertoireNode } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { defaultSettings } from '$lib/storage/settings';
import { shortestPathTree } from '$lib/tree/traversal';
import { buildSegment, orderNewCards } from './buildSegment';

const REP = 'rep-progressive';
const ROOT = 'root';

const rep: Repertoire = {
	id: REP,
	name: 'Test',
	color: 'white',
	rootFen: 'startpos',
	rootFenKey: ROOT,
	createdAt: 0,
	updatedAt: 0
};

function node(fenKey: string, children: string[]): RepertoireNode {
	return {
		repertoireId: REP,
		fenKey,
		children: children.map((toFenKey) => ({ san: 'x', uci: 'xxxx', toFenKey }))
	};
}

function newCard(fenKey: string, dueAt: number): Card {
	return { repertoireId: REP, fenKey, expectedSan: 'x', fsrs: {} as Card['fsrs'], dueAt };
}

function reviewed(fenKey: string, stability: number, dueAt: number): Card {
	return {
		...newCard(fenKey, dueAt),
		fsrs: { state: 2, stability } as Card['fsrs'],
		lastReview: dueAt - 1
	} as Card;
}

async function reset(nodes: RepertoireNode[], cards: Card[]) {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards'], 'readwrite');
	await tx.objectStore('nodes').clear();
	await tx.objectStore('cards').clear();
	for (const n of nodes) await tx.objectStore('nodes').put(n);
	for (const c of cards) await tx.objectStore('cards').put(c);
	await tx.done;
}

/**
 * `lines` independent lines of `depth` cards each, all branching at the
 * root, seeded line by line with increasing dueAt — exactly how PGN import
 * orders them.
 */
function importedTree(lines: number, depth: number) {
	const nodes: RepertoireNode[] = [];
	const cards: Card[] = [];
	const heads: string[] = [];
	let t = 1;
	for (let l = 0; l < lines; l++) {
		const keys = Array.from({ length: depth }, (_, d) => `L${l}D${d}`);
		heads.push(keys[0]);
		keys.forEach((k, d) => {
			nodes.push(node(k, d < depth - 1 ? [keys[d + 1]] : []));
			cards.push(newCard(k, t++));
		});
	}
	nodes.push(node(ROOT, heads));
	return { nodes, cards };
}

function settings(overrides: Record<string, unknown> = {}) {
	return {
		...defaultSettings(),
		drillIntermediateMoves: 'play' as const,
		drillSessionCap: 30,
		dailyNewCardCap: 10,
		...overrides
	};
}

describe('buildSegment pool (issue #86)', () => {
	beforeEach(async () => {
		const { nodes, cards } = importedTree(20, 20);
		// One due review deep in the import order (last line).
		cards[cards.length - 20] = reviewed('L19D0', 5, Date.now() - 1000);
		await reset(nodes, cards);
	});

	it('keeps due reviews in the session despite a large new-card backlog', async () => {
		const seg = await buildSegment(rep, 'due', settings());
		expect(seg.cards.map((c) => c.fenKey)).toContain('L19D0');
	});

	it('introduces new cards shallowest-first across the whole tree, not in import order', async () => {
		const seg = await buildSegment(rep, 'due', settings());
		const newKeys = seg.cards.filter((c) => !c.lastReview).map((c) => c.fenKey);
		expect(newKeys.length).toBeGreaterThan(0);
		// Every introduced card is a line's first move — no deep moves of the
		// first-imported lines ahead of later lines' first moves.
		for (const k of newKeys) expect(k).toMatch(/D0$/);
	});
});

describe('buildSegment progressive unlock', () => {
	// root → A → B → C → D → E; user cards at A, C, E.
	const nodes = [
		node(ROOT, ['A']),
		node('A', ['B']),
		node('B', ['C']),
		node('C', ['D']),
		node('D', ['E']),
		node('E', [])
	];
	const past = Date.now() - 60_000;
	const future = Date.now() + 10 * 86_400_000;

	it('holds back a new move while an earlier move on its line is shaky', async () => {
		await reset(nodes, [reviewed('A', 0.2, future), newCard('C', 1), newCard('E', 2)]);
		const seg = await buildSegment(rep, 'due', settings());
		expect(seg.cards).toEqual([]);
	});

	it('unlocks it once the earlier move is recalled', async () => {
		await reset(nodes, [reviewed('A', 3, future), newCard('C', 1), newCard('E', 2)]);
		const seg = await buildSegment(rep, 'due', settings());
		expect(seg.cards.map((c) => c.fenKey).sort()).toEqual(['C', 'E']);
	});

	it('still drills the shaky move itself when it comes due', async () => {
		await reset(nodes, [reviewed('A', 0.2, past), newCard('C', 1)]);
		const seg = await buildSegment(rep, 'due', settings());
		expect(seg.cards.map((c) => c.fenKey)).toEqual(['A']);
	});

	it('can be switched off per repertoire', async () => {
		await reset(nodes, [reviewed('A', 0.2, future), newCard('C', 1), newCard('E', 2)]);
		const seg = await buildSegment({ ...rep, progressiveUnlock: false }, 'due', settings());
		expect(seg.cards.map((c) => c.fenKey).sort()).toEqual(['C', 'E']);
	});
});

describe('orderNewCards', () => {
	const nodes = new Map<string, RepertoireNode>(
		[node(ROOT, ['A', 'X']), node('A', ['B']), node('B', ['C']), node('C', []), node('X', [])].map(
			(n) => [n.fenKey, n]
		)
	);
	const tree = shortestPathTree(nodes, ROOT);

	it('orders by depth, then import order', () => {
		const fresh = [newCard('C', 1), newCard('X', 3), newCard('A', 2)];
		const out = orderNewCards(fresh, new Map(), tree, false);
		expect(out.map((c) => c.fenKey)).toEqual(['A', 'X', 'C']);
	});

	it('chains a fresh line within one ordering', () => {
		const fresh = [newCard('A', 1), newCard('C', 2)];
		const byKey = new Map(fresh.map((c) => [c.fenKey, c]));
		expect(orderNewCards(fresh, byKey, tree, true).map((c) => c.fenKey)).toEqual(['A', 'C']);
	});

	it('does not let an untrainable new ancestor block its descendants', () => {
		// A has a card but isn't offered (e.g. its line is disabled).
		const byKey = new Map([
			['A', newCard('A', 1)],
			['C', newCard('C', 2)]
		]);
		const out = orderNewCards([newCard('C', 2)], byKey, tree, true);
		expect(out.map((c) => c.fenKey)).toEqual(['C']);
	});
});
