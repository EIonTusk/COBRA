import { expect, type Page } from '@playwright/test';

/**
 * Open the home page, skipping the first-launch welcome page that a fresh
 * browser profile (no Lichess account) is sent to.
 */
export async function openHome(page: Page): Promise<void> {
	await page.goto('/');
	await page.getByRole('button', { name: 'Skip for now' }).click();
	await expect(page).not.toHaveURL(/\/welcome/);
}
