// Multi-session simulation for issue #86. Each simulated day builds real
// drill segments from IndexedDB, plays them the way DrillRunner does (Learn
// and Train passes, failed-move retries, wrong-answer re-queues, the leaves
// cycle — see drillSessionModel.testutil.ts) with grading through the same
// SessionGrader, persists every grade, and advances the clock a day. So
// scheduling, pooling, progressive unlock and in-session repetition interact
// the way they do across real sessions, including after wrong answers.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Color, Repertoire, RepertoireNode, StoredMistake } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { defaultSettings } from '$lib/storage/settings';
import { createFreshCard } from '$lib/fsrs/scheduler';
import { reachProbabilities } from '$lib/tree/reachProbability';
import { buildSegment, isShaky } from './buildSegment';
import { buildQuickDrillSegments } from './quickDrill';
import { playSession, type Answer, type GradeEvent } from './drillSessionModel.testutil';
import type { DrillSegment } from './types';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 9);

interface SimRep {
	rep: Repertoire;
	nodes: RepertoireNode[];
	/** Card fenKeys in PGN-import (depth-first, line by line) order. */
	importOrder: string[];
	/** User-move depth of each card (0 = first move). */
	depth: Map<string, number>;
	/** Nearest ancestor card of each card (none for the first move). */
	parentCard: Map<string, string>;
}

/**
 * A repertoire for `color`, one prepared move per position and two opponent
 * replies to each (a black rep also branches on white's first move):
 * `userMoves` deep. Keys end in " w"/" b" so `colorToMove` reads them. Built
 * depth-first so card creation order matches a PGN import.
 */
function buildRep(
	id: string,
	color: Color,
	userMoves: number,
	/** Lichess share of the first / second opponent reply everywhere. */
	split?: [number, number]
): SimRep {
	const nodes: RepertoireNode[] = [];
	const importOrder: string[] = [];
	const depth = new Map<string, number>();
	const parentCard = new Map<string, string>();
	const user = color === 'white' ? 'w' : 'b';
	const opp = color === 'white' ? 'b' : 'w';
	let n = 0;
	const key = (side: string) => `${id}-${n++} ${side}`;
	const edge = (to: string) => ({ san: 'm', uci: 'm', toFenKey: to });
	const userNode = (k: string, d: number, parent: string | null) => {
		importOrder.push(k);
		depth.set(k, d);
		if (parent) parentCard.set(k, parent);
		const o = key(opp);
		nodes.push({ repertoireId: id, fenKey: k, children: [edge(o)] });
		oppNode(o, d, k);
	};
	const oppNode = (k: string, d: number, parent: string | null) => {
		if (d === userMoves - 1) {
			nodes.push({ repertoireId: id, fenKey: k, children: [] });
			return;
		}
		const kids = [key(user), key(user)];
		nodes.push({
			repertoireId: id,
			fenKey: k,
			children: kids.map((c, i) => ({
				...edge(c),
				...(split
					? {
							frequency: {
								games: split[i] * 1000,
								total: 1000,
								source: 'lichess' as const,
								fetchedAt: 0
							}
						}
					: {})
			}))
		});
		for (const c of kids) userNode(c, parent === null ? 0 : d + 1, parent);
	};
	const root = key(color === 'white' ? user : opp);
	if (color === 'white') userNode(root, 0, null);
	else oppNode(root, -1, null);
	const rep: Repertoire = {
		id,
		name: id,
		color,
		rootFen: 'startpos',
		rootFenKey: root,
		createdAt: 0,
		updatedAt: 0
	};
	return { rep, nodes, importOrder, depth, parentCard };
}

async function seed(reps: SimRep[], mistakes: StoredMistake[] = []) {
	const db = await getDB();
	const tx = db.transaction(['repertoires', 'nodes', 'cards', 'mistakes'], 'readwrite');
	for (const s of ['repertoires', 'nodes', 'cards', 'mistakes'] as const) {
		await tx.objectStore(s).clear();
	}
	for (const r of reps) {
		await tx.objectStore('repertoires').put(r.rep);
		for (const n of r.nodes) await tx.objectStore('nodes').put(n);
		for (let i = 0; i < r.importOrder.length; i++) {
			await tx
				.objectStore('cards')
				.put(createFreshCard(r.rep.id, r.importOrder[i], 'm', T0 - DAY + i));
		}
	}
	for (const m of mistakes) await tx.objectStore('mistakes').put(m);
	await tx.done;
}

