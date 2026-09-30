import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Repertoire, RepertoireNode } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { nodesMap } from '$lib/storage/nodes';
import type { ExplorerResponse } from './client';

const calls: string[] = [];
let failAfter = Infinity;

vi.mock('./client', async (orig) => {
	const real = await orig<typeof import('./client')>();
	return {
		...real,
		fetchExplorer: vi.fn(async ({ fen }: { fen: string }) => {
			if (calls.length >= failAfter) throw new real.ExplorerRateLimited(60_000);
			calls.push(fen);
			return explorer(fen);
		})
	};
});

const {
	backfillMoveFrequencies,
	captureMoveFrequencies,
	frequencyCoverage,
	frequencyFromExplorer
} = await import('./moveFrequency');

/** Every position: 1000 games, "a" played 600 times, "b" 100. */
function explorer(_fen: string): ExplorerResponse {
	return {
		white: 400,
		draws: 200,
		black: 400,
		moves: [
			{ uci: 'x', san: 'a', white: 240, draws: 120, black: 240 },
			{ uci: 'y', san: 'b', white: 40, draws: 20, black: 40 }
		]
	};
}

const REP = 'rep-freq';
// White repertoire. Opponent to move at " b" keys: o1 (depth 1), o2/o3 (depth 3).
const rep: Repertoire = {
	id: REP,
	name: 'f',
	color: 'white',
	rootFen: 'root w - - 0 1',
	rootFenKey: 'root w',
	createdAt: 0,
	updatedAt: 0
};
const e = (san: string, to: string, extra: Partial<Edge> = {}): Edge => ({
	san,
	uci: san,
	toFenKey: to,
	updatedAt: 5,
	...extra
});
const tree: RepertoireNode[] = [
	{ repertoireId: REP, fenKey: 'root w', children: [e('e4', 'o1 b')] },
	{ repertoireId: REP, fenKey: 'o1 b', children: [e('a', 'u1 w'), e('b', 'u2 w'), e('c', 'u3 w')] },
	{ repertoireId: REP, fenKey: 'u1 w', children: [e('Nf3', 'o2 b')] },
	{ repertoireId: REP, fenKey: 'u2 w', children: [e('Nc3', 'o3 b')] },
	{ repertoireId: REP, fenKey: 'u3 w', children: [] },
	{ repertoireId: REP, fenKey: 'o2 b', children: [e('a', 'l1 w')] },
	{ repertoireId: REP, fenKey: 'o3 b', children: [e('b', 'l2 w')] },
	{ repertoireId: REP, fenKey: 'l1 w', children: [] },
	{ repertoireId: REP, fenKey: 'l2 w', children: [] }
];

async function seed(nodes = tree) {
	const db = await getDB();
	const tx = db.transaction('nodes', 'readwrite');
	await tx.store.clear();
	for (const n of nodes) await tx.store.put(structuredClone(n));
	await tx.done;
}

beforeEach(async () => {
	calls.length = 0;
	failAfter = Infinity;
	await seed();
});

describe('frequencyFromExplorer', () => {
	it('matches by SAN; a move outside the listed ones counts as 0 games', () => {
		const res = explorer('');
		expect(frequencyFromExplorer(res, 'a', 'lichess', 1)).toEqual({
			games: 600,
			total: 1000,
			source: 'lichess',
			fetchedAt: 1
		});
		expect(frequencyFromExplorer(res, 'zz', 'lichess', 1)?.games).toBe(0);
		expect(
			frequencyFromExplorer({ ...res, white: 0, draws: 0, black: 0 }, 'a', 'lichess', 1)
		).toBeNull();
	});
});

describe('captureMoveFrequencies', () => {
	it('records opponent replies without stamping updatedAt', async () => {
		expect(await captureMoveFrequencies(rep, 'o1 b', explorer(''), 'lichess', 10)).toBe(3);
		const node = (await nodesMap(REP)).get('o1 b')!;
		expect(node.children.map((c) => c.frequency?.games)).toEqual([600, 100, 0]);
		expect(node.children.every((c) => c.updatedAt === 5)).toBe(true);
	});

	it('ignores positions where it is the user to move', async () => {
		expect(await captureMoveFrequencies(rep, 'root w', explorer(''), 'lichess', 10)).toBe(0);
	});

	it('prefers Lichess counts over masters, and refreshes only stale ones', async () => {
		await captureMoveFrequencies(rep, 'o1 b', explorer(''), 'masters', 10);
		expect(await captureMoveFrequencies(rep, 'o1 b', explorer(''), 'lichess', 20)).toBe(3);
		expect(await captureMoveFrequencies(rep, 'o1 b', explorer(''), 'masters', 30)).toBe(0);
		expect(await captureMoveFrequencies(rep, 'o1 b', explorer(''), 'lichess', 40)).toBe(0);
	});
});

describe('backfillMoveFrequencies', () => {
	it('fills every opponent position, shallowest first, one request each', async () => {
		const res = await backfillMoveFrequencies(rep, await nodesMap(REP), {
			token: 't',
			delayMs: 0
		});
		expect(res).toEqual({ filled: 3, remaining: 0 });
		expect(calls).toEqual(['o1 b 0 1', 'o2 b 0 1', 'o3 b 0 1']);
		expect(frequencyCoverage(rep, await nodesMap(REP))).toEqual({ withData: 5, total: 5 });
	});

	it('stops on the rate limit and resumes where it left off', async () => {
		failAfter = 1;
		const first = await backfillMoveFrequencies(rep, await nodesMap(REP), {
			token: 't',
			delayMs: 0
		});
		expect(first).toEqual({ filled: 1, remaining: 2, stoppedBy: 'rate-limit' });
		failAfter = Infinity;
		calls.length = 0;
		const second = await backfillMoveFrequencies(rep, await nodesMap(REP), {
			token: 't',
			delayMs: 0
		});
		expect(second).toEqual({ filled: 2, remaining: 0 });
		expect(calls).toEqual(['o2 b 0 1', 'o3 b 0 1']);
	});

	it('upgrades masters counts from the auto-builder to Lichess counts', async () => {
		for (const k of ['o1 b', 'o2 b', 'o3 b']) {
			await captureMoveFrequencies(rep, k, explorer(''), 'masters', 1);
		}
		const res = await backfillMoveFrequencies(rep, await nodesMap(REP), {
			token: 't',
			delayMs: 0
		});
		expect(res.filled).toBe(3);
		const nodes = await nodesMap(REP);
		expect(nodes.get('o2 b')!.children[0].frequency?.source).toBe('lichess');
	});

	it('uses the repertoire root FEN when the root is the opponent to move', async () => {
		// Black repertoire from a White-to-move root: the root is the opponent's.
		const blackRep: Repertoire = { ...rep, color: 'black' };
		await backfillMoveFrequencies(blackRep, await nodesMap(REP), { token: 't', delayMs: 0 });
		expect(calls[0]).toBe('root w - - 0 1');
	});
});
