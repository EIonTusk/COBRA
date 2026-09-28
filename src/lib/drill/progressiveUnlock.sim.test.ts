// Multi-session simulation for issue #86. Each simulated day builds a real
// `due` segment from IndexedDB, answers every card in it through the real
// FSRS `reviewCard`, persists the result, and advances the clock a day —
// so scheduling, pooling and progressive unlock interact the way they do
// across real sessions, including after wrong answers.
//
// Simplification vs. DrillRunner: each card is rated once per session (the
// runner's Learn/Train passes and end-of-session retries can rate a new or
// failed card again the same day). That affects how fast stability grows,
// not which cards the builder offers — which is what's under test here.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rating } from 'ts-fsrs';
import type { Card, Repertoire, RepertoireNode } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { defaultSettings } from '$lib/storage/settings';
import { createFreshCard, reviewCard } from '$lib/fsrs/scheduler';
import { buildSegment } from './buildSegment';

const REP = 'rep-sim';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 9);

// Cards live at white-to-move keys (" w"), matching `colorToMove`.
const rep: Repertoire = {
	id: REP,
	name: 'Sim',
	color: 'white',
	rootFen: 'startpos',
	rootFenKey: 'n0 w',
	createdAt: 0,
	updatedAt: 0
};

interface SimTree {
	nodes: RepertoireNode[];
	/** Card fenKeys in PGN-import (depth-first, line by line) order. */
	importOrder: string[];
	/** User-move depth of each card (0 = first move). */
	depth: Map<string, number>;
	/** Nearest ancestor card of each card (none for the first move). */
	parentCard: Map<string, string>;
}

/**
 * White repertoire, one prepared move per position, two opponent replies
 * after each: `userMoves` deep → 2^userMoves − 1 cards. Built depth-first so
 * card creation order matches a PGN import.
 */
function buildTree(userMoves: number): SimTree {
	const nodes: RepertoireNode[] = [];
	const importOrder: string[] = [];
	const depth = new Map<string, number>();
	const parentCard = new Map<string, string>();
	let id = 0;
	const edge = (to: string) => ({ san: 'm', uci: 'm', toFenKey: to });
	const visit = (key: string, d: number, parent: string | null) => {
		importOrder.push(key);
		depth.set(key, d);
		if (parent) parentCard.set(key, parent);
		const opp = `n${++id} b`;
		nodes.push({ repertoireId: REP, fenKey: key, children: [edge(opp)] });
		if (d === userMoves - 1) {
			nodes.push({ repertoireId: REP, fenKey: opp, children: [] });
			return;
		}
		const kids = [`n${++id} w`, `n${++id} w`];
		nodes.push({ repertoireId: REP, fenKey: opp, children: kids.map(edge) });
		for (const k of kids) visit(k, d + 1, key);
	};
	visit(rep.rootFenKey, 0, null);
	return { nodes, importOrder, depth, parentCard };
}

async function seed(tree: SimTree) {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards'], 'readwrite');
	await tx.objectStore('nodes').clear();
	await tx.objectStore('cards').clear();
	for (const n of tree.nodes) await tx.objectStore('nodes').put(n);
	for (let i = 0; i < tree.importOrder.length; i++) {
		await tx.objectStore('cards').put(createFreshCard(REP, tree.importOrder[i], 'm', T0 - DAY + i));
	}
	await tx.done;
}

type Policy = (fenKey: string, day: number, timesAsked: number) => boolean;

interface SimResult {
	introducedDay: Map<string, number>;
	/** Sessions where a new card was offered below a shaky / unseen ancestor. */
	gateViolations: string[];
	/** Days whose session had due reviews available but drilled none. */
	reviewStarvedDays: number[];
	/** Largest overdue gap (days) of any review at session build time. */
	maxOverdueDays: number;
	/** Days on which each card was drilled. */
	drilledOn: Map<string, number[]>;
	/** Stability of each card at the start of each day. */
	stabilityAt: (fenKey: string, day: number) => number | undefined;
}

