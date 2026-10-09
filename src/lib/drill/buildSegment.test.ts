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
import { buildSegment, depthFilter, trainableFilter } from './buildSegment';

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

// Issue #91: the remaining paths that let disabled moves back into a drill —
// mistake/retrain modes, idea prompts, and line-walk prefix steps.
describe('buildSegment disabled lines in every mode', () => {
	beforeEach(async () => {
		await wipe();
		await seed();
		const db = await getDB();
		await db.clear('idea_cards');
		await db.clear('mistakes');
		await db.clear('repertoires');
	});

	it('drops lapsed cards in a disabled line from mistakes mode', async () => {
		const db = await getDB();
		const lapsed = (k: string): Card => ({
			...card(k),
			fsrs: { lapses: 1, state: 3 } as Card['fsrs'],
			lastReview: 1
		});
		for (const k of ['A', 'C', 'E']) await db.put('cards', lapsed(k));
		await disableEdge('B', 'D');
		const seg = await buildSegment(rep, 'mistakes', settings());
		expect(keys(seg.cards)).toEqual(['A', 'C']);
	});

	it('drops pending game mistakes in a disabled line from retrain mode', async () => {
		const db = await getDB();
		await db.put('repertoires', { ...rep, startingFenKey: null });
		const mistake = (fenKey: string) => ({
			id: `g:${REP}:${fenKey}`,
			gameId: 'g',
			gameUrl: '',
			playedAt: 0,
			detectedAt: 0,
			speed: 'blitz',
			opponent: 'o',
			color: 'white' as const,
			repertoireId: REP,
			repertoireName: 'Test',
			fenKey,
			fen: fenKey,
			playedSan: 'y',
			expectedSan: 'x',
			plyOffTree: 0,
			status: 'pending' as const,
			correctCount: 0
		});
		for (const k of ['C', 'E']) await db.put('mistakes', mistake(k));
		await disableEdge('B', 'D');
		const seg = await buildSegment(rep, 'retrain', settings());
		expect(keys(seg.cards)).toEqual(['C']);
	});

	it('drops idea prompts at positions only reachable through a disabled line', async () => {
		const db = await getDB();
		const idea = (fenKey: string) => ({
			repertoireId: REP,
			fenKey,
			prompt: 'plan?',
			fsrs: {} as Card['fsrs'],
			dueAt: 0,
			createdAt: 0
		});
		for (const k of ['C', 'E']) await db.put('idea_cards', idea(k));
		await disableEdge('B', 'D');
		const seg = await buildSegment(rep, 'due', settings());
		expect(seg.ideaQueue.map((c) => c.fenKey)).toEqual(['C']);
	});

	it('drills a position by its live move when the card expects a disabled one', async () => {
		// root → P; P offers 'p' (disabled, → Q) and 'q' (live, → R → F).
		// The card at P was created for 'p'. Issue #91 stopped the walk to F
		// from asking 'p'; issue #102: P isn't dropped either, since 'q' is
		// still prepared there, so the drill asks P with 'q' as the answer.
		await wipe();
		const db = await getDB();
		const n = (fenKey: string, children: RepertoireNode['children']): RepertoireNode => ({
			repertoireId: REP,
			fenKey,
			children
		});
		const e = (san: string, toFenKey: string, disabled?: boolean) => ({
			san,
			uci: 'xxxx',
			toFenKey,
			...(disabled ? { disabled } : {})
		});
		for (const node of [
			n(ROOT, [e('a', 'P')]),
			n('P', [e('p', 'Q', true), e('q', 'R')]),
			n('Q', []),
			n('R', [e('r', 'F')]),
			n('F', [e('f', 'G')]),
			n('G', [])
		])
			await db.put('nodes', node);
		await db.put('cards', { ...card('P'), expectedSan: 'p' });
		await db.put('cards', { ...card('F'), expectedSan: 'f' });
		// Test keys read as black-to-move, so a black rep owns every position.
		const blackRep: Repertoire = { ...rep, color: 'black' };
		const seg = await buildSegment(blackRep, 'due', {
			...settings(),
			drillIntermediateMoves: 'play' as const
		});
		expect(seg.cards.map((c) => c.fenKey)).toEqual(['P', 'F']);
		const filter = trainableFilter(blackRep, seg.nodes);
		expect(filter({ ...card('P'), expectedSan: 'p' })).toBe(true);

		// Disable 'q' too: nothing is prepared at P any more, so P drops out.
		await db.put('nodes', n('P', [e('p', 'Q', true), e('q', 'R', true)]));
		const after = await buildSegment(blackRep, 'due', settings());
		expect(after.cards.map((c) => c.fenKey)).not.toContain('P');
	});
});

