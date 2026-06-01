import { expect, test } from '@playwright/test';
import { Chess } from 'chessops/chess';
import { makeFen, parseFen } from 'chessops/fen';
import { parsePgn } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { makeUci, parseSquare } from 'chessops/util';

// The board is up to 600px tall and sits below the page header; the default
// 720px-tall viewport clips its bottom rank off-screen, which makes back-rank
// piece moves (e.g. Ng1-f3) impossible to click. Give it room.
test.use({ viewport: { width: 1280, height: 1040 } });

/**
 * Reproduction harness for issue #60 — "Drill gets stuck after playing the
 * move the arrow indicates."
 *
 * The reported symptom: you play the suggested move, the arrow re-appears, the
 * board doesn't advance, and the session freezes (it's the opponent's turn, so
 * nothing is clickable) until you restart the drill.
 *
 * CONFIRMED ROOT CAUSE (reproduced by this test). When a line-walk's Learn pass
 * finishes and the walk needs a Train pass, `advanceQueue` forces `phase` back
 * to `'pending'` and resets `idx = flatWalkStarts[currentWalk]`. If that reset
 * lands on the same card the user just answered, `currentEntry` keeps its
 * identity, so the card-lifecycle `$effect` (which calls `startCard` to reset
 * `currentFen` / `correctEdges`) never re-runs. The drill is left with
 * `phase === 'pending'` while `currentFen` is still the *post-user-move*
 * position (opponent to move) and `correctEdges` still holds the move just
 * played. Result: `movableColor` is the user's colour but every legal dest
 * belongs to the opponent → no piece is movable, and the stale hint arrow
 * re-appears. Only a remount ("restart the drill") clears it. Because the
 * Learn→Train transition fires on essentially every drill, it hits "most of
 * the time," as reported.
 *
 * The existing drill e2e deliberately stops *before* simulating a move
 * ("fragile to test via coordinates"), which is exactly why this shipped. This
 * test closes that gap: it plays real moves through chessground and asserts the
 * drill keeps advancing.
 *
 * How it drives moves without depending on the (sometimes-absent) hint arrow:
 * it derives the set of prepared White moves for every White-to-move position
 * straight from the imported PGN (`chessops`), then at each prompt it reads the
 * board placement from chessground's DOM (`piece.cgKey`) and plays the prepared
 * move for that exact placement. Freeze detection = after a correct move, the
 * drill must return to an interactive "Your move" prompt for a *new* position
 * (or a terminal screen) within a generous timeout; if it doesn't, and the
 * board is sitting on the position right after the user's own move, that is the
 * issue-60 freeze. The test FAILS while the bug is present and turns green once
 * it is fixed — i.e. it doubles as the regression guard.
 */

// A castling- and promotion-free mainline (12 White moves) with one White
// branch (Bb5 vs Bc4 at the 3rd move) so shared-prefix walk splitting and a
// multi-child decision point are both exercised. White moves are dragged by
// the test; Black replies are auto-played by the drill. No White castling, so
// every driven move is an unambiguous two-square click.
const PGN = `[Event "Issue 60 repro"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5 4. c3 Nf6) 3... a6 4. Ba4 Nf6
5. d3 d6 6. c3 g6 7. Nbd2 Bg7 8. Nf1 h6 9. Ng3 Nh7 10. h4 Qe7
11. Bc2 Nf8 12. d4 Bd7 *
`;

/**
 * Map every White-to-move position in the repertoire tree to a prepared White
 * move, keyed by FEN piece-placement (the first FEN field). Covers variation
 * tails too, so whatever order the drill surfaces cards in, the driver has a
 * legal prepared reply. At multi-child nodes we record the first child (the
 * "main" move — the one the user is told to play).
 */
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
	const file = sq.charCodeAt(0) - 97; // a..h -> 0..7
	const rank = sq.charCodeAt(1) - 49; // 1..8 -> 0..7
	const col = geom.whiteOrient ? file : 7 - file;
	const row = geom.whiteOrient ? 7 - rank : rank;
	return {
		x: geom.left + col * geom.size + geom.size / 2,
		y: geom.top + row * geom.size + geom.size / 2
	};
}

/**
 * Apply a White uci move to a piece-placement and return the resulting
 * placement (the question position is always White-to-move). Used to recognise
 * "the board is frozen on the position right after the user's own move."
 */
