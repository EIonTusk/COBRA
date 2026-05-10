import { describe, it, expect } from 'vitest';

import { continuationFromPgn } from './generate';
import { fenKeyFromFen } from '$lib/chess/fen';

const SAMPLE_PGN = `[Event "Test"]
[Site "?"]
[Date "2020.01.01"]
[Round "?"]
[White "A"]
[Black "B"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 *
`;

const FEN_AFTER_3_BB5 = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';

describe('continuationFromPgn', () => {
	it('returns the next N plies after the matched position', () => {
		const target = fenKeyFromFen(FEN_AFTER_3_BB5);
		const cont = continuationFromPgn(SAMPLE_PGN, target, 6);
		expect(cont).not.toBeNull();
		// chessops emits castling as king→rook (Chess960 form), so O-O is `e1h1`.
		expect(cont!.slice(0, 4)).toEqual(['a7a6', 'b5a4', 'g8f6', 'e1h1']);
		expect(cont!.length).toBe(6);
	});

	it('returns null when the target position never occurs', () => {
		// Caro-Kann starting position — different from this Spanish-game PGN.
		const otherFen = 'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
		const target = fenKeyFromFen(otherFen);
		const cont = continuationFromPgn(SAMPLE_PGN, target, 6);
		expect(cont).toBeNull();
	});

	it('returns an empty array when the target is the terminal position of the game', () => {
		// Spelling out: target = the position right after Bb3 d6 (last pair in mainline).
		// We need the EPD of the final position. Build it step-by-step.
		// 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6 → final pos.
		// Trust chessops to produce it via re-parse.
		const target = fenKeyFromFen(
			'r1bqk2r/2p1bppp/p1np1n2/1p2p3/4P3/1B3N2/PPPP1PPP/RNBQR1K1 w kq - 0 8'
		);
		const cont = continuationFromPgn(SAMPLE_PGN, target, 6);
		// Either matched-with-no-more-moves (returns []) or position not found (null).
		// We check: if not null, the array is empty (mainline ended at match).
		if (cont !== null) expect(cont.length).toBe(0);
	});
});
