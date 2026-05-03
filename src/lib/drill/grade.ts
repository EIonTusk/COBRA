/**
 * Drill / walkthrough move-quality grading.
 *
 * The drill flow probes Stockfish at two positions per wrong move —
 * `fenBefore` (where the user was about to move) and `fenAfter` (the
 * position they reached). With the engine's STM-POV cp at both, we
 * derive user-POV evals (`bestUserPov`, `playedUserPov`) and grade by
 * cpLoss + absolute-eval context. That lets us distinguish:
 *
 *  - `gave_advantage` — the user was clearly winning, then this move
 *    squandered it. Reads as "you gave away the advantage."
 *  - `missed_chance` — the position offered a meaningful chance for
 *    advantage; the user's move didn't take it.
 *  - `blunder` / `mistake` — the older absolute-magnitude tiers, kept
 *    for "fell into a clearly losing position" / "generic significant
 *    slip" cases that don't carry the advantage-narrative framing.
 *
 * The pre-PR-38 grade looked at the absolute opponent-POV eval at
 * `fenAfter` only; it missed the case where the user blew a winning
 * position into a roughly-equal one (the absolute eval at fenAfter
 * stays small even though cpLoss is huge). cpLoss-based grading fixes
 * that and powers the refutation playout for those cases too.
 */

export type MoveQuality =
	| 'correct'
	| 'playable'
	| 'dubious'
	| 'missed_chance'
	| 'gave_advantage'
	| 'mistake'
	| 'blunder';

const PLAYABLE_MAX_CPLOSS = 30;
const DUBIOUS_MIN_CPLOSS = 50;
const MISTAKE_MIN_CPLOSS = 100;
const BLUNDER_MIN_CPLOSS = 200;
/** Absolute-eval boundary for "clearly winning" / "clearly losing". */
const WINNING_THRESHOLD = 200;
const LOSING_THRESHOLD = -200;

/**
 * Grade a wrong move from user-POV eval pair.
 *
 * - `bestUserPov` — the engine's evaluation at `fenBefore` (which is
 *   the eval after the engine's recommended move, by minimax).
 * - `playedUserPov` — the engine's evaluation at `fenAfter`,
 *   negated to land in user-POV (since STM at fenAfter is the
 *   opponent).
 *
 * Both numbers are in centipawns from the user's perspective:
 * positive = good for the user.
 */
export function gradeMove(bestUserPov: number, playedUserPov: number): MoveQuality {
	const cpLoss = Math.max(0, bestUserPov - playedUserPov);

	// Negligible drop — engine considers the user's choice ~equivalent
	// to its own pick. Keep it `playable` even if the rep doesn't list
	// it.
	if (cpLoss < PLAYABLE_MAX_CPLOSS) return 'playable';

	// The user's actual move keeps them clearly winning. A "blunder"
	// label here would be misleading even when cpLoss is large —
	// they're still ahead, just not by as much as the best line. Cap
	// at `mistake`.
	if (playedUserPov >= WINNING_THRESHOLD) {
		if (cpLoss >= MISTAKE_MIN_CPLOSS) return 'mistake';
		if (cpLoss >= DUBIOUS_MIN_CPLOSS) return 'dubious';
		return 'playable';
	}

	// Was clearly winning, now no longer.
	if (bestUserPov >= WINNING_THRESHOLD && cpLoss >= MISTAKE_MIN_CPLOSS) {
		// If the swing crashed all the way into a clearly losing
		// position, that's a blunder, not a "gave away" — the framing
		// matters and "blunder" is the harsher / more accurate read.
		return playedUserPov < LOSING_THRESHOLD ? 'blunder' : 'gave_advantage';
	}

	// Fell into a clearly losing position from a non-winning starting
	// point (already balanced or already worse and got worse).
	if (playedUserPov < LOSING_THRESHOLD && cpLoss >= MISTAKE_MIN_CPLOSS) {
		return 'blunder';
	}

	// The position offered a meaningful chance for advantage and the
	// user didn't take it. `bestUserPov >= MISTAKE_MIN_CPLOSS` means
	// the engine's pick gives a real edge (≥1 pawn), and the user's
	// cpLoss was significant — they walked past a win.
	if (bestUserPov >= MISTAKE_MIN_CPLOSS && cpLoss >= MISTAKE_MIN_CPLOSS) {
		return 'missed_chance';
	}

	// Generic cpLoss buckets for everything that didn't fit above.
	if (cpLoss >= BLUNDER_MIN_CPLOSS) return 'blunder';
	if (cpLoss >= MISTAKE_MIN_CPLOSS) return 'mistake';
	if (cpLoss >= DUBIOUS_MIN_CPLOSS) return 'dubious';
	return 'playable';
}

