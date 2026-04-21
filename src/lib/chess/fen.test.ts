import { describe, expect, it } from 'vitest';
import { Chess } from 'chessops/chess';
import { INITIAL_FEN, parseFen, makeFen } from 'chessops/fen';
import { parseSan, makeSanAndPlay } from 'chessops/san';

import { fenKeyFromFen, tryFenKey, colorToMove, STARTPOS_KEY } from './fen';

describe('fenKeyFromFen', () => {
	it('strips halfmove and fullmove counters', () => {
		const a = fenKeyFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
		const b = fenKeyFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 99 500');
		expect(a).toBe(b);
	});

	it('start position has a canonical key', () => {
		expect(STARTPOS_KEY).toBe(fenKeyFromFen(INITIAL_FEN));
	});

	it('merges transpositions (Italian via move order swap)', () => {
		const keyA = fenKeyFromFen(playLine(INITIAL_FEN, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']));
		const keyB = fenKeyFromFen(playLine(INITIAL_FEN, ['Nf3', 'Nc6', 'e4', 'e5', 'Bc4']));
		expect(keyA).toBe(keyB);
	});

	it('rejects invalid fen via tryFenKey', () => {
		expect(tryFenKey('not a fen')).toBeNull();
		expect(tryFenKey('8/8/8/8/8/8/8/8 w - - 0 1')).toBeNull();
	});

	it('colorToMove reads side from fen key', () => {
		expect(colorToMove(STARTPOS_KEY)).toBe('white');
		const afterE4 = fenKeyFromFen(playLine(INITIAL_FEN, ['e4']));
		expect(colorToMove(afterE4)).toBe('black');
	});
});

function playLine(startFen: string, sans: string[]): string {
	const pos = Chess.fromSetup(parseFen(startFen).unwrap()).unwrap();
	for (const san of sans) {
		const move = parseSan(pos, san);
		if (!move) throw new Error(`illegal san: ${san} in ${makeFen(pos.toSetup())}`);
		makeSanAndPlay(pos, move);
	}
	return makeFen(pos.toSetup());
}
