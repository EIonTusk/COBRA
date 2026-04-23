import { expect, test } from '@playwright/test';

test('landing page renders the dashboard', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: /your openings/i })).toBeVisible();
	await expect(page.getByRole('link', { name: /new repertoire/i }).first()).toBeVisible();
	await expect(page.getByRole('link', { name: /open library/i }).first()).toBeVisible();
});

test('theme toggle flips html between dark and light', async ({ page }) => {
	await page.goto('/');
	// mode-watcher picks up the system preference on first paint, so the
	// initial direction isn't fixed — grab whichever toggle is rendered
	// and flip twice, asserting the `light` class toggles each time.
	const toggle = page.getByRole('button', { name: /switch to (light|dark) theme/i });
	await expect(toggle).toBeVisible();
	const initialHasLight = (await page.locator('html').getAttribute('class'))?.includes('light');
	await toggle.click();
	if (initialHasLight) {
		await expect(page.locator('html')).not.toHaveClass(/(^|\s)light(\s|$)/);
	} else {
		await expect(page.locator('html')).toHaveClass(/(^|\s)light(\s|$)/);
	}
	await page.getByRole('button', { name: /switch to (light|dark) theme/i }).click();
	if (initialHasLight) {
		await expect(page.locator('html')).toHaveClass(/(^|\s)light(\s|$)/);
	} else {
		await expect(page.locator('html')).not.toHaveClass(/(^|\s)light(\s|$)/);
	}
});

test('theme choice survives a reload (mode-watcher persists to localStorage)', async ({ page }) => {
	await page.goto('/');
	const toggle = page.getByRole('button', { name: /switch to (light|dark) theme/i });
	await expect(toggle).toBeVisible();
	const beforeLight = ((await page.locator('html').getAttribute('class')) ?? '').includes('light');
	await toggle.click();
	if (beforeLight) {
		await expect(page.locator('html')).not.toHaveClass(/(^|\s)light(\s|$)/);
	} else {
		await expect(page.locator('html')).toHaveClass(/(^|\s)light(\s|$)/);
	}
	await page.reload();
	if (beforeLight) {
		await expect(page.locator('html')).not.toHaveClass(/(^|\s)light(\s|$)/);
	} else {
		await expect(page.locator('html')).toHaveClass(/(^|\s)light(\s|$)/);
	}
});

test('export library triggers a .cobra download', async ({ page }) => {
	await page.goto('/settings');
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('button', { name: /export library/i }).click()
	]);
	expect(download.suggestedFilename()).toMatch(/^cobra-\d{4}-\d{2}-\d{2}\.cobra$/);
});

test('can create a repertoire and land on the edit page', async ({ page }) => {
	await page.goto('/repertoire/new');
	await expect(page.getByRole('heading', { name: /a new repertoire/i })).toBeVisible();
	await page.getByLabel('Title').fill('Smoke test white');
	await page.getByRole('button', { name: /^create$/i }).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/edit$/);
	await expect(page.locator('.cg-wrap')).toBeVisible();
});

test('import page renders and validates empty submission', async ({ page }) => {
	await page.goto('/import');
	await expect(page.getByRole('heading', { name: /bring a pgn/i })).toBeVisible();
	const submit = page.getByRole('button', { name: /^import$/i });
	await expect(submit).toBeDisabled();
});

test('settings page loads and shows defaults', async ({ page }) => {
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: /dials/i })).toBeVisible();
	await expect(page.getByLabel('New cards per session')).toHaveValue('10');
});