// A line walk's prefix steps reinforce moves already learned. Its route
// prefers live lines while progressive unlock gates along the shortest route,
// so through a transposition a never-introduced move can sit on the walk. It
// must not be asked there: unhinted, and past the gate.
describe('buildSegment line-walk prefix steps', () => {
	it('never asks a move that was never introduced', async () => {
		// root → Q (disabled) → F is the short route; root → P → R → F the
		// live one. F is a due review; P is new and not yet offered.
		await wipe();
		const db = await getDB();
		const e = (san: string, toFenKey: string, disabled?: boolean) => ({
			san,
			uci: 'xxxx',
			toFenKey,
			...(disabled ? { disabled } : {})
		});
		const n = (fenKey: string, children: RepertoireNode['children']): RepertoireNode => ({
			repertoireId: REP,
			fenKey,
			children
		});
		for (const node of [
			n(ROOT, [e('a', 'Q', true), e('b', 'P')]),
			n('Q', [e('q', 'F')]),
			n('P', [e('p', 'R')]),
			n('R', [e('r', 'F')]),
			n('F', [e('f', 'G')]),
			n('G', [])
		])
			await db.put('nodes', node);
		await db.put('cards', { ...card('P'), expectedSan: 'p', dueAt: Date.now() + 86_400_000 });
		await db.put('cards', {
			...card('F'),
			expectedSan: 'f',
			fsrs: { state: 2, stability: 1 } as Card['fsrs'],
			lastReview: Date.now() - 86_400_000,
			lastRating: 3
		});
		// Test keys read as black-to-move, so a black rep owns every position.
		const seg = await buildSegment({ ...rep, color: 'black' }, 'due', {
			...settings(),
			drillIntermediateMoves: 'play' as const
		});
		expect(seg.cards.map((c) => c.fenKey)).toEqual(['F']);
	});
});

// Training depth (issue #86): only drill moves within the first N moves of
// each line. Test keys aren't real FENs, so `colorToMove` reads the root as
// black-to-move (offset 1): ply 0 → move 1, plies 1–2 → move 2, plies 3–4 →
// move 3. Tree: root(0) → A(1) → B(2) → { C(3), D(3) → E(4) }.
describe('buildSegment training depth', () => {
	beforeEach(async () => {
		await wipe();
		await seed();
	});

	it('keeps only cards within the first N moves', async () => {
		const seg = await buildSegment({ ...rep, drillMaxMoves: 2 }, 'due', settings());
		expect(keys(seg.cards)).toEqual(['A']);
	});

	it('only limits the repertoire it is set on', async () => {
		const seg = await buildSegment(rep, 'due', settings());
		expect(keys(seg.cards)).toEqual(['A', 'C', 'E']);
	});

	it('trains the full repertoire when the limit is 0', async () => {
		const seg = await buildSegment({ ...rep, drillMaxMoves: 0 }, 'due', settings());
		expect(keys(seg.cards)).toEqual(['A', 'C', 'E']);
	});

	it('includes a move exactly at the limit', async () => {
		const seg = await buildSegment({ ...rep, drillMaxMoves: 3 }, 'due', settings());
		expect(keys(seg.cards)).toEqual(['A', 'C', 'E']);
	});

	it('combines with train-from-position, counting from the repertoire root', async () => {
		const seg = await buildSegment({ ...rep, drillMaxMoves: 2 }, 'due', settings(), {
			startFenKey: 'B'
		});
		expect(seg.cards).toEqual([]);
	});

	it('applies under line-walk too', async () => {
		const seg = await buildSegment({ ...rep, drillMaxMoves: 2 }, 'due', {
			...settings(),
			drillIntermediateMoves: 'play'
		});
		expect(keys(seg.cards)).toEqual(['A']);
	});
});

describe('depthFilter', () => {
	const WHITE_ROOT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
	const nodes = new Map<string, RepertoireNode>([
		[WHITE_ROOT, node(WHITE_ROOT, ['p1'])],
		['p1', node('p1', ['p2'])],
		['p2', node('p2', ['p3'])],
		['p3', node('p3', [])]
	]);
	const whiteRep = { ...rep, rootFenKey: WHITE_ROOT };
	const c = (fenKey: string) => card(fenKey);

	it('numbers moves from a white-to-move root', () => {
		const within1 = depthFilter(whiteRep, nodes, 1);
		// ply 0 (1.e4) and ply 1 (1...e5) are move 1; ply 2 is move 2.
		expect(within1(c(WHITE_ROOT))).toBe(true);
		expect(within1(c('p1'))).toBe(true);
		expect(within1(c('p2'))).toBe(false);
	});

	it('drops cards unreachable from the root', () => {
		expect(depthFilter(whiteRep, nodes, 10)(c('orphan'))).toBe(false);
	});

	it('is a no-op without a limit', () => {
		expect(depthFilter(whiteRep, nodes, undefined)(c('orphan'))).toBe(true);
	});
});
