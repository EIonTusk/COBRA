/**
 * Clock-spend analysis. Two views:
 *
 *  - **alloc**: fraction of the user's total time spent in each phase.
 *    Computed from the per-move `clockSecondsAfter` deltas that
 *    `classify.ts` pulls out of PGN `[%clk]` tags. Moves where we can't
 *    compute a delta (first move of the game, no clock data at all) are
 *    skipped. Normalised across phases so the three values sum to 1.
 *
 *  - **blunders**: fraction of blunders that fell in each phase.
 *    Computed from the v2 eval pass. Shown next to `alloc` so a user
 *    spending 50 % of their time in the opening and 50 % of their
 *    blunders in the endgame can see the mismatch at a glance.
 *
 * Peer `alloc` from the calibrated bucket is included when available.
 */
import type { ClassifiedGame, Phase } from './classify';
import type { EvalMoveResult } from './evalAxes';
import type { BaselineClockSpendJson } from './fingerprint';

export interface ClockSpendReport {
	alloc: Record<Phase, number>;
	blunders: Record<Phase, number>;
	peerAlloc: Record<Phase, number> | null;
	peerBlunders: Record<Phase, number> | null;
	gamesWithClock: number;
	secondsSpent: number;
	blunderCount: number;
	/** Phase where the biggest (alloc - blunder) mismatch lives. */
	mismatchPhase: Phase | null;
	mismatchHeadline: string | null;
}

export function buildClockSpend(
	games: ClassifiedGame[],
	moves: EvalMoveResult[] | null,
	peer: BaselineClockSpendJson | null | undefined
): ClockSpendReport {
	const phaseSeconds: Record<Phase, number> = { opening: 0, middle: 0, end: 0 };
	let totalSeconds = 0;
	let gamesWithClock = 0;

	for (const g of games) {
		let prev: number | null = null;
		let gameHadClock = false;
		for (const m of g.moves) {
			const now = m.clockSecondsAfter;
			if (now == null) {
				prev = null;
				continue;
			}
			gameHadClock = true;
			if (prev != null) {
				// `prev` was clock-after-previous-user-move; `now` is clock-
				// after-this-user-move. The gap is roughly what this move cost
				// plus whatever increment was added. Increments differ by
				// time control so we don't try to correct — but we clamp
				// negatives to 0 (increment > time spent) to avoid skew.
				const delta = Math.max(0, prev - now);
				phaseSeconds[m.phase] += delta;
				totalSeconds += delta;
			}
			prev = now;
		}
		if (gameHadClock) gamesWithClock += 1;
	}

	const alloc: Record<Phase, number> = { opening: 0, middle: 0, end: 0 };
	if (totalSeconds > 0) {
		alloc.opening = phaseSeconds.opening / totalSeconds;
		alloc.middle = phaseSeconds.middle / totalSeconds;
		alloc.end = phaseSeconds.end / totalSeconds;
	}

	const blunders: Record<Phase, number> = { opening: 0, middle: 0, end: 0 };
	let blunderCount = 0;
	if (moves) {
		for (const m of moves) {
			if (m.classification === 'blunder') {
				blunders[m.phase] += 1;
				blunderCount += 1;
			}
		}
		if (blunderCount > 0) {
			blunders.opening /= blunderCount;
			blunders.middle /= blunderCount;
			blunders.end /= blunderCount;
		}
	}

	const peerAlloc = peer ? { opening: peer.opening, middle: peer.middle, end: peer.end } : null;
	const peerBlunders = peer
		? { opening: peer.blunderOpening, middle: peer.blunderMiddle, end: peer.blunderEnd }
		: null;

	const { phase: mismatchPhase, headline } = pickMismatch(alloc, blunders, blunderCount);

	return {
		alloc,
		blunders,
		peerAlloc,
		peerBlunders,
		gamesWithClock,
		secondsSpent: totalSeconds,
		blunderCount,
		mismatchPhase,
		mismatchHeadline: headline
	};
}

function pickMismatch(
	alloc: Record<Phase, number>,
	blunders: Record<Phase, number>,
	blunderCount: number
): { phase: Phase | null; headline: string | null } {
	if (blunderCount < 5) return { phase: null, headline: null };
	let worst: { phase: Phase; mismatch: number } | null = null;
	for (const phase of ['opening', 'middle', 'end'] as const) {
		// Positive mismatch = share of blunders exceeds share of time.
		const mismatch = blunders[phase] - alloc[phase];
		if (!worst || mismatch > worst.mismatch) worst = { phase, mismatch };
	}
	if (!worst || worst.mismatch < 0.12) return { phase: null, headline: null };

	const phaseLabel =
		worst.phase === 'opening' ? 'opening' : worst.phase === 'middle' ? 'middlegame' : 'endgame';
	const timePct = Math.round(alloc[worst.phase] * 100);
	const blunderPct = Math.round(blunders[worst.phase] * 100);
	return {
		phase: worst.phase,
		headline: `You spend ${timePct}% of your clock in the ${phaseLabel}, but ${blunderPct}% of your blunders fall there — that's where the clock is betraying you.`
	};
}
