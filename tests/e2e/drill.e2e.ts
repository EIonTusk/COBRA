import { expect, test } from '@playwright/test';

/**
 * End-to-end: PGN import → repertoire → drill session loads a card.
 *
 * This covers the chain that the existing smoke tests don't touch:
 * the PGN parser creating tree nodes + FSRS cards on disk, and the drill
 * page picking them up and rendering a due card with a board. We stop short
 * of simulating a move on chessground (fragile to test via coordinates);
 * the goal is to catch regressions that break the whole drill startup,
 * not to exercise chessground itself.
 */

const SIMPLE_PGN = `[Event "Smoke"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 *
`;

test('PGN import seeds a drill queue that the drill page can load', async ({ page }) => {
	await page.goto('/import');
	await expect(page.getByRole('heading', { name: /bring a pgn/i })).toBeVisible();

	await page.getByLabel('Title').fill('Drill smoke test');
	await page.getByLabel('PGN text').fill(SIMPLE_PGN);
	await page.getByRole('button', { name: /^import$/i }).click();

	// Import redirects to the repertoire dashboard.
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	const repUrl = new URL(page.url());
	const match = repUrl.pathname.match(/\/repertoire\/([a-f0-9-]+)/);
	expect(match, 'repertoire id missing from URL').not.toBeNull();
	const repId = match![1];

	await page.goto(`/repertoire/${repId}/drill`);

	// The drill page must either land in an active-card phase (board visible)
	// or — if no cards are due for this colour — show "All caught up". It must
	// NOT stay stuck in the "Loading due cards…" phase or throw.
	const board = page.locator('.cg-wrap');
	const caughtUp = page.getByRole('heading', { name: /all caught up/i });
	await expect(board.or(caughtUp)).toBeVisible({ timeout: 10_000 });

	// Importing as white with the given PGN should produce cards on white's
	// turn (plies 0, 2, 4, 6). If instead we get "all caught up", something
	// upstream is broken — fail loudly to flag the regression.
	await expect(
		board,
		'drill queue should have cards after importing a mainline PGN as white'
	).toBeVisible();
});
