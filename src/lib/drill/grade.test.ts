import { describe, expect, it } from 'vitest';

import {
	gradeMove,
	gradeFromOpponentPov,
	shouldRefute,
	moveQualityLabel,
	moveQualityHeadline,
	nagGlyph,
	nagColor,
	type MoveQuality
} from './grade';

/**
 * `gradeMove` is the core change behind the refutation-playout
 * upgrade: cpLoss + absolute-eval context, not just absolute opponent
 * eval at fenAfter. The prior grader missed "you blew a winning
 * position" entirely (cpLoss huge but absolute eval at fenAfter
 * stayed small/positive in user-POV → opponent-POV stayed small/
 * negative → graded as `playable`, no playout).
 *
 * The cases below pin the expected category for each
 * (bestUserPov, playedUserPov) regime so that future tweaks to the
 * thresholds fail loudly with a recognisable diff.
 */

describe('gradeMove', () => {
	describe('negligible drops', () => {
		it('returns playable when cpLoss is below the floor', () => {
			expect(gradeMove(20, 18)).toBe('playable');
			expect(gradeMove(0, -10)).toBe('playable');
			expect(gradeMove(50, 30)).toBe('playable');
		});

		it('treats user-found-better moves as playable (cpLoss clamped to 0)', () => {
			// Engine prefers a different move; user's actual move is even
			// better than what engine recommends.
			expect(gradeMove(0, 250)).toBe('playable');
			expect(gradeMove(50, 300)).toBe('playable');
		});
	});

	describe('still-winning slips never escalate to blunder', () => {
		it('caps at mistake even when cpLoss is large', () => {
			// Was +500, played +250. cpLoss = 250 (would normally be
			// blunder). But user is still clearly winning, so cap at
			// mistake.
			expect(gradeMove(500, 250)).toBe('mistake');
			expect(gradeMove(800, 220)).toBe('mistake');
		});

		it('drops to dubious for medium cpLoss while still winning', () => {
			expect(gradeMove(400, 320)).toBe('dubious');
		});
	});

	describe('gave_advantage', () => {
		it('fires when winning → equal-ish with significant cpLoss', () => {
			// Was +500 (winning), played +30 (basically equal). cpLoss = 470.
			expect(gradeMove(500, 30)).toBe('gave_advantage');
		});

		it('fires when winning → slightly negative', () => {
			expect(gradeMove(300, -50)).toBe('gave_advantage');
		});

		it('escalates to blunder when winning → clearly losing', () => {
			// Crashing all the way past the losing threshold is too
			// severe for "gave_advantage" — call it a blunder.
			expect(gradeMove(500, -300)).toBe('blunder');
			expect(gradeMove(250, -250)).toBe('blunder');
		});
	});

	describe('blunder — fell into a losing position', () => {
		it('fires from balanced into clearly losing', () => {
			expect(gradeMove(20, -300)).toBe('blunder');
			expect(gradeMove(0, -500)).toBe('blunder');
		});

		it('fires from already-worse into much-worse with significant loss', () => {
			expect(gradeMove(-100, -400)).toBe('blunder');
		});
	});

	describe('missed_chance', () => {
		it('fires when best move would have given a clear edge', () => {
			// Best gives +150 (chance for advantage); user's move keeps
			// things at 0. cpLoss = 150.
			expect(gradeMove(150, 0)).toBe('missed_chance');
		});

		it('fires when best is a sizeable advantage and user dropped to slight worse', () => {
			expect(gradeMove(180, -30)).toBe('missed_chance');
		});

		it('does not fire when best was only a tiny edge', () => {
			// Best at +80 isn't a "chance for advantage" worth flagging —
			// it falls through to the generic cpLoss tier (cpLoss=110 →
			// mistake) without the missed_chance framing.
			expect(gradeMove(80, -30)).toBe('mistake');
		});
	});

	describe('generic cpLoss tiers', () => {
		it('returns dubious for small cpLoss in flat positions', () => {
			expect(gradeMove(20, -50)).toBe('dubious');
			expect(gradeMove(0, -60)).toBe('dubious');
		});

		it('returns mistake for medium cpLoss in flat positions', () => {
			// best=20 is below the missed_chance floor (100), so falls
			// through to generic tier.
			expect(gradeMove(20, -100)).toBe('mistake');
		});

		it('returns blunder for very large cpLoss when nothing else fits', () => {
			expect(gradeMove(0, -250)).toBe('blunder');
		});
	});
});

describe('gradeFromOpponentPov — fallback path', () => {
	// Mirrors the pre-PR-38 logic: positive value = good for whoever
	// is on move at fenAfter (= opponent) = bad for the user.
	it('grades by absolute magnitude when only fenAfter eval is known', () => {
		expect(gradeFromOpponentPov(250)).toBe('blunder');
		expect(gradeFromOpponentPov(150)).toBe('mistake');
		expect(gradeFromOpponentPov(70)).toBe('dubious');
		expect(gradeFromOpponentPov(20)).toBe('playable');
		expect(gradeFromOpponentPov(-100)).toBe('playable');
	});
});

describe('shouldRefute', () => {
	it('triggers playout for cpLoss-significant categories', () => {
		expect(shouldRefute('blunder')).toBe(true);
		expect(shouldRefute('mistake')).toBe(true);
		expect(shouldRefute('gave_advantage')).toBe(true);
		expect(shouldRefute('missed_chance')).toBe(true);
	});

	it('skips playout for low-severity categories', () => {
		expect(shouldRefute('correct')).toBe(false);
		expect(shouldRefute('playable')).toBe(false);
		expect(shouldRefute('dubious')).toBe(false);
	});
});

describe('label / glyph / color exhaustiveness', () => {
	const allCategories: MoveQuality[] = [
		'correct',
		'playable',
		'dubious',
		'missed_chance',
		'gave_advantage',
		'mistake',
		'blunder'
	];

	it('every category has a non-empty label', () => {
		for (const q of allCategories) {
			expect(moveQualityLabel(q)).toBeTruthy();
			expect(nagGlyph(q)).toBeTruthy();
			expect(nagColor(q)).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	it('every wrong-phase category has a headline (correct is intentionally empty)', () => {
		for (const q of allCategories) {
			if (q === 'correct') {
				expect(moveQualityHeadline(q)).toBe('');
			} else {
				expect(moveQualityHeadline(q)).toBeTruthy();
			}
		}
	});

	it('uses the agreed framing for new categories', () => {
		expect(moveQualityLabel('gave_advantage')).toBe('Gave away the advantage');
		expect(moveQualityLabel('missed_chance')).toBe('Missed a chance');
		expect(moveQualityHeadline('gave_advantage')).toMatch(/gives away your advantage/i);
		expect(moveQualityHeadline('missed_chance')).toMatch(/chance for an advantage/i);
	});
});
