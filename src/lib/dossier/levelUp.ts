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

export interface AxisDiff {
	axis: keyof AxisRates;
	you: number;
	target: number;
	delta: number; // target − you
	magnitude: number;
	direction: 'raise' | 'lower' | 'hold';
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
		const delta = tVal - yVal;
		const magnitude = Math.abs(delta);
		return {
			axis,
			you: yVal,
			target: tVal,
			delta,
			magnitude,
			direction: Math.abs(delta) < 0.01 ? 'hold' : delta > 0 ? 'raise' : 'lower'
		};
	});
	diffs.sort((a, b) => b.magnitude - a.magnitude);

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
