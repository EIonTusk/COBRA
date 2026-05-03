import { describe, expect, it } from 'vitest';

import { enginePairToUserPov } from './evalAxes';
import type { EngineInfo } from '$lib/stockfish/engine';
import { accuracyFromWpLoss, classifyByWpLoss, wpLoss } from './sota';

/**
 * Regression coverage for the PR #38 dossier-scoring fix.
 *
 * The fixed bug: `analyseEvalAxes` evaluates two positions per user
 * move — `fenBefore` (user to move) and `fenAfter` (opponent to move) —
 * and computes cpLoss from the difference. The old code applied a
 * single sign keyed on the user's colour, which only correctly
 * converted positions where the user was on move. The after-position
 * eval was silently inverted, doubling cpLoss on normal moves and
 * suppressing real blunders.
 *
 * These tests exercise `enginePairToUserPov` with hand-crafted
 * EngineInfo readings for a tiny synthetic "game" — three moves each
 * for a white-playing user and a black-playing user — and assert the
 * resulting cpLoss / move-quality numbers match what the same
 * positions would produce if scored by a human. Anything that
 * silently re-introduces a sign flip would shift several of these
 * expectations by ~2× the position eval.
 */

const cp = (n: number): EngineInfo => ({ depth: 14, scoreCp: n, pv: ['a1a1'] });
const mate = (n: number): EngineInfo => ({ depth: 14, scoreMate: n, pv: ['a1a1'] });

/**
 * One synthetic move in the mini-game. `beforeUser` / `afterUser` are
 * the *true* user-POV evals at the two positions. The test then derives
 * the engine's STM-POV reading (negating when the side at that FEN is
 * not the user) and feeds it through `enginePairToUserPov`. If the
 * helper is correct, what comes back must match `beforeUser` /
 * `afterUser` exactly.
 */
interface MiniMove {
	label: string;
	/** True user-POV cp at the position before the user moved. */
	beforeUser: number;
	/** True user-POV cp at the position after the user moved. */
	afterUser: number;
	/** Expected non-negative cpLoss = max(0, beforeUser - afterUser). */
	expectedCpLoss: number;
}

function runMiniGame(userColor: 'white' | 'black', moves: MiniMove[]) {
	const stmAfter: 'white' | 'black' = userColor === 'white' ? 'black' : 'white';
	return moves.map((m) => {
		// Engine emits in STM-POV. At `before` STM = user, so user-POV value
		// IS the STM-POV value. At `after` STM = opponent, so STM-POV value
		// is the negation of user-POV.
		const beforeStm = m.beforeUser; // STM = user
		const afterStm = -m.afterUser; // STM = opponent
		void stmAfter;
		const out = enginePairToUserPov(cp(beforeStm), cp(afterStm), userColor);
		return { label: m.label, expected: m, actual: out };
	});
}

describe('enginePairToUserPov — mini-game regression', () => {
	// Three moves an Italian-Game-ish white player might make. Pinned
	// numbers below are what the helper SHOULD produce; if the engine
	// pair gets misinterpreted (e.g. the after-position eval gets
	// inverted as in the pre-PR-38 code), the assertions below will
	// fail by margins of 2× the position eval magnitude.
	const whiteUserGame: MiniMove[] = [
		// Solid opening move at a balanced position — should score near zero.
		{ label: 'normal move on balanced board', beforeUser: 25, afterUser: 22, expectedCpLoss: 3 },
		// Slight inaccuracy — drops ~80cp.
		{ label: 'modest inaccuracy', beforeUser: 30, afterUser: -50, expectedCpLoss: 80 },
		// Real blunder — winning to losing.
		{ label: 'real blunder', beforeUser: 200, afterUser: -300, expectedCpLoss: 500 }
	];

	// Same shape, mirrored — a black player. Pre-fix code mishandled
	// black-user games even more badly than white-user games because
	// the sign math compounded across before AND after positions.
	const blackUserGame: MiniMove[] = [
		{ label: 'normal move on balanced board', beforeUser: 30, afterUser: 28, expectedCpLoss: 2 },
		{ label: 'modest inaccuracy', beforeUser: 40, afterUser: -45, expectedCpLoss: 85 },
		{ label: 'real blunder', beforeUser: 180, afterUser: -320, expectedCpLoss: 500 }
	];

	for (const user of ['white', 'black'] as const) {
		const game = user === 'white' ? whiteUserGame : blackUserGame;
		describe(`user is ${user}`, () => {
			const results = runMiniGame(user, game);
			for (const { label, expected, actual } of results) {
				it(`${label}: cpLoss = ${expected.expectedCpLoss}`, () => {
					expect(actual.cpLoss).toBe(expected.expectedCpLoss);
					expect(actual.userEvalBeforeCp).toBe(expected.beforeUser);
					expect(actual.userEvalAfterCp).toBe(expected.afterUser);
				});
			}

			// Aggregate sanity — the kind of dashboard number that shifts
			// most visibly when the bug is present. A correctly-scored mini
			// game has ONE blunder; a buggy one tends to misclassify either
			// the normal move (false positive) or the blunder (demoted to
			// mistake) depending on direction.
			it('classifies blunders correctly across the mini-game', () => {
				const qualities = results.map((r) =>
					classifyByWpLoss(wpLoss(r.actual.userEvalBeforeCp, r.actual.userEvalAfterCp))
				);
				expect(qualities.filter((q) => q === 'blunder').length).toBe(1);
				// And the average accuracy lands well above 0; pre-fix this
				// was depressed by ~30 points because the normal move got
				// flagged as inaccuracy.
				const avgAccuracy =
					results
						.map((r) =>
							accuracyFromWpLoss(wpLoss(r.actual.userEvalBeforeCp, r.actual.userEvalAfterCp))
						)
						.reduce((a, b) => a + b, 0) / results.length;
				expect(avgAccuracy).toBeGreaterThan(60);
			});
		});
	}
});

describe('enginePairToUserPov — mate scores', () => {
	// Mate scores must clamp to ±MATE_CP (1500) before flipping. Test the
	// four corner cases (user white/black × mate before/after).
	it('user-white mating from a winning position', () => {
		// User-POV before: +mate (white mates). After: still mate.
		const before = mate(3);
		const after = mate(-2); // STM at after = black, "black mate in 2" = good for white
		const out = enginePairToUserPov(before, after, 'white');
		expect(out.userEvalBeforeCp).toBe(1500);
		expect(out.userEvalAfterCp).toBe(1500);
		expect(out.cpLoss).toBe(0);
	});

	it('user-black walking into mate is a max blunder', () => {
		// User-POV before: equal-ish (engine STM = black emits 0).
		// User-POV after: white-mates → user-POV -1500. Engine at fenAfter
		// (STM = white) emits +mate → +1500 in white-POV/STM-POV.
		const before = cp(0);
		const after = mate(2); // white mates in 2
		const out = enginePairToUserPov(before, after, 'black');
		expect(out.userEvalBeforeCp).toBe(0);
		expect(out.userEvalAfterCp).toBe(-1500);
		expect(out.cpLoss).toBe(1500);
	});
});
