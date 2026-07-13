import { expect, test } from '@playwright/test';
import { Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { parsePgn } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { makeUci } from 'chessops/util';

// The board is up to 600px tall and sits below the page header; the default
// 720px viewport clips its bottom rank, making back-rank moves unclickable.
test.use({ viewport: { width: 1280, height: 1040 } });

/**
 * End-to-end for issue #84 — "the drill keeps repeating moves I already know."
 *
 * A line-walk *prefix* step is a user move the drill asks for on the way to a
 * card that's actually due. It used to be a free pass in both directions: a
 * correct answer earned no FSRS credit and a wrong one booked no lapse. That
 * closed a loop. A trunk move below the well-learned stability threshold is
 * re-walked in every session, but recalling it built no stability, so it could
 * never graduate out of the walk pool — the user answered it correctly forever
 * and kept being asked for it. That is the reported symptom.
 *
 * This test builds the exact situation the unit tests can't: a card that is NOT
 * due (so it can only ever appear as a prefix step) sitting on the path to one
 * that is. It then drives a real drill session through chessground and asserts
 * that recalling the prefix move moved its schedule — `reps` went up and the
 * next due date was pushed out. Before the fix, that card came out of the
 * session byte-for-byte unchanged, which is what this pins.
 */

const PGN = `[Event "Issue 84"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. Nbd2 O-O *
`;

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

/** Snapshot of the FSRS fields we assert on. */
interface CardProbe {
	fenKey: string;
	reps: number;
	stability: number;
	state: number;
	dueAt: number;
	lastReview: number | null;
}

test('a recalled line-walk prefix move earns FSRS credit (issue #84)', async ({ page }) => {
	test.setTimeout(180_000);

	const table = buildWhiteMoveTable(PGN);
	expect(table.size, 'PGN should yield prepared White moves').toBeGreaterThan(4);

	await page.goto('/import');
	await expect(page.getByRole('heading', { name: /bring a pgn/i })).toBeVisible();
	await page.getByLabel('Title').fill('Issue 84');
	await page.getByLabel('PGN text').fill(PGN);
	await page.getByRole('button', { name: /^import$/i }).click();

	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	const repId = new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/)?.[1];
	expect(repId, 'repertoire id missing from URL').toBeTruthy();

	// ── Set the stage ────────────────────────────────────────────────────────
	// Make the two shallowest White cards graduated-but-NOT-due, and coherent:
	// stability 5d (under the 7d well-learned threshold, so line-walk still asks
	// for them), last reviewed 3 days ago on a 5-day interval, so they next come
	// due in 2 days. Not due today → they can only reach the board as prefix
	// steps; still below the threshold → they are not animated past.
	//
	// The schedule has to be internally consistent for the due-date assertion to
	// mean anything. FSRS reschedules from `now`, so an early review moves the
	// due date out by `elapsed + (newInterval - oldInterval)` — always forward
	// for a coherent card on a correct answer, since stability only grows. Park
	// a stability-5 card a month out instead and the "early" review legitimately
	// pulls it *in*; that says nothing about the fix, only about the fixture.
	const prefixKeys: string[] = await page.evaluate(async (rid) => {
		const db: IDBDatabase = await new Promise((resolve, reject) => {
			const req = indexedDB.open('openingtrainer');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const all = <T>(store: string): Promise<T[]> =>
			new Promise((resolve, reject) => {
				const req = db.transaction(store).objectStore(store).getAll();
				req.onsuccess = () => resolve(req.result as T[]);
				req.onerror = () => reject(req.error);
			});

		type Node = { repertoireId: string; fenKey: string; children: { toFenKey: string }[] };
		type Card = { repertoireId: string; fenKey: string; fsrs: Record<string, unknown> };
		const nodes = (await all<Node>('nodes')).filter((n) => n.repertoireId === rid);
		const cards = (await all<Card>('cards')).filter((c) => c.repertoireId === rid);
		const reps = await all<{ id: string; rootFenKey: string }>('repertoires');
		const root = reps.find((r) => r.id === rid)!.rootFenKey;

		// BFS from the root to get each card position's depth.
		const kids = new Map(nodes.map((n) => [n.fenKey, n.children.map((c) => c.toFenKey)]));
		const depth = new Map<string, number>([[root, 0]]);
		const queue = [root];
		while (queue.length) {
			const cur = queue.shift()!;
			for (const next of kids.get(cur) ?? []) {
				if (depth.has(next)) continue;
				depth.set(next, depth.get(cur)! + 1);
				queue.push(next);
			}
		}

		const shallowest = cards
			.filter((c) => depth.has(c.fenKey))
			.sort((a, b) => depth.get(a.fenKey)! - depth.get(b.fenKey)!)
			.slice(0, 2);

		const now = Date.now();
		const reviewedAt = new Date(now - 3 * 864e5); // 3 days ago
		const nextDue = new Date(now + 2 * 864e5); // on a 5-day interval → due in 2 days
		const tx = db.transaction('cards', 'readwrite');
		for (const c of shallowest) {
			c.fsrs = {
				due: nextDue,
				stability: 5, // below the 7-day well-learned threshold → still walked
				difficulty: 5,
				elapsed_days: 5,
				scheduled_days: 5,
				reps: 3,
				lapses: 0,
				state: 2, // Review
				last_review: reviewedAt,
				learning_steps: 0
			};
			(c as Record<string, unknown>).dueAt = nextDue.getTime();
			(c as Record<string, unknown>).lastReview = reviewedAt.getTime();
			tx.objectStore('cards').put(c);
		}
		await new Promise((res) => (tx.oncomplete = res));
		return shallowest.map((c) => c.fenKey);
	}, repId!);

	expect(prefixKeys.length, 'need two prefix-only cards').toBe(2);

	const probe = async (): Promise<CardProbe[]> =>
		page.evaluate(
			async ([rid, keys]) => {
				const db: IDBDatabase = await new Promise((resolve, reject) => {
					const req = indexedDB.open('openingtrainer');
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				});
				const out = [];
				for (const fenKey of keys as string[]) {
					const c: {
						fsrs: { reps: number; stability: number; state: number };
						dueAt: number;
						lastReview?: number;
					} = await new Promise((resolve, reject) => {
						const req = db
							.transaction('cards')
							.objectStore('cards')
							.get([rid as string, fenKey]);
						req.onsuccess = () => resolve(req.result);
						req.onerror = () => reject(req.error);
					});
					out.push({
						fenKey,
						reps: c.fsrs.reps,
						stability: c.fsrs.stability,
						state: c.fsrs.state,
						dueAt: c.dueAt,
						lastReview: c.lastReview ?? null
					});
				}
				return out;
			},
			[repId!, prefixKeys] as [string, string[]]
		);

	const before = await probe();

	// ── Drive a real session ─────────────────────────────────────────────────
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

	const walkedPlacements = new Set<string>();
	let played = 0;

	for (let i = 0; i < 60; i++) {
		// Wait for an interactive prompt or a terminal screen.
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
		walkedPlacements.add(placement);

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
		played++;
		await page.waitForTimeout(400);
	}

	expect(played, 'the session should have driven several correct moves').toBeGreaterThanOrEqual(4);

	// ── Assert the prefix moves were actually credited ───────────────────────
	// Let the last rating's IDB write land.
	await page.waitForTimeout(1500);
	const after = await probe();

	for (const key of prefixKeys) {
		const b = before.find((c) => c.fenKey === key)!;
		const a = after.find((c) => c.fenKey === key)!;

		// The move was asked for as a prefix step and answered correctly, so it
		// is a review like any other: one more rep, a fresh review timestamp, and
		// a due date pushed further out than the month we parked it at.
		expect(a.reps, `prefix card ${key} should have banked a rep`).toBe(b.reps + 1);
		expect(a.lastReview, `prefix card ${key} should have a fresh review stamp`).not.toBe(
			b.lastReview
		);
		expect(a.stability, `prefix card ${key} should have gained stability`).toBeGreaterThan(
			b.stability
		);
		expect(a.dueAt, `prefix card ${key} should have its due date pushed out`).toBeGreaterThan(
			b.dueAt
		);

		// Rated once per session, not once per walk it appears in.
		expect(a.reps, `prefix card ${key} should not stack multiple reviews`).toBeLessThanOrEqual(
			b.reps + 1
		);
	}
});
