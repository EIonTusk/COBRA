import { expect, test } from '@playwright/test';

/**
 * Verifies the repertoire graph page: it's reachable from the tree view in the
 * builder, renders one chessboard per position, and clicking a board deep-links
 * back into the builder at that position.
 */

const BASE_PGN = `1. e4 e5 2. Nf3 Nc6 *`;
const EXTRA_PGN = `1. e4 c5 2. Nf3 d6 *`;

async function seedRepertoire(page: import('@playwright/test').Page): Promise<string> {
	await page.goto('/import');
	await page.getByLabel('Title').fill('Graph view test');
	await page.getByLabel('PGN text').fill(BASE_PGN);
	await page.getByRole('button', { name: /^import$/i }).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	const repId = new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/)![1];

	await page.goto(`/repertoire/${repId}/import`);
	await page.getByLabel('PGN text').fill(EXTRA_PGN);
	await page.getByRole('button', { name: /import into repertoire/i }).click();
	await expect(page.getByRole('heading', { name: /^imported$/i })).toBeVisible();
	return repId;
}

test('graph is reachable from the tree view and renders boards', async ({ page }) => {
	const repId = await seedRepertoire(page);
	await page.goto(`/repertoire/${repId}/edit`);
	await expect(page.locator('.cg-wrap').first()).toBeVisible();

	// The tree view exposes a button that opens the graph.
	await page.getByRole('link', { name: 'View the whole repertoire as a graph' }).first().click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/graph\?from=edit$/);

	// One mini-board per position (root + 7 prepared positions = 8).
	const boards = page.locator('.mini-board');
	await expect(boards.first()).toBeVisible();
	expect(await boards.count()).toBeGreaterThanOrEqual(8);

	// Clicking a board deep-links back into the builder at that position.
	await boards.nth(3).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/edit\?jump=/);
});
