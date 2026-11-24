import { expect, test, type Page } from '@playwright/test';
import { Chess } from 'chessops/chess';
import { parsePgn } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { makeUci } from 'chessops/util';

// The board is up to 600px tall and sits below the page header; the default
// 720px viewport clips its bottom rank, making back-rank moves unclickable.
test.use({ viewport: { width: 1280, height: 1040 } });

/**
 * The drill animates the moves leading to every position it asks about
 * (the "intro animation" setting). A card asked again later in the same
 * session, such as the deferred Train pass of a line learned earlier, used
 * to snap straight to its position from whatever line the board was on.
 *
 * This drives a fresh session (every card new, so each walk gets a Learn
 * and a Train pass) and checks how the board reached each prompt: the last
 * change before the prompt must be a single move, not a jump.
 */

const PGN = `[Event "Lead-in"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 (2... d6 3. d4 exd4 4. Nxd4 Nf6) 3. Bc4 Bc5 (3... Nf6 4. Ng5 d5) 4. c3 Nf6 5. d4 exd4 *
`;

/** A board as 64 chars, a8..h1, '.' for an empty square. */
type Board64 = string;

function board64(pos: Chess): Board64 {
	let out = '';
	for (let rank = 7; rank >= 0; rank--) {
		for (let file = 0; file < 8; file++) {
			const p = pos.board.get(rank * 8 + file);
			if (!p) out += '.';
			else {
				const c = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' }[p.role];
				out += p.color === 'white' ? c.toUpperCase() : c;
			}
		}
	}
	return out;
}

/** White's prepared move for every White-to-move position. */
function whiteMoves(pgn: string): Map<Board64, string> {
	const table = new Map<Board64, string>();
	type PgnNode = { children: { data: { san: string }; children: unknown[] }[] };
	const walk = (node: PgnNode, pos: Chess) => {
		if (node.children.length === 0) return;
		if (pos.turn === 'white') {
			const mv = parseSan(pos, node.children[0].data.san);
			if (mv) table.set(board64(pos), makeUci(mv));
		}
		for (const child of node.children) {
			const next = pos.clone();
			const mv = parseSan(next, child.data.san);
			if (!mv) continue;
			next.play(mv);
			walk(child as PgnNode, next);
		}
	};
	walk(parsePgn(pgn)[0].moves as PgnNode, Chess.default());
	return table;
}

const changedSquares = (a: Board64, b: Board64) => [...a].filter((c, i) => c !== b[i]).length;

/** Record every distinct board the page shows, sampled every 30ms. */
async function startRecording(page: Page) {
	await page.evaluate(() => {
		const w = window as unknown as { __boards: string[] };
		w.__boards = [];
		const chars: Record<string, string> = {
			pawn: 'p',
			knight: 'n',
			bishop: 'b',
			rook: 'r',
			queen: 'q',
			king: 'k'
		};
		setInterval(() => {
			const board = document.querySelector('cg-board');
			if (!board) return;
			const grid = new Array(64).fill('.');
			for (const node of Array.from(board.querySelectorAll('piece'))) {
				const el = node as HTMLElement & { cgKey?: string; cgPiece?: string };
				if (el.classList.contains('fading') || el.classList.contains('ghost') || !el.cgKey)
					continue;
				const [color, role] = (el.cgPiece || el.className).split(' ');
				const c = chars[role];
				if (!c) continue;
				const idx = (7 - (el.cgKey.charCodeAt(1) - 49)) * 8 + (el.cgKey.charCodeAt(0) - 97);
				grid[idx] = color === 'white' ? c.toUpperCase() : c;
			}
			const s = grid.join('');
			if (w.__boards[w.__boards.length - 1] !== s) w.__boards.push(s);
		}, 30);
	});
}

const boards = (page: Page) =>
	page.evaluate(() => (window as unknown as { __boards: string[] }).__boards.slice());

test('every drill prompt is reached by a played move, never a jump', async ({ page }) => {
	test.setTimeout(180_000);
	const table = whiteMoves(PGN);
	const startBoard = board64(Chess.default());

	await page.goto('/import');
	await page.getByLabel('Title').fill('Lead-in');
	await page.getByLabel('PGN text').fill(PGN);
	await page.getByRole('button', { name: /^import$/i }).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	const repId = new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/)![1];

	await page.goto(`/repertoire/${repId}/drill`);
	await expect(page.locator('.cg-wrap')).toBeVisible({ timeout: 15_000 });
	await page.locator('cg-board').scrollIntoViewIfNeeded();
	await startRecording(page);

	const prompt = page.getByText(/What do you play here\?/i).first();
	const done = page.getByRole('heading', { name: /a good session|all caught up/i });

	const jumps: string[] = [];
	let prompts = 0;
	for (let i = 0; i < 40; i++) {
		await expect(prompt.or(done)).toBeVisible({ timeout: 15_000 });
		if (await done.isVisible()) break;
		// Let the lead-in finish: the board is stable for a while.
		let seen = (await boards(page)).length;
		for (let t = 0; t < 30; t++) {
			await page.waitForTimeout(150);
			const now = (await boards(page)).length;
			if (now === seen) break;
			seen = now;
		}
		const history = await boards(page);
		const here = history[history.length - 1];
		const move = table.get(here);
		expect(move, `prompt position should be a prepared White move: ${here}`).toBeTruthy();
		prompts++;
		if (here !== startBoard && history.length >= 2) {
			const before = history[history.length - 2];
			// One ply changes at most 4 squares (castling).
			if (changedSquares(before, here) > 4) jumps.push(`${before} -> ${here}`);
		}

		const box = (await page.locator('cg-board').boundingBox())!;
		const at = (sq: string) => ({
			x: box.x + (sq.charCodeAt(0) - 97 + 0.5) * (box.width / 8),
			y: box.y + (8 - Number(sq[1]) + 0.5) * (box.height / 8)
		});
		const from = at(move!.slice(0, 2));
		const to = at(move!.slice(2, 4));
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
		await page.mouse.move(to.x, to.y, { steps: 4 });
		await page.mouse.up();
		await expect(prompt).toBeHidden({ timeout: 5_000 });
	}

	// The fresh session asks each of the 8 moves twice (Learn, then Train).
	expect(prompts, 'the session should run its Train pass too').toBeGreaterThanOrEqual(12);
	expect(jumps, 'prompts reached by a jump instead of a lead-in').toEqual([]);
});
