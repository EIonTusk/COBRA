import { expect, test } from '@playwright/test';

// Reaches a position where it's White to move with a pawn on b7 (one square
// from promotion): 1. e4 d5 2. exd5 c6 3. dxc6 e5 4. cxb7 Nd7.
const NEAR_PROMOTION_PGN = '1. e4 d5 2. exd5 c6 3. dxc6 e5 4. cxb7 Nd7';

test('promotion picker appears and underpromotion can be chosen', async ({ page }) => {
	// Import a line that leaves a white pawn on the 7th rank.
	await page.goto('/import');
	await page.getByPlaceholder(/1\. e4 e5/i).fill(NEAR_PROMOTION_PGN);
	await page.getByRole('button', { name: /^import$/i }).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+(\/|$)/);

	const id = page.url().match(/repertoire\/([a-f0-9-]+)/)![1];
	await page.goto(`/repertoire/${id}/edit`);
	const board = page.locator('.cg-wrap');
	await expect(board).toBeVisible();

	// Jump to the leaf (White to move, pawn on b7).
	await page.keyboard.press('End');

	// Click-move b7 -> b8 (chessground selectable is enabled).
	const box = (await board.boundingBox())!;
	const sq = (file: number, rank: number) => ({
		x: box.x + ((file + 0.5) / 8) * box.width,
		y: box.y + ((8 - rank + 0.5) / 8) * box.height
	});
	const b7 = sq(1, 7);
	const b8 = sq(1, 8);
	await page.mouse.click(b7.x, b7.y);
	await page.mouse.click(b8.x, b8.y);

	// The promotion picker must appear with all four choices.
	for (const role of ['q', 'r', 'b', 'n']) {
		await expect(
			page.getByRole('button', { name: new RegExp(`Promote to ${role}`, 'i') })
		).toBeVisible();
	}

	// Choose the knight (underpromotion) and confirm the move was recorded.
	await page.getByRole('button', { name: /Promote to n/i }).click();
	await expect(page.getByRole('button', { name: /Promote to/i })).toHaveCount(0);
	await expect(page.getByText('b8=N', { exact: false })).toBeVisible();
});
