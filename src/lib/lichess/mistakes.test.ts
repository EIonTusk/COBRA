import { describe, expect, it } from 'vitest';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen, INITIAL_FEN } from 'chessops/fen';
import { parseSan, makeSanAndPlay } from 'chessops/san';

import { analyzeGame, detectMistake, type CandidateRep } from './mistakes';
import type { LichessGameMeta } from './games';
import type { RepertoireNode, Color } from '$lib/types';

/**
 * Build a CandidateRep by walking a list of move-lines in SAN. The first move
 * of each line becomes the canonical edge (`children[0]`), so the scanner
 * reports that as `expectedSan` when the user deviates.
 */
function buildRep(id: string, name: string, color: Color, lines: string[][]): CandidateRep {
	const nodes = new Map<string, RepertoireNode>();
	const ensure = (fenKey: string): RepertoireNode => {
		let n = nodes.get(fenKey);
		if (!n) {
			n = { repertoireId: id, fenKey, children: [] };
			nodes.set(fenKey, n);
		}
		return n;
	};
	for (const line of lines) {
		const pos = Chess.fromSetup(parseFen(INITIAL_FEN).unwrap()).unwrap();
		let fenKey = makeFen(pos.toSetup(), { epd: true });
		ensure(fenKey);
		for (const san of line) {
			const move = parseSan(pos, san);
			if (!move) throw new Error(`illegal SAN ${san}`);
			makeSanAndPlay(pos, move);
			const nextKey = makeFen(pos.toSetup(), { epd: true });
			const node = ensure(fenKey);
			if (!node.children.some((e) => e.san === san)) {
				// uci isn't exercised by the scanner — only san is matched.
				node.children.push({ san, uci: '', toFenKey: nextKey });
			}
			ensure(nextKey);
			fenKey = nextKey;
		}
	}
	const rootKey = makeFen(Chess.default().toSetup(), { epd: true });
	return { id, name, color, rootFenKey: rootKey, nodes };
}

function gameFromSans(
	id: string,
	sans: string[],
	whiteName: string,
	blackName: string
): LichessGameMeta {
	const movetext = sans
		.map((san, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${san}` : san))
		.join(' ');
	const pgn = `[White "${whiteName}"]\n[Black "${blackName}"]\n\n${movetext} *\n`;
	return {
		id,
		rated: true,
		variant: 'standard',
		speed: 'blitz',
		createdAt: 1_700_000_000_000,
		players: {
			white: { user: { name: whiteName } },
			black: { user: { name: blackName } }
		},
		pgn
	};
}

describe('mistake scanner', () => {
	it('flags a deviation and names the prepared move', () => {
		const rep = buildRep('rep-w', 'Italian', 'white', [
			['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3']
		]);
		// User (white) deviates at move 4: plays Bb5 (Ruy Lopez) instead of
		// prepared Bc4 (Italian).
		const game = gameFromSans('game-1', ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], 'hero', 'villain');
		const mistake = detectMistake(game, 'hero', [rep]);
		expect(mistake).not.toBeNull();
		expect(mistake!.playedSan).toBe('Bb5');
		expect(mistake!.expectedSan).toBe('Bc4');
		expect(mistake!.color).toBe('white');
		expect(mistake!.repertoireId).toBe('rep-w');
	});

	it('returns null when the user followed prep to the end of the game', () => {
		const rep = buildRep('rep-w', 'Italian', 'white', [['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']]);
		const game = gameFromSans('game-2', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], 'hero', 'villain');
		expect(detectMistake(game, 'hero', [rep])).toBeNull();
	});

	it('reports a gap when the opponent drives the user off-tree', () => {
		// White prep only has e4 → c5 → Nf3 → d6. The opponent plays e5 instead,
		// which isn't in the tree — prep ran out, no user mistake.
		const rep = buildRep('rep-w', 'Open Sicilian', 'white', [['e4', 'c5', 'Nf3', 'd6']]);
		const game = gameFromSans('game-3', ['e4', 'e5', 'Nf3', 'Nc6'], 'hero', 'villain');
		const result = analyzeGame(game, 'hero', [rep]);
		expect(result.mistake).toBeUndefined();
		expect(result.gap).toBeDefined();
		expect(result.gap!.repertoireId).toBe('rep-w');
		expect(result.gap!.plyOffTree).toBeGreaterThan(0);
	});

	it('only considers repertoires of the user colour', () => {
		const whiteRep = buildRep('rep-w', 'Italian', 'white', [['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']]);
		const blackRep = buildRep('rep-b', 'Caro-Kann', 'black', [['e4', 'c6']]);
		// User is black, plays non-Caro (1...e5). Only blackRep applies; whiteRep
		// should be filtered out by colour before any match logic runs.
		const game = gameFromSans('game-4', ['e4', 'e5'], 'villain', 'hero');
		const mistake = detectMistake(game, 'hero', [whiteRep, blackRep]);
		expect(mistake).not.toBeNull();
		expect(mistake!.repertoireId).toBe('rep-b');
		expect(mistake!.playedSan).toBe('e5');
		expect(mistake!.expectedSan).toBe('c6');
	});

	it('picks the best-fit rep (followed deepest) when several match colour', () => {
		const short = buildRep('short', 'Stub', 'white', [['d4']]);
		const long = buildRep('long', 'Mainline', 'white', [
			['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3']
		]);
		// User follows `long` through ply 5 then blunders Ng5 (wrong move) on
		// move 4. `short` goes off-book at move 1. Scanner should attribute to
		// `long` because the user followed it deeper.
		const game = gameFromSans('game-5', ['e4', 'e5', 'Nf3', 'Nc6', 'Ng5'], 'hero', 'villain');
		const mistake = detectMistake(game, 'hero', [short, long]);
		expect(mistake).not.toBeNull();
		expect(mistake!.repertoireId).toBe('long');
		expect(mistake!.playedSan).toBe('Ng5');
		expect(mistake!.expectedSan).toBe('Bc4');
	});

	it('returns null when the user is not in the game', () => {
		const rep = buildRep('rep-w', 'Italian', 'white', [['e4']]);
		const game = gameFromSans('game-6', ['e4', 'e5'], 'alice', 'bob');
		expect(detectMistake(game, 'someone-else', [rep])).toBeNull();
	});
});
