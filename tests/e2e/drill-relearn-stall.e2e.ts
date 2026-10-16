import { expect, test, type Page } from '@playwright/test';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parsePgn } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { makeUci } from 'chessops/util';

// The board is up to 600px tall and sits below the page header; the default
// 720px viewport clips its bottom rank, making back-rank moves unclickable.
test.use({ viewport: { width: 1280, height: 1040 } });

/**
 * End-to-end for issues #103 / #101 — "Drill says All caught up while the
 * repertoire shows 126 due."
 *
 * Progressive unlock holds new cards back until every introduced card on their
 * path was last recalled successfully. When the user missed (graded Again) an
 * early trunk move, that card was scheduled a day out, so it wasn't due — and
 * every new card below it was gated. The drill came up empty, while the due
 * counters (which just counted `dueAt <= now`) advertised every new card.
 *
 * The fix routes the counters and the drill through one planner
 * (`planDueCards`): the shaky blocker is offered early as a "relearn" card, the
 * gated new cards are not counted, and recalling the blocker unlocks them.
 *
 * These tests seed a real repertoire through the PGN importer, rewrite the FSRS
 * state of the first move in IndexedDB to "missed yesterday, due tomorrow", and
 * then drive the real app: the counters, the drill page and chessground.
 */

const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR';

/** Prepared White move for every White-to-move position, keyed by placement. */
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

async function importPgn(page: Page, title: string, pgn: string): Promise<string> {
	await page.goto('/import');
	await expect(page.getByRole('heading', { name: /bring a pgn/i })).toBeVisible();
	await page.getByLabel('Title').fill(title);
	await page.getByLabel('PGN text').fill(pgn);
	await page.getByRole('button', { name: /^import$/i }).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	const repId = new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/)?.[1];
	expect(repId, 'repertoire id missing from URL').toBeTruthy();
	return repId!;
}

/** The "N due now" figure on the repertoire page (0 when it says "Nothing due"). */
async function repertoirePageDue(page: Page, repId: string): Promise<number> {
	await page.goto(`/repertoire/${repId}`);
	const dueNow = page.getByText(/\d+ due now/).first();
	const nothingDue = page.getByText(/Nothing due/).first();
	await expect(dueNow.or(nothingDue)).toBeVisible({ timeout: 10_000 });
	// Counts load asynchronously after the page shell; give them a beat to settle.
	await page.waitForTimeout(500);
	if (await nothingDue.isVisible()) return 0;
	const text = (await dueNow.textContent()) ?? '';
	return Number(text.match(/(\d+) due now/)?.[1] ?? NaN);
}

interface StoredCard {
	fenKey: string;
	expectedSan: string;
	dueAt: number;
	lastReview: number | null;
	lastRating: number | null;
	reps: number;
	lapses: number;
}