/**
 * Fallback grader when only the post-move eval is available (engine
 * probe at `fenBefore` failed). Mirrors the pre-PR-38 thresholds: the
 * input is STM-POV cp at fenAfter — i.e. opponent-POV — so positive =
 * bad for the user.
 *
 * This is strictly weaker than `gradeMove`: it can't distinguish "blew
 * a winning position into equality" (cpLoss huge, absolute eval at
 * fenAfter small) from "played a fine move." Used only on degraded
 * paths where probing fenBefore returned nothing.
 */
export function gradeFromOpponentPov(opponentPovCp: number): MoveQuality {
	if (opponentPovCp >= BLUNDER_MIN_CPLOSS) return 'blunder';
	if (opponentPovCp >= MISTAKE_MIN_CPLOSS) return 'mistake';
	if (opponentPovCp >= DUBIOUS_MIN_CPLOSS) return 'dubious';
	return 'playable';
}

/** Categories that warrant playing out the engine's refutation line. */
export function shouldRefute(q: MoveQuality): boolean {
	return q === 'blunder' || q === 'mistake' || q === 'gave_advantage' || q === 'missed_chance';
}

export function nagGlyph(q: MoveQuality): string {
	switch (q) {
		case 'correct':
			return '!';
		case 'playable':
			return '!?';
		case 'dubious':
			return '?!';
		case 'missed_chance':
			return '?!';
		case 'gave_advantage':
			return '?';
		case 'mistake':
			return '?';
		case 'blunder':
			return '??';
	}
}

export function nagColor(q: MoveQuality): string {
	switch (q) {
		case 'correct':
			return '#639b24';
		case 'playable':
			return '#749bbf';
		case 'dubious':
			return '#e8b730';
		case 'missed_chance':
			return '#e8b730';
		case 'gave_advantage':
			return '#e58f2a';
		case 'mistake':
			return '#e58f2a';
		case 'blunder':
			return '#ac3332';
	}
}

export function moveQualityLabel(q: MoveQuality): string {
	switch (q) {
		case 'correct':
			return 'Correct';
		case 'playable':
			return 'Playable — not your line';
		case 'dubious':
			return 'Dubious — not your line';
		case 'missed_chance':
			return 'Missed a chance';
		case 'gave_advantage':
			return 'Gave away the advantage';
		case 'mistake':
			return 'A mistake';
		case 'blunder':
			return 'A blunder';
	}
}

/**
 * Headline shown in the wrong-phase panel — frames *what* happened in
 * a sentence, not just the category label. The label-line and the
 * headline together carry the message.
 */
export function moveQualityHeadline(q: MoveQuality): string {
	switch (q) {
		case 'correct':
			return '';
		case 'playable':
			return 'Fair, but not your repertoire. Try again.';
		case 'dubious':
			return 'Not quite. Try again.';
		case 'missed_chance':
			return 'You had a chance for an advantage there. Try again.';
		case 'gave_advantage':
			return 'That gives away your advantage. Try again.';
		case 'mistake':
			return 'Try again.';
		case 'blunder':
			return 'Try again.';
	}
}
