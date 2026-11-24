import { describe, expect, it } from 'vitest';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';

import type { ExplorerQuery, ExplorerResponse } from '$lib/explorer/client';
import { ExplorerRateLimited } from '$lib/explorer/client';
import type { Edge, RepertoireNode } from '$lib/types';
import { GapIndex, fenFromKey } from './gapIndex';

function after(key: string, uci: string): string {
	const pos = Chess.fromSetup(parseFen(fenFromKey(key)).unwrap()).unwrap();
	pos.play(parseUci(uci)!);
	return makeFen(pos.toSetup(), { epd: true });
}
const mv = (san: string, uci: string, games: number) => ({
	san,
	uci,
	white: games,
	draws: 0,
	black: 0
});
type Mv = ReturnType<typeof mv>;

/** A fake explorer that records every position asked for. */
function fakeExplorer(data: Map<string, Mv[]>) {
	const asked: string[] = [];
	return {
		asked,
		deps: {
			fetch: async (q: ExplorerQuery) => {
				const key = q.fen.split(' ').slice(0, 4).join(' ');
				asked.push(key);
				return { white: 0, draws: 0, black: 0, moves: data.get(key) ?? [] } as ExplorerResponse;
			},
			peek: () => null
		}
	};
}

function nodeMap(entries: [string, Edge[]][]): Map<string, RepertoireNode> {
	return new Map(
		entries.map(([fenKey, children]) => [fenKey, { repertoireId: 'r', fenKey, children }])
	);
}

const ROOT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
// Black repertoire: 1.e4 c5 / 1.e4 e5 (disabled) / 1.d4 d5.
const E4 = after(ROOT, 'e2e4');
const D4 = after(ROOT, 'd2d4');
const C5 = after(E4, 'c7c5');
const E5 = after(E4, 'e7e5');
const D5 = after(D4, 'd7d5');
const NF3 = after(C5, 'g1f3');
const NF3_D6 = after(NF3, 'd7d6');

function baseTree() {
	return nodeMap([
		[
			ROOT,
			[
				{ san: 'e4', uci: 'e2e4', toFenKey: E4 },
				{ san: 'd4', uci: 'd2d4', toFenKey: D4 }
			]
		],
		[
			E4,
			[
				{ san: 'c5', uci: 'c7c5', toFenKey: C5 },
				{ san: 'e5', uci: 'e7e5', toFenKey: E5, disabled: true }
			]
		],
		[E5, []],
		[C5, [{ san: 'Nf3', uci: 'g1f3', toFenKey: NF3 }]],
		[NF3, [{ san: 'd6', uci: 'd7d6', toFenKey: NF3_D6 }]],
		[NF3_D6, []],
		[D4, [{ san: 'd5', uci: 'd7d5', toFenKey: D5 }]],
		[D5, []]
	]);
}

function baseData() {
	return new Map<string, Mv[]>([
		// root total 10_000; goal 100 → threshold 100
		[ROOT, [mv('e4', 'e2e4', 6000), mv('d4', 'd2d4', 3000), mv('c4', 'c2c4', 1000)]],
		[E4, [mv('c5', 'c7c5', 3000), mv('e5', 'e7e5', 3000)]],
		[C5, [mv('Nf3', 'g1f3', 2000), mv('Nc3', 'b1c3', 600), mv('c3', 'c2c3', 400)]],
		[E5, [mv('Nf3', 'g1f3', 2900), mv('f4', 'f2f4', 100)]],
		[NF3_D6, [mv('d4', 'd2d4', 1500), mv('Bb5+', 'f1b5', 300)]],
		[D5, [mv('c4', 'c2c4', 1500), mv('Nf3', 'g1f3', 1200), mv('Bf4', 'c1f4', 300)]]
	]);
}

function index(
	nodes = baseTree(),
	data = baseData(),
	pending: { fromKey: string; uci: string }[] = []
) {
	const ex = fakeExplorer(data);
	const idx = new GapIndex(
		{
			rootFenKey: ROOT,
			rootFen: fenFromKey(ROOT),
			color: 'black',
			token: 't',
			getNodes: () => nodes,
			getPending: () => pending
		},
		ex.deps
	);
	return { idx, ex, nodes, pending };
}