async function readCards(page: Page, repId: string): Promise<StoredCard[]> {
	return page.evaluate(async (rid) => {
		const db: IDBDatabase = await new Promise((resolve, reject) => {
			const req = indexedDB.open('openingtrainer');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		type Card = {
			repertoireId: string;
			fenKey: string;
			expectedSan: string;
			dueAt: number;
			lastReview?: number;
			lastRating?: number;
			fsrs: { reps: number; lapses: number };
		};
		const getAll = <T>(store: string): Promise<T[]> =>
			new Promise((resolve, reject) => {
				const req = db.transaction(store).objectStore(store).getAll();
				req.onsuccess = () => resolve(req.result as T[]);
				req.onerror = () => reject(req.error);
			});
		// A card is its slot in `cards` joined with the move's shared record in
		// `move_progress` (issue #97).
		const slots = await getAll<Pick<Card, 'repertoireId' | 'fenKey' | 'expectedSan'>>('cards');
		const progress = new Map(
			(await getAll<Omit<Card, 'repertoireId'>>('move_progress')).map((p) => [
				`${p.fenKey}|${p.expectedSan}`,
				p
			])
		);
		const cards: Card[] = slots.map((s) => ({
			...progress.get(`${s.fenKey}|${s.expectedSan}`)!,
			...s
		}));
		db.close();
		return cards
			.filter((c) => c.repertoireId === rid)
			.map((c) => ({
				fenKey: c.fenKey,
				expectedSan: c.expectedSan,
				dueAt: c.dueAt,
				lastReview: c.lastReview ?? null,
				lastRating: c.lastRating ?? null,
				reps: c.fsrs.reps,
				lapses: c.fsrs.lapses
			}));
	}, repId);
}

/** Drives chessground: reads the board, plays prepared moves, records prompts. */
function boardDriver(page: Page) {
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

	/** Wait for an interactive prompt or a terminal screen. */
	const waitPrompt = async (): Promise<'pending' | 'done' | 'caught-up' | 'idea' | 'timeout'> => {
		const start = Date.now();
		while (Date.now() - start < 15_000) {
			if (await sessionDone.isVisible()) return 'done';
			if (await caughtUp.isVisible()) return 'caught-up';
			if (await ideaPhase.isVisible()) return 'idea';
			if (await yourMove.isVisible()) {
				await settle(3000);
				return 'pending';
			}
			await page.waitForTimeout(150);
		}
		return 'timeout';
	};

	/** Drag `uci`; true once the origin square emptied (the move executed). */
	const play = async (uci: string): Promise<boolean> => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const geom = await readGeom();
			if (!geom) return false;
			const o = squareCenter(uci.slice(0, 2), geom);
			const d = squareCenter(uci.slice(2, 4), geom);
			await page.mouse.move(o.x, o.y);
			await page.mouse.down();
			await page.mouse.move((o.x + d.x) / 2, (o.y + d.y) / 2, { steps: 4 });
			await page.mouse.move(d.x, d.y, { steps: 4 });
			await page.mouse.up();
			const t0 = Date.now();
			while (Date.now() - t0 < 1500) {
				const pl = await readPlacement();
				if (!pl || !placementHas(pl, uci.slice(0, 2))) return true;
				await page.waitForTimeout(100);
			}
			await page.waitForTimeout(250);
		}
		return false;
	};

	/**
	 * Answer every prompt with the prepared move until the session ends or
	 * `stop(placement)` says so (checked before answering). Returns the prompts
	 * in order and how the loop ended.
	 */
	const drive = async (
		table: Map<string, string>,
		stop: (placement: string) => boolean = () => false,
		maxPrompts = 60
	): Promise<{ prompts: string[]; end: string }> => {
		const prompts: string[] = [];
		for (let i = 0; i < maxPrompts; i++) {
			const state = await waitPrompt();
			if (state !== 'pending') return { prompts, end: state };
			const placement = await readPlacement();
			if (!placement) return { prompts, end: 'no-board' };
			prompts.push(placement);
			if (stop(placement)) return { prompts, end: 'stopped' };
			const uci = table.get(placement);
			if (!uci) return { prompts, end: `unknown-position ${placement}` };
			if (!(await play(uci))) return { prompts, end: `move-failed ${uci}` };
			await page.waitForTimeout(400);
		}
		return { prompts, end: 'max-prompts' };
	};

	return { readPlacement, waitPrompt, play, drive, sessionDone, caughtUp };
}

// A single mainline: one White card per White move (6), so "everything below
// the first move" is five new cards.
const MAINLINE_PGN = `[Event "Relearn stall"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. Nbd2 a6 *
`;