interface SimOptions {
	days: number;
	/** Unhinted answer model; `day` is the simulated day index. */
	answer: (p: Parameters<Answer>[0], day: number) => boolean;
	/** 'play' = line walk on (default setting), 'auto' = off. */
	walk?: 'play' | 'auto';
	/** Build the quick drill across all reps instead of one rep's drill. */
	quick?: boolean;
	/** Extra practice sessions run after each day's due drill. */
	extra?: (day: number) => ('mistakes' | 'retrain')[];
	mistakes?: StoredMistake[];
}

interface SimResult {
	/** Day each `${repId}|${fenKey}` got its first grade. */
	introducedDay: Map<string, number>;
	/** First grades that broke the progressive-unlock rule. */
	gateViolations: string[];
	/** `${repId}@day` where due reviews existed but the drill held none. */
	reviewStarved: string[];
	/** Largest overdue gap (days) of any review at session build time. */
	maxOverdueDays: number;
	/**
	 * Reviews 2+ days overdue that a session neither presented, nor dropped
	 * because an earlier move on their line was missed in that session, nor
	 * left out of an auto-mode session that was already at its card cap.
	 */
	unexplainedOverdue: string[];
	/** All grade events, tagged with the day and session kind. */
	events: (GradeEvent & { day: number; kind: string })[];
	/** Stored card at the start of each day. */
	cardAt: (repId: string, fenKey: string, day: number) => Card | undefined;
}

