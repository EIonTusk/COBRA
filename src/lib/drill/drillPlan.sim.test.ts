// Randomised multi-session checks for the due plan (issues #103, #101).
//
// Every simulated session builds a real drill segment from IndexedDB, plays
// it the way DrillRunner does (drillSessionModel.testutil.ts) and persists
// the grades, several times a day ("Continue studying") across many days.
// Trees are random: opponent branching, alternative prepared moves,
// transpositions, disabled lines and training depth. After every build the
// invariants the earlier drill fixes established are re-checked, so a change
// to the plan can't quietly bring one of those bugs back:
//
//  - #103: whenever the due count is above zero, the drill has cards.
//  - #103: the drill's FSRS-due cards are exactly cards the count includes.
//  - #80/#91: nothing in a disabled line is ever served.
//  - #86: nothing past the training depth is served; a new move is never
//    first graded while an earlier move on its line is shaky.
//  - #101: the whole repertoire is learned in the end, even with mistakes.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Color, Repertoire, RepertoireNode } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { defaultSettings } from '$lib/storage/settings';
import { createFreshCard } from '$lib/fsrs/scheduler';
import { shortestPathTree } from '$lib/tree/traversal';
import {
	buildSegment,
	countDrillDue,
	depthFilter,
	isShaky,
	planDueCards,
	trainableFilter
} from './buildSegment';
import { playSession, type Answer } from './drillSessionModel.testutil';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 9);

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

interface RandomRepOptions {
	color: Color;
	/** User moves deep along each line. */
	userMoves: number;
	/** Chance an opponent position has 1, 2 or 3 replies prepared against. */
	branching: [number, number, number];
	/** Chance a user position has a second prepared move. */
	altMove: number;
	/** Chance an opponent reply transposes into an existing user position. */
	transpose: number;
	/** Chance a user move is disabled. */
	disable: number;
	drillMaxMoves?: number | null;
	progressiveUnlock?: boolean;
}

/**
 * A random repertoire, built depth-first like a PGN import. Keys end in
 * " w"/" b" so `colorToMove` reads the side to move. The card at each user
 * position expects the first move saved there.
 */
function randomRep(id: string, rand: () => number, o: RandomRepOptions) {
	const nodes = new Map<string, RepertoireNode>();
	const cardKeys: string[] = [];
	const user = o.color === 'white' ? 'w' : 'b';
	const opp = o.color === 'white' ? 'b' : 'w';
	let n = 0;
	const key = (side: string) => `${id}-${n++} ${side}`;
	const userAtDepth = new Map<number, string[]>();
	const path = new Set<string>();

	const userNode = (k: string, d: number) => {
		cardKeys.push(k);
		path.add(k);
		(userAtDepth.get(d) ?? userAtDepth.set(d, []).get(d)!).push(k);
		const moves = rand() < o.altMove ? 2 : 1;
		const children = [];
		for (let i = 0; i < moves; i++) {
			const to = key(opp);
			children.push({
				san: `u${n}`,
				uci: 'xxxx',
				toFenKey: to,
				// Never the first move: a fully disabled repertoire trains nothing.
				...(d > 0 && rand() < o.disable ? { disabled: true } : {})
			});
		}
		nodes.set(k, { repertoireId: id, fenKey: k, children });
		for (const c of children) oppNode(c.toFenKey, d);
		path.delete(k);
	};
	const oppNode = (k: string, d: number) => {
		if (d === o.userMoves - 1) {
			nodes.set(k, { repertoireId: id, fenKey: k, children: [] });
			return;
		}
		const r = rand();
		const replies = r < o.branching[0] ? 1 : r < o.branching[0] + o.branching[1] ? 2 : 3;
		const children = [];
		for (let i = 0; i < replies; i++) {
			// Transpose into a finished user position at the same depth that
			// isn't on the current path (so the graph stays acyclic).
			const pool = (userAtDepth.get(d + 1) ?? []).filter((x) => !path.has(x));
			if (pool.length > 0 && rand() < o.transpose) {
				children.push({
					san: `o${n++}`,
					uci: 'xxxx',
					toFenKey: pool[Math.floor(rand() * pool.length)]
				});
			} else {
				children.push({ san: `o${n}`, uci: 'xxxx', toFenKey: key(user) });
			}
		}
		nodes.set(k, { repertoireId: id, fenKey: k, children });
		for (const c of children) if (!nodes.has(c.toFenKey)) userNode(c.toFenKey, d + 1);
	};

	let root: string;
	if (o.color === 'white') {
		root = key(user);
		userNode(root, 0);
	} else {
		root = key(opp);
		oppNode(root, -1);
	}
	const rep: Repertoire = {
		id,
		name: id,
		color: o.color,
		rootFen: 'startpos',
		rootFenKey: root,
		createdAt: 0,
		updatedAt: 0,
		drillMaxMoves: o.drillMaxMoves ?? null,
		progressiveUnlock: o.progressiveUnlock
	};
	return { rep, nodes, cardKeys };
}

type SimRep = ReturnType<typeof randomRep>;

