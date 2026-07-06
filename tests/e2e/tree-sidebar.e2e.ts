import { expect, test } from '@playwright/test';

/**
 * Verifies the editor Tree sidebar: on desktop it's a left rail drawing the
 * mainline plus an indented sideline, and clicking a move navigates the board.
 * On mobile it's an off-canvas drawer that opens from a toolbar button and
 * closes after picking a move.
 */

const BASE_PGN = `1. e4 e5 2. Nf3 Nc6 *`;
const EXTRA_PGN = `1. e4 c5 2. Nf3 d6 *`;

async function seedRepertoire(page: import('@playwright/test').Page): Promise<string> {
	await page.goto('/import');
	await page.getByLabel('Title').fill('Tree sidebar test');
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

test('desktop: left-rail tree renders variations and navigates on click', async ({ page }) => {
	const repId = await seedRepertoire(page);
	await page.goto(`/repertoire/${repId}/edit`);
	await expect(page.locator('.cg-wrap')).toBeVisible();

	const tree = page.locator('.ink-panel', { hasText: 'Tree' });
	for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'c5', 'd6']) {
		await expect(tree.getByRole('button', { name: san, exact: true }).first()).toBeVisible();
	}

	await tree.getByRole('button', { name: 'd6', exact: true }).first().click();
	const lineStrip = page.locator('section', { has: page.getByText('Line', { exact: true }) });
	await expect(lineStrip.getByRole('button', { name: 'd6', exact: true }).first()).toBeVisible();
});

test('mobile: tree drawer flies in, navigates, and closes', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const repId = await seedRepertoire(page);
	await page.goto(`/repertoire/${repId}/edit`);
	await expect(page.locator('.cg-wrap')).toBeVisible();

	// The tree is not inline on mobile; it opens from the toolbar button into
	// a fixed off-canvas drawer.
	const drawer = page.locator('.z-50', { hasText: 'Tree' });
	await expect(drawer).toBeHidden();

	await page.getByRole('button', { name: 'Show repertoire tree' }).click();
	await expect(drawer).toBeVisible();
	await expect(drawer.getByRole('button', { name: 'd6', exact: true }).first()).toBeVisible();

	// Picking a move navigates the board and dismisses the drawer.
	await drawer.getByRole('button', { name: 'd6', exact: true }).first().click();
	await expect(drawer).toBeHidden();
	const lineStrip = page.locator('section', { has: page.getByText('Line', { exact: true }) });
	await expect(lineStrip.getByRole('button', { name: 'd6', exact: true }).first()).toBeVisible();

	// It can also be dismissed with Escape.
	await page.getByRole('button', { name: 'Show repertoire tree' }).click();
	await expect(drawer).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(drawer).toBeHidden();
});
