import { expect, test } from '@playwright/test';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parsePgn } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { makeUci } from 'chessops/util';

test.use({ viewport: { width: 1280, height: 1040 } });

/**
 * A freshly-learned move must not be re-asked as the very next prompt.
 *
 * A line-walk that introduces a new card owes a "Train" pass — the walk is
 * replayed so the user actively recalls what they were just shown. That replay
 * used to run inline, re-anchoring to the start of the walk the instant it
 * finished. On a SHORT walk that start is the card the user just answered, so
 * the drill asked for the same move twice in a row. On a small repertoire —
 * where trunk extraction leaves lots of one- and two-card tail walks — that is
 * most of the session, and it makes the spacing worthless: nothing has been
 * recalled if nothing came in between.
 *
 * The Train pass is now deferred to the segment tail. This test drives a real
 * session and asserts BOTH halves of that:
 *   - no position is ever prompted twice back-to-back, and
 *   - the new cards genuinely do come back later (the pass still happens).
 *
 * The PGN branches at move 3 so the queue contains one- and two-card tail walks
 * (the shapes that produced the immediate repeat), not just one long trunk.
 */
const PGN = `[Event "Train pass deferral"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 (3... Nf6 4. Ng5) 4. c3 Nf6 *
`;

function buildWhiteMoveTable(pgn: string): Map<string, string> {
	const table = new Map<string, string>();
	const games = parsePgn(pgn);
	if (games.length === 0) return table;
	type PgnNode = { children: { data: { san: string }; children: unknown[] }[] };
	const walk = (node: PgnNode, pos: Chess) => {
		if (node.children.length === 0) return;
		if (pos.turn === 'white') {
			const mv = parseSan(pos, node.children[0].data.san);
			if (mv) table.set(makeFen(pos.toSetup()).split(' ')[0], makeUci(mv));
		}
		for (const child of node.children) {
			const childPos = pos.clone();
			const mv = parseSan(childPos, child.data.san);
			if (!mv) continue;
			childPos.play(mv);
			walk(child as PgnNode, childPos);
		}
	};
	walk(games[0].moves as PgnNode, Chess.default());
	return table;
}

interface BoardGeom {
	left: number;
	top: number;
	size: number;
	whiteOrient: boolean;
}

function squareCenter(sq: string, geom: BoardGeom): { x: number; y: number } {
	const file = sq.charCodeAt(0) - 97;
	const rank = sq.charCodeAt(1) - 49;
	const col = geom.whiteOrient ? file : 7 - file;
	const row = geom.whiteOrient ? 7 - rank : rank;
	return {
		x: geom.left + col * geom.size + geom.size / 2,
		y: geom.top + row * geom.size + geom.size / 2
	};
}

function placementHas(placement: string, sq: string): boolean {
	const file = sq.charCodeAt(0) - 97;
	const rank = sq.charCodeAt(1) - 49;
	const row = placement.split('/')[7 - rank];
	if (!row) return false;
	let f = 0;
	for (const ch of row) {
		if (ch >= '1' && ch <= '8') f += Number(ch);
		else {
			if (f === file) return true;
			f += 1;
		}
	}
	return false;
}