async function seed(sim: SimRep) {
	const db = await getDB();
	const tx = db.transaction(['repertoires', 'nodes', 'cards', 'idea_cards'], 'readwrite');
	for (const s of ['repertoires', 'nodes', 'cards', 'idea_cards'] as const) {
		await tx.objectStore(s).clear();
	}
	await tx.objectStore('repertoires').put(sim.rep);
	for (const node of sim.nodes.values()) await tx.objectStore('nodes').put(node);
	for (let i = 0; i < sim.cardKeys.length; i++) {
		const k = sim.cardKeys[i];
		const san = sim.nodes.get(k)!.children[0].san;
		await tx.objectStore('cards').put(createFreshCard(sim.rep.id, k, san, T0 - DAY + i));
	}
	await tx.done;
}

interface RunOptions {
	days: number;
	sessionsPerDay: number;
	walk: 'play' | 'auto';
	answer: Answer;
	hintedMiss?: Answer;
}

interface RunResult {
	violations: string[];
	/** Day and session each card was first graded in. */
	firstGraded: Map<string, [number, number]>;
	/** Eligible cards (trainable, within depth) never graded. */
	neverIntroduced: string[];
	eligible: number;
}

async function run(sim: SimRep, o: RunOptions): Promise<RunResult> {
	await seed(sim);
	const settings = {
		...defaultSettings(),
		drillIntermediateMoves: o.walk,
		drillSessionCap: 30,
		dailyNewCardCap: 10
	};
	const db = await getDB();
	const { rep, nodes } = sim;
	const isTrainable = trainableFilter(rep, nodes);
	const withinDepth = depthFilter(rep, nodes, rep.drillMaxMoves);
	const tree = shortestPathTree(nodes, rep.rootFenKey);
	const violations: string[] = [];
	const firstGraded = new Map<string, [number, number]>();

	for (let day = 0; day < o.days; day++) {
		for (let s = 0; s < o.sessionsPerDay; s++) {
			const now = T0 + day * DAY + s * 5 * 60_000;
			vi.setSystemTime(now);
			const tag = `day ${day} session ${s}`;
			const all = await db.getAllFromIndex('cards', 'by-repertoire', rep.id);
			const byKey = new Map(all.map((c) => [c.fenKey, c]));
			const plan = planDueCards(rep, nodes, all, now);
			const planKeys = new Set(
				[...plan.reviews, ...plan.relearn, ...plan.fresh].map((c) => c.fenKey)
			);
			const count = await countDrillDue(rep, now);
			if (count !== planKeys.size)
				violations.push(`${tag}: count ${count} ≠ plan ${planKeys.size}`);

			const seg = await buildSegment(rep, 'due', settings);
			// #103: a due count above zero must come with something to drill.
			if (count > 0 && seg.cards.length === 0) {
				violations.push(`${tag}: ${count} due but the drill is empty`);
			}
			// #103/#101: while new moves are waiting, the drill always has
			// something to do — a move to learn or a missed move to relearn.
			const waiting = all.filter(
				(c) => !c.lastReview && c.dueAt <= now && isTrainable(c) && withinDepth(c)
			).length;
			if (waiting > 0 && seg.cards.length === 0) {
				violations.push(`${tag}: ${waiting} new moves waiting but the drill is empty`);
			}
			for (const c of seg.cards) {
				if (!isTrainable(c)) violations.push(`${tag}: served ${c.fenKey} in a disabled line`);
				if (!withinDepth(c)) violations.push(`${tag}: served ${c.fenKey} past the depth limit`);
			}
			for (const k of seg.dueOriginalKeys) {
				if (!planKeys.has(k)) violations.push(`${tag}: drilled ${k} as due but not counted`);
			}

			const events = await playSession(
				[seg],
				o.answer,
				settings.fsrsParams,
				new Date(now),
				o.hintedMiss
			);

			// #86 gate: a new move's first grade needs every earlier eligible
			// move on its line ready at build time, or first graded earlier in
			// this session.
			const firstAt = new Map<string, number>();
			events.forEach((e, i) => {
				if (e.after && !byKey.get(e.fenKey)!.lastReview && !firstAt.has(e.fenKey)) {
					firstAt.set(e.fenKey, i);
				}
				if (e.after && !firstGraded.has(e.fenKey)) firstGraded.set(e.fenKey, [day, s]);
			});
			if (rep.progressiveUnlock !== false) {
				for (const [k, i] of firstAt) {
					for (let a = tree.parent.get(k); a !== undefined; a = tree.parent.get(a)) {
						const anc = byKey.get(a);
						if (!anc || !isTrainable(anc) || !withinDepth(anc)) continue;
						const ok = anc.lastReview ? !isShaky(anc) : (firstAt.get(a) ?? Infinity) < i;
						if (!ok) violations.push(`${tag}: ${k} first graded below ${a}`);
					}
				}
			}
		}
	}

	const eligible = (await db.getAllFromIndex('cards', 'by-repertoire', rep.id)).filter(
		(c: Card) => isTrainable(c) && withinDepth(c)
	);
	return {
		violations,
		firstGraded,
		neverIntroduced: eligible.filter((c) => !firstGraded.has(c.fenKey)).map((c) => c.fenKey),
		eligible: eligible.length
	};
}

