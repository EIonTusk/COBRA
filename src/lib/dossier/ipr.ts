/**
 * Intrinsic Performance Rating (IPR).
 *
 * Estimates the rating at which the user's observed move-quality
 * distribution would be *typical* of a peer. The canonical version is
 * Ken Regan's, which anchors a CP-loss → rating curve from large-scale
 * master-game samples. We ship a simpler, transparent variant:
 *
 *   1. Build a calibration curve from the peer-bucket's `evalByPhaseColor`
 *      — each rating band's typical per-move CP loss. Empirically
 *      monotone: higher-rated buckets lose fewer centipawns per move.
 *   2. For a given slice of user moves (overall, per-phase, per-family),
 *      compute the user's mean CP loss.
 *   3. Invert the calibration curve to find the rating whose expected CP
 *      loss matches the user's observation. Linear interpolation between
 *      the two nearest bucket rating centres.
 *   4. Report a standard error derived from the user's per-move CP-loss
 *      SD, propagated through the inverted curve via a local slope.
 *
 * Edge cases:
 *   - No peer buckets with CP fields: return null IPR, flag unavailable.
 *   - User CP loss below best bucket / above worst: clamp to endpoint +
 *     annotate that the estimate is pinned.
 *   - Sample too thin (< 30 moves): SE is wide; caller gates display.
 *
 * IPR is a point estimate — it does not forecast the user's Lichess/chess.com
 * rating, nor does it imply one will "reach" that rating with practice. It
 * answers one specific, well-posed question: "at what rating is the user's
 * accuracy typical?" Reader can judge the gap to their actual rating.
 */

import type { DossierScanResult } from './scan';
import type { BaselinePhaseStatsJson } from './fingerprint';
import type { Phase } from './classify';
import { normalMeanCI, type Interval } from './stats';

import baselineData from './baseline.json';

interface BucketPoint {
	ratingCentre: number;
	avgCpLoss: number;
	avgCpLossSd: number | null;
	moves: number;
}

/**
 * IPR for one slice of user moves. Phase-level IPRs reveal, e.g., an
 * opening IPR of 1800 with an endgame IPR of 1400 — a skill spike the
 * headline overall IPR would blur out.
 */
export interface IPR {
	label: string;
	moves: number;
	userAvgCpLoss: number;
	/** Point estimate of IPR. Null when the calibration curve is unavailable. */
	rating: number | null;
	/** 95% CI on the rating estimate. Wider for thin slices. */
	ci95: Interval | null;
	/** True when the user's observation fell outside the curve and was clamped. */
	clamped: boolean;
	/** True when the user sample is too thin for the estimate to be reliable. */
	thin: boolean;
	/** Number of peer buckets on the calibration curve used for the fit. */
	curvePoints: number;
}

export interface IPRSummary {
	overall: IPR;
	byPhase: Record<Phase, IPR>;
	/** True when the calibration curve couldn't be built. */
	curveUnavailable: boolean;
	/** Number of peer buckets used (across phases). */
	curveBucketCount: number;
}

/**
 * Minimum peer bucket count needed for a non-degenerate curve. Two
 * points are enough for linear interpolation; any fewer and we can't
 * invert.
 */
const MIN_CURVE_POINTS = 2;
const THIN_SAMPLE_MOVES = 30;

/**
 * Build an IPR summary for the dossier. Reads the rating-bucketed peer
 * calibration curve from the shipped baseline.json (plus any runtime
 * self-calibrated buckets the user has accumulated). Per-phase estimates
 * and the overall estimate share the curve but use different slices of
 * user moves.
 */
