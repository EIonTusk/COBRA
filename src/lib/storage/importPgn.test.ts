// Covers the additive PGN-merge helper used by /import, the Lichess study
// pull, and the in-repertoire "Import PGN" flow (issue #70): merging parsed
// lines into an EXISTING repertoire must add new moves, seed FSRS cards only
// for to-move positions that lack one, stay idempotent on re-import, and skip
// lines that start from a different position than the repertoire's root.
//
// Runs against a real IndexedDB (fake-indexeddb) so it exercises the actual
// addEdge / applyImportedNote transactions rather than stand-ins.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseRepertoirePgn } from '$lib/chess/pgn';
import { getDB } from './db';
import { createRepertoire } from './repertoires';
import { listNodes } from './nodes';
import { listCards } from './cards';
import { mergeLinesIntoRepertoire } from './importPgn';

async function wipe() {
	const db = await getDB();
	const tx = db.transaction(['repertoires', 'nodes', 'cards', 'idea_cards'], 'readwrite');
	await tx.objectStore('repertoires').clear();
	await tx.objectStore('nodes').clear();
	await tx.objectStore('cards').clear();
	await tx.objectStore('idea_cards').clear();
	await tx.done;
}

describe('mergeLinesIntoRepertoire', () => {
	beforeEach(wipe);

	it('adds new moves and seeds cards for the to-move side only', async () => {
		const rep = await createRepertoire('Italian', 'white');
		const lines = parseRepertoirePgn('1. e4 e5 2. Nf3 Nc6 3. Bc4');
		const res = await mergeLinesIntoRepertoire(rep.id, rep.color, rep.rootFenKey, lines);

		expect(res.importedLines).toBe(1);
		expect(res.skippedLines).toBe(0);
		// 5 plies → 5 new edges across the tree.
		expect(res.addedEdges).toBe(5);
		// White's turn at plies 1, 3, 5 (e4, Nf3, Bc4) → 3 cards.
		expect(res.addedCards).toBe(3);

		const cards = await listCards(rep.id);
		expect(cards.map((c) => c.expectedSan).sort()).toEqual(['Bc4', 'Nf3', 'e4']);
	});

	it('is idempotent: re-importing the same PGN adds nothing', async () => {
		const rep = await createRepertoire('Italian', 'white');
		const lines = parseRepertoirePgn('1. e4 e5 2. Nf3 Nc6 3. Bc4');
		await mergeLinesIntoRepertoire(rep.id, rep.color, rep.rootFenKey, lines);
		const again = await mergeLinesIntoRepertoire(rep.id, rep.color, rep.rootFenKey, lines);

		expect(again.addedEdges).toBe(0);
		expect(again.addedCards).toBe(0);
		expect(again.importedLines).toBe(1);
	});

	it('merges a fresh variation into an existing tree without duplicating shared moves', async () => {
		const rep = await createRepertoire('e4', 'white');
		await mergeLinesIntoRepertoire(
			rep.id,
			rep.color,
			rep.rootFenKey,
			parseRepertoirePgn('1. e4 e5 2. Nf3')
		);
		// Shares 1.e4 with the first line; adds the 1...c5 Sicilian branch.
		const res = await mergeLinesIntoRepertoire(
			rep.id,
			rep.color,
			rep.rootFenKey,
			parseRepertoirePgn('1. e4 c5 2. Nf3')
		);

		// 1.e4 already exists; only 1...c5 and 2.Nf3 (from the new position) are new.
		expect(res.addedEdges).toBe(2);
		// The root node should now have both e4 (shared) — still one edge — and
		// the tree should contain the Sicilian position.
		const nodes = await listNodes(rep.id);
		const root = nodes.find((n) => n.fenKey === rep.rootFenKey)!;
		expect(root.children).toHaveLength(1); // only 1.e4 leaves the root
		expect(root.children[0].san).toBe('e4');
	});

	it('skips lines that start from a different position than the root', async () => {
		const rep = await createRepertoire('Standard start', 'white');
		// A PGN whose game begins from a custom FEN (not the standard start).
		const customStart =
			'[FEN "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"]\n\n1. Nf3 Nc6';
		const lines = parseRepertoirePgn(customStart);
		const res = await mergeLinesIntoRepertoire(rep.id, rep.color, rep.rootFenKey, lines);

		expect(res.importedLines).toBe(0);
		expect(res.skippedLines).toBe(1);
		expect(res.addedEdges).toBe(0);
	});
});