describe('GapIndex.biggest', () => {
	it('returns the most-played gap in live lines only (#99)', async () => {
		const { idx } = index();
		const gap = await idx.biggest(100);
		// NF3_D6 d4 (1500) ties D5 c4 (1500) — but E5 Nf3 (2900) is disabled.
		expect(gap?.games).toBe(1500);
		expect([NF3_D6, D5]).toContain(gap?.fromFenKey);
		expect(gap?.fromFenKey).not.toBe(E5);
	});

	it('finds the root gap (1.c4) when it is the biggest', async () => {
		const data = baseData();
		data.set(ROOT, [mv('e4', 'e2e4', 6000), mv('d4', 'd2d4', 1000), mv('c4', 'c2c4', 3000)]);
		const { idx } = index(baseTree(), data);
		const gap = await idx.biggest(100);
		expect(gap).toMatchObject({
			fromFenKey: ROOT,
			san: 'c4',
			games: 3000,
			positionGames: 10000,
			depth: 0
		});
	});

	it('never probes user-to-move positions, nor positions below the threshold', async () => {
		const data = baseData();
		// 1.d4 is now rare: 50 games < threshold 100 (root total 7050/goal 100 = 70.5).
		data.set(ROOT, [mv('e4', 'e2e4', 6000), mv('d4', 'd2d4', 50), mv('c4', 'c2c4', 1000)]);
		const { idx, ex } = index(baseTree(), data);
		await idx.biggest(100);
		expect(ex.asked).not.toContain(D5);
		expect(ex.asked).not.toContain(E4);
		expect(ex.asked).not.toContain(NF3);
		expect(ex.asked).not.toContain(D4);
	});

	it('stops once the best gap beats everything left to look at', async () => {
		const data = baseData();
		// A 5000-game gap at the root beats any subtree (each < 5000 games).
		data.set(ROOT, [mv('e4', 'e2e4', 4000), mv('d4', 'd2d4', 1000), mv('c4', 'c2c4', 5000)]);
		const { idx, ex } = index(baseTree(), data);
		const gap = await idx.biggest(100);
		expect(gap?.san).toBe('c4');
		expect(ex.asked).toEqual([ROOT]);
	});

	it('answers repeated queries and tree edits from memory', async () => {
		const { idx, ex, nodes } = index();
		await idx.biggest(100);
		const firstRound = ex.asked.length;
		await idx.biggest(100);
		expect(ex.asked.length).toBe(firstRound);
		// Answer both 1500-game gaps: the next one comes without new requests
		// for positions already seen.
		nodes.get(NF3_D6)!.children.push({ san: '?', uci: 'd2d4', toFenKey: after(NF3_D6, 'd2d4') });
		nodes.get(D5)!.children.push({ san: '?', uci: 'c2c4', toFenKey: after(D5, 'c2c4') });
		const next = await idx.biggest(100);
		expect(next).toMatchObject({ fromFenKey: D5, san: 'Nf3', games: 1200 });
		expect(new Set(ex.asked).size).toBe(ex.asked.length); // never the same position twice
	});

	it('treats unsaved moves as covered', async () => {
		const pending = [
			{ fromKey: NF3_D6, uci: 'd2d4' },
			{ fromKey: D5, uci: 'c2c4' }
		];
		const { idx } = index(baseTree(), baseData(), pending);
		expect(await idx.biggest(100)).toMatchObject({ fromFenKey: D5, san: 'Nf3' });
	});

	it('skips excluded positions but still looks below them', async () => {
		const { idx } = index();
		const gap = await idx.biggest(100, { exclude: new Set([ROOT, D4, D5]) });
		expect(gap).toMatchObject({ fromFenKey: NF3_D6, san: 'd4' });
	});

	it('uses stored frequencies to skip probing a rare position', async () => {
		const nodes = baseTree();
		// D5's prepared move says only 80 games reach it: below threshold 100.
		nodes.get(D5)!.children.push({
			san: 'c4',
			uci: 'c2c4',
			toFenKey: after(D5, 'c2c4'),
			frequency: { games: 40, total: 80, source: 'lichess', fetchedAt: 0 }
		});
		const { idx, ex } = index(nodes);
		const gap = await idx.biggest(100);
		expect(ex.asked).not.toContain(D5);
		expect(gap).toMatchObject({ fromFenKey: NF3_D6, san: 'd4' });
	});

	it('passes a rate limit up instead of reporting no gaps', async () => {
		const idx = new GapIndex(
			{
				rootFenKey: ROOT,
				rootFen: fenFromKey(ROOT),
				color: 'black',
				token: 't',
				getNodes: baseTree
			},
			{
				fetch: async () => {
					throw new ExplorerRateLimited(60_000);
				},
				peek: () => null
			}
		);
		await expect(idx.biggest(100)).rejects.toBeInstanceOf(ExplorerRateLimited);
	});

	it('stops probing when aborted', async () => {
		const { idx, ex } = index();
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(idx.biggest(100, { signal: ctrl.signal })).rejects.toThrow();
		expect(ex.asked).toEqual([]);
	});
});

describe('GapIndex.nextOnLine', () => {
	it('returns the earliest gap on the line, not the biggest', async () => {
		const data = baseData();
		data.set(C5, [mv('Nf3', 'g1f3', 2000), mv('Nc3', 'b1c3', 200)]);
		const { idx } = index(baseTree(), data);
		const gap = await idx.nextOnLine(100, [ROOT, E4, C5, NF3, NF3_D6]);
		expect(gap).toMatchObject({ fromFenKey: ROOT, san: 'c4', depth: 0 });
	});

	it('picks the first opponent position with a gap along the line', async () => {
		const data = baseData();
		data.set(ROOT, [mv('e4', 'e2e4', 6000), mv('d4', 'd2d4', 3000)]);
		const { idx } = index(baseTree(), data);
		expect(await idx.nextOnLine(100, [ROOT, E4, C5, NF3, NF3_D6])).toMatchObject({
			fromFenKey: C5,
			san: 'Nc3',
			depth: 2
		});
	});

	it('stops at a disabled move', async () => {
		const data = baseData();
		data.set(ROOT, [mv('e4', 'e2e4', 6000), mv('d4', 'd2d4', 3000)]);
		const { idx } = index(baseTree(), data);
		expect(await idx.nextOnLine(100, [ROOT, E4, E5])).toBeNull();
	});

	it('continues into the subtree below the board when the line is clean', async () => {
		const data = baseData();
		data.set(ROOT, [mv('e4', 'e2e4', 6000), mv('d4', 'd2d4', 3000)]);
		data.set(C5, [mv('Nf3', 'g1f3', 2000)]);
		const { idx } = index(baseTree(), data);
		// Sitting at 1.e4 c5: the line is clean, the subtree's gap is 3.d4.
		expect(await idx.nextOnLine(100, [ROOT, E4, C5])).toMatchObject({
			fromFenKey: NF3_D6,
			san: 'd4',
			depth: 4
		});
		// Sitting at 1.d4: the gap below is at 1.d4 d5.
		expect(await idx.nextOnLine(100, [ROOT, D4])).toMatchObject({ fromFenKey: D5, san: 'c4' });
	});
});
