import { expect, test, type Page } from '@playwright/test';

/**
 * Issue #96: a saved move that the Lichess explorer doesn't list had no row in
 * the Candidates panel, so nothing could delete it. It now gets a row of its
 * own there, and every move in the tree sidebar has a right-click menu.
 */

// Mainline 1. e4 e5 2. Nf3 Nc6, plus a sideline 1...c5 2. Nf3 d6 we'll remove.
const BASE_PGN = `1. e4 e5 2. Nf3 Nc6 *`;
const EXTRA_PGN = `1. e4 c5 2. Nf3 d6 *`;

async function seedRepertoire(page: Page): Promise<string> {
	await page.goto('/import');
	await page.getByLabel('Title').fill('Remove move test');
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

function treePanel(page: Page) {
	return page.locator('.ink-panel', { hasText: 'Tree' });
}

test('tree right-click removes a move and the line beneath it', async ({ page }) => {
	const repId = await seedRepertoire(page);
	await page.goto(`/repertoire/${repId}/edit`);
	await expect(page.locator('.cg-wrap')).toBeVisible();

	const tree = treePanel(page);
	await expect(tree.getByRole('button', { name: 'c5', exact: true })).toBeVisible();

	await tree.getByRole('button', { name: 'c5', exact: true }).click({ button: 'right' });
	const menu = page.getByRole('menu');
	await expect(menu.getByRole('menuitem', { name: 'Train from here' })).toBeVisible();
	await expect(menu.getByRole('menuitem', { name: 'Disable line' })).toBeVisible();
	await menu.getByRole('menuitem', { name: /remove move/i }).click();

	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText("and the 2 moves you've prepared beneath it");
	await dialog.getByRole('button', { name: 'Remove' }).click();

	await expect(tree.getByRole('button', { name: 'c5', exact: true })).toHaveCount(0);
	await expect(tree.getByRole('button', { name: 'd6', exact: true })).toHaveCount(0);
	await expect(tree.getByRole('button', { name: 'Nc6', exact: true })).toBeVisible();
});

test('tree right-click disables and re-enables a line', async ({ page }) => {
	const repId = await seedRepertoire(page);
	await page.goto(`/repertoire/${repId}/edit`);
	const tree = treePanel(page);
	const c5 = tree.getByRole('button', { name: 'c5', exact: true });

	await c5.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Disable line' }).click();
	await expect(c5).toHaveClass(/line-through/);

	await c5.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Enable line' }).click();
	await expect(c5).not.toHaveClass(/line-through/);
});

test('removing the move the board is on steps back to its parent', async ({ page }) => {
	const repId = await seedRepertoire(page);
	await page.goto(`/repertoire/${repId}/edit`);
	const tree = treePanel(page);

	await tree.getByRole('button', { name: 'd6', exact: true }).click();
	await expect(tree.getByRole('button', { name: 'd6', exact: true })).toHaveAttribute(
		'data-current',
		'true'
	);

	await tree.getByRole('button', { name: 'c5', exact: true }).click({ button: 'right' });
	await page.getByRole('menuitem', { name: /remove move/i }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();

	// Board is back on the position after 1. e4, where c5 was played from.
	await expect(tree.getByRole('button', { name: 'e4', exact: true })).toHaveAttribute(
		'data-current',
		'true'
	);
});

test('candidates panel lists saved moves Lichess does not, and deletes them', async ({ page }) => {
	// The explorer knows only e5 after 1. e4 — our saved c5 is "unlisted".
	await page.route('https://explorer.lichess.ovh/**', (route) =>
		route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({
				white: 10,
				draws: 5,
				black: 5,
				moves: [
					{
						uci: 'e7e5',
						san: 'e5',
						white: 10,
						draws: 5,
						black: 5,
						averageRating: 2000
					}
				],
				topGames: [],
				opening: null
			})
		})
	);

	await page.goto('/settings');
	await page.getByLabel('Or paste a personal API token').fill('lip_test');
	await page.getByRole('button', { name: 'Save changes' }).click();

	const repId = await seedRepertoire(page);
	await page.goto(`/repertoire/${repId}/edit`);
	const tree = treePanel(page);
	await tree.getByRole('button', { name: 'e4', exact: true }).click();

	await expect(page.getByText('Also in your repertoire')).toBeVisible();
	await expect(page.getByText('not in the database')).toBeVisible();

	await page.getByRole('button', { name: 'Delete c5 from your tree', exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();

	await expect(page.getByText('Also in your repertoire')).toHaveCount(0);
	await expect(tree.getByRole('button', { name: 'c5', exact: true })).toHaveCount(0);
});
