import { describe, expect, it } from 'vitest';

import { cpToWinProb, stmPovToUserPov, wpLoss } from './sota';

describe('stmPovToUserPov', () => {
	// Engine output is documented as side-to-move POV: positive cp = good
	// for whoever is on move at the analysed FEN. The dossier wants
	// user-POV: positive = good for the user being scored. The conversion
	// is "flip the sign when STM and the user disagree on colour."
	it('returns the score unchanged when STM is the user', () => {
		expect(stmPovToUserPov(50, 'white', 'white')).toBe(50);
		expect(stmPovToUserPov(-50, 'white', 'white')).toBe(-50);
		expect(stmPovToUserPov(50, 'black', 'black')).toBe(50);
		expect(stmPovToUserPov(-50, 'black', 'black')).toBe(-50);
	});

	it('negates the score when STM is the opponent', () => {
		expect(stmPovToUserPov(50, 'black', 'white')).toBe(-50);
		expect(stmPovToUserPov(-50, 'black', 'white')).toBe(50);
		expect(stmPovToUserPov(50, 'white', 'black')).toBe(-50);
		expect(stmPovToUserPov(-50, 'white', 'black')).toBe(50);
	});

	it('zero is invariant under any conversion', () => {
		expect(stmPovToUserPov(0, 'white', 'white')).toBe(0);
		expect(stmPovToUserPov(0, 'black', 'white')).toBe(-0);
		expect(stmPovToUserPov(0, 'white', 'black')).toBe(-0);
	});

	// The motivating bug: dossier scoring evaluates `before` (user to
	// move) and `after` (opponent to move) for each user move, then
	// computes `cpLoss = userPov(before) - userPov(after)`. With the old
	// `* sign` math (sign keyed on user colour, not on STM at the FEN),
	// `before` was correct but `after` was inverted, so a normal small-
	// gain move at a balanced position got scored as a chunky inaccuracy.
	// These cases pin down the "before / after" pairing under the new
	// helper so the regression can't come back silently.
	it('paired before/after conversion produces a sane cpLoss for a normal user-white move', () => {
		// Position before: white to move (user), engine says +20 (white POV
		// = STM POV here). After a non-blundering move, position has black
		// to move; user-POV after is +18, so engine emits -18 in black-POV.
		const beforeUser = stmPovToUserPov(20, 'white', 'white'); // +20
		const afterUser = stmPovToUserPov(-18, 'black', 'white'); // +18
		const cpLoss = Math.max(0, beforeUser - afterUser);
		expect(cpLoss).toBe(2);
	});

	it('paired before/after conversion produces a sane cpLoss for a normal user-black move', () => {
		// Position before: black to move (user), engine says +20 (black POV
		// = STM POV here, so user-POV directly). After: white to move; user
		// (black) is +18 user-POV, so engine emits -18 in white-POV.
		const beforeUser = stmPovToUserPov(20, 'black', 'black'); // +20
		const afterUser = stmPovToUserPov(-18, 'white', 'black'); // +18
		const cpLoss = Math.max(0, beforeUser - afterUser);
		expect(cpLoss).toBe(2);
	});

	it('paired before/after conversion catches a real user-white blunder', () => {
		// Before: user-white, +200 (winning). After (black to move): user
		// is now -300 (losing), so engine emits +300 in black-POV.
		const beforeUser = stmPovToUserPov(200, 'white', 'white'); // +200
		const afterUser = stmPovToUserPov(300, 'black', 'white'); // -300
		const cpLoss = Math.max(0, beforeUser - afterUser);
		expect(cpLoss).toBe(500);
	});

	it('paired before/after conversion catches a real user-black blunder', () => {
		// Before: user-black, +200 user-POV. STM=black=user → engine emits +200.
		// After (white to move, opponent's turn): user-POV -300 →
		// white-POV/STM-POV +300 → engine emits +300.
		const beforeUser = stmPovToUserPov(200, 'black', 'black'); // +200
		const afterUser = stmPovToUserPov(300, 'white', 'black'); // -300
		const cpLoss = Math.max(0, beforeUser - afterUser);
		expect(cpLoss).toBe(500);
	});
});

describe('cpToWinProb', () => {
	// The sigmoid is symmetric around 0: cpToWinProb(+X) + cpToWinProb(-X) = 100.
	it('is symmetric around 0', () => {
		for (const cp of [25, 100, 300, 1500]) {
			expect(cpToWinProb(cp) + cpToWinProb(-cp)).toBeCloseTo(100, 5);
		}
	});

	it('returns 50 at cp=0', () => {
		expect(cpToWinProb(0)).toBe(50);
	});

	it('clamps mate-scale inputs', () => {
		// Past ±MATE_WP_CP the value should pin near 0 / 100.
		expect(cpToWinProb(99999)).toBeCloseTo(cpToWinProb(1500), 5);
		expect(cpToWinProb(-99999)).toBeCloseTo(cpToWinProb(-1500), 5);
	});
});

describe('wpLoss', () => {
	it('is zero for an unchanged position', () => {
		expect(wpLoss(20, 20)).toBe(0);
	});

	it('clamps to zero when the user IMPROVED their position', () => {
		// User-POV before +20, after +50 (got better). Loss is non-negative.
		expect(wpLoss(20, 50)).toBe(0);
	});

	it('produces a meaningful loss when the user got worse', () => {
		// +200 → -300 in user-POV is a real blunder; expect a substantial WP drop.
		const loss = wpLoss(200, -300);
		expect(loss).toBeGreaterThan(40);
	});
});
