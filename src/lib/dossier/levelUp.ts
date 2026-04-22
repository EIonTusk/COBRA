/**
 * Level-up diff — compare the user's style axes to the picked baseline at
 * user_rating + TARGET_OFFSET, so you can see which axes you'd need to
 * move on to look like a player 200 rating points above you.
 *
 * If no higher-rating baseline bucket exists (no bucket shipped for that
 * band, no self-calibrated bucket at that level), we fall back to whatever
 * the highest-rating available bucket is and annotate that.
 */

import type { AxisRates, DossierFingerprint } from './fingerprint';
import { pickBaseline, primarySpeed } from './fingerprint';
import { zScore, type ZScore } from './stats';

export interface AxisDiff {
	axis: keyof AxisRates;
	you: number;
	target: number;
	delta: number; // target − you
	magnitude: number;
	direction: 'raise' | 'lower' | 'hold';
	/**
	 * z-score of the *user* against the target-rating peer distribution.
	 * Positive means the user is further from target in units of the
	 * target bucket's SD; the magnitude here is what drives sorting when
	 * available, replacing the raw `magnitude` for ranking purposes.
	 */
	userZvsTarget: ZScore | null;
}

export interface LevelUpSummary {
	targetRating: number;
	sourceRating: number | null;
	targetSource: string;
	diffs: AxisDiff[];
	biggestGap: AxisDiff | null;
}

const AXES: (keyof AxisRates)[] = ['forcing', 'capture', 'pawnPlay', 'queenside', 'earlyCastle'];

export function buildLevelUp(fp: DossierFingerprint, targetOffset = 200): LevelUpSummary {
	const speed = primarySpeed(fp);
	const you = fp.overall;
	const target = fp.avgUserRating != null ? fp.avgUserRating + targetOffset : null;
	const picked = pickBaseline(target, speed);

	const diffs: AxisDiff[] = AXES.map((axis) => {
		const yVal = (you as AxisRates)[axis];
		const tVal = picked.axes[axis];
		const sd = picked.axesSd?.[axis];
		const delta = tVal - yVal;
		const magnitude = Math.abs(delta);
		const userZvsTarget = sd != null && sd > 0 ? zScore(yVal, tVal, sd) : null;
		return {
			axis,
			you: yVal,
			target: tVal,
			delta,
			magnitude,
			direction: Math.abs(delta) < 0.01 ? 'hold' : delta > 0 ? 'raise' : 'lower',
			userZvsTarget
		};
	});
	// Prefer |z| sorting when SDs are available — "furthest from target in
	// units of peer SD" is a more honest ranking than raw delta, since a
	// 0.03 gap on forcing (SD ~0.04) is smaller than a 0.03 gap on
	// creationRate (SD ~0.015).
	diffs.sort((a, b) => {
		const za = a.userZvsTarget ? Math.abs(a.userZvsTarget.z) : a.magnitude * 10;
		const zb = b.userZvsTarget ? Math.abs(b.userZvsTarget.z) : b.magnitude * 10;
		return zb - za;
	});

	return {
		targetRating: target ?? 0,
		sourceRating: fp.avgUserRating,
		targetSource: picked.source,
		diffs,
		biggestGap: diffs[0] ?? null
	};
}

export const AXIS_LABEL: Record<keyof AxisRates, string> = {
	forcing: 'Forcing moves',
	capture: 'Captures',
	pawnPlay: 'Pawn moves',
	queenside: 'Queenside play',
	earlyCastle: 'Early castle'
};
