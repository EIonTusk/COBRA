// Randomised multi-session checks for disabled moves (issues #80, #91, #102).
//
// Random repertoires with alternative prepared moves and disabled lines are
// drilled day after day through real drill segments (played the way
// DrillRunner does, see drillSessionModel.testutil.ts), and every few days
// the user disables or re-enables a random move. After every build:
//
//  - nothing only reachable through a disabled move is served (#80, #91);
//  - every served position still has a live move to ask for (#102);
//  - by the end, every position with a live move that's reachable through
//    live moves has been trained — including positions whose card was
//    created for a move that's now disabled (#102).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Color, Repertoire, RepertoireNode } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { defaultSettings } from '$lib/storage/settings';
import { createFreshCard } from '$lib/fsrs/scheduler';
import { liveReachableFenKeys } from '$lib/tree/traversal';
import { answerSan } from '$lib/tree/liveMoves';
import { buildSegment } from './buildSegment';
import { playSession } from './drillSessionModel.testutil';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1, 9);

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/**
 * A random repertoire built depth-first like a PGN import: 1–3 opponent
 * replies per position, a second prepared move at `altMove` of user
 * positions, `disable` of user moves disabled. Keys end in " w"/" b" so
 * `colorToMove` reads the side to move.
 */
function randomRep(
	rand: () => number,
	color: Color,
	userMoves: number,
	altMove: number,
	disable: number
) {
	const id = 'r';
	const nodes = new Map<string, RepertoireNode>();
	const cardKeys: string[] = [];
	/** User moves past the first, which the simulated user may toggle. */
	const toggleable: RepertoireNode['children'] = [];
	const user = color === 'white' ? 'w' : 'b';
	const opp = color === 'white' ? 'b' : 'w';
	let n = 0;
	const key = (side: string) => `${id}-${n++} ${side}`;
	const userNode = (k: string, d: number) => {
		cardKeys.push(k);
		const moves = rand() < altMove ? 2 : 1;
		const children = Array.from({ length: moves }, () => ({
			san: `u${n}`,
			uci: 'xxxx',
			toFenKey: key(opp),
			// Never the first move: a fully disabled repertoire trains nothing.
			...(d > 0 && rand() < disable ? { disabled: true } : {})
		}));
		// The #102 case: the move the card was created for (the first) is
		// disabled while the alternative stays live.
		if (d > 0 && moves === 2 && rand() < 0.3) {
			children[0].disabled = true;
			children[1].disabled = undefined;
		}
		nodes.set(k, { repertoireId: id, fenKey: k, children });
		if (d > 0) toggleable.push(...children);
		for (const c of children) oppNode(c.toFenKey, d);
	};
	const oppNode = (k: string, d: number) => {
		if (d === userMoves - 1) {
			nodes.set(k, { repertoireId: id, fenKey: k, children: [] });
			return;
		}
		const r = rand();
		const replies = r < 0.45 ? 1 : r < 0.85 ? 2 : 3;
		const children = Array.from({ length: replies }, () => ({
			san: `o${n}`,
			uci: 'xxxx',
			toFenKey: key(user)
		}));
		nodes.set(k, { repertoireId: id, fenKey: k, children });
		for (const c of children) userNode(c.toFenKey, d + 1);
	};
	let root: string;
	if (color === 'white') {
		root = key(user);
		userNode(root, 0);
	} else {
		root = key(opp);
		oppNode(root, -1);
	}
	const rep: Repertoire = {
		id,
		name: id,
		color,
		rootFen: 'startpos',
		rootFenKey: root,
		createdAt: 0,
		updatedAt: 0
	};
	return { rep, nodes, cardKeys, toggleable };
}

describe('disabled moves under random repertoires', { timeout: 300_000 }, () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// Three seeds per mode by default (CI). For a deeper soak run,
	// e.g. COBRA_SIM_SEEDS=20 npm run test:sim.
	const seeds = Math.max(3, Number(process.env.COBRA_SIM_SEEDS ?? 3));
	for (let seed = 0; seed < seeds; seed++) {
		for (const walk of ['play', 'auto'] as const) {
			for (const color of ['white', 'black'] as const) {
				it(`${color}, walk=${walk}, seed ${seed}`, async () => {
					const rand = rng(
						seed * 7919 + (walk === 'play' ? 1 : 2) * 100 + (color === 'white' ? 1 : 2)
					);
					// A repertoire the drill can fully learn in the simulated days
					// (10 new moves a day): redraw until it has 30–250 positions.
					let sim = randomRep(rand, color, 6, 0.35, 0.15);
					while (sim.cardKeys.length < 30 || sim.cardKeys.length > 250) {
						sim = randomRep(rand, color, 6, 0.35, 0.15);
					}
					const { rep, nodes, cardKeys, toggleable } = sim;
					const db = await getDB();
					const tx = db.transaction(['nodes', 'cards'], 'readwrite');
					await tx.objectStore('nodes').clear();
					await tx.objectStore('cards').clear();
					for (const node of nodes.values()) await tx.objectStore('nodes').put(node);
					for (let i = 0; i < cardKeys.length; i++) {
						const k = cardKeys[i];
						const san = nodes.get(k)!.children[0].san;
						await tx.objectStore('cards').put(createFreshCard(rep.id, k, san, T0 - DAY + i));
					}
					await tx.done;

					const settings = {
						...defaultSettings(),
						drillIntermediateMoves: walk,
						drillSessionCap: 30,
						dailyNewCardCap: 10
					};
					const violations: string[] = [];
					const graded = new Set<string>();
					// Positions whose card was created for a move that's disabled
					// while another move there is live: the #102 case.
					const reAnswered = new Set<string>();
					const userEdges = toggleable;

					for (let day = 0; day < 50; day++) {
						const now = T0 + day * DAY;
						vi.setSystemTime(now);
						// The user changes their mind now and then (first 30 days).
						if (day > 0 && day < 30 && day % 3 === 0) {
							const edge = userEdges[Math.floor(rand() * userEdges.length)];
							edge.disabled = edge.disabled ? undefined : true;
							const owner = [...nodes.values()].find((nd) => nd.children.includes(edge))!;
							await db.put('nodes', owner);
						}
						const live = liveReachableFenKeys(nodes, rep.rootFenKey);
						const seg = await buildSegment(rep, 'due', settings);
						for (const c of seg.cards) {
							const node = nodes.get(c.fenKey);
							if (!live.has(c.fenKey))
								violations.push(`day ${day}: served ${c.fenKey} (disabled line)`);
							const answer = answerSan(node, c.expectedSan);
							if (answer === null)
								violations.push(`day ${day}: served ${c.fenKey} with no live move`);
							if (answer !== c.expectedSan) reAnswered.add(c.fenKey);
						}
						const events = await playSession([seg], () => true, settings.fsrsParams, new Date(now));
						for (const e of events) if (e.after) graded.add(e.fenKey);
					}

					// Every position with a live move, reachable through live moves,
					// got trained.
					const live = liveReachableFenKeys(nodes, rep.rootFenKey);
					const cards = await db.getAllFromIndex('cards', 'by-repertoire', rep.id);
					const shouldTrain = cards.filter(
						(c) => live.has(c.fenKey) && answerSan(nodes.get(c.fenKey), c.expectedSan) !== null
					);
					expect(violations).toEqual([]);
					expect(shouldTrain.filter((c) => !graded.has(c.fenKey)).map((c) => c.fenKey)).toEqual([]);
					expect(reAnswered.size).toBeGreaterThan(0);
				});
			}
		}
	}
});