test('a missed first move is offered for relearning instead of stalling the drill (#103, #101)', async ({
	page
}) => {
	test.setTimeout(180_000);

	const table = buildWhiteMoveTable(MAINLINE_PGN);
	const repId = await importPgn(page, 'Relearn stall', MAINLINE_PGN);

	// ── Seed: the first move was graded Again a minute ago, due again tomorrow.
	// Every deeper card is still new (never reviewed, due since import).
	const seeded = await page.evaluate(async (rid) => {
		const db: IDBDatabase = await new Promise((resolve, reject) => {
			const req = indexedDB.open('openingtrainer');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const rep: { rootFenKey: string } = await new Promise((resolve, reject) => {
			const req = db.transaction('repertoires').objectStore('repertoires').get(rid);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const slot: { expectedSan: string } = await new Promise((resolve, reject) => {
			const req = db.transaction('cards').objectStore('cards').get([rid, rep.rootFenKey]);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		// Progress lives in `move_progress`, keyed by position and move (issue #97).
		const card: Record<string, unknown> = {
			fenKey: rep.rootFenKey,
			expectedSan: slot.expectedSan
		};
		const now = Date.now();
		const reviewedAt = now - 60_000;
		const dueAt = now + 864e5;
		card.fsrs = {
			due: new Date(dueAt),
			stability: 0.4,
			difficulty: 7,
			elapsed_days: 0,
			scheduled_days: 1,
			reps: 1,
			lapses: 0,
			state: 1, // Learning — what a first review graded Again leaves
			last_review: new Date(reviewedAt),
			learning_steps: 0
		};
		card.dueAt = dueAt;
		card.lastReview = reviewedAt;
		card.lastRating = 1; // Rating.Again
		const tx = db.transaction('move_progress', 'readwrite');
		tx.objectStore('move_progress').put(card);
		await new Promise((res) => (tx.oncomplete = res));
		db.close();
		return { rootFenKey: rep.rootFenKey, expectedSan: card.expectedSan as string };
	}, repId);
	expect(seeded.expectedSan).toBe('e4');

	const before = await readCards(page, repId);
	expect(before.length, 'one card per White move').toBe(6);
	const newCards = before.filter((c) => c.lastReview === null);
	expect(newCards.length, 'every card below the first move is new').toBe(5);
	expect(
		newCards.every((c) => c.dueAt <= Date.now()),
		'new cards are due (that is what the old counter counted)'
	).toBe(true);

	// ── Counters: only the relearn card is servable, so every counter says 1
	// (the old counter said 5 — the gated new cards — while the drill had 0).
	expect(await repertoirePageDue(page, repId), 'repertoire page due count').toBe(1);

	await page.goto('/');
	await expect(page.getByText(/Quick drill/).first()).toBeVisible({ timeout: 10_000 });
	await page.waitForTimeout(500);
	await expect(page.getByText(/Quick drill/).first()).toHaveText(/Quick drill · 1 due/);

	await page.goto('/library');
	await expect(page.getByText('Relearn stall').first()).toBeVisible({ timeout: 10_000 });
	await page.waitForTimeout(500);
	await expect(page.getByText(/^\d+ due$/).first()).toHaveText('1 due');

	// ── Drill: serves exactly that one card, and it is the missed first move.
	await page.goto(`/repertoire/${repId}/drill`);
	const drv = boardDriver(page);
	await expect(page.locator('.cg-wrap').or(drv.caughtUp)).toBeVisible({ timeout: 15_000 });
	await expect(drv.caughtUp, 'the drill must not come up empty').not.toBeVisible();
	await page.locator('cg-board').scrollIntoViewIfNeeded();

	const first = await drv.drive(table);
	expect(first.prompts[0], 'the first card asked is the missed first move').toBe(START_PLACEMENT);
	expect(
		first.prompts,
		`the session should serve exactly the one relearn card; got ${first.prompts.join(' | ')}`
	).toEqual([START_PLACEMENT]);
	expect(first.end, 'the session ends after the relearn card').toBe('done');
	await expect(page.getByText(/You drilled\s*1\s*cards/)).toBeVisible();

	// The relearn card was graded on a correct recall: no longer Again.
	await page.waitForTimeout(800);
	const afterRelearn = await readCards(page, repId);
	const root = afterRelearn.find((c) => c.fenKey === seeded.rootFenKey)!;
	expect(root.lastRating, 'the recalled first move is no longer graded Again').not.toBe(1);
	expect(root.lastReview!).toBeGreaterThan(
		before.find((c) => c.fenKey === root.fenKey)!.lastReview!
	);

	// ── Continue studying: the moves below it are now unlocked and offered.
	await page.getByRole('button', { name: /continue studying/i }).click();
	await expect(page.locator('.cg-wrap').or(drv.caughtUp)).toBeVisible({ timeout: 15_000 });
	const second = await drv.drive(table, (p) => p !== START_PLACEMENT);
	expect(
		second.end,
		`after relearning, the drill should go on to a new move; prompts: ${second.prompts.join(' | ')}`
	).toBe('stopped');
	expect(second.prompts.at(-1), 'the next new move below the first one is asked').toBe(AFTER_E4_E5);
	const nf3 = afterRelearn.find((c) => c.expectedSan === 'Nf3')!;
	expect(nf3.lastReview, 'Nf3 is a new card being introduced').toBeNull();
});

// A branch on Black's first reply: 1...c5 is a line the user disabled.
//   live:      e4 (move 1), Nf3 after 1...e5 (move 2), Bc4 (move 3)
//   disabled:  Nf3 after 1...c5 (move 2), d4 (move 3)
const BRANCHED_PGN = `[Event "Counter scope"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 (1... c5 2. Nf3 d6 3. d4 cxd4) 2. Nf3 Nc6 3. Bc4 Bc5 *
`;

const AFTER_E4_E5_NF3_NC6 = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R';

test('due counters match the drill and skip disabled lines and cards past the depth limit', async ({
	page
}) => {
	test.setTimeout(180_000);

	const table = buildWhiteMoveTable(BRANCHED_PGN);
	const repId = await importPgn(page, 'Counter scope', BRANCHED_PGN);

	const all = await readCards(page, repId);
	expect(all.length, 'five White cards across both lines').toBe(5);
	expect(all.every((c) => c.lastReview === null && c.dueAt <= Date.now())).toBe(true);
	expect(await repertoirePageDue(page, repId), 'everything is due before disabling').toBe(5);

	// Disable 1...c5 (the head edge of the Sicilian branch).
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
		const rootNode = await get<Node>('nodes', [rid, rep.rootFenKey]);
		const afterE4Key = rootNode.children.find((e) => e.san === 'e4')!.toFenKey;
		const afterE4 = await get<Node>('nodes', [rid, afterE4Key]);
		const c5 = afterE4.children.find((e) => e.san === 'c5');
		if (!c5) throw new Error('no 1...c5 edge');
		c5.disabled = true;
		const tx = db.transaction('nodes', 'readwrite');
		tx.objectStore('nodes').put(afterE4);
		await new Promise((res) => (tx.oncomplete = res));
		db.close();
	}, repId);

	expect(
		await repertoirePageDue(page, repId),
		'cards only reachable through the disabled 1...c5 are not due'
	).toBe(3);

	// Limit training depth to the first 2 moves through the repertoire page UI.
	const depthInput = page.getByLabel('Custom training depth in moves');
	await depthInput.fill('2');
	await depthInput.press('Tab');
	await expect(page.getByText(/^First 2$/).first()).toBeVisible();
	await expect(page.getByText(/\d+ due now/).first()).toHaveText(/^\s*2 due now\s*$/);
	// And it sticks after a reload.
	expect(await repertoirePageDue(page, repId), 'the depth limit drops Bc4 (move 3)').toBe(2);

	await page.goto('/library');
	await expect(page.getByText('Counter scope').first()).toBeVisible({ timeout: 10_000 });
	await page.waitForTimeout(500);
	await expect(page.getByText(/^\d+ due$/).first()).toHaveText('2 due');

	// ── The drill serves exactly those two cards and nothing else.
	await page.goto(`/repertoire/${repId}/drill`);
	const drv = boardDriver(page);
	await expect(page.locator('.cg-wrap').or(drv.caughtUp)).toBeVisible({ timeout: 15_000 });
	await expect(drv.caughtUp).not.toBeVisible();
	await page.locator('cg-board').scrollIntoViewIfNeeded();

	const run = await drv.drive(table);
	expect(run.end, `session should finish cleanly; prompts: ${run.prompts.join(' | ')}`).toBe(
		'done'
	);
	const asked = new Set(run.prompts);
	expect([...asked].sort(), 'the drill asks exactly the two counted cards').toEqual(
		[START_PLACEMENT, AFTER_E4_E5].sort()
	);
	expect(asked.has(AFTER_E4_E5_NF3_NC6), 'Bc4 (move 3) is past the depth limit').toBe(false);
});
