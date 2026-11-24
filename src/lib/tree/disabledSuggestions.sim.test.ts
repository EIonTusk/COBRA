// Randomised checks that disabled moves stay out of move suggestions (#99).
//
// Random repertoires are grown from the start position with real legal
// moves (so transpositions and FEN handling are the real thing), random
// moves get disabled, and a fake opening explorer reports random game counts
// for every legal move. Then:
//
//  - the walkthrough's branch point is reached through live moves only.
//
// The builder's gap search ("Find gap") is checked against disabled lines in
// gapIndex.sim.test.ts, with explorer counts that add up the way real ones do.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { makeSanAndPlay } from 'chessops/san';
import { makeUci } from 'chessops/util';

import type { Color, Edge, RepertoireNode } from '$lib/types';
import { colorToMove } from '$lib/chess/fen';
import { liveReachableFenKeys } from './traversal';
import { liveMoves } from './liveMoves';

type Move = { uci: string; san: string; white: number; draws: number; black: number };
const explorerMock = vi.hoisted(() => ({ responses: new Map<string, { moves: Move[] }>() }));

vi.mock('$lib/explorer/client', () => ({
	fetchExplorer: vi.fn(async (query: { fen: string }) => {
		const epd = query.fen.split(' ').slice(0, 4).join(' ');
		return explorerMock.responses.get(epd) ?? { moves: [] };
	})
}));

import { findBranchPoint } from '$lib/walkthrough/repBranches';

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const fenFromKey = (k: string) => `${k} 0 1`;

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

/**
 * Grow a repertoire depth-first: 1–2 user moves per user position (a second
 * one is an alternative), 1–3 opponent replies. `disable` of all moves past
 * the first ply are disabled. Every position also gets an explorer answer.
 */
function randomRep(rand: () => number, color: Color, plies: number, disable: number) {
	const nodes = new Map<string, RepertoireNode>();
	const pick = <T>(xs: T[], n: number) => {
		const pool = [...xs];
		const out: T[] = [];
		while (out.length < n && pool.length)
			out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
		return out;
	};
	const grow = (key: string, ply: number) => {
		if (nodes.has(key)) return; // transposition: already grown
		const node: RepertoireNode = { repertoireId: 'r', fenKey: key, children: [] };
		nodes.set(key, node);
		const legal = legalMoves(key);
		// Random explorer counts for every legal move; most get a few games,
		// some are popular.
		explorerMock.responses.set(key, {
			moves: legal.map((m) => {
				const games = rand() < 0.3 ? Math.floor(rand() * 400) : Math.floor(rand() * 5);
				return { uci: m.uci, san: m.san, white: games, draws: 0, black: 0 };
			})
		});
		if (ply >= plies) return;
		const ours = colorToMove(key) === color;
		const n = ours ? (rand() < 0.4 ? 2 : 1) : 1 + Math.floor(rand() * 3);
		for (const m of pick(legal, n)) {
			const edge: Edge = { san: m.san, uci: m.uci, toFenKey: m.to };
			if (ply > 0 && rand() < disable) edge.disabled = true;
			node.children.push(edge);
			grow(m.to, ply + 1);
		}
	};
	grow(START, 0);
	return nodes;
}

describe(
	'disabled moves stay out of move suggestions (random repertoires)',
	{ timeout: 120_000 },
	() => {
		beforeEach(() => explorerMock.responses.clear());

		const seeds = Math.max(20, Number(process.env.COBRA_SIM_SEEDS ?? 20));
		for (let seed = 0; seed < seeds; seed++) {
			for (const color of ['white', 'black'] as const) {
				it(`${color}, seed ${seed}`, async () => {
					const rand = rng(seed * 104729 + (color === 'white' ? 1 : 2));
					// Redraw until some positions are only reachable through a
					// disabled move, so every case exercises a disabled line.
					let nodes = randomRep(rand, color, 7, 0.25);
					let live = liveReachableFenKeys(nodes, START);
					while (nodes.size === live.size) {
						explorerMock.responses.clear();
						nodes = randomRep(rand, color, 7, 0.25);
						live = liveReachableFenKeys(nodes, START);
					}
					// The walkthrough's branch point is on a live, unique-move trunk.
					const bp = findBranchPoint({ nodes, rootFenKey: START });
					expect(bp).not.toBeNull();
					expect(live.has(bp!)).toBe(true);
					expect(liveMoves(nodes.get(bp!)).length).not.toBe(1);
				});
			}
		}
	}
);
