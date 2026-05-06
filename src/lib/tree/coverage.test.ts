import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { RepertoireNode } from '$lib/types';

// fetchExplorer is mocked per-test below. The mock has to be installed
// before the SUT is imported, so we use vi.hoisted to share state.
const explorerMock = vi.hoisted(() => ({
	responses: new Map<
		string,
		{
			white: number;
			draws: number;
			black: number;
			moves: { uci: string; san: string; white: number; draws: number; black: number }[];
		}
	>()
}));

vi.mock('$lib/explorer/client', () => ({
	fetchExplorer: vi.fn(async (query: { fen: string }) => {
		const epd = query.fen.split(' ').slice(0, 4).join(' ');
		const r = explorerMock.responses.get(epd);
		if (!r) throw new Error(`no mock response for ${epd}`);
		return r;
	})
}));

import { computeCoverage } from './coverage';

const startEpd = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const startFen = `${startEpd} 0 1`;
const fenFromKey = (k: string) => (k.split(' ').length === 4 ? `${k} 0 1` : k);

function makeNode(fenKey: string, children: RepertoireNode['children']): RepertoireNode {
	return { repertoireId: 'rep', fenKey, children };
}

describe('computeCoverage', () => {
	beforeEach(() => {
		explorerMock.responses.clear();
	});

	it('keeps the BFS shape independent of the threshold (monotonic across goals)', async () => {
		// Root explorer response with five opponent moves spread across the
		// 1-in-100 / 1-in-200 / 1-in-300 thresholds. rootTotal = 1000:
		//   threshold(100) = 10   → e4, d4, c4, Nf3 above (4 needed); b3 below
		//   threshold(200) = 5    → all 5 above
		//   threshold(300) ≈ 3.3  → all 5 above
		explorerMock.responses.set(startEpd, {
			white: 0,
			draws: 0,
			black: 0,
			moves: [
				{ uci: 'e2e4', san: 'e4', white: 600, draws: 0, black: 0 },
				{ uci: 'd2d4', san: 'd4', white: 350, draws: 0, black: 0 },
				{ uci: 'c2c4', san: 'c4', white: 30, draws: 0, black: 0 },
				{ uci: 'g1f3', san: 'Nf3', white: 15, draws: 0, black: 0 },
				{ uci: 'b2b3', san: 'b3', white: 5, draws: 0, black: 0 }
			]
		});

		// User's tree (Black rep): from start, prepared replies to e4 and
		// d4 only (e5 and Nf6). c4/Nf3/b3 are unanswered.
		const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -';
		const afterD4 = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -';
		const nodes = new Map<string, RepertoireNode>();
		nodes.set(
			startEpd,
			makeNode(startEpd, [
				{ uci: 'e2e4', san: 'e4', toFenKey: afterE4 },
				{ uci: 'd2d4', san: 'd4', toFenKey: afterD4 }
			])
		);
		// Stub the after-positions as leaves — no further prep, so the BFS
		// has nothing more to probe past the root opponent position.
		nodes.set(afterE4, makeNode(afterE4, []));
		nodes.set(afterD4, makeNode(afterD4, []));

		const inputs = {
			rootFen: startFen,
			rootFenKey: startEpd,
			color: 'black' as const
		};

		const at100 = await computeCoverage({ ...inputs, goal: 100 }, nodes, fenFromKey, {
			token: 't'
		});
		const at200 = await computeCoverage({ ...inputs, goal: 200 }, nodes, fenFromKey, {
			token: 't'
		});
		const at300 = await computeCoverage({ ...inputs, goal: 300 }, nodes, fenFromKey, {
			token: 't'
		});

		// 100: needed = 4 (e4, d4, c4, Nf3). Covered = 2 (e4, d4) → 2/4 = 0.5
		expect(at100.needed).toBe(4);
		expect(at100.covered).toBe(2);
		expect(at100.ratio).toBeCloseTo(0.5);

		// 200: needed = 5 (all). Covered = 2 → 2/5 = 0.4
		expect(at200.needed).toBe(5);
		expect(at200.covered).toBe(2);
		expect(at200.ratio).toBeCloseTo(0.4);

		// 300: same as 200 — adding rarer moves doesn't add anything new
		// here, all 5 already counted.
		expect(at300.needed).toBe(5);
		expect(at300.covered).toBe(2);
		expect(at300.ratio).toBeCloseTo(0.4);

		// Crucially: ratio is non-increasing as N grows. The previous
		// implementation could have ratio(300) > ratio(200) because the
		// walk shape changed with N.
		expect(at200.ratio).toBeLessThanOrEqual(at100.ratio);
		expect(at300.ratio).toBeLessThanOrEqual(at200.ratio);
	});

	it('records edgeCount on the snapshot for stale-detection on the overview', async () => {
		explorerMock.responses.set(startEpd, {
			white: 0,
			draws: 0,
			black: 0,
			moves: [{ uci: 'e2e4', san: 'e4', white: 1000, draws: 0, black: 0 }]
		});
		const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -';
		const nodes = new Map<string, RepertoireNode>();
		nodes.set(startEpd, makeNode(startEpd, [{ uci: 'e2e4', san: 'e4', toFenKey: afterE4 }]));
		nodes.set(afterE4, makeNode(afterE4, []));

		const snap = await computeCoverage(
			{
				rootFen: startFen,
				rootFenKey: startEpd,
				color: 'black',
				goal: 100
			},
			nodes,
			fenFromKey,
			{ token: 't' }
		);
		expect(snap.edgeCount).toBe(1);
	});
});
