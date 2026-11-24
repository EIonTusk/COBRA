// Randomised checks for the builder's gap search (GapIndex).
//
// Random repertoires are grown from the start position with real legal
// moves, some moves get disabled, and a fake opening explorer reports game
// counts that are consistent the way real ones are: the games for a move
// from a position add up to no more than the games reaching that position.
// Then, against a brute-force scan of every live opponent position:
//
//  - "Biggest gap overall" / "off this line" return the true largest gap
//    (exact when the tree has no transpositions, otherwise always a real gap);
//  - answering gaps one by one, as a user building the repertoire would,
//    keeps returning the right next gap without asking the explorer about
//    any position twice;
//  - "Next gap on this line" returns the earliest gap on the line, stops at
//    disabled moves, and continues into the subtree below a clean line;
//  - the search asks for far fewer positions than the old 40-probe BFS
//    rescans did, and finds gaps that BFS missed.
//
// COBRA_SIM_SEEDS=N runs more seeds.
import { describe, expect, it } from 'vitest';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { makeSanAndPlay } from 'chessops/san';
import { makeUci } from 'chessops/util';

import type { ExplorerQuery, ExplorerResponse } from '$lib/explorer/client';
import { colorToMove } from '$lib/chess/fen';
import type { Color, Edge, RepertoireNode } from '$lib/types';
import { liveReachableFenKeys } from './traversal';
import { liveMoves } from './liveMoves';
import { GapIndex, fenFromKey } from './gapIndex';

type Move = { uci: string; san: string; white: number; draws: number; black: number };

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const GOAL = 1000;

function legalMoves(key: string): { uci: string; san: string; to: string }[] {
	const pos = Chess.fromSetup(parseFen(fenFromKey(key)).unwrap()).unwrap();
	const out: { uci: string; san: string; to: string }[] = [];
	const ctx = pos.ctx();
	for (const from of pos.board[pos.turn]) {
		for (const to of pos.dests(from, ctx)) {
			const p = pos.clone();
			const move = { from, to };
			const san = makeSanAndPlay(p, move);
			out.push({ uci: makeUci(move), san, to: makeFen(p.toSetup(), { epd: true }) });
		}
	}
	return out;
}

const games = (m: Move) => m.white + m.draws + m.black;

/** Split `budget` games over the legal moves: a few popular, most rare. */
function explorerAnswer(rand: () => number, key: string, budget: number): Move[] {
	const legal = legalMoves(key);
	// Openings are top-heavy: often one main move takes most of the games.
	const weights = legal.map(() => (rand() < 0.2 ? rand() : rand() * 0.01));
	if (rand() < 0.8) weights[Math.floor(rand() * weights.length)] += 4;
	const sum = weights.reduce((a, b) => a + b, 0) || 1;
	const scale = (budget * (0.85 + rand() * 0.15)) / sum;
	return legal
		.map((m, i) => ({
			uci: m.uci,
			san: m.san,
			white: Math.floor(weights[i] * scale),
			draws: 0,
			black: 0
		}))
		.sort((a, b) => games(b) - games(a))
		.slice(0, 30);
}

interface World {
	nodes: Map<string, RepertoireNode>;
	explorer: Map<string, Move[]>;
	color: Color;
}

/**
 * Grow a repertoire: 1–2 user moves per user position, 1–3 opponent replies
 * (mostly popular ones, so the tree follows real-looking lines).
 */
function randomWorld(
	rand: () => number,
	color: Color,
	plies: number,
	disable: number,
	freq: boolean
): World {
	const nodes = new Map<string, RepertoireNode>();
	const explorer = new Map<string, Move[]>();
	const grow = (key: string, ply: number, budget: number) => {
		if (nodes.has(key)) return;
		const node: RepertoireNode = { repertoireId: 'r', fenKey: key, children: [] };
		nodes.set(key, node);
		const answer = explorerAnswer(rand, key, budget);
		explorer.set(key, answer);
		if (ply >= plies) return;
		const ours = colorToMove(key) === color;
		const n = ours ? (rand() < 0.2 ? 2 : 1) : 2 + Math.floor(rand() * 3);
		// Prefer popular moves, with some randomness.
		const pool = answer.filter((m) => games(m) > 0);
		const picked: Move[] = [];
		while (picked.length < n && pool.length) {
			const i =
				rand() < 0.9
					? Math.floor(rand() * Math.min(3, pool.length))
					: Math.floor(rand() * pool.length);
			picked.push(pool.splice(i, 1)[0]);
		}
		const total = answer.reduce((s, m) => s + games(m), 0);
		for (const m of picked) {
			const to = legalMoves(key).find((l) => l.uci === m.uci)!.to;
			const edge: Edge = { san: m.san, uci: m.uci, toFenKey: to };
			if (ply > 0 && rand() < disable) edge.disabled = true;
			if (freq && !ours && rand() < 0.6) {
				edge.frequency = { games: games(m), total, source: 'lichess', fetchedAt: 0 };
			}
			node.children.push(edge);
			grow(to, ply + 1, games(m));
		}
	};
	grow(START, 0, 500_000_000);
	return { nodes, explorer, color };
}

