import { expect, test, type Page } from '@playwright/test';

// The board is up to 600px tall and sits below the page header; the default
// 720px viewport clips its bottom rank, making back-rank moves unclickable.
test.use({ viewport: { width: 1280, height: 1040 } });
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
		const cards: Card[] = await new Promise((resolve, reject) => {
			const req = db.transaction('cards').objectStore('cards').getAll();
			req.onsuccess = () => resolve(req.result as Card[]);
			req.onerror = () => reject(req.error);
		});
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

/**
 * End-to-end for issues #102 / #99 — disabled moves in Drill.
 *
 * A card keeps the SAN of the first move saved at its position. When the user
 * has two prepared moves at a position P and disables the one the card was
 * created for, the card used to drop out of the drill entirely (the live move
 * at P was never asked), and playing the disabled move in a drill counted as a
 * miss. Now:
 *   - P stays in the drill, with the live move as the answer (hint and arrow
 *     point at it, and playing it is correct);
 *   - playing the disabled move shows a "Disabled line" note, resets the board
 *     and does not grade the attempt.
 *
 * Seeded through the real PGN importer, then the FSRS state and the disabled
 * flag are written straight into IndexedDB, and the drill is driven through
 * chessground.
 */

// P = after 1.e4 e5. White has two prepared moves there: 2.Nf3 (the card's
// expectedSan, first in the PGN) and 2.Bc4. 2.Nf3 gets disabled.
const PGN = `[Event "Disabled answer"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 2. Nf3 (2. Bc4 Nf6 3. d3) 2... Nc6 3. Bb5 *
`;

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const P = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR';
const AFTER_BC4_NF6 = 'rnbqkb1r/pppp1ppp/5n2/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR';

/** The moves the user should play: the LIVE move at P, never the disabled one. */
const LIVE_TABLE = new Map([
	[START, 'e2e4'],
	[P, 'f1c4'],
	[AFTER_BC4_NF6, 'd2d3']
]);
const DISABLED_AT_P = 'g1f3';
const LIVE_AT_P = 'f1c4';

/**
 * Disable 2.Nf3 at P and give the cards a coherent review history:
 *   - e4 (root): well learned, not due — animated past as the lead-in;
 *   - P: reviewed, last graded Good, due an hour ago — the card under test;
 *   - d3 (Bc4 line): reviewed, not due.
 * Bb5 is only reachable through the disabled 2.Nf3, so it's out of play.
 */
async function seed(page: Page, repId: string): Promise<{ pKey: string }> {
	return page.evaluate(async (rid) => {
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
		const afterE4 = await get<Node>('nodes', [
			rid,
			root.children.find((e) => e.san === 'e4')!.toFenKey
		]);
		const pKey = afterE4.children.find((e) => e.san === 'e5')!.toFenKey;
		const pNode = await get<Node & Record<string, unknown>>('nodes', [rid, pKey]);
		const sans = pNode.children.map((e) => e.san).sort();
		if (sans.join(',') !== 'Bc4,Nf3') throw new Error(`P has moves ${sans}`);
		pNode.children.find((e) => e.san === 'Nf3')!.disabled = true;

		const afterBc4 = await get<Node>('nodes', [
			rid,
			pNode.children.find((e) => e.san === 'Bc4')!.toFenKey
		]);
		const d3Key = afterBc4.children.find((e) => e.san === 'Nf6')!.toFenKey;

		const now = Date.now();
		const day = 864e5;
		const schedule = async (
			fenKey: string,
			stability: number,
			reviewedAgo: number,
			dueIn: number
		): Promise<Record<string, unknown>> => {
			const card = await get<Record<string, unknown>>('cards', [rid, fenKey]);
			if (!card) throw new Error(`no card at ${fenKey}`);
			card.fsrs = {
				due: new Date(now + dueIn),
				stability,
				difficulty: 5,
				elapsed_days: Math.round(reviewedAgo / day),
				scheduled_days: Math.round((reviewedAgo + dueIn) / day),
				reps: 3,
				lapses: 0,
				state: 2, // Review
				last_review: new Date(now - reviewedAgo),
				learning_steps: 0
			};
			card.dueAt = now + dueIn;
			card.lastReview = now - reviewedAgo;
			card.lastRating = 3; // Rating.Good
			return card;
		};
		const rootCard = await schedule(rep.rootFenKey, 30, 10 * day, 20 * day);
		const pCard = await schedule(pKey, 5, 6 * day, -3600_000);
		const d3Card = await schedule(d3Key, 5, 2 * day, 3 * day);
		if (pCard.expectedSan !== 'Nf3') throw new Error(`P card expects ${pCard.expectedSan}`);

		const tx = db.transaction(['nodes', 'cards'], 'readwrite');
		tx.objectStore('nodes').put(pNode);
		for (const c of [rootCard, pCard, d3Card]) tx.objectStore('cards').put(c);
		await new Promise((res) => (tx.oncomplete = res));
		db.close();
		return { pKey };
	}, repId);
}

/** cgHash of every shape chessground currently draws ("…,orig,dest,brush,…"). */
async function shapeHashes(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll('cg-container [cgHash]')).map(
			(el) => el.getAttribute('cgHash') ?? ''
		)
	);
}

