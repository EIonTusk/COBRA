// Explorer client request handling (issue #88): shared cache keys, merged
// identical requests, request spacing, foreground-before-background, dropping
// aborted requests, and the 429 cooldown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No IndexedDB here: the persistent cache falls back to "miss".
vi.mock('$lib/storage/db', () => ({
	getDB: async () => {
		throw new Error('no idb in this test');
	},
	pruneExplorerCache: async () => undefined
}));

const {
	fetchExplorer,
	peekExplorer,
	explorerCooldownMs,
	ExplorerRateLimited,
	MIN_GAP_MS,
	BACKGROUND_GAP_MS,
	__resetExplorerClientForTests
} = await import('./client');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

let sent: { url: URL; at: number }[] = [];
let status = 200;

function body() {
	return {
		white: 50,
		draws: 20,
		black: 30,
		moves: Array.from({ length: 30 }, (_, i) => ({
			uci: `m${i}`,
			san: `M${i}`,
			white: 30 - i,
			draws: 0,
			black: 0
		}))
	};
}

beforeEach(() => {
	// Only timers and the clock: faking everything also stalls the module
	// loader's own scheduling.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	__resetExplorerClientForTests();
	sent = [];
	status = 200;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			sent.push({ url: new URL(url), at: Date.now() });
			return { status, ok: status === 200, json: async () => body() };
		})
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const q = (fen: string, extra: Record<string, unknown> = {}) => ({
	fen,
	speeds: ['blitz'],
	ratings: [1600],
	moves: 10,
	token: 't',
	...extra
});

/** Let queued timers and promises run. */
async function settle(ms = 5000) {
	await vi.advanceTimersByTimeAsync(ms);
}

describe('explorer client', () => {
	it('sends one request for identical queries in flight (panel + board hints)', async () => {
		const a = fetchExplorer(q(START));
		const b = fetchExplorer(q(START));
		await settle();
		expect((await a).moves).toHaveLength(10);
		expect((await b).moves).toHaveLength(10);
		expect(sent).toHaveLength(1);
	});

	it('reuses a result for the same position reached with different move counters', async () => {
		await Promise.all([fetchExplorer(q(START)), settle()]);
		const again = await fetchExplorer(q(START.replace(/ 0 1$/, ' 4 3')));
		expect(again.moves).toHaveLength(10);
		expect(sent).toHaveLength(1);
	});

	it('shares one fetch between callers asking for different move counts', async () => {
		const ten = fetchExplorer(q(START));
		const thirty = fetchExplorer(q(START, { moves: 30 }));
		const dflt = fetchExplorer(q(START, { moves: undefined }));
		await settle();
		expect((await ten).moves).toHaveLength(10);
		expect((await thirty).moves).toHaveLength(30);
		expect((await dflt).moves).toHaveLength(12);
		expect(sent).toHaveLength(1);
		expect(sent[0].url.searchParams.get('moves')).toBe('30');
		// The caller's own position FEN is sent as-is.
		expect(sent[0].url.searchParams.get('fen')).toBe(START);
	});

	it('shows a cached position instantly via peekExplorer', async () => {
		expect(peekExplorer(q(START))).toBeNull();
		await Promise.all([fetchExplorer(q(START, { moves: 30 })), settle()]);
		expect(peekExplorer(q(START))?.moves).toHaveLength(10);
	});

	it('spaces requests out', async () => {
		const a = fetchExplorer(q(START));
		const b = fetchExplorer(q(AFTER_E4));
		await settle();
		await Promise.all([a, b]);
		expect(sent).toHaveLength(2);
		expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(MIN_GAP_MS);
	});

	it('runs a foreground request ahead of queued background work, which is spaced wider', async () => {
		const scan = ['K6k', 'K5k1', 'K4k2'].map((rank) =>
			fetchExplorer(q(`8/8/8/8/8/8/8/${rank} w - - 0 1`), { priority: 'background' })
		);
		const panel = fetchExplorer(q(START));
		await settle(10_000);
		await Promise.all([...scan, panel]);
		// The first background job may already be on the wire; the panel's
		// request goes next, before the rest of the scan.
		const order = sent.map((s) => s.url.searchParams.get('fen'));
		expect(order.indexOf(START)).toBeLessThanOrEqual(1);
		const bgTimes = sent.filter((s) => s.url.searchParams.get('fen') !== START).map((s) => s.at);
		for (let i = 1; i < bgTimes.length; i++) {
			expect(bgTimes[i] - bgTimes[i - 1]).toBeGreaterThanOrEqual(BACKGROUND_GAP_MS);
		}
	});

	it('drops a queued request once its caller aborts (the user moved on)', async () => {
		const first = fetchExplorer(q(START));
		const abort = new AbortController();
		const stale = fetchExplorer(q(AFTER_E4), { signal: abort.signal });
		abort.abort();
		await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
		await settle();
		await first;
		expect(sent.map((s) => s.url.searchParams.get('fen'))).toEqual([START]);
	});

	it('keeps a shared request alive while another caller still waits for it', async () => {
		const abort = new AbortController();
		const hints = fetchExplorer(q(START), { signal: abort.signal });
		const panel = fetchExplorer(q(START));
		abort.abort();
		await expect(hints).rejects.toMatchObject({ name: 'AbortError' });
		await settle();
		expect((await panel).moves).toHaveLength(10);
		expect(sent).toHaveLength(1);
	});

	it('on a 429 starts the cooldown and fails queued requests without sending them', async () => {
		status = 429;
		const a = fetchExplorer(q(START));
		const b = fetchExplorer(q(AFTER_E4));
		const results = Promise.allSettled([a, b]);
		await settle();
		const [ra, rb] = await results;
		expect(ra.status === 'rejected' && ra.reason instanceof ExplorerRateLimited).toBe(true);
		expect(rb.status === 'rejected' && rb.reason instanceof ExplorerRateLimited).toBe(true);
		expect(sent).toHaveLength(1);
		expect(explorerCooldownMs()).toBeGreaterThan(50_000);
		await expect(fetchExplorer(q('8/8/8/8/8/8/8/K6k w - - 0 1'))).rejects.toBeInstanceOf(
			ExplorerRateLimited
		);
		expect(sent).toHaveLength(1);
	});
});
