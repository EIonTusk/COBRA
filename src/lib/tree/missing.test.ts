import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { parseUci } from 'chessops/util';

import type { RepertoireNode } from '$lib/types';

// fetchExplorer is mocked per-test below (same pattern as coverage.test.ts).
const explorerMock = vi.hoisted(() => ({
	responses: new Map<
		string,
		{ moves: { uci: string; san: string; white: number; draws: number; black: number }[] }
	>()
}));

vi.mock('$lib/explorer/client', () => ({
	fetchExplorer: vi.fn(async (query: { fen: string }) => {
		const epd = query.fen.split(' ').slice(0, 4).join(' ');
		return explorerMock.responses.get(epd) ?? { moves: [] };
	})
}));

import { collectMissingMoves, firstMissingOnLine } from './missing';

const fenFromKey = (k: string) => `${k} 0 1`;
function after(key: string, uci: string): string {
	const pos = Chess.fromSetup(parseFen(fenFromKey(key)).unwrap()).unwrap();
	pos.play(parseUci(uci)!);
	return makeFen(pos.toSetup(), { epd: true });
}
const move = (san: string, uci: string, games: number) => ({
	san,
	uci,
	white: games,
	draws: 0,
	black: 0
});

// A black repertoire: 1.e4 and then two prepared answers, 1...e5 (disabled)
// and 1...c5. Explorer says 2.Nf3 is popular after both.
const ROOT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const E4 = after(ROOT, 'e2e4');
const E5 = after(E4, 'e7e5');
const C5 = after(E4, 'c7c5');

function tree(): Map<string, RepertoireNode> {
	const n = (fenKey: string, children: RepertoireNode['children']): RepertoireNode => ({
		repertoireId: 'rep',
		fenKey,
		children
	});
	return new Map([
		[ROOT, n(ROOT, [{ san: 'e4', uci: 'e2e4', toFenKey: E4 }])],
		[
			E4,
			n(E4, [
				{ san: 'e5', uci: 'e7e5', toFenKey: E5, disabled: true },
				{ san: 'c5', uci: 'c7c5', toFenKey: C5 }
			])
		],
		[E5, n(E5, [])],
		[C5, n(C5, [])]
	]);
}

describe('missing moves skip disabled lines (#99)', () => {
	beforeEach(() => {
		explorerMock.responses.clear();
		explorerMock.responses.set(ROOT, { moves: [move('e4', 'e2e4', 1000)] });
		explorerMock.responses.set(E5, { moves: [move('Nf3', 'g1f3', 800)] });
		explorerMock.responses.set(C5, { moves: [move('Nf3', 'g1f3', 600)] });
	});

	it('only suggests moves in live lines', async () => {
		const found = await collectMissingMoves(
			tree(),
			ROOT,
			fenFromKey(ROOT),
			'black',
			100,
			fenFromKey,
			{ token: '' }
		);
		expect(found.map((m) => m.fromFenKey)).toEqual([C5]);
	});

	it('suggests nothing on a line that runs through a disabled move', async () => {
		const path = (keys: string[]) => keys.map((fenKey) => ({ fenKey, fen: fenFromKey(fenKey) }));
		expect(
			await firstMissingOnLine(tree(), path([ROOT, E4, E5]), 'black', 100, { token: '' })
		).toBeNull();
		const live = await firstMissingOnLine(tree(), path([ROOT, E4, C5]), 'black', 100, {
			token: ''
		});
		expect(live?.fromFenKey).toBe(C5);
	});
});
