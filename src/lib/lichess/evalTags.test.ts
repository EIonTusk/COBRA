import { describe, expect, it } from 'vitest';
import { parseEvalComments } from './evalTags';

describe('parseEvalComments', () => {
	it('extracts centipawn evals from a short game', () => {
		const pgn =
			'[Event "Test"]\n\n1. e4 { [%eval 0.34] [%clk 0:01:00] } e5 { [%eval 0.31] } 2. Nf3 *';
		const evals = parseEvalComments(pgn);
		expect(evals).toEqual([{ cp: 34 }, { cp: 31 }, null]);
	});

	it('handles mate scores', () => {
		const pgn = '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6?? 4. Qxf7# { [%eval #3] } 1-0';
		const evals = parseEvalComments(pgn);
		// Only the last ply is tagged in this fixture; others are null.
		expect(evals).toHaveLength(7);
		expect(evals[6]).toEqual({ mate: 3 });
	});

	it('handles negative-mate (black mates)', () => {
		const pgn = '1. f3 e5 2. g4?? Qh4# { [%eval #-1] } 0-1';
		const evals = parseEvalComments(pgn);
		expect(evals[3]).toEqual({ mate: -1 });
	});

	it('returns null for plies without an [%eval] tag', () => {
		const pgn = '1. e4 { [%clk 0:05:00] } e5 *';
		const evals = parseEvalComments(pgn);
		expect(evals).toEqual([null, null]);
	});

	it('skips parenthesised variations, keeps mainline evals', () => {
		const pgn =
			'1. e4 { [%eval 0.3] } e5 (1... c5 { [%eval 0.4] } 2. Nf3) 2. Nf3 { [%eval 0.25] } *';
		const evals = parseEvalComments(pgn);
		// Three mainline plies: e4, e5, Nf3. e5 has no comment of its own.
		expect(evals).toEqual([{ cp: 30 }, null, { cp: 25 }]);
	});

	it('stops cleanly on a game result token', () => {
		const pgn = '1. e4 { [%eval 0.3] } e5 { [%eval 0.28] } 1/2-1/2';
		const evals = parseEvalComments(pgn);
		expect(evals).toEqual([{ cp: 30 }, { cp: 28 }]);
	});

	it('rounds fractional pawn values to centipawns', () => {
		const pgn = '1. e4 { [%eval 1.235] } 1-0';
		const evals = parseEvalComments(pgn);
		expect(evals[0]).toEqual({ cp: 124 });
	});

	it('returns an empty array for a headerless PGN with no moves', () => {
		expect(parseEvalComments('')).toEqual([]);
		expect(parseEvalComments('*')).toEqual([]);
	});
});
