import { expect, test, type Page } from '@playwright/test';

/**
 * The builder's "Find gap" menu: one button whose entries ("Next gap on this
 * line", "Biggest gap off this line", "Biggest gap overall") preview their
 * answers, while asking the Lichess explorer as little as possible:
 *  - nothing is probed for gaps until the menu is opened;
 *  - each position is asked about at most once, also across reloads
 *    (answers are kept in IndexedDB);
 *  - positions with too few games to hold a gap are never asked about;
 *  - a rate limit is reported as such, not as "no gaps".
 *
 * White repertoire: 1.e4 e5 2.Nf3 Nc6 3.Bb5 and 2.Bc4 Nf6 3.d3.
 * Gaps: 3...a6 after 3.Bb5 (3000 games), 3...Bc5 after 3.d3 (400 games),
 * and 2...Nc6 is answered. 1...c5 has 30 games: below the 1-in-100 threshold,
 * so the line after it (1...c5 2.Nf3) is never probed.
 */

test.use({ viewport: { width: 1280, height: 1040 } });

const PGN = `[Event "Find gap"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 (1... c5 2. Nf3) 2. Nf3 (2. Bc4 Nf6 3. d3) 2... Nc6 3. Bb5 *
`;

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -';
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -';
const AFTER_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -';
const AFTER_BB5 = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -';
const AFTER_BC4 = 'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR b KQkq -';
const AFTER_D3 = 'rnbqkb1r/pppp1ppp/5n2/4p3/2B1P3/3P4/PPP2PPP/RNBQK1NR b KQkq -';
const AFTER_C5_NF3 = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -';

const move = (uci: string, san: string, games: number) => ({
	uci,
	san,
	white: games,
	draws: 0,
	black: 0,
	averageRating: 2000
});

const EXPLORER: Record<string, ReturnType<typeof move>[]> = {
	[START]: [move('e2e4', 'e4', 10000)],
	[AFTER_E4]: [move('e7e5', 'e5', 9000), move('c7c5', 'c5', 30)],
	[AFTER_E5]: [move('g1f3', 'Nf3', 5500), move('f1c4', 'Bc4', 3500)],
	[AFTER_NF3]: [move('b8c6', 'Nc6', 5000)],
	[AFTER_BB5]: [move('a7a6', 'a6', 3000)],
	[AFTER_BC4]: [move('g8f6', 'Nf6', 3500)],
	[AFTER_D3]: [move('f8c5', 'Bc5', 400)],
	[AFTER_C5_NF3]: [move('d7d6', 'd6', 20)]
};

/** How often the fake explorer was asked about each position. */
let asked = new Map<string, number>();
let rateLimit = new Set<string>();

async function setup(page: Page): Promise<string> {
	asked = new Map();
	rateLimit = new Set();
	await page.route('https://explorer.lichess.ovh/**', (route) => {
		const fen = new URL(route.request().url()).searchParams.get('fen') ?? '';
		const epd = fen.split(' ').slice(0, 4).join(' ');
		asked.set(epd, (asked.get(epd) ?? 0) + 1);
		if (rateLimit.has(epd)) return route.fulfill({ status: 429, body: '' });
		const moves = EXPLORER[epd] ?? [];
		const total = moves.reduce((s, m) => s + m.white, 0);
		return route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ white: total, draws: 0, black: 0, moves, topGames: [], opening: null })
		});
	});
	await page.goto('/settings');
	await page.getByLabel('Or paste a personal API token').fill('lip_test');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByText('Saved', { exact: true })).toBeVisible();

	await page.goto('/import');
	await page.getByLabel('Title').fill('Find gap');
	await page.getByLabel('PGN text').fill(PGN);
	await page.getByRole('button', { name: /^import$/i }).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	return new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/)![1];
}

const preview = (page: Page, kind: 'line' | 'offLine' | 'overall') =>
	page.getByTestId(`gap-preview-${kind}`);

test('Find gap previews its answers and asks about each position once', async ({ page }) => {
	const repId = await setup(page);
	asked.clear();
	await page.goto(`/repertoire/${repId}/edit`);
	await expect(page.getByRole('button', { name: 'Find gap' })).toBeEnabled();
	await page.waitForTimeout(2500);
	// Opening the builder doesn't scan for gaps any more.
	expect(asked.has(AFTER_BB5)).toBe(false);
	expect(asked.has(AFTER_D3)).toBe(false);

	await page.getByRole('button', { name: 'Find gap' }).click();
	// At the start position the line is clean, so "next" looks below it.
	await expect(preview(page, 'line')).toHaveText(/a6 · 3,000/);
	await expect(preview(page, 'offLine')).toHaveText(/a6 · 3,000/);
	await expect(preview(page, 'overall')).toHaveText(/a6 · 3,000/);
	expect(asked.get(AFTER_BB5)).toBe(1);
	// Below the threshold: never asked.
	expect(asked.has(AFTER_C5_NF3)).toBe(false);

	await page.getByRole('menuitem', { name: 'Biggest gap overall' }).click();
	await expect(page.getByText(/a6 · 3,000 games/)).toBeVisible();

	// Sitting on the 3.Bb5 line now: "off this line" is the other gap.
	await page.getByRole('button', { name: 'Find gap' }).click();
	await expect(preview(page, 'offLine')).toHaveText(/Bc5 · 400/);
	await page.keyboard.press('Escape');

	for (const [pos, n] of asked) {
		if (pos !== START && pos !== AFTER_E4) expect(n, pos).toBe(1);
	}

	// A reload answers from IndexedDB: no new requests for these positions.
	const before = new Map(asked);
	await page.goto(`/repertoire/${repId}/edit`);
	await page.getByRole('button', { name: 'Find gap' }).click();
	await expect(preview(page, 'overall')).toHaveText(/a6 · 3,000/);
	await expect(preview(page, 'offLine')).toHaveText(/a6 · 3,000/);
	expect(asked.get(AFTER_BB5)).toBe(before.get(AFTER_BB5));
	expect(asked.get(AFTER_D3)).toBe(before.get(AFTER_D3));
});

test('a rate limit is reported, not shown as "no gaps"', async ({ page }) => {
	const repId = await setup(page);
	rateLimit.add(AFTER_BB5);
	await page.goto(`/repertoire/${repId}/edit`);
	await page.getByRole('button', { name: 'Find gap' }).click();
	await expect(preview(page, 'overall')).toHaveText(/rate limit/);
	await page.getByRole('menuitem', { name: 'Biggest gap overall' }).click();
	await expect(page.getByText(/Lichess rate limit, try again in \d+ s/)).toBeVisible();
	await expect(page.getByText('No gap in this repertoire.')).toHaveCount(0);
});