async function simulate(
	tree: SimTree,
	days: number,
	policy: Policy,
	repOverrides: Partial<Repertoire> = {}
): Promise<SimResult> {
	await seed(tree);
	const settings = {
		...defaultSettings(),
		drillIntermediateMoves: 'play' as const,
		drillSessionCap: 30,
		dailyNewCardCap: 10
	};
	const r = { ...rep, ...repOverrides };
	const db = await getDB();
	const introducedDay = new Map<string, number>();
	const gateViolations: string[] = [];
	const reviewStarvedDays: number[] = [];
	const drilledOn = new Map<string, number[]>();
	const asked = new Map<string, number>();
	const stabilityLog = new Map<string, Map<number, number>>();
	let maxOverdueDays = 0;

	for (let day = 0; day < days; day++) {
		const now = T0 + day * DAY;
		vi.setSystemTime(now);
		const before = new Map((await db.getAll('cards')).map((c) => [c.fenKey, c] as [string, Card]));
		for (const c of before.values()) {
			if (!c.lastReview) continue;
			let log = stabilityLog.get(c.fenKey);
			if (!log) stabilityLog.set(c.fenKey, (log = new Map()));
			log.set(day, c.fsrs.stability);
		}
		const dueReviews = [...before.values()].filter((c) => c.lastReview && c.dueAt <= now);
		for (const c of dueReviews) maxOverdueDays = Math.max(maxOverdueDays, (now - c.dueAt) / DAY);

		const seg = await buildSegment(r, 'due', settings);
		const order = [...new Set(seg.cards.map((c) => c.fenKey))];
		if (dueReviews.length > 0 && !order.some((k) => before.get(k)!.lastReview)) {
			reviewStarvedDays.push(day);
		}

		// Gate invariant, checked against the state the session was built from.
		if (r.progressiveUnlock !== false) {
			order.forEach((k, i) => {
				if (before.get(k)!.lastReview) return;
				for (let a = tree.parentCard.get(k); a; a = tree.parentCard.get(a)) {
					const anc = before.get(a)!;
					const ok = anc.lastReview
						? anc.fsrs.stability >= 1
						: order.indexOf(a) !== -1 && order.indexOf(a) < i;
					if (!ok) gateViolations.push(`day ${day}: ${k} offered below ${a}`);
				}
			});
		}

		for (const k of order) {
			const card = (await db.get('cards', [REP, k]))!;
			if (!card.lastReview) introducedDay.set(k, day);
			const n = (asked.get(k) ?? 0) + 1;
			asked.set(k, n);
			const correct = policy(k, day, n);
			await db.put(
				'cards',
				reviewCard(card, correct ? Rating.Good : Rating.Again, settings.fsrsParams, new Date(now))
			);
			const list = drilledOn.get(k) ?? [];
			list.push(day);
			drilledOn.set(k, list);
		}
	}

	return {
		introducedDay,
		gateViolations,
		reviewStarvedDays,
		maxOverdueDays,
		drilledOn,
		stabilityAt: (k, d) => stabilityLog.get(k)?.get(d)
	};
}

/** Deterministic PRNG so the random-mistake runs are reproducible. */
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

function maxDepth(tree: SimTree) {
	return Math.max(...tree.depth.values());
}