export function buildIPR(result: DossierScanResult): IPRSummary {
	const moves = result.evalAxes?.allMoves ?? [];
	const curve = buildCalibrationCurve();

	if (curve.overall.length < MIN_CURVE_POINTS) {
		return {
			overall: unavailableIPR('Overall', moves.length, avg(moves.map((m) => m.cpLoss))),
			byPhase: {
				opening: unavailableIPR(
					'Opening',
					moves.filter((m) => m.phase === 'opening').length,
					avg(moves.filter((m) => m.phase === 'opening').map((m) => m.cpLoss))
				),
				middle: unavailableIPR(
					'Middlegame',
					moves.filter((m) => m.phase === 'middle').length,
					avg(moves.filter((m) => m.phase === 'middle').map((m) => m.cpLoss))
				),
				end: unavailableIPR(
					'Endgame',
					moves.filter((m) => m.phase === 'end').length,
					avg(moves.filter((m) => m.phase === 'end').map((m) => m.cpLoss))
				)
			},
			curveUnavailable: true,
			curveBucketCount: curve.overall.length
		};
	}

	const overall = fitIPR(
		'Overall',
		moves.map((m) => m.cpLoss),
		curve.overall
	);
	const byPhase: Record<Phase, IPR> = {
		opening: fitIPR(
			'Opening',
			moves.filter((m) => m.phase === 'opening').map((m) => m.cpLoss),
			curve.opening ?? curve.overall
		),
		middle: fitIPR(
			'Middlegame',
			moves.filter((m) => m.phase === 'middle').map((m) => m.cpLoss),
			curve.middle ?? curve.overall
		),
		end: fitIPR(
			'Endgame',
			moves.filter((m) => m.phase === 'end').map((m) => m.cpLoss),
			curve.end ?? curve.overall
		)
	};

	return {
		overall,
		byPhase,
		curveUnavailable: false,
		curveBucketCount: curve.overall.length
	};
}

/**
 * Fit an IPR for one slice by inverting the calibration curve.
 *
 * The curve is sorted by ratingCentre ascending. For each adjacent pair
 * we interpolate linearly. When the user's CP loss falls outside the
 * curve we clamp to the nearest endpoint and flag `clamped: true`.
 */
function fitIPR(label: string, cpSamples: number[], curve: BucketPoint[]): IPR {
	const moves = cpSamples.length;
	if (moves === 0 || curve.length < MIN_CURVE_POINTS) {
		return {
			label,
			moves,
			userAvgCpLoss: avg(cpSamples),
			rating: null,
			ci95: null,
			clamped: false,
			thin: moves < THIN_SAMPLE_MOVES,
			curvePoints: curve.length
		};
	}
	const userMean = avg(cpSamples);
	const userCI = normalMeanCI(cpSamples);

	// The calibration curve is CP-loss as a function of rating, typically
	// monotone-decreasing (higher rating → lower CP loss). Sort then walk.
	const sorted = [...curve].sort((a, b) => a.avgCpLoss - b.avgCpLoss);
	const rating = invertCurve(userMean, sorted);
	const ratingLo = invertCurve(userCI.hi, sorted); // higher CP → lower rating
	const ratingHi = invertCurve(userCI.lo, sorted);
	const clamped = rating.clamped || ratingLo.clamped || ratingHi.clamped;
	return {
		label,
		moves,
		userAvgCpLoss: userMean,
		rating: rating.value,
		ci95: { lo: ratingLo.value, hi: ratingHi.value },
		clamped,
		thin: moves < THIN_SAMPLE_MOVES,
		curvePoints: curve.length
	};
}

/**
 * Invert the (CP-loss → rating) curve via linear interpolation between
 * the two points bracketing the user's observation. Outside the curve we
 * clamp to the endpoint rather than extrapolate — extrapolating a linear
 * CP-to-rating curve outside a well-sampled band produces implausibly
 * high / low ratings that the reader would have to mentally discount.
 */
function invertCurve(
	userCp: number,
	sortedByCp: BucketPoint[]
): { value: number; clamped: boolean } {
	const first = sortedByCp[0];
	const last = sortedByCp[sortedByCp.length - 1];
	if (userCp <= first.avgCpLoss) return { value: first.ratingCentre, clamped: true };
	if (userCp >= last.avgCpLoss) return { value: last.ratingCentre, clamped: true };
	for (let i = 0; i < sortedByCp.length - 1; i++) {
		const lo = sortedByCp[i];
		const hi = sortedByCp[i + 1];
		if (userCp >= lo.avgCpLoss && userCp <= hi.avgCpLoss) {
			const t = (userCp - lo.avgCpLoss) / (hi.avgCpLoss - lo.avgCpLoss || 1);
			return { value: lo.ratingCentre + t * (hi.ratingCentre - lo.ratingCentre), clamped: false };
		}
	}
	return { value: last.ratingCentre, clamped: true };
}

/**
 * Pool every eligible peer bucket in baseline.json into per-phase
 * calibration curves. A bucket contributes one point per phase when
 * `evalByPhaseColor` exists; the point's rating centre is the midpoint of
 * the bucket's rating band, and its CP loss is averaged across colours.
 *
 * The "overall" curve averages all six phase-colour tiles; it's the
 * fallback used when a phase-specific curve is too thin.
 */