/** Any live position reached by more than one live move. */
function hasTransposition(w: World): boolean {
	const live = liveReachableFenKeys(w.nodes, START);
	const seen = new Set<string>();
	for (const key of live) {
		for (const e of liveMoves(w.nodes.get(key))) {
			if (seen.has(e.toFenKey)) return true;
			seen.add(e.toFenKey);
		}
	}
	return false;
}

function thresholdOf(w: World): number {
	return w.explorer.get(START)!.reduce((s, m) => s + games(m), 0) / GOAL;
}

interface Gap {
	fromFenKey: string;
	uci: string;
	games: number;
}

/** Every gap in the live tree, by brute force. */
function allGaps(w: World, from = START): Gap[] {
	const t = thresholdOf(w);
	const out: Gap[] = [];
	for (const key of liveReachableFenKeys(w.nodes, from)) {
		if (colorToMove(key) === w.color) continue;
		const node = w.nodes.get(key);
		if (!node) continue;
		const saved = new Set(node.children.map((e) => e.uci));
		for (const m of w.explorer.get(key) ?? []) {
			if (games(m) >= t && !saved.has(m.uci))
				out.push({ fromFenKey: key, uci: m.uci, games: games(m) });
		}
	}
	return out.sort((a, b) => b.games - a.games);
}

function makeIndex(w: World) {
	const asked: string[] = [];
	const idx = new GapIndex(
		{
			rootFenKey: START,
			rootFen: fenFromKey(START),
			color: w.color,
			token: 't',
			getNodes: () => w.nodes
		},
		{
			fetch: async (q: ExplorerQuery) => {
				const key = q.fen.split(' ').slice(0, 4).join(' ');
				asked.push(key);
				return {
					white: 0,
					draws: 0,
					black: 0,
					moves: w.explorer.get(key) ?? []
				} as ExplorerResponse;
			},
			peek: () => null
		}
	);
	return { idx, asked };
}

/** The old search: BFS over live moves, probing every opponent position, capped. */
function oldBfs(w: World, maxProbes = 40): { top: Gap | null; probed: string[] } {
	const t = thresholdOf(w);
	const probed = [START];
	const visited = new Set([START]);
	const queue = [START];
	const found: Gap[] = [];
	while (queue.length && probed.length <= maxProbes) {
		const key = queue.shift()!;
		const node = w.nodes.get(key);
		if (!node) continue;
		if (colorToMove(key) !== w.color) {
			if (key !== START) probed.push(key);
			const saved = new Set(node.children.map((e) => e.uci));
			for (const m of w.explorer.get(key) ?? []) {
				if (games(m) >= t && !saved.has(m.uci))
					found.push({ fromFenKey: key, uci: m.uci, games: games(m) });
			}
		}
		for (const e of liveMoves(node)) {
			if (visited.has(e.toFenKey)) continue;
			visited.add(e.toFenKey);
			queue.push(e.toFenKey);
		}
	}
	found.sort((a, b) => b.games - a.games);
	return { top: found[0] ?? null, probed };
}

/** Random root-to-leaf walk over all saved moves, disabled ones included. */
function randomPath(w: World, rand: () => number): string[] {
	const path = [START];
	let node = w.nodes.get(START);
	const stopAt = 1 + Math.floor(rand() * 12);
	while (node && node.children.length > 0 && path.length < stopAt) {
		const e = node.children[Math.floor(rand() * node.children.length)];
		path.push(e.toFenKey);
		node = w.nodes.get(e.toFenKey);
	}
	return path;
}

const totals = { newAsked: 0, oldAsked: 0, oldWrong: 0, rounds: 0, positions: 0, subtreeCases: 0 };

