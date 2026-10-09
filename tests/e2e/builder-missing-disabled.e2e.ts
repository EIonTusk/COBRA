import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end for issue #99 in the builder: the missing-move buttons searched
 * disabled lines too, so they suggested new moves to add inside a line the
 * user had shelved. Disabling a move also left stale suggestions in the
 * cached list the buttons answer from.
 *
 * White repertoire: 1.e4 e5 2.Nf3 (the line we disable) and 2.Bc4 Nf6 3.d3.
 * The fake explorer reports one popular unanswered reply in each line:
 * 2...Nc6 after 2.Nf3 (5000 games) and 3...Bc5 after 3.d3 (500 games).
 */

test.use({ viewport: { width: 1280, height: 1040 } });

const PGN = `[Event "Missing in disabled line"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 2. Nf3 (2. Bc4 Nf6 3. d3) *
`;

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -';
const AFTER_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -';
const AFTER_D3 = 'rnbqkb1r/pppp1ppp/5n2/4p3/2B1P3/3P4/PPP2PPP/RNBQK1NR b KQkq -';

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
	[AFTER_E4]: [move('e7e5', 'e5', 10000)],
	[AFTER_NF3]: [move('b8c6', 'Nc6', 5000)],
	[AFTER_D3]: [move('f8c5', 'Bc5', 500)]
};

/** Positions the fake explorer has been asked about. */
let probed = new Set<string>();

async function setup(page: Page): Promise<string> {
	probed = new Set();
	await page.route('https://explorer.lichess.ovh/**', (route) => {
		const fen = new URL(route.request().url()).searchParams.get('fen') ?? '';
		const epd = fen.split(' ').slice(0, 4).join(' ');
		probed.add(epd);
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
	// Wait for the save to land before navigating away, or the token can be
	// lost and every Lichess-backed control stays disabled.
	await expect(page.getByText('Saved', { exact: true })).toBeVisible();

	await page.goto('/import');
	await page.getByLabel('Title').fill('Missing in disabled line');
	await page.getByLabel('PGN text').fill(PGN);
	await page.getByRole('button', { name: /^import$/i }).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	return new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/)![1];
}

const treePanel = (page: Page) => page.locator('.ink-panel', { hasText: 'Tree' });

test('missing-move buttons skip a line disabled in the builder (#99)', async ({ page }) => {
	const repId = await setup(page);
	await page.goto(`/repertoire/${repId}/edit`);
	const tree = treePanel(page);
	const nf3 = tree.getByRole('button', { name: 'Nf3', exact: true });
	await expect(nf3).toBeVisible();
	// Let the background probe fill the suggestion cache while 2.Nf3 is live
	// (it has reached both gaps), so the disable below has to invalidate it.
	await expect
		.poll(() => probed.has(AFTER_NF3) && probed.has(AFTER_D3), { timeout: 15_000 })
		.toBe(true);
	await page.waitForTimeout(500);

	await nf3.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Disable line' }).click();
	await expect(nf3).toHaveClass(/line-through/);

	// Most popular missing: the bigger gap (2...Nc6) is in the disabled line.
	await page.getByRole('button', { name: 'Most popular missing' }).click();
	await expect(page.getByText(/Bc5 — 500 games/)).toBeVisible();
	await expect(page.getByText(/Nc6 — 5,000 games/)).toHaveCount(0);

	// Next missing while sitting in the disabled line suggests nothing there.
	await page.goto(`/repertoire/${repId}/edit`);
	await treePanel(page).getByRole('button', { name: 'Nf3', exact: true }).click();
	await page.getByRole('button', { name: 'Next missing' }).click();
	await expect(page.getByText('No missing threshold-popular moves on this line.')).toBeVisible();
});

test('re-enabling the line brings its suggestion back (#99)', async ({ page }) => {
	const repId = await setup(page);
	await page.goto(`/repertoire/${repId}/edit`);
	const nf3 = treePanel(page).getByRole('button', { name: 'Nf3', exact: true });
	await expect(nf3).toBeVisible();

	await nf3.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Disable line' }).click();
	await expect(nf3).toHaveClass(/line-through/);
	await nf3.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Enable line' }).click();
	await expect(nf3).not.toHaveClass(/line-through/);
	await page.waitForTimeout(3000);

	await page.getByRole('button', { name: 'Most popular missing' }).click();
	await expect(page.getByText(/Nc6 — 5,000 games/)).toBeVisible();
});
