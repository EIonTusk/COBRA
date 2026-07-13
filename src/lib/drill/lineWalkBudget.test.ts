// Line-walk session budgeting (issue #84).
//
// A user with a large repertoire reported that the drill kept replaying the
// same shallow moves and barely advanced a 6000-card due queue. Three defects
// in the line-walk builder combined to cause it; each is pinned below.
//
// Runs against a real IndexedDB via fake-indexeddb so the actual
// nodesMap / dueCards / getCard reads inside buildSegment are exercised.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppSettings, Card, Repertoire, RepertoireNode } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { defaultSettings } from '$lib/storage/settings';
import { buildSegment } from './buildSegment';

const REP = 'rep-1';

// `colorToMove` only reads the side-to-move field, so FEN-shaped keys are
// enough to drive the builder's user-move-vs-opponent-move logic.
const W0 = 'w0 w -'; // root, user to move
const B0 = 'b0 b -';
const W1 = 'w1 w -';
const B1 = 'b1 b -';
const W2 = 'w2 w -';
const B2 = 'b2 b -';
const LEAVES = ['l1 w -', 'l2 w -', 'l3 w -', 'l4 w -', 'l5 w -'];

// Trunk W0 → W1 → W2, then five leaves fanning out below it. Every leaf's path
// back to the root crosses the same three user moves — the shared-trunk shape
// that made the old budget over-charge.
const TREE: [string, string[]][] = [
	[W0, [B0]],
	[B0, [W1]],
	[W1, [B1]],
	[B1, [W2]],
	[W2, [B2]],
	[B2, LEAVES],
	...LEAVES.map((l): [string, string[]] => [l, []])
];

const FUTURE = 8640000000000; // beyond any test `now`

