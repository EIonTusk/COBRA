// The explorer client's persisted (IndexedDB) cache: rows count as fresh for
// 24 h, and callers that only rank by game counts (the builder's gap search)
// may accept rows up to MAX_STALE_MS old instead of spending a request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAY = 24 * 60 * 60 * 1000;
const store = vi.hoisted(() => ({ fetchedAt: 0 }));

vi.mock('$lib/storage/db', () => ({
	getDB: async () => ({
		get: async () => ({
			key: 'k',
			fetchedAt: store.fetchedAt,
			data: {
				white: 1,
				draws: 0,
				black: 0,
				moves: [{ uci: 'e2e4', san: 'e4', white: 1, draws: 0, black: 0 }]
			}
		}),
		put: async () => undefined
	}),
	pruneExplorerCache: async () => undefined
}));

const { fetchExplorer, MAX_STALE_MS, __resetExplorerClientForTests } = await import('./client');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let sent = 0;

beforeEach(() => {
	__resetExplorerClientForTests();
	sent = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			sent++;
			return new Response(JSON.stringify({ white: 9, draws: 0, black: 0, moves: [] }), {
				status: 200
			});
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

describe('persisted explorer cache age', () => {
	it('refetches a 3-day-old row by default', async () => {
		store.fetchedAt = Date.now() - 3 * DAY;
		await fetchExplorer({ fen: START, token: 't' });
		expect(sent).toBe(1);
	});

	it('reuses it when the caller accepts older rows', async () => {
		store.fetchedAt = Date.now() - 3 * DAY;
		const res = await fetchExplorer({ fen: START, token: 't' }, { maxAgeMs: MAX_STALE_MS });
		expect(sent).toBe(0);
		expect(res.moves[0].san).toBe('e4');
	});

	it('never reuses rows older than MAX_STALE_MS', async () => {
		store.fetchedAt = Date.now() - MAX_STALE_MS - DAY;
		await fetchExplorer({ fen: START, token: 't' }, { maxAgeMs: 10 * MAX_STALE_MS });
		expect(sent).toBe(1);
	});
});