interface Curve {
	overall: BucketPoint[];
	opening: BucketPoint[] | null;
	middle: BucketPoint[] | null;
	end: BucketPoint[] | null;
}

function buildCalibrationCurve(): Curve {
	const overall: BucketPoint[] = [];
	const opening: BucketPoint[] = [];
	const middle: BucketPoint[] = [];
	const end: BucketPoint[] = [];
	const rawBuckets = (baselineData as { buckets?: unknown[] }).buckets ?? [];
	for (const raw of rawBuckets as Array<{
		ratingMin?: number | null;
		ratingMax?: number | null;
		evalByPhaseColor?: {
			opening: { white: BaselinePhaseStatsJson; black: BaselinePhaseStatsJson };
			middle: { white: BaselinePhaseStatsJson; black: BaselinePhaseStatsJson };
			end: { white: BaselinePhaseStatsJson; black: BaselinePhaseStatsJson };
		};
	}>) {
		const epc = raw.evalByPhaseColor;
		if (!epc) continue;
		const lo = raw.ratingMin ?? 0;
		const hi = raw.ratingMax ?? lo;
		const centre = (lo + hi) / 2;

		const phaseAvg = (tiles: BaselinePhaseStatsJson[]): BucketPoint | null => {
			const valid = tiles.filter((t) => Number.isFinite(t.avgCpLoss) && t.avgCpLoss >= 0);
			if (valid.length === 0) return null;
			const mean = valid.reduce((s, t) => s + t.avgCpLoss, 0) / valid.length;
			const sds = valid.map((t) => t.avgCpLossSd).filter((s): s is number => s != null && s > 0);
			const sd = sds.length > 0 ? sds.reduce((a, b) => a + b, 0) / sds.length : null;
			const moves = valid.reduce((s, t) => s + (t.moves || 0), 0);
			return { ratingCentre: centre, avgCpLoss: mean, avgCpLossSd: sd, moves };
		};

		const op = phaseAvg([epc.opening.white, epc.opening.black]);
		const mid = phaseAvg([epc.middle.white, epc.middle.black]);
		const en = phaseAvg([epc.end.white, epc.end.black]);
		const ov = phaseAvg([
			epc.opening.white,
			epc.opening.black,
			epc.middle.white,
			epc.middle.black,
			epc.end.white,
			epc.end.black
		]);
		if (op) opening.push(op);
		if (mid) middle.push(mid);
		if (en) end.push(en);
		if (ov) overall.push(ov);
	}
	// De-duplicate same-rating buckets by averaging; keep curves sorted by
	// rating for deterministic fits.
	return {
		overall: dedupSortByRating(overall),
		opening: opening.length >= MIN_CURVE_POINTS ? dedupSortByRating(opening) : null,
		middle: middle.length >= MIN_CURVE_POINTS ? dedupSortByRating(middle) : null,
		end: end.length >= MIN_CURVE_POINTS ? dedupSortByRating(end) : null
	};
}

function dedupSortByRating(points: BucketPoint[]): BucketPoint[] {
	const byRating = new Map<number, BucketPoint[]>();
	for (const p of points) {
		const arr = byRating.get(p.ratingCentre) ?? [];
		arr.push(p);
		byRating.set(p.ratingCentre, arr);
	}
	const merged: BucketPoint[] = [];
	for (const [centre, arr] of byRating) {
		const cp =
			arr.reduce((s, p) => s + p.avgCpLoss * p.moves, 0) /
			Math.max(
				1,
				arr.reduce((s, p) => s + p.moves, 0)
			);
		const totalMoves = arr.reduce((s, p) => s + p.moves, 0);
		merged.push({
			ratingCentre: centre,
			avgCpLoss: cp,
			avgCpLossSd: arr[0].avgCpLossSd,
			moves: totalMoves
		});
	}
	merged.sort((a, b) => a.ratingCentre - b.ratingCentre);
	return merged;
}

function unavailableIPR(label: string, moves: number, cp: number): IPR {
	return {
		label,
		moves,
		userAvgCpLoss: cp,
		rating: null,
		ci95: null,
		clamped: false,
		thin: moves < THIN_SAMPLE_MOVES,
		curvePoints: 0
	};
}

function avg(xs: number[]): number {
	if (xs.length === 0) return 0;
	return xs.reduce((a, b) => a + b, 0) / xs.length;
}