function applyWhiteUci(placement: string, uci: string): string | null {
	try {
		const chess = Chess.fromSetup(parseFen(`${placement} w - - 0 1`).unwrap()).unwrap();
		const from = parseSquare(uci.slice(0, 2));
		const to = parseSquare(uci.slice(2, 4));
		if (from === undefined || to === undefined) return null;
		const move = { from, to };
		if (!chess.isLegal(move)) return null;
		chess.play(move);
		return makeFen(chess.toSetup()).split(' ')[0];
	} catch {
		return null;
	}
}

/** Does `sq` (e.g. "g1") hold a piece in this FEN piece-placement string? */
function placementHas(placement: string, sq: string): boolean {
	const file = sq.charCodeAt(0) - 97;
	const rank = sq.charCodeAt(1) - 49; // 0 = rank 1
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

test('Drill keeps advancing after each correct move (issue #60)', async ({ page }) => {
	test.setTimeout(180_000);

	const table = buildWhiteMoveTable(PGN);
	expect(table.size, 'PGN should yield prepared White moves').toBeGreaterThan(5);

	// Import the repertoire as White.
	await page.goto('/import');
	await expect(page.getByRole('heading', { name: /bring a pgn/i })).toBeVisible();
	await page.getByLabel('Title').fill('Issue 60 repro');
	await page.getByLabel('PGN text').fill(PGN);
	await page.getByRole('button', { name: /^import$/i }).click();

	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	const repId = new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/)?.[1];
	expect(repId, 'repertoire id missing from URL').toBeTruthy();

	await page.goto(`/repertoire/${repId}/drill`);
	await expect(page.locator('.cg-wrap')).toBeVisible({ timeout: 15_000 });
	await page.locator('cg-board').scrollIntoViewIfNeeded();

	// Phase proxies. "Your move as <color>" shows only while phase === 'pending'
	// (the board is interactive). The terminal screens end the session cleanly.
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
				const key = el.cgKey;
				if (!key) continue;
				const [color, role] = (el.cgPiece || el.className).split(' ');
				let c = toChar[role];
				if (!c) continue;
				if (color === 'white') c = c.toUpperCase();
				grid[key] = c;
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

	type Phase = 'pending' | 'done' | 'idea' | 'empty' | 'timeout';
	const waitForPhase = async (deadlineMs: number): Promise<Phase> => {
		const start = Date.now();
		while (Date.now() - start < deadlineMs) {
			if (await sessionDone.isVisible()) return 'done';
			if (await caughtUp.isVisible()) return 'empty';
			if (await ideaPhase.isVisible()) return 'idea';
			if (await yourMove.isVisible()) return 'pending';
			await page.waitForTimeout(150);
		}
		return 'timeout';
	};

	// Progress = a terminal screen, or an interactive "Your move" prompt at a
	// White-to-move position we have a prepared move for. This is called only
	// after the move was confirmed to land on the board, so the board is on the
	// just-played (Black-to-move) position — which is NOT in the table. A healthy
	// drill leaves that position only by advancing to the next card OR (Train
	// pass / failed-walk drain) re-presenting the SAME card as a fresh, playable
	// White-to-move prompt; both put a table position back on the board. A frozen
	// drill sits on the Black-to-move position forever → this times out.
	const waitForProgress = async (deadlineMs: number): Promise<boolean> => {
		const start = Date.now();
		while (Date.now() - start < deadlineMs) {
			if (
				(await sessionDone.isVisible()) ||
				(await ideaPhase.isVisible()) ||
				(await caughtUp.isVisible())
			) {
				return true;
			}
			if (await yourMove.isVisible()) {
				const pl = await readPlacement();
				if (pl && table.has(pl)) return true;
			}
			await page.waitForTimeout(150);
		}
		return false;
	};

	const fail = async (message: string): Promise<never> => {
		const panel = await page
			.locator('aside')
			.first()
			.innerText()
			.catch(() => '(side panel unavailable)');
		const screenshot = 'test-results/drill-freeze-issue60.png';
		await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
		throw new Error(`${message}\n--- side panel ---\n${panel}\n--- screenshot: ${screenshot} ---`);
	};

	// Wait until the board placement is stable across two reads — the chain /
	// intro animation has finished and it's safe to read coordinates and play.
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

	const squareEmpty = async (sq: string): Promise<boolean> => {
		const pl = await readPlacement();
		return !pl || !placementHas(pl, sq);
	};

	// Drag the piece in one gesture (more robust than select-then-click, which
	// can race a board re-render between the two clicks).
	const dragMove = async (uci: string, geom: BoardGeom) => {
		const o = squareCenter(uci.slice(0, 2), geom);
		const d = squareCenter(uci.slice(2, 4), geom);
		await page.mouse.move(o.x, o.y);
		await page.mouse.down();
		await page.mouse.move((o.x + d.x) / 2, (o.y + d.y) / 2, { steps: 4 });
		await page.mouse.move(d.x, d.y, { steps: 4 });
		await page.mouse.up();
	};

	const MAX_MOVES = 80;
	let played = 0;
	// A card is legitimately drilled at most a few times in a row (Learn pass,
	// Train pass, a failed-walk drain); an unbounded re-presentation of the same
	// position is itself a bug. Guard so a regression can't masquerade as success.
	let lastPlacement: string | null = null;
	let repeats = 0;

	for (let i = 0; i < MAX_MOVES; i++) {
		const phase = await waitForPhase(15_000);
		if (phase === 'done' || phase === 'idea' || phase === 'empty') break;
		if (phase === 'timeout') {
			await fail(
				`FREEZE: drill never returned to a "Your move" prompt before move ${played + 1} ` +
					`(phase stranded off 'pending' — board frozen, exactly the issue-60 symptom).`
			);
		}

		await settle(3000);
		const placement = await readPlacement();
		expect(placement, 'could not read board placement').toBeTruthy();

		repeats = placement === lastPlacement ? repeats + 1 : 0;
		lastPlacement = placement;
		if (repeats >= 4) {
			await fail(
				`Drill re-presented the same position "${placement}" ${repeats + 1} times in a row ` +
					`(move ${played + 1}) — suspected re-presentation loop.`
			);
		}

		const uci = table.get(placement!);
		if (!uci) {
			await fail(
				`No prepared move for placement "${placement}" at move ${played + 1} — ` +
					`board and repertoire are out of sync (test setup issue, not the bug).`
			);
		}
		const origSq = uci!.slice(0, 2);

		// Drive the move, verifying chessground actually executed it (origin
		// square empties). Retry to rule out a synthetic-input miss; geometry is
		// re-read each attempt in case the layout shifted.
		let executed = false;
		for (let attempt = 0; attempt < 3 && !executed; attempt++) {
			const geom = await readGeom();
			expect(geom, 'could not read board geometry').toBeTruthy();
			await dragMove(uci!, geom!);
			const start = Date.now();
			while (Date.now() - start < 1500) {
				if (await squareEmpty(origSq)) {
					executed = true;
					break;
				}
				await page.waitForTimeout(100);
			}
			if (!executed) await page.waitForTimeout(250);
		}

		if (!executed) {
			// Ground truth: select the piece and count the legal-destination markers
			// chessground renders. 0 => the drill is offering this side no move here.
			const cur = await readPlacement();
			const geom = await readGeom();
			const c = squareCenter(origSq, geom!);
			await page.mouse.move(c.x, c.y);
			await page.mouse.down();
			await page.waitForTimeout(150);
			const moveDests = await page.evaluate(
				() => document.querySelector('cg-board')?.querySelectorAll('.move-dest').length ?? -1
			);
			await page.mouse.up();
			await fail(
				`The board never accepted the prepared move ${uci} (move ${played + 1}) after 3 ` +
					`attempts: origin ${origSq} stayed occupied, current placement "${cur}", ` +
					`legal destinations chessground offered for ${origSq}: ${moveDests}. ` +
					(moveDests === 0
						? 'The drill is offering no legal move here (turn/dests desync) — issue #60.'
						: 'A non-zero count means the harness mis-targeted the square, not an app freeze.')
			);
		}

		// The move landed on the board; now the drill must advance to the next
		// interactive prompt (or a terminal screen).
		const progressed = await waitForProgress(15_000);
		if (!progressed) {
			const cur = await readPlacement();
			const afterOwnMove = applyWhiteUci(placement!, uci!);
			const frozenOnOwnMove = cur != null && cur === afterOwnMove;
			await fail(
				`FREEZE after playing ${uci} (move ${played + 1}): the drill never returned to an ` +
					`interactive prompt for a new position. ` +
					(frozenOnOwnMove
						? `The board is sitting on the position immediately after the user's own move — ` +
							`the opponent never replied and no new card loaded — yet the panel still says ` +
							`"Your move as White". currentFen is the opponent's turn while phase is 'pending', ` +
							`so no White piece is movable and the just-played hint re-appears. This is issue #60.`
						: `Board placement is "${cur}" (expected to advance past "${placement}").`)
			);
		}
		played++;
	}

	// Sanity: we should have driven a meaningful number of moves (Learn pass +
	// at least into the Train pass) before the session ended cleanly.
	expect(
		played,
		'drill should advance through several correct moves without freezing'
	).toBeGreaterThanOrEqual(8);
});
