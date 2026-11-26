import { expect, test } from '@playwright/test';

test('Enable Sync is one button: it asks Lichess for the sync sign-in itself', async ({ page }) => {
	// Stand in for Lichess's consent screen; we only check what was asked.
	await page.route('https://lichess.org/oauth**', (route) =>
		route.fulfill({ status: 200, contentType: 'text/html', body: '<p>consent</p>' })
	);

	await page.goto('/settings#sync');
	await page.getByRole('radio', { name: /your own database/i }).check();
	await page.getByLabel('Your database address').fill('https://worker.example');
	await page.getByLabel('Your database address').blur();
	await expect(page.getByText(/approve a sign-in that only proves who you are/)).toBeVisible();

	const authRequest = page.waitForRequest(/lichess\.org\/oauth/);
	await page.getByRole('button', { name: 'Enable Sync' }).click();
	const url = new URL((await authRequest).url());
	// Scopeless: the Worker's sign-in token can't act on the account.
	expect(url.searchParams.has('scope')).toBe(false);

	await expect(page.getByText('consent')).toBeVisible();

	// The page that sign-in returns to knows to finish turning sync on.
	// (Read it from another app page: /settings itself would act on it.)
	await page.goto('/library');
	const pending = await page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const open = indexedDB.open('openingtrainer');
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		const row = await new Promise<Record<string, unknown>>((resolve) => {
			const g = db.transaction('settings').objectStore('settings').get('root');
			g.onsuccess = () => resolve(g.result);
		});
		db.close();
		return row.syncEnablePending;
	});
	expect(pending).toBe(true);
});
