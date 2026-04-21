/**
 * SOTA helpers for the v2 engine pipeline.
 *
 * The classical CP-loss classifier treats centipawns as linear — 50cp in
 * a balanced position weighs the same as 50cp in an already-lost one.
 * That's wrong in almost every practical sense. These helpers switch the
 * metric to **win probability** (Lichess's sigmoid transform), then
 * derive per-move loss and a per-move accuracy score on the same curve
 * Lichess deep analysis uses.
 *
 *   WP = 50 + 50 · (2 / (1 + exp(−0.00368208 · cp)) − 1)
 *
 * Every existing downstream metric can still be computed in WP space; we
 * keep the CP fields for backward compatibility and add WP alongside.
 */

/** Clamp mate scores to a fixed ±mate ceiling so the sigmoid doesn't blow up. */
export const MATE_WP_CP = 1500;

export interface ScoreLike {
	scoreCp?: number;
	scoreMate?: number;
}

/** Convert any engine score into a signed CP value clamped into ±MATE_WP_CP. */
export function scoreToSignedCp(s: ScoreLike): number {
	if (s.scoreMate !== undefined) {
		return s.scoreMate > 0 ? MATE_WP_CP : -MATE_WP_CP;
	}
	if (s.scoreCp !== undefined) return Math.max(-MATE_WP_CP, Math.min(MATE_WP_CP, s.scoreCp));
	return 0;
}

/** Lichess win-probability sigmoid. Input cp from POV of side-to-move. Returns 0–100. */
export function cpToWinProb(cp: number): number {
	const clamped = Math.max(-MATE_WP_CP, Math.min(MATE_WP_CP, cp));
	return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

/** WP-loss for a move: drop in win probability from the position before to after. */
export function wpLoss(cpBefore: number, cpAfter: number): number {
	const wpBefore = cpToWinProb(cpBefore);
	const wpAfter = cpToWinProb(cpAfter);
	return Math.max(0, wpBefore - wpAfter);
}

/**
 * Lichess-style per-move accuracy. Their public formula:
 *   accuracy = 103.1668 · exp(−0.04354 · wpLoss) − 3.1669
 * clamped to 0–100.
 *
 * Intuition: WP loss = 0 → accuracy ≈ 100; WP loss = 10 → ≈ 63; WP
 * loss = 20 → ≈ 40; WP loss = 50 → ≈ 9; anything ≥ 70 → ~0.
 */
export function accuracyFromWpLoss(wpLossPct: number): number {
	const acc = 103.1668 * Math.exp(-0.04354 * wpLossPct) - 3.1669;
	return Math.max(0, Math.min(100, acc));
}

export type MoveQuality =
	| 'brilliant'
	| 'best'
	| 'excellent'
	| 'good'
	| 'inaccuracy'
	| 'mistake'
	| 'blunder';

/**
 * Classify a move by WP loss. Thresholds roughly match Lichess's public
 * buckets — we lump "brilliant" separately (flagged via intentional-sac
 * detection in the caller), so this function only handles the regular
 * ladder.
 */
export function classifyByWpLoss(wpLossPct: number): MoveQuality {
	if (wpLossPct < 2) return 'best';
	if (wpLossPct < 5) return 'excellent';
	if (wpLossPct < 10) return 'good';
	if (wpLossPct < 20) return 'inaccuracy';
	if (wpLossPct < 30) return 'mistake';
	return 'blunder';
}

export const MOVE_QUALITY_LABEL: Record<MoveQuality, string> = {
	brilliant: 'Brilliant',
	best: 'Best',
	excellent: 'Excellent',
	good: 'Good',
	inaccuracy: 'Inaccuracy',
	mistake: 'Mistake',
	blunder: 'Blunder'
};

/** Severity tier for move-quality bars; used by the histogram exhibit. */
export const MOVE_QUALITY_ORDER: MoveQuality[] = [
	'brilliant',
	'best',
	'excellent',
	'good',
	'inaccuracy',
	'mistake',
	'blunder'
];

export interface MoveQualityBucket {
	quality: MoveQuality;
	count: number;
	share: number;
}

/** Bucket a set of move qualities into the canonical order with shares. */
export function bucketHistogram(qualities: MoveQuality[]): MoveQualityBucket[] {
	const counts: Record<MoveQuality, number> = {
		brilliant: 0,
		best: 0,
		excellent: 0,
		good: 0,
		inaccuracy: 0,
		mistake: 0,
		blunder: 0
	};
	for (const q of qualities) counts[q] += 1;
	const total = qualities.length || 1;
	return MOVE_QUALITY_ORDER.map((q) => ({
		quality: q,
		count: counts[q],
		share: counts[q] / total
	}));
}

/**
 * Count how many FEN pieces are on the board — cheap parse, no chessops.
 * Used to gate tablebase lookups (≤ 7 pieces).
 */
export function countFenPieces(fen: string): number {
	const board = fen.split(' ')[0] ?? '';
	let count = 0;
	for (const c of board) {
		if (/[prnbqkPRNBQK]/.test(c)) count += 1;
	}
	return count;
}