/** Open the drill and answer lead-in prompts until P is asked. */
async function openDrillAtP(page: Page, repId: string) {
	await page.goto(`/repertoire/${repId}/drill`);
	const drv = boardDriver(page);
	await expect(page.locator('.cg-wrap').or(drv.caughtUp)).toBeVisible({ timeout: 15_000 });
	await expect(
		drv.caughtUp,
		'P must stay in the drill: its card move is disabled but Bc4 is live'
	).not.toBeVisible();
	await page.locator('cg-board').scrollIntoViewIfNeeded();
	const asked: string[] = [];
	for (let i = 0; i < 5; i++) {
		const state = await drv.waitPrompt();
		expect(state, `expected a prompt; asked so far: ${asked.join(' | ')}`).toBe('pending');
		const placement = (await drv.readPlacement())!;
		asked.push(placement);
		if (placement === P) return drv;
		expect(placement, 'only the lead-in to P may be asked first').toBe(START);
		expect(await drv.play(LIVE_TABLE.get(START)!)).toBe(true);
		await page.waitForTimeout(400);
	}
	throw new Error(`the drill never asked P; asked: ${asked.join(' | ')}`);
}

test('a position whose card move is disabled is drilled with the live move as the answer (#102)', async ({
	page
}) => {
	test.setTimeout(120_000);
	const repId = await importPgn(page, 'Disabled answer', PGN);
	const { pKey } = await seed(page, repId);
	const before = (await readCards(page, repId)).find((c) => c.fenKey === pKey)!;
	expect(before.expectedSan).toBe('Nf3');

	const drv = await openDrillAtP(page, repId);

	// Hint level 1 highlights the piece to move: the c4 bishop's f1, not g1.
	await page.getByRole('button', { name: /show hint/i }).click();
	await expect(page.getByText(/the piece to move is highlighted/i)).toBeVisible();
	await expect
		.poll(async () => (await shapeHashes(page)).filter((h) => h.includes('paleGreen')))
		.toEqual([expect.stringMatching(/,f1,paleGreen/)]);

	// Hint level 2 draws the answer arrow: Bc4 (f1→c4), never Nf3 (g1→f3).
	await page.getByRole('button', { name: /show answer/i }).click();
	await expect(page.getByText(/the answer is drawn on the board/i)).toBeVisible();
	await expect
		.poll(async () => (await shapeHashes(page)).filter((h) => /,green\b/.test(h)))
		.toEqual([expect.stringMatching(/,f1,c4,green/)]);
	expect((await shapeHashes(page)).some((h) => h.includes(',g1,'))).toBe(false);

	// The live move is accepted as correct.
	expect(await drv.play(LIVE_AT_P)).toBe(true);
	await expect(page.getByText('Got there', { exact: true })).toBeVisible({ timeout: 5_000 });

	// Finish the session with live moves only.
	const rest = await drv.drive(LIVE_TABLE);
	expect(rest.end, `prompts after P: ${rest.prompts.join(' | ')}`).toBe('done');

	await page.waitForTimeout(800);
	const after = (await readCards(page, repId)).find((c) => c.fenKey === pKey)!;
	expect(after.reps, 'P was reviewed').toBe(before.reps + 1);
	expect(after.lapses, 'a correct (hinted) answer is not a lapse').toBe(0);
	expect(after.lastRating, 'P is not graded Again').not.toBe(1);
	expect(after.dueAt).toBeGreaterThan(Date.now());
});

test('playing a disabled move shows "Disabled line" and is not graded (#99)', async ({ page }) => {
	test.setTimeout(120_000);
	const repId = await importPgn(page, 'Disabled answer', PGN);
	const { pKey } = await seed(page, repId);
	const before = (await readCards(page, repId)).find((c) => c.fenKey === pKey)!;

	const drv = await openDrillAtP(page, repId);

	// Play the disabled 2.Nf3. The shelved path returns before any engine
	// probe, so this doesn't depend on Stockfish.
	expect(await drv.play(DISABLED_AT_P)).toBe(true);
	await expect(page.getByText('Disabled line', { exact: true })).toBeVisible({ timeout: 5_000 });
	await expect(page.getByText('Not in your active repertoire.')).toBeVisible();
	await expect(page.getByText(/this try doesn't count against you/i)).toBeVisible();

	// Not graded: the stored card is untouched.
	const during = (await readCards(page, repId)).find((c) => c.fenKey === pKey)!;
	expect(during, 'the shelved attempt must not write the card').toEqual(before);

	// The board resets to P and asks again, without counting a failed try.
	expect(await drv.waitPrompt()).toBe('pending');
	expect(await drv.readPlacement(), 'board resets to P').toBe(P);
	await expect(page.getByText(/· try 2/)).not.toBeVisible();
	await expect(page.getByText(/Not that one/)).not.toBeVisible();
	await expect(page.getByText('What do you play here?')).toBeVisible();

	// Now the live move: a clean first-try correct answer.
	expect(await drv.play(LIVE_AT_P)).toBe(true);
	await expect(page.getByText('Correct', { exact: true })).toBeVisible({ timeout: 5_000 });

	const rest = await drv.drive(LIVE_TABLE);
	expect(rest.end, `prompts after P: ${rest.prompts.join(' | ')}`).toBe('done');
	await expect(page.getByText(/to retry/)).not.toBeVisible();

	await page.waitForTimeout(800);
	const after = (await readCards(page, repId)).find((c) => c.fenKey === pKey)!;
	expect(after.reps, 'P was reviewed once, for the live move').toBe(before.reps + 1);
	expect(after.lapses, 'the disabled move did not book a lapse').toBe(0);
	expect(after.lastRating, 'P is not graded Again').not.toBe(1);
	expect(after.lastRating, 'a clean first-try recall grades Good or Easy').toBeGreaterThanOrEqual(
		3
	);
	expect(after.dueAt).toBeGreaterThan(Date.now());
});
