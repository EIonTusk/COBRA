import { describe, expect, it } from 'vitest';

import { freezeEvalAxesState, thawEvalAxesState, type EvalAxesPersistedState } from './evalAxes';

/**
 * Exercise the freeze/thaw round-trip used by the scan-checkpoint path.
 * The state struct mixes plain fields with a Map (perGameAcc) — without
 * the explicit converters IDB's structured-clone path either rejects the
 * Map or produces a value that breaks `.get()`. These tests pin down the
 * conversion contract so a regression is caught before it corrupts a
 * resumed scan.
 */
describe('evalAxes state serialisation', () => {
	const persisted: EvalAxesPersistedState = {
		cpSum: 1234,
		wpSumAll: 12.5,
		accSumAll: 8800,
		blunders: 3,
		inaccuracies: 7,
		volatileMoves: 11,
		movesSkippedSan: 1,
		movesSkippedEngine: 0,
		movesSkippedNoScore: 2,
		movesSkippedBook: 4,
		movesFromLichess: 30,
		movesFromLocal: 70,
		firstError: 'sample error message',
		phaseAcc: {
			opening: { sum: 100, n: 10, blunders: 0, inaccuracies: 1, wpSum: 1.5, accSum: 950 },
			middle: { sum: 600, n: 50, blunders: 2, inaccuracies: 4, wpSum: 8.0, accSum: 4400 },
			end: { sum: 534, n: 40, blunders: 1, inaccuracies: 2, wpSum: 3.0, accSum: 3450 }
		},
		phaseColorAcc: {
			opening: {
				white: { sum: 60, n: 6, blunders: 0, inaccuracies: 0, wpSum: 1.0, accSum: 580 },
				black: { sum: 40, n: 4, blunders: 0, inaccuracies: 1, wpSum: 0.5, accSum: 370 }
			},
			middle: {
				white: { sum: 300, n: 25, blunders: 1, inaccuracies: 2, wpSum: 4.0, accSum: 2200 },
				black: { sum: 300, n: 25, blunders: 1, inaccuracies: 2, wpSum: 4.0, accSum: 2200 }
			},
			end: {
				white: { sum: 234, n: 18, blunders: 0, inaccuracies: 1, wpSum: 1.5, accSum: 1530 },
				black: { sum: 300, n: 22, blunders: 1, inaccuracies: 1, wpSum: 1.5, accSum: 1920 }
			}
		},
		perGameAcc: [
			['game-a', { sum: 240, n: 18, accSum: 1700 }],
			['game-b', { sum: 180, n: 22, accSum: 2100 }]
		],
		moveResults: []
	};

	it('thaws and freezes back to a structurally-equal snapshot', () => {
		const runtime = thawEvalAxesState(persisted);
		const round = freezeEvalAxesState(runtime);
		expect(round).toEqual(persisted);
	});

	it('survives a JSON round-trip of the persisted form', () => {
		// Mirrors what IDB does under the hood: a structured-clone equivalent
		// for plain data. If a future field gets a Map / Set / Date introduced
		// without a corresponding converter, this catches it.
		const json = JSON.parse(JSON.stringify(persisted)) as EvalAxesPersistedState;
		const runtime = thawEvalAxesState(json);
		expect(runtime.perGameAcc.get('game-a')).toEqual({ sum: 240, n: 18, accSum: 1700 });
		expect(runtime.perGameAcc.get('game-b')).toEqual({ sum: 180, n: 22, accSum: 2100 });
		expect(runtime.cpSum).toBe(1234);
		expect(runtime.firstError).toBe('sample error message');
	});

	it('rebuilds the perGameAcc Map with working get/set semantics', () => {
		const runtime = thawEvalAxesState(persisted);
		runtime.perGameAcc.set('game-c', { sum: 0, n: 0, accSum: 0 });
		const frozen = freezeEvalAxesState(runtime);
		const ids = frozen.perGameAcc.map(([id]) => id);
		expect(ids).toContain('game-a');
		expect(ids).toContain('game-b');
		expect(ids).toContain('game-c');
	});
});