const rep: Repertoire = {
	id: REP,
	name: 'Test',
	color: 'white',
	rootFen: 'startpos',
	rootFenKey: W0,
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

/** A graduated (Review-state) card, due now unless `dueAt` says otherwise. */
function reviewCard(
	fenKey: string,
	over: Partial<Card> & { state?: number; stability?: number } = {}
) {
	const { state = 2, stability = 1, ...rest } = over;
	return {
		repertoireId: REP,
		fenKey,
		expectedSan: 'x',
		fsrs: { state, stability } as Card['fsrs'],
		lastReview: 1,
		dueAt: 0,
		...rest
	} as Card;
}

/** Never reviewed → the builder treats it as new and charges the new budget. */
function newCard(fenKey: string): Card {
	return {
		repertoireId: REP,
		fenKey,
		expectedSan: 'x',
		fsrs: { state: 0, stability: 0 } as Card['fsrs'],
		dueAt: 0
	} as Card;
}

async function seed(cards: Card[]) {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards'], 'readwrite');
	await tx.objectStore('nodes').clear();
	await tx.objectStore('cards').clear();
	for (const [fenKey, children] of TREE) await tx.objectStore('nodes').put(node(fenKey, children));
	for (const c of cards) await tx.objectStore('cards').put(c);
	await tx.done;
}

function settings(over: Partial<AppSettings> = {}): AppSettings {
	return {
		...defaultSettings(),
		drillIntermediateMoves: 'play', // line-walk on — the default, and the path under test
		drillWellLearnedDays: 7,
		drillSessionCap: 10,
		dailyNewCardCap: 10,
		...over
	};
}

const TRUNK_AND_LEAVES = [W0, W1, W2, ...LEAVES];

describe('line-walk budgeting', () => {
	beforeEach(async () => {
		await seed(TRUNK_AND_LEAVES.map((k) => reviewCard(k)));
	});

	it('charges a shared trunk once, so the session reaches every due leaf', async () => {
		// Eight due cards. Each leaf's walk is [W0, W1, W2, leaf]. Billing every
		// walk for the full path cost 1+2+3+4+4+4+4+4 = 26 events against a cap of
		// 10, which stranded four of the five leaves. The trunk is emitted once, so
		// the true incremental cost is 8 — and the whole queue fits.
		const seg = await buildSegment(rep, 'due', settings({ drillSessionCap: 10 }));
		expect([...seg.dueOriginalKeys].sort()).toEqual([...TRUNK_AND_LEAVES].sort());
	});

	it('still refuses walks that overrun the session cap', async () => {
		// The budget is now accurate, not absent: a cap of 4 admits the trunk
		// (3 events) plus exactly one leaf, and stops.
		const seg = await buildSegment(rep, 'due', settings({ drillSessionCap: 4 }));
		expect(seg.dueOriginalKeys.size).toBe(4);
		for (const k of [W0, W1, W2]) expect(seg.dueOriginalKeys.has(k)).toBe(true);
	});

	it('builds a review-only session when the new-card budget is zero', async () => {
		// The natural way to grind down a backlog is to stop taking on new cards.
		// An exhausted new budget used to `break` the admission loop outright,
		// which starved reviews too and produced an empty session.
		const seg = await buildSegment(rep, 'due', settings({ dailyNewCardCap: 0 }));
		expect([...seg.dueOriginalKeys].sort()).toEqual([...TRUNK_AND_LEAVES].sort());
	});

	it('admits reviews alongside a new card once the new budget is spent', async () => {
		// One new leaf, everything else a review, and room for exactly one new
		// card. The new leaf gets in; so does every review behind it.
		await seed([
			...[W0, W1, W2].map((k) => reviewCard(k)),
			newCard(LEAVES[0]),
			...LEAVES.slice(1).map((k) => reviewCard(k))
		]);
		const seg = await buildSegment(
			rep,
			'due',
			settings({ dailyNewCardCap: 1, drillSessionCap: 20 })
		);
		expect([...seg.dueOriginalKeys].sort()).toEqual([...TRUNK_AND_LEAVES].sort());
	});

	it('holds new cards back beyond the new-card budget', async () => {
		await seed([...[W0, W1, W2].map((k) => reviewCard(k)), ...LEAVES.map(newCard)]);
		const seg = await buildSegment(
			rep,
			'due',
			settings({ dailyNewCardCap: 2, drillSessionCap: 40 })
		);
		const admittedLeaves = LEAVES.filter((l) => seg.dueOriginalKeys.has(l));
		expect(admittedLeaves.length).toBe(2);
	});
});

describe('line-walk well-learned prefixes', () => {
	// W1 is never due — it can only ever enter a session as a prefix step.
	const prefixOnly = (over: Partial<Card> & { state?: number; stability?: number }) => [
		reviewCard(W0, { state: 2, stability: 99 }),
		reviewCard(W1, { dueAt: FUTURE, ...over }),
		reviewCard(W2, { state: 2, stability: 99 }),
		...LEAVES.map((k) => reviewCard(k))
	];

	it('animates past a lapsed prefix whose stability still clears the threshold', async () => {
		// State 3 is Relearning. It used to fail the `state === 2` gate no matter
		// how stable the card was, so one slip on a trunk move conscripted every
		// line beneath it into re-drilling that move — every session, forever.
		await seed(prefixOnly({ state: 3, stability: 30 }));
		const seg = await buildSegment(rep, 'due', settings({ drillSessionCap: 40 }));
		expect(seg.cards.some((c) => c.fenKey === W1)).toBe(false);
	});

	it('still drills a lapsed prefix that has fallen below the threshold', async () => {
		await seed(prefixOnly({ state: 3, stability: 1 }));
		const seg = await buildSegment(rep, 'due', settings({ drillSessionCap: 40 }));
		expect(seg.cards.some((c) => c.fenKey === W1)).toBe(true);
		// Drilled as a lead-in only — a prefix step is not an FSRS review.
		expect(seg.dueOriginalKeys.has(W1)).toBe(false);
	});

	it('still drills an unlearned prefix that has not graduated', async () => {
		await seed(prefixOnly({ state: 1, stability: 99 }));
		const seg = await buildSegment(rep, 'due', settings({ drillSessionCap: 40 }));
		expect(seg.cards.some((c) => c.fenKey === W1)).toBe(true);
	});
});