async function simulate(reps: SimRep[], opts: SimOptions): Promise<SimResult> {
	await seed(reps, opts.mistakes);
	const settings = {
		...defaultSettings(),
		drillIntermediateMoves: opts.walk ?? 'play',
		drillSessionCap: 30,
		dailyNewCardCap: 10
	};
	const db = await getDB();
	const byId = new Map(reps.map((r) => [r.rep.id, r]));
	const introducedDay = new Map<string, number>();
	const gateViolations: string[] = [];
	const reviewStarved: string[] = [];
	const unexplainedOverdue: string[] = [];
	const events: SimResult['events'] = [];
	const snapshots: Map<string, Card>[] = [];
	let maxOverdueDays = 0;

	for (let day = 0; day < opts.days; day++) {
		const now = T0 + day * DAY;
		vi.setSystemTime(now);
		const before = new Map<string, Card>(
			(await db.getAll('cards')).map((c) => [`${c.repertoireId}|${c.fenKey}`, c])
		);
		snapshots.push(before);
		for (const c of before.values()) {
			if (c.lastReview && c.dueAt <= now) {
				maxOverdueDays = Math.max(maxOverdueDays, (now - c.dueAt) / DAY);
			}
		}

		const segments: DrillSegment[] = opts.quick
			? await buildQuickDrillSegments(
					reps.map((r) => r.rep),
					settings
				)
			: [await buildSegment(reps[0].rep, 'due', settings)];
		const played = await playSession(
			segments,
			(p) => opts.answer(p, day),
			settings.fsrsParams,
			new Date(now)
		);
		events.push(...played.map((e) => ({ ...e, day, kind: 'due' })));

		// Long-overdue reviews must be drilled, unless the session cut their
		// line after a miss above them (auto mode's pruneDeeperInLine).
		const presented = new Set(played.map((e) => `${e.repId}|${e.fenKey}`));
		const missed = new Set(
			played.filter((e) => e.outcome === 'wrong').map((e) => `${e.repId}|${e.fenKey}`)
		);
		for (const [k, c] of before) {
			if (!c.lastReview || now - c.dueAt < 2 * DAY || presented.has(k)) continue;
			const sim = byId.get(c.repertoireId)!;
			let prunedBelowMiss = false;
			for (let a = sim.parentCard.get(c.fenKey); a; a = sim.parentCard.get(a)) {
				if (missed.has(`${c.repertoireId}|${a}`)) prunedBelowMiss = true;
			}
			// Auto mode's pickBalancedDueCards stops at drillSessionCap cards;
			// past that, reviews wait for the next session (most overdue first).
			const seg = segments.find((sg) => sg.rep.id === c.repertoireId);
			const leftOutOfFullSession =
				!!seg &&
				seg.walkStarts.length === 0 &&
				!seg.cards.some((x) => x.fenKey === c.fenKey) &&
				seg.dueOriginalKeys.size >= settings.drillSessionCap;
			if (!prunedBelowMiss && !leftOutOfFullSession) {
				unexplainedOverdue.push(`day ${day}: ${k}`);
			}
		}

		// Reviews starved: a rep had due reviews but its drill graded none.
		for (const r of reps) {
			const hadDue = [...before.values()].some(
				(c) => c.repertoireId === r.rep.id && c.lastReview && c.dueAt <= now
			);
			const reviewed = played.some((e) => e.repId === r.rep.id && e.before.lastReview);
			if (hadDue && !reviewed) reviewStarved.push(`${r.rep.id}@${day}`);
		}

		// Progressive-unlock invariant on every first grade this session: each
		// earlier user move on its line was ready when the session was built,
		// or itself got its first grade earlier in this same session.
		const firstGradedAt = new Map<string, number>();
		played.forEach((e, i) => {
			const k = `${e.repId}|${e.fenKey}`;
			if (!before.get(k)!.lastReview && e.after && !firstGradedAt.has(k)) {
				firstGradedAt.set(k, i);
				introducedDay.set(k, day);
			}
		});
		for (const [k, i] of firstGradedAt) {
			const [repId, fenKey] = k.split('|');
			const sim = byId.get(repId)!;
			if (sim.rep.progressiveUnlock === false) continue;
			for (let a = sim.parentCard.get(fenKey); a; a = sim.parentCard.get(a)) {
				const anc = before.get(`${repId}|${a}`)!;
				const ok = anc.lastReview
					? !isShaky(anc)
					: (firstGradedAt.get(`${repId}|${a}`) ?? Infinity) < i;
				if (!ok) gateViolations.push(`day ${day}: ${k} first graded below ${a}`);
			}
		}

		for (const kind of opts.extra?.(day) ?? []) {
			const segs = await Promise.all(reps.map((r) => buildSegment(r.rep, kind, settings)));
			const extra = await playSession(
				segs.filter((s) => s.cards.length > 0),
				(p) => opts.answer(p, day),
				settings.fsrsParams,
				new Date(now + 60_000)
			);
			events.push(...extra.map((e) => ({ ...e, day, kind })));
		}
	}

	return {
		introducedDay,
		gateViolations,
		reviewStarved,
		maxOverdueDays,
		unexplainedOverdue,
		events,
		cardAt: (repId, fenKey, day) => snapshots[day]?.get(`${repId}|${fenKey}`)
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

const allRight = () => true;

/** Keys of every card below `anc` in the rep. */
function below(sim: SimRep, anc: string): string[] {
	return sim.importOrder.filter((k) => {
		for (let a = sim.parentCard.get(k); a; a = sim.parentCard.get(a)) if (a === anc) return true;
		return false;
	});
}

describe('multi-session drill simulation (issue #86)', { timeout: 180_000 }, () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('all answers right: everything introduced breadth-first, reviews never starved', async () => {
		// 255 cards — more than the 150-card window the old pool used.
		const sim = buildRep('w', 'white', 8);
		const res = await simulate([sim], { days: 45, answer: allRight });

		expect(res.introducedDay.size).toBe(sim.importOrder.length);
		expect(res.gateViolations).toEqual([]);
		expect(res.reviewStarved).toEqual([]);
		expect(res.maxOverdueDays).toBeLessThanOrEqual(1);
		expect(res.unexplainedOverdue).toEqual([]);
		// Every move at depth d is introduced no later than any at depth d + 1.
		const dayOf = (k: string) => res.introducedDay.get(`w|${k}`)!;
		for (let d = 0; d < 7; d++) {
			const at = (dd: number) => sim.importOrder.filter((k) => sim.depth.get(k) === dd).map(dayOf);
			expect(Math.max(...at(d))).toBeLessThanOrEqual(Math.min(...at(d + 1)));
		}
	});

	it('a new move is recalled unhinted in its Train pass the day it is introduced', async () => {
		const sim = buildRep('w', 'white', 4);
		const res = await simulate([sim], { days: 1, answer: allRight });
		const first = sim.importOrder[0];
		const shown = res.events.filter((e) => e.fenKey === first);
		expect(shown.map((e) => [e.phase, e.hinted, e.outcome])).toEqual([
			['learn', true, 'peeked'],
			['train', false, 'correct']
		]);
		// The recall is what's stored: a Good from new, not a Hard.
		expect(shown[1].after!.fsrs.stability).toBeGreaterThanOrEqual(2);
	});

	it('a miss followed by a correct retry in the same session still counts as a lapse', async () => {
		const sim = buildRep('w', 'white', 4);
		const weak = sim.importOrder[0];
		// The first time `weak` comes up due in its own right (not as a walk
		// prefix, which is graded once per session anyway), miss it on the
		// first try and get the in-session retry right.
		let missDay = -1;
		const res = await simulate([sim], {
			days: 12,
			answer: (p, day) => {
				if (p.fenKey !== weak || p.hinted || p.lineWalkStep) return true;
				if (missDay === -1 && p.attempt === 0) missDay = day;
				return !(day === missDay && p.attempt === 0);
			}
		});
		expect(missDay).toBeGreaterThan(0);
		const thatDay = res.events.filter((e) => e.day === missDay && e.fenKey === weak);
		expect(thatDay.map((e) => [e.phase, e.outcome])).toEqual([
			['learn', 'wrong'],
			['retry', 'correct']
		]);
		expect(thatDay[1].after).toBeNull(); // the retry doesn't overwrite the miss
		const next = res.cardAt('w', weak, missDay + 1)!;
		expect(next.fsrs.lapses).toBe(1);
		expect(isShaky(next)).toBe(true);
	});

	it('a forgotten early move pauses only its own subtree until it is recalled', async () => {
		const sim = buildRep('w', 'white', 7); // 127 cards
		const weak = sim.importOrder[1]; // second move, left branch
		const sibling = sim.importOrder.find((k) => sim.depth.get(k) === 1 && k !== weak)!;
		// First unhinted attempt at `weak` is wrong on its first 3 review days;
		// in-session retries are right (the answer was just shown).
		const missDays = new Set<number>();
		const res = await simulate([sim], {
			days: 40,
			answer: (p, day) => {
				if (p.fenKey !== weak || p.attempt > 0 || p.phase !== 'learn') return true;
				if (missDays.size < 3 || missDays.has(day)) {
					missDays.add(day);
					return false;
				}
				return true;
			}
		});

		expect(res.gateViolations).toEqual([]);
		expect(res.reviewStarved).toEqual([]);
		expect(res.unexplainedOverdue).toEqual([]);

		const shakyDays = [...Array(40).keys()].filter((d) => {
			const c = res.cardAt('w', weak, d);
			return !!c?.lastReview && isShaky(c);
		});
		expect(shakyDays.length).toBeGreaterThanOrEqual(3);
		const introduced = (k: string) => res.introducedDay.get(`w|${k}`);
		// Nothing new beneath it while it's shaky…
		for (const k of below(sim, weak)) expect(shakyDays).not.toContain(introduced(k));
		// …the sibling branch keeps progressing meanwhile…
		expect(below(sim, sibling).some((k) => shakyDays.includes(introduced(k)!))).toBe(true);
		// …and everything is learned in the end.
		expect(res.introducedDay.size).toBe(sim.importOrder.length);
	});

	it.each(['play', 'auto'] as const)(
		'random mistakes, walk=%s: gate holds, no deadlock, reviews not starved',
		async (walk) => {
			const sim = buildRep('w', 'white', 7);
			const rand = rng(86);
			const res = await simulate([sim], {
				days: 70,
				walk,
				// 25% miss on a first unhinted attempt, 5% on an in-session retry.
				answer: (p) => rand() >= (p.attempt === 0 ? 0.25 : 0.05)
			});
			expect(res.gateViolations).toEqual([]);
			expect(res.reviewStarved).toEqual([]);
			expect(res.unexplainedOverdue).toEqual([]);
			// With line walk off, a miss drops the rest of its line for the
			// session, so reviews below repeatedly-missed moves wait longer.
			expect(res.maxOverdueDays).toBeLessThanOrEqual(walk === 'play' ? 1 : 10);
			expect(res.introducedDay.size).toBe(sim.importOrder.length);
		}
	);

	it('with Lichess frequencies: the likeliest positions are learned first', async () => {
		// The first-imported reply is the rare one (5%), so import order and
		// plain breadth-first would both reach it early.
		const sim = buildRep('w', 'white', 7, [0.05, 0.8]);
		const res = await simulate([sim], { days: 40, answer: allRight });
		expect(res.introducedDay.size).toBe(sim.importOrder.length);
		expect(res.gateViolations).toEqual([]);
		expect(res.reviewStarved).toEqual([]);

		const reach = reachProbabilities(
			new Map(sim.nodes.map((n) => [n.fenKey, n])),
			sim.rep.rootFenKey,
			'white'
		);
		const day = (k: string) => res.introducedDay.get(`w|${k}`)!;
		// Never learn a clearly less likely position before a likelier one.
		for (const a of sim.importOrder) {
			for (const b of sim.importOrder) {
				if (reach.get(a)! > reach.get(b)! * 1.5) expect(day(a)).toBeLessThanOrEqual(day(b));
			}
		}
		// The common line reaches move 7 before the rare reply's second move.
		const commonDeep = sim.importOrder.filter((k) => sim.depth.get(k) === 6 && reach.get(k)! > 0.2);
		const rareSecond = sim.importOrder.filter((k) => sim.depth.get(k) === 1 && reach.get(k)! < 0.1);
		expect(Math.max(...commonDeep.map(day))).toBeLessThanOrEqual(Math.min(...rareSecond.map(day)));
	});

	it('with Lichess frequencies and random mistakes: gate holds, nothing starves', async () => {
		const sim = buildRep('w', 'white', 7, [0.05, 0.8]);
		const rand = rng(11);
		const res = await simulate([sim], {
			days: 70,
			answer: (p) => rand() >= (p.attempt === 0 ? 0.25 : 0.05)
		});
		expect(res.gateViolations).toEqual([]);
		expect(res.reviewStarved).toEqual([]);
		expect(res.unexplainedOverdue).toEqual([]);
		expect(res.introducedDay.size).toBe(sim.importOrder.length);
	});

	it('quick drill across a white and a black repertoire', async () => {
		const white = buildRep('w', 'white', 6);
		const black = buildRep('b', 'black', 6);
		const rand = rng(7);
		const res = await simulate([white, black], {
			days: 60,
			quick: true,
			answer: (p) => rand() >= (p.attempt === 0 ? 0.2 : 0.05)
		});
		expect(res.gateViolations).toEqual([]);
		// Shared daily budgets: never more than 10 first grades a day in total.
		const perDay = new Map<number, number>();
		for (const d of res.introducedDay.values()) perDay.set(d, (perDay.get(d) ?? 0) + 1);
		expect(Math.max(...perDay.values())).toBeLessThanOrEqual(10);
		// Both repertoires get fully learned, each breadth-first on its own.
		for (const sim of [white, black]) {
			const id = sim.rep.id;
			expect(sim.importOrder.every((k) => res.introducedDay.has(`${id}|${k}`))).toBe(true);
		}
		expect(res.reviewStarved).toEqual([]);
		expect(res.unexplainedOverdue).toEqual([]);
	});

	it('mistakes and retrain drills never touch the schedule', async () => {
		const sim = buildRep('w', 'white', 6);
		const gameMistakes: StoredMistake[] = sim.importOrder.slice(0, 6).map((fenKey, i) => ({
			id: `g${i}:w:${fenKey}`,
			gameId: `g${i}`,
			gameUrl: '',
			playedAt: T0,
			detectedAt: T0 + i,
			speed: 'blitz',
			opponent: 'x',
			color: 'white',
			repertoireId: 'w',
			repertoireName: 'w',
			fenKey,
			fen: fenKey,
			playedSan: 'z',
			expectedSan: 'm',
			plyOffTree: 0,
			status: 'pending',
			correctCount: 0
		}));
		const rand = rng(3);
		const answer = (p: Parameters<Answer>[0]) => rand() >= (p.attempt === 0 ? 0.3 : 0.05);
		const withExtras = await simulate([sim], {
			days: 30,
			answer,
			mistakes: gameMistakes,
			extra: (day) => (day % 3 === 2 ? ['mistakes', 'retrain'] : [])
		});

		const extras = withExtras.events.filter((e) => e.kind !== 'due');
		expect(extras.some((e) => e.kind === 'mistakes')).toBe(true);
		expect(extras.some((e) => e.kind === 'retrain')).toBe(true);
		// Practice only: nothing graded into FSRS…
		expect(extras.every((e) => e.after === null)).toBe(true);
		// …and the stored cards are untouched by those sessions.
		for (const e of extras) {
			const nextDay = withExtras.cardAt(e.repId, e.fenKey, e.day + 1);
			if (nextDay) {
				const dueThatDay = withExtras.events.filter(
					(x) => x.kind === 'due' && x.day === e.day && x.fenKey === e.fenKey && x.after
				);
				const expected = dueThatDay.length
					? dueThatDay[dueThatDay.length - 1].after!
					: withExtras.cardAt(e.repId, e.fenKey, e.day)!;
				expect(nextDay.fsrs).toEqual(expected.fsrs);
			}
		}
		// Retrain resolves game mistakes answered correctly.
		const db = await getDB();
		const stored = await db.getAll('mistakes');
		expect(stored.some((m) => m.status === 'corrected')).toBe(true);
		expect(withExtras.gateViolations).toEqual([]);
	});
});