test('a freshly-learned move is not re-asked immediately', async ({ page }) => {
	test.setTimeout(180_000);

	const table = buildWhiteMoveTable(PGN);

	await page.goto('/import');
	await expect(page.getByRole('heading', { name: /bring a pgn/i })).toBeVisible();
	await page.getByLabel('Title').fill('Train pass deferral');
	await page.getByLabel('PGN text').fill(PGN);
	await page.getByRole('button', { name: /^import$/i }).click();

	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	const repId = new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/)?.[1];
	expect(repId).toBeTruthy();

	await page.goto(`/repertoire/${repId}/drill`);
	await expect(page.locator('.cg-wrap')).toBeVisible({ timeout: 15_000 });
	await page.locator('cg-board').scrollIntoViewIfNeeded();

	const yourMove = page.getByText(/Your move as/i).first();
	const sessionDone = page.getByRole('heading', { name: /a good session/i });
	const caughtUp = page.getByRole('heading', { name: /all caught up/i });
	const ideaPhase = page.getByText(/Idea ·/).first();

	const readPlacement = () =>
		page.evaluate(() => {
			const board = document.querySelector('cg-board');
			if (!board) return null;
			const toChar: Record<string, string> = {
				pawn: 'p',
				knight: 'n',
				bishop: 'b',
				rook: 'r',
				queen: 'q',
				king: 'k'
			};
			const grid: Record<string, string> = {};
			for (const node of Array.from(board.querySelectorAll('piece'))) {
				const el = node as HTMLElement & { cgKey?: string; cgPiece?: string };
				if (el.classList.contains('fading') || el.classList.contains('ghost')) continue;
				if (!el.cgKey) continue;
				const [color, role] = (el.cgPiece || el.className).split(' ');
				let c = toChar[role];
				if (!c) continue;
				if (color === 'white') c = c.toUpperCase();
				grid[el.cgKey] = c;
			}
			let out = '';
			for (let rank = 8; rank >= 1; rank--) {
				let empties = 0;
				for (let f = 0; f < 8; f++) {
					const c = grid['abcdefgh'[f] + rank];
					if (!c) empties++;
					else {
						if (empties) {
							out += empties;
							empties = 0;
						}
						out += c;
					}
				}
				if (empties) out += empties;
				if (rank > 1) out += '/';
			}
			return out;
		});

	const readGeom = (): Promise<BoardGeom | null> =>
		page.evaluate(() => {
			const board = document.querySelector('cg-board');
			if (!board) return null;
			const r = board.getBoundingClientRect();
			const size = r.width / 8;
			let whiteOrient = true;
			const piece = board.querySelector('piece') as (HTMLElement & { cgKey?: string }) | null;
			if (piece?.cgKey) {
				const file = piece.cgKey.charCodeAt(0) - 97;
				const rank = piece.cgKey.charCodeAt(1) - 49;
				const m = /translate\(\s*([-\d.]+)px[ ,]+([-\d.]+)px/.exec(piece.style.transform || '');
				if (m) {
					const col = Math.round(parseFloat(m[1]) / size);
					const row = Math.round(parseFloat(m[2]) / size);
					whiteOrient = col === file && row === 7 - rank;
				}
			}
			return { left: r.left, top: r.top, size, whiteOrient };
		});

	const settle = async (deadlineMs: number): Promise<string | null> => {
		const start = Date.now();
		let prev = await readPlacement();
		while (Date.now() - start < deadlineMs) {
			await page.waitForTimeout(180);
			const cur = await readPlacement();
			if (cur && cur === prev) return cur;
			prev = cur;
		}
		return prev;
	};

	const dragMove = async (uci: string, geom: BoardGeom) => {
		const o = squareCenter(uci.slice(0, 2), geom);
		const d = squareCenter(uci.slice(2, 4), geom);
		await page.mouse.move(o.x, o.y);
		await page.mouse.down();
		await page.mouse.move((o.x + d.x) / 2, (o.y + d.y) / 2, { steps: 4 });
		await page.mouse.move(d.x, d.y, { steps: 4 });
		await page.mouse.up();
	};

	const squareEmpty = async (sq: string): Promise<boolean> => {
		const pl = await readPlacement();
		return !pl || !placementHas(pl, sq);
	};

	// Every position the drill actually asked the user to move in, in order.
	const prompts: string[] = [];

	for (let i = 0; i < 60; i++) {
		let phase: 'pending' | 'end' | 'timeout' = 'timeout';
		const start = Date.now();
		while (Date.now() - start < 15_000) {
			if (
				(await sessionDone.isVisible()) ||
				(await caughtUp.isVisible()) ||
				(await ideaPhase.isVisible())
			) {
				phase = 'end';
				break;
			}
			if (await yourMove.isVisible()) {
				phase = 'pending';
				break;
			}
			await page.waitForTimeout(150);
		}
		if (phase !== 'pending') break;

		await settle(3000);
		const placement = await readPlacement();
		const uci = placement ? table.get(placement) : undefined;
		if (!placement || !uci) break;
		prompts.push(placement);

		let executed = false;
		for (let attempt = 0; attempt < 3 && !executed; attempt++) {
			const geom = await readGeom();
			if (!geom) break;
			await dragMove(uci, geom);
			const t0 = Date.now();
			while (Date.now() - t0 < 1500) {
				if (await squareEmpty(uci.slice(0, 2))) {
					executed = true;
					break;
				}
				await page.waitForTimeout(100);
			}
			if (!executed) await page.waitForTimeout(250);
		}
		if (!executed) break;
		await page.waitForTimeout(400);
	}

	expect(prompts.length, 'the session should have asked for several moves').toBeGreaterThanOrEqual(
		6
	);

	// Every move here is answered correctly first time, so a card is never
	// legitimately re-prompted on the spot (a wrong answer retries in place).
	// Two identical consecutive prompts therefore mean the Train pass fired
	// inline and re-asked the move the user had just played.
	const backToBack: string[] = [];
	for (let i = 1; i < prompts.length; i++) {
		if (prompts[i] === prompts[i - 1]) backToBack.push(prompts[i]);
	}
	expect(
		backToBack,
		`the drill re-asked a position immediately after it was answered: ${backToBack.join(', ')}\n` +
			`prompt order was:\n  ${prompts.join('\n  ')}`
	).toEqual([]);

	// The Train pass must still happen — just later. New cards are introduced and
	// then recalled once the rest of the segment has been worked through, so at
	// least one position is legitimately asked more than once across the session.
	const seen = new Map<string, number>();
	for (const p of prompts) seen.set(p, (seen.get(p) ?? 0) + 1);
	const repeated = [...seen.values()].filter((n) => n > 1).length;
	expect(repeated, 'new cards should still be re-asked later in the session').toBeGreaterThan(0);
});
