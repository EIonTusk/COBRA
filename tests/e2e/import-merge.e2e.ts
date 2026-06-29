import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end for issue #70: importing PGN into an EXISTING repertoire.
 *
 * Covers both surfaces that funnel through `mergeLinesIntoRepertoire`:
 *   1. the dedicated `repertoire/[id]/import` page (paste → merge → summary),
 *      with an independent tree-growth check on the repertoire overview, and
 *   2. the in-builder "Import PGN" modal on the edit page.
 *
 * The unit test (`src/lib/storage/importPgn.test.ts`) already pins the merge
 * arithmetic; these tests guard the wiring — that the UI actually parses the
 * paste, calls the helper against the right repertoire, and persists the new
 * lines.
 */

const BASE_PGN = `1. e4 e5 2. Nf3 Nc6 *`;
// Shares 1.e4 with the base line, then branches into the Sicilian — so a
// correct additive merge adds new moves without duplicating the shared e4.
const EXTRA_PGN = `1. e4 c5 2. Nf3 d6 *`;

async function createRepertoire(page: Page, title: string, pgn: string): Promise<string> {
	await page.goto('/import');
	await page.getByLabel('Title').fill(title);
	await page.getByLabel('PGN text').fill(pgn);
	await page.getByRole('button', { name: /^import$/i }).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	const match = new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/);
	expect(match, 'repertoire id missing from URL').not.toBeNull();
	return match![1];
}

/** Read the "Moves" count from the overview's Tree-contents panel. */
async function movesCount(page: Page, repId: string): Promise<number> {
	await page.goto(`/repertoire/${repId}`);
	const dd = page.locator('dt', { hasText: 'Moves' }).locator('xpath=following-sibling::dd[1]');
	await expect(dd).toBeVisible();
	const text = (await dd.textContent())?.trim() ?? '';
	const n = parseInt(text, 10);
	expect(Number.isNaN(n), `Moves count "${text}" was not a number`).toBe(false);
	return n;
}

test('import page merges new PGN lines into an existing repertoire', async ({ page }) => {
	const repId = await createRepertoire(page, 'Merge target', BASE_PGN);
	const before = await movesCount(page, repId);

	await page.goto(`/repertoire/${repId}/import`);
	await expect(page.getByRole('heading', { name: /add pgn lines/i })).toBeVisible();

	await page.getByLabel('PGN text').fill(EXTRA_PGN);
	await page.getByRole('button', { name: /import into repertoire/i }).click();

	// Post-import summary confirms the merge ran and reports new moves.
	await expect(page.getByRole('heading', { name: /^imported$/i })).toBeVisible();
	await expect(page.getByText('New moves')).toBeVisible();

	// Independent confirmation: the tree actually grew on disk.
	const after = await movesCount(page, repId);
	expect(after, 'tree should have more moves after importing a fresh variation').toBeGreaterThan(
		before
	);
});

test('builder Import PGN modal merges lines into the open repertoire', async ({ page }) => {
	// Default viewport (1280) is ≥ the lg breakpoint, so the desktop toolbar
	// button is visible rather than collapsed into the Actions menu.
	const repId = await createRepertoire(page, 'Builder merge', BASE_PGN);
	const before = await movesCount(page, repId);

	await page.goto(`/repertoire/${repId}/edit`);

	await page.getByRole('button', { name: 'Import PGN' }).click();

	const dialog = page.getByRole('dialog');
	await expect(dialog.getByText(/import pgn into this repertoire/i)).toBeVisible();

	await dialog.getByPlaceholder(/1\. e4 e5/).fill(EXTRA_PGN);
	await dialog.getByRole('button', { name: 'Import', exact: true }).click();

	// Modal swaps to the summary on success.
	await expect(dialog.getByText('New moves')).toBeVisible();
	await expect(dialog.getByText('Lines merged')).toBeVisible();

	const after = await movesCount(page, repId);
	expect(after, 'tree should have grown after importing via the builder modal').toBeGreaterThan(
		before
	);
});