describe('gap search matches a brute-force scan (random repertoires)', { timeout: 300_000 }, () => {
	const seeds = Math.max(30, Number(process.env.COBRA_SIM_SEEDS ?? 30));
	for (let seed = 0; seed < seeds; seed++) {
		for (const color of ['white', 'black'] as const) {
			it(`${color}, seed ${seed}`, async () => {
				const rand = rng(seed * 7919 + (color === 'white' ? 11 : 13));
				const w = randomWorld(rand, color, 13, 0.12, seed % 2 === 0);
				const exact = !hasTransposition(w);
				totals.positions += [...liveReachableFenKeys(w.nodes, START)].filter(
					(k) => colorToMove(k) !== color
				).length;
				const live = liveReachableFenKeys(w.nodes, START);
				const { idx } = makeIndex(w);

				// 1. "Off this line" on random lines.
				for (let i = 0; i < 6; i++) {
					const path = randomPath(w, rand);
					const exclude = new Set(path);
					const truth = allGaps(w).filter((g) => !exclude.has(g.fromFenKey));
					const got = await idx.biggest(GOAL, { exclude });
					if (got) {
						expect(exclude.has(got.fromFenKey)).toBe(false);
						expect(truth.some((g) => g.fromFenKey === got.fromFenKey && g.uci === got.uci)).toBe(
							true
						);
					}
					if (exact) expect(got?.games ?? null).toBe(truth[0]?.games ?? null);
				}

				// 2. "Next gap on this line".
				const t = thresholdOf(w);
				for (let i = 0; i < 10; i++) {
					const path = randomPath(w, rand);
					let cut = path.length;
					for (let j = 1; j < path.length; j++) {
						const via = w.nodes.get(path[j - 1])!.children.find((e) => e.toFenKey === path[j]);
						if (via?.disabled) {
							cut = j;
							break;
						}
					}
					// Half the time, answer every gap on the line first, so the
					// search has to continue below the board position.
					if (i % 2 === 0) {
						for (const key of path.slice(0, cut)) {
							if (colorToMove(key) === color) continue;
							const node = w.nodes.get(key)!;
							for (const m of w.explorer.get(key) ?? []) {
								if (games(m) < t || node.children.some((e) => e.uci === m.uci)) continue;
								const to = legalMoves(key).find((l) => l.uci === m.uci)!.to;
								node.children.push({ san: m.san, uci: m.uci, toFenKey: to });
							}
						}
					}
					const got = await idx.nextOnLine(GOAL, path);
					let wantKey: string | null = null;
					for (let j = 0; j < cut && !wantKey; j++) {
						const key = path[j];
						if (colorToMove(key) === color) continue;
						const saved = new Set(w.nodes.get(key)!.children.map((e) => e.uci));
						if ((w.explorer.get(key) ?? []).some((m) => games(m) >= t && !saved.has(m.uci)))
							wantKey = key;
					}
					if (wantKey) {
						expect(got?.fromFenKey).toBe(wantKey);
					} else if (cut < path.length) {
						expect(got).toBeNull();
					} else {
						const below = allGaps(w, path[path.length - 1]).filter(
							(g) => g.fromFenKey !== path[path.length - 1]
						);
						if (below.length > 0) totals.subtreeCases++;
						if (got)
							expect(below.some((g) => g.fromFenKey === got.fromFenKey && g.uci === got.uci)).toBe(
								true
							);
						if (exact) expect(got?.games ?? null).toBe(below[0]?.games ?? null);
					}
				}
				{
					// Fresh index, so the request count covers this phase only.
					const { idx, asked } = makeIndex(w);
					const oldAskedEver = new Set<string>();
					// 3. Build the repertoire gap by gap, as a user would: take the
					// biggest gap, answer it, ask again.
					for (let round = 0; round < 30; round++) {
						const truth = allGaps(w);
						const got = await idx.biggest(GOAL);
						const old = oldBfs(w);
						for (const k of old.probed) oldAskedEver.add(k);
						totals.rounds++;
						if (truth.length > 0 && old.top?.games !== truth[0].games) totals.oldWrong++;
						if (got) {
							expect(
								live.has(got.fromFenKey) || liveReachableFenKeys(w.nodes, START).has(got.fromFenKey)
							).toBe(true);
							expect(
								truth.some((g) => g.fromFenKey === got.fromFenKey && g.uci === got.uci),
								'a real gap'
							).toBe(true);
						}
						if (exact) expect(got?.games ?? null).toBe(truth[0]?.games ?? null);
						else if (truth.length > 0) expect(got).not.toBeNull();
						if (!got) break;
						// Answer it: the opponent move plus (if legal moves remain) a reply.
						const node = w.nodes.get(got.fromFenKey)!;
						node.children.push({ san: got.san, uci: got.uci, toFenKey: got.afterFenKey });
						if (!w.nodes.has(got.afterFenKey)) {
							w.nodes.set(got.afterFenKey, {
								repertoireId: 'r',
								fenKey: got.afterFenKey,
								children: []
							});
							if (!w.explorer.has(got.afterFenKey))
								w.explorer.set(got.afterFenKey, explorerAnswer(rand, got.afterFenKey, got.games));
						}
					}
					// Never the same position twice.
					expect(new Set(asked).size).toBe(asked.length);
					totals.newAsked += asked.length;
					totals.oldAsked += oldAskedEver.size;
				}
			});
		}
	}

	it('asks for fewer positions than the old BFS rescans', () => {
		// Printed for the PR description; the assertions keep the claim honest.
		console.log(
			`gap search: ${totals.newAsked} positions asked vs ${totals.oldAsked} for the old BFS; ` +
				`old BFS wrong in ${totals.oldWrong}/${totals.rounds} rounds; ${totals.positions} opponent positions in the trees; ${totals.subtreeCases} subtree cases`
		);
		expect(totals.newAsked).toBeLessThan(totals.oldAsked);
		expect(totals.subtreeCases).toBeGreaterThan(20);
	});
});