const shapes: Array<[string, Omit<RandomRepOptions, 'color'>]> = [
	// Gambit-style: narrow at the top, most material under a few trunk moves.
	[
		'narrow trunk',
		{ userMoves: 9, branching: [0.7, 0.25, 0.05], altMove: 0.05, transpose: 0.05, disable: 0 }
	],
	['bushy', { userMoves: 6, branching: [0.2, 0.5, 0.3], altMove: 0.1, transpose: 0.1, disable: 0 }],
	[
		'disabled lines',
		{ userMoves: 7, branching: [0.4, 0.4, 0.2], altMove: 0.2, transpose: 0.1, disable: 0.12 }
	],
	[
		'depth limit',
		{
			userMoves: 8,
			branching: [0.4, 0.4, 0.2],
			altMove: 0.1,
			transpose: 0.05,
			disable: 0.05,
			drillMaxMoves: 5
		}
	],
	[
		'progressive off',
		{
			userMoves: 7,
			branching: [0.4, 0.4, 0.2],
			altMove: 0.1,
			transpose: 0.05,
			disable: 0.05,
			progressiveUnlock: false
		}
	]
];

describe('due plan under random repertoires and mistakes', { timeout: 600_000 }, () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// One seed per shape and mode by default (CI). For a deeper soak run,
	// e.g. COBRA_SIM_SEEDS=10 npm run test:sim.
	const seeds = Math.max(1, Number(process.env.COBRA_SIM_SEEDS ?? 1));
	for (let seed = 0; seed < seeds; seed++) {
		for (const [name, shape] of shapes) {
			for (const walk of ['play', 'auto'] as const) {
				const color = (seed + (walk === 'play' ? 0 : 1)) % 2 === 0 ? 'white' : 'black';
				it(`${name}, ${color}, walk=${walk}, seed ${seed}`, async () => {
					const rand = rng(seed * 7919 + name.length * 31 + (walk === 'play' ? 1 : 2));
					const sim = randomRep('r', rand, { ...shape, color });
					const res = await run(sim, {
						days: 40,
						sessionsPerDay: 2,
						walk,
						// 20% miss on a first unhinted attempt, 5% on a retry, and
						// an occasional misclick on a hinted introduction.
						answer: (p) => rand() >= (p.attempt === 0 ? 0.2 : 0.05),
						hintedMiss: () => rand() < 0.05
					});
					expect(res.eligible).toBeGreaterThan(10);
					expect(res.violations).toEqual([]);
					expect(res.neverIntroduced).toEqual([]);
				});
			}
		}
	}

	it('one missed first move never leaves the drill empty (issue #103 repro)', async () => {
		const rand = rng(103);
		const sim = randomRep('r', rand, {
			color: 'white',
			userMoves: 8,
			branching: [0.5, 0.4, 0.1],
			altMove: 0,
			transpose: 0,
			disable: 0
		});
		const first = sim.rep.rootFenKey;
		let missed = false;
		const res = await run(sim, {
			days: 10,
			sessionsPerDay: 4,
			walk: 'play',
			// Miss the first move's first unhinted recall, then answer right.
			answer: (p) => {
				if (p.fenKey === first && !missed) {
					missed = true;
					return false;
				}
				return true;
			}
		});
		expect(missed).toBe(true);
		expect(res.violations).toEqual([]);
		// Session 0 introduces the first moves and misses the first one in its
		// Train pass. Session 1 relearns it, so session 2 the same day carries
		// on with new moves instead of waiting a day for it to come due.
		expect(res.firstGraded.get(first)).toEqual([0, 0]);
		const sameDayLater = [...res.firstGraded.values()].filter(([d, s]) => d === 0 && s >= 2);
		expect(sameDayLater.length).toBeGreaterThan(0);
	});

	it('a misclick on a hinted introduction in line-walk mode does not stall (issue #101)', async () => {
		const rand = rng(101);
		const sim = randomRep('r', rand, {
			color: 'white',
			userMoves: 8,
			branching: [0.6, 0.3, 0.1],
			altMove: 0,
			transpose: 0,
			disable: 0
		});
		const db = await getDB();
		let clicked = 0;
		const res = await run(sim, {
			days: 1,
			sessionsPerDay: 1,
			walk: 'play',
			answer: () => true,
			// Misclick on the hinted Learn pass of every new move.
			hintedMiss: () => {
				clicked++;
				return true;
			}
		});
		expect(clicked).toBeGreaterThan(0);
		expect(res.violations).toEqual([]);
		// The Train-pass recall sets the grade: nothing introduced is shaky.
		const shaky = (await db.getAllFromIndex('cards', 'by-repertoire', 'r')).filter(
			(c) => c.lastReview && isShaky(c)
		);
		expect(shaky.map((c) => c.fenKey)).toEqual([]);
	});
});