describe('multi-session drill simulation (issue #86)', { timeout: 120_000 }, () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const tree = buildTree(7); // 127 cards

	it('all answers right: introduces everything, breadth-first, without starving reviews', async () => {
		// 255 cards — more than the old 150-card due window, which is what let
		// import order leak into the new-card order and crowd out reviews.
		const tree = buildTree(8);
		const res = await simulate(tree, 45, () => true);

		expect(res.introducedDay.size).toBe(tree.importOrder.length);
		expect(res.gateViolations).toEqual([]);
		expect(res.reviewStarvedDays).toEqual([]);
		expect(res.maxOverdueDays).toBeLessThanOrEqual(1);

		// Breadth-first across the whole tree: every move at depth d is
		// introduced no later than any move at depth d + 1.
		for (let d = 0; d < maxDepth(tree); d++) {
			const days = (dd: number) =>
				tree.importOrder
					.filter((k) => tree.depth.get(k) === dd)
					.map((k) => res.introducedDay.get(k)!);
			expect(Math.max(...days(d))).toBeLessThanOrEqual(Math.min(...days(d + 1)));
		}
	});

	it('a forgotten early move pauses only its own subtree until it is recalled', async () => {
		// Second move of the left branch: answered wrong the first 3 times asked.
		const weak = tree.importOrder[1];
		const sibling = tree.importOrder.find((k) => tree.depth.get(k) === 1 && k !== weak)!;
		const below = (anc: string) =>
			tree.importOrder.filter((k) => {
				for (let a = tree.parentCard.get(k); a; a = tree.parentCard.get(a))
					if (a === anc) return true;
				return false;
			});

		const res = await simulate(tree, 40, (k, _day, n) => !(k === weak && n <= 3));

		expect(res.gateViolations).toEqual([]);
		expect(res.reviewStarvedDays).toEqual([]);

		// The weak move keeps coming back while it's shaky…
		const weakDays = res.drilledOn.get(weak)!;
		expect(weakDays.length).toBeGreaterThanOrEqual(4);
		const recoveredDay = weakDays[3]; // first correct answer
		expect(weakDays.slice(0, 4)).toEqual(
			weakDays.slice(0, 4).map((_, i) => weakDays[0] + i) // daily, no gaps
		);

		// Days whose session was built while the weak move was shaky. (Moves
		// below it may already have been introduced on day 0, alongside it,
		// before it was ever answered wrong — that's by design.)
		const shakyDays: number[] = [];
		for (let d = weakDays[0] + 1; d <= recoveredDay; d++) {
			if ((res.stabilityAt(weak, d) ?? Infinity) < 1) shakyDays.push(d);
		}
		expect(shakyDays.length).toBe(3);

		// …nothing new beneath it is introduced while it's shaky…
		for (const k of below(weak)) {
			expect(shakyDays).not.toContain(res.introducedDay.get(k));
		}
		// …its subtree resumes once it's answered right…
		expect(below(weak).some((k) => res.introducedDay.get(k)! > recoveredDay)).toBe(true);
		// …while the sibling branch keeps progressing in the meantime…
		expect(below(sibling).some((k) => shakyDays.includes(res.introducedDay.get(k)!))).toBe(true);
		// …and everything is eventually learned.
		expect(res.introducedDay.size).toBe(tree.importOrder.length);
	});

	it('random mistakes (25%): gate holds every session, no deadlock, no review starvation', async () => {
		const rand = rng(86);
		const res = await simulate(tree, 70, () => rand() >= 0.25);

		expect(res.gateViolations).toEqual([]);
		expect(res.reviewStarvedDays).toEqual([]);
		expect(res.maxOverdueDays).toBeLessThanOrEqual(1);
		expect(res.introducedDay.size).toBe(tree.importOrder.length);
	});

	it('with progressive unlock off, new moves still arrive below a shaky move', async () => {
		const weak = tree.importOrder[1];
		const res = await simulate(tree, 40, (k, _day, n) => !(k === weak && n <= 3), {
			progressiveUnlock: false
		});
		const weakDays = res.drilledOn.get(weak)!;
		const recoveredDay = weakDays[3];
		const child = tree.importOrder.find((k) => tree.parentCard.get(k) === weak)!;
		expect(res.introducedDay.get(child)!).toBeLessThanOrEqual(recoveredDay);
		expect(res.introducedDay.size).toBe(tree.importOrder.length);
	});
});
