import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end for issue #99: the repertoire tour treated a disabled move like
 * any other, so it was listed as a continuation, drawn as an arrow, and the
 * "main line" (End) and random line (R) walked straight into it.
 *
 * After 1.e4 e5 the PGN saves 2.Nf3 first (the old main line) and 2.Bc4 as the
 * alternative; 2.Nf3 gets disabled.
 */

test.use({ viewport: { width: 1280, height: 1040 } });

const PGN = `[Event "Disabled in tour"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 2. Nf3 (2. Bc4 Nf6 3. d3) 2... Nc6 3. Bb5 *
`;

async function importPgn(page: Page): Promise<string> {
	await page.goto('/import');
	await expect(page.getByRole('heading', { name: /bring a pgn/i })).toBeVisible();
	await page.getByLabel('Title').fill('Disabled in tour');
	await page.getByLabel('PGN text').fill(PGN);
	await page.getByRole('button', { name: /^import$/i }).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	return new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/)![1];
}

/** Disable 2.Nf3 after 1.e4 e5, the way the builder's Disable action stores it. */
async function disableNf3(page: Page, repId: string): Promise<void> {
	await page.evaluate(async (rid) => {
		const db: IDBDatabase = await new Promise((resolve, reject) => {
			const req = indexedDB.open('openingtrainer');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const get = <T>(store: string, key: IDBValidKey): Promise<T> =>
			new Promise((resolve, reject) => {
				const req = db.transaction(store).objectStore(store).get(key);
				req.onsuccess = () => resolve(req.result as T);
				req.onerror = () => reject(req.error);
			});
		type Node = { children: { san: string; toFenKey: string; disabled?: boolean }[] };
		const rep = await get<{ rootFenKey: string }>('repertoires', rid);
		const root = await get<Node>('nodes', [rid, rep.rootFenKey]);
		const afterE4 = await get<Node>('nodes', [rid, root.children[0].toFenKey]);
		const pKey = afterE4.children.find((e) => e.san === 'e5')!.toFenKey;
		const p = await get<Node>('nodes', [rid, pKey]);
		if (p.children[0].san !== 'Nf3') throw new Error(`first move is ${p.children[0].san}`);
		p.children[0].disabled = true;
		const tx = db.transaction('nodes', 'readwrite');
		tx.objectStore('nodes').put(p);
		await new Promise((res) => (tx.oncomplete = res));
		db.close();
	}, repId);
}

/** The move spine ("start 1.e4 e5 2.Bc4 …"), read from its panel. */
const lineText = (page: Page) =>
	page
		.locator('div.ink-panel')
		.filter({ has: page.getByRole('button', { name: 'start' }) })
		.innerText();

test('the tour never plays or offers a disabled move (#99)', async ({ page }) => {
	const repId = await importPgn(page);
	await disableNf3(page, repId);
	await page.goto(`/repertoire/${repId}/tour`);
	await expect(page.getByRole('button', { name: 'start' })).toBeVisible();

	// The main line (End) follows the live 2.Bc4, not the disabled 2.Nf3.
	await page.keyboard.press('End');
	await expect.poll(() => lineText(page)).toContain('2.Bc4');
	expect(await lineText(page)).not.toContain('Nf3');

	// After 1.e4 e5: Bc4 is the only continuation; Nf3 is listed as disabled.
	await page.keyboard.press('Home');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	const continuations = page.locator('section', { has: page.getByText('Continuations') });
	await expect(continuations.getByRole('button', { name: /Bc4/ })).toBeVisible();
	await expect(continuations.getByRole('button', { name: /Nf3/ })).toHaveCount(0);
	await expect(page.getByText('not in your active repertoire')).toBeVisible();

	// Random lines (R) never take the disabled move either.
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press('r');
		await expect.poll(() => lineText(page)).toContain('2.');
		expect(await lineText(page)).not.toContain('Nf3');
	}
});

test('tour autoplay walks every live line and skips the disabled one (#99)', async ({ page }) => {
	const repId = await importPgn(page);
	await disableNf3(page, repId);
	await page.goto(`/repertoire/${repId}/tour`);
	await expect(page.getByRole('button', { name: 'start' })).toBeVisible();

	// Play the tour and record every line it shows until it finishes.
	await page.keyboard.press('a');
	const seen = new Set<string>();
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		seen.add(await lineText(page));
		if ([...seen].some((t) => t.includes('3.d3'))) break;
		await page.waitForTimeout(150);
	}
	const lines = [...seen];
	expect(
		lines.some((t) => t.includes('3.d3')),
		'autoplay reached the live line'
	).toBe(true);
	expect(lines.filter((t) => t.includes('Nf3'))).toEqual([]);
});
