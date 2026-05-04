import { describe, expect, it } from 'vitest';
import { describeGameEnd } from './endState';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// "Fool's mate" — Black mates on move 2.
const FOOLS_MATE_FEN = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
// Stalemate from a known ending: White king h1, pawn h2; Black king f2, queen g2.
// Wait — let's use a textbook stalemate position. White: Kh1; Black: Kf2, Qg3. White to move, no legal moves, not in check.
const STALEMATE_FEN = '7k/8/8/8/8/8/5q2/7K w - - 0 1';
// Insufficient material: K+B vs K.
const KBVK_FEN = '8/8/8/8/3k4/8/4B3/4K3 w - - 50 80';

describe('describeGameEnd', () => {
	it('checkmate gets a winner-named headline', () => {
		const r = describeGameEnd({
			result: '0-1',
			whiteName: 'Alice',
			blackName: 'Bob',
			finalFen: FOOLS_MATE_FEN
		});
		expect(r.score).toBe('0–1');
		expect(r.tone).toBe('black');
		expect(r.headline).toMatch(/checkmate/i);
		expect(r.headline).toContain('Bob');
	});

	it('stalemate beats result-only fallback', () => {
		const r = describeGameEnd({ result: '1/2-1/2', finalFen: STALEMATE_FEN });
		expect(r.tone).toBe('draw');
		expect(r.headline).toMatch(/stalemate/i);
	});

	it('decisive without checkmate reads as resignation', () => {
		const r = describeGameEnd({
			result: '1-0',
			whiteName: 'Carlsen',
			blackName: 'Nepomniachtchi',
			finalFen: STARTPOS
		});
		expect(r.tone).toBe('white');
		expect(r.headline).toBe('Nepomniachtchi resigned.');
	});

	it('time forfeit overrides resignation default', () => {
		const r = describeGameEnd({
			result: '1-0',
			termination: 'Time forfeit',
			whiteName: 'A',
			blackName: 'B',
			finalFen: STARTPOS
		});
		expect(r.headline).toBe('B lost on time.');
	});

	it('insufficient material flagged on draws', () => {
		const r = describeGameEnd({ result: '1/2-1/2', finalFen: KBVK_FEN });
		expect(r.headline).toMatch(/insufficient material/i);
	});

	it('50-move rule flagged when halfmoves >= 100', () => {
		// K+R vs K+R — has sufficient material so the 50-move signal fires.
		const fen = '4k3/8/8/8/8/8/3r4/3RK3 w - - 100 50';
		const r = describeGameEnd({ result: '1/2-1/2', finalFen: fen });
		expect(r.headline).toMatch(/50-move/);
	});

	it('threefold repetition flagged when last position appears 3+ times', () => {
		const fen = '4k3/8/8/8/8/8/3r4/3RK3 w - - 0 1';
		const keys = ['a', 'b', 'a', 'c', 'a'];
		const r = describeGameEnd({
			result: '1/2-1/2',
			finalFen: fen,
			positionKeys: keys
		});
		expect(r.headline).toMatch(/threefold/i);
	});

	it('falls back to "Draw agreed" when no special signal fires', () => {
		const r = describeGameEnd({ result: '1/2-1/2', finalFen: STARTPOS });
		expect(r.headline).toBe('Draw agreed.');
	});

	it('unknown result yields generic complete text', () => {
		const r = describeGameEnd({ result: '*', finalFen: STARTPOS });
		expect(r.tone).toBe('unknown');
		expect(r.headline).toBe('Game complete.');
	});

	it('handles missing finalFen gracefully', () => {
		const r = describeGameEnd({ result: '1-0', whiteName: 'X', blackName: 'Y' });
		expect(r.headline).toBe('Y resigned.');
	});
});
