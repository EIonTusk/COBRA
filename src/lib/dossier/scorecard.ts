/**
 * Scorecard — headline of the /dossier page. Six (phase × color) tiles
 * plus an Overall tile, each reporting average centipawn-loss with a
 * delta against the peer baseline. Keeps the UI grounded in a single
 * honest measure (CP loss) rather than an implied-rating translation,
 * which varies by speed and encourages misplaced precision.
 */
import type { EvalAxesSummary, PhaseEvalSummary } from './evalAxes';
import type { PickedBaseline, BaselinePhaseStatsJson } from './fingerprint';
import type { Phase } from './classify';
import type { Color } from '$lib/types';
import {
	wilsonInterval,
	normalMeanCI,
	zScore,
	intervalsOverlap,
	type Interval,
	type ZScore
} from './stats';

export interface ScorecardTile {
	phase: Phase | 'overall';
	color: Color | 'overall';
	moves: number;
	cpLoss: number;
	/** 95% CI for the tile's mean CP loss. Normal-SE approximation on per-move samples. */
	cpLossCI: Interval;
	blunderRate: number;
	/** Wilson 95% CI for the tile's blunder rate. */
	blunderRateCI: Interval;
	/** Peer CP loss from the picked baseline bucket, or null when unavailable. */
	peerCpLoss: number | null;
	/** cpLoss - peerCpLoss: positive = worse than peers. null when unavailable. */
	peerDelta: number | null;
	/**
	 * Z-score of the user's CP loss against the peer distribution for this
	 * phase-colour bucket. Requires `avgCpLossSd` on the peer tile — older
	 * buckets omit that, in which case `null` here and the card falls back
	 * to delta-only display.
	 */
	peerZ: ZScore | null;
	/**
	 * Peer CI. Computed from the peer's `avgCpLossSd` and sample size so
	 * the verdict can gate on "does the user CI exclude the peer band?"
	 */
	peerCI: Interval | null;
	/** Verdict relative to peers; used to tint the tile. */
	verdict: 'strong' | 'even' | 'weak' | 'unknown';
	/** True when we have too few moves (<10) to say anything honest. */
	sparse: boolean;
}

export interface Scorecard {
	tiles: ScorecardTile[];
	overall: ScorecardTile;
	weakest: ScorecardTile | null;
	strongest: ScorecardTile | null;
	/** Ready-to-render sentence summarising the biggest gap. */
	headline: string | null;
}

const MIN_MOVES_FOR_TILE = 10;
/**
 * Minimum |z| on CP-loss vs peer to move a tile out of "even". The CI
 * rule independently demands non-overlap of user and peer bands, so this
 * threshold only controls which side (strong/weak) the tile lands on when
 * the interval test passes.
 */
const MEANINGFUL_Z = 0.5;

export function buildScorecard(summary: EvalAxesSummary, baseline: PickedBaseline): Scorecard {
	const peer = baseline.evalByPhaseColor ?? null;
	// Bucket per-move CP losses so each tile can compute its own mean CI.
	const cpByTile: Record<Phase, Record<Color, number[]>> = {
		opening: { white: [], black: [] },
		middle: { white: [], black: [] },
		end: { white: [], black: [] }
	};
	const blundersByTile: Record<Phase, Record<Color, number>> = {
		opening: { white: 0, black: 0 },
		middle: { white: 0, black: 0 },
		end: { white: 0, black: 0 }
	};
	for (const m of summary.allMoves) {
		cpByTile[m.phase][m.userColor].push(m.cpLoss);
		if (m.classification === 'blunder') blundersByTile[m.phase][m.userColor] += 1;
	}
	const tiles: ScorecardTile[] = [];
	for (const phase of ['opening', 'middle', 'end'] as const) {
		for (const color of ['white', 'black'] as const) {
			const stats = summary.byPhaseColor[phase][color];
			const peerStats = peer ? peer[phase][color] : null;
			tiles.push(
				tileFor(
					phase,
					color,
					stats,
					peerStats,
					cpByTile[phase][color],
					blundersByTile[phase][color]
				)
			);
		}
	}

	const overallPeer = peer ? averagePeerOverall(peer) : null;
	const allCp = summary.allMoves.map((m) => m.cpLoss);
	const overallBlunders = summary.allMoves.filter((m) => m.classification === 'blunder').length;
	const overall = tileFor(
		'overall',
		'overall',
		{
			moves: summary.movesAnalysed,
			avgCpLoss: summary.avgCpLoss,
			blunderRate: summary.blunderRate,
			inaccuracyRate: summary.inaccuracyRate,
			avgAccuracy: summary.avgAccuracy,
			avgWpLoss: summary.avgWpLoss
		},
		overallPeer,
		allCp,
		overallBlunders
	);

	const eligible = tiles.filter((t) => !t.sparse);
	let weakest: ScorecardTile | null = null;
	let strongest: ScorecardTile | null = null;
	for (const t of eligible) {
		if (!weakest || t.cpLoss > weakest.cpLoss) weakest = t;
		if (!strongest || t.cpLoss < strongest.cpLoss) strongest = t;
	}

	return {
		tiles,
		overall,
		weakest,
		strongest,
		headline: buildHeadline(weakest, strongest)
	};
}

function tileFor(
	phase: Phase | 'overall',
	color: Color | 'overall',
	stats: PhaseEvalSummary,
	peerStats: BaselinePhaseStatsJson | null,
	cpSamples: number[],
	blunderCount: number
): ScorecardTile {
	const sparse = stats.moves < MIN_MOVES_FOR_TILE;
	// Accept any non-negative peer value. Seeded baselines ship with
	// `moves: 0, avgCpLoss: <eyeballed>` — rejecting `avgCpLoss === 0`
	// silently strips peer data whenever a calibration bucket has a
	// legitimately-zero phase.
	const peerCpLoss =
		peerStats != null && peerStats.avgCpLoss >= 0 && Number.isFinite(peerStats.avgCpLoss)
			? peerStats.avgCpLoss
			: null;
	const peerDelta = peerCpLoss != null ? stats.avgCpLoss - peerCpLoss : null;

	// Confidence intervals.
	const cpLossCI = normalMeanCI(cpSamples);
	const blunderRateCI = wilsonInterval(blunderCount, stats.moves);

	// Peer CI: if we have peer SD and peer sample size, treat peer as a
	// mean with SE = sd/sqrt(n). Otherwise we can't bracket the peer and
	// the verdict stays delta-based only.
	let peerCI: Interval | null = null;
	let peerZ: ZScore | null = null;
	if (peerCpLoss != null && peerStats) {
		const peerSd = peerStats.avgCpLossSd;
		const peerN = peerStats.moves;
		if (peerSd != null && peerSd > 0 && peerN > 0) {
			const peerSe = peerSd / Math.sqrt(peerN);
			peerCI = { lo: peerCpLoss - 1.96 * peerSe, hi: peerCpLoss + 1.96 * peerSe };
			peerZ = zScore(stats.avgCpLoss, peerCpLoss, peerSd);
		}
	}

	// Verdict: require both (a) user CI and peer CI to not overlap, and
	// (b) the z-score to clear MEANINGFUL_Z. When peer SD is missing we
	// can't compute the CI-gate, so fall back to a moderate delta gate
	// (keeps behaviour reasonable on old baselines).
	let verdict: ScorecardTile['verdict'] = 'unknown';
	if (peerDelta != null) {
		const ciSeparated = peerCI != null ? !intervalsOverlap(cpLossCI, peerCI) : true;
		const zClear = peerZ != null ? Math.abs(peerZ.z) >= MEANINGFUL_Z : Math.abs(peerDelta) >= 10;
		if (ciSeparated && zClear && peerDelta > 0) verdict = 'weak';
		else if (ciSeparated && zClear && peerDelta < 0) verdict = 'strong';
		else verdict = 'even';
	}

	return {
		phase,
		color,
		moves: stats.moves,
		cpLoss: stats.avgCpLoss,
		cpLossCI,
		blunderRate: stats.blunderRate,
		blunderRateCI,
		peerCpLoss,
		peerDelta,
		peerZ,
		peerCI,
		verdict,
		sparse
	};
}

function averagePeerOverall(
	peer: NonNullable<PickedBaseline['evalByPhaseColor']>
): BaselinePhaseStatsJson {
	const all = [
		peer.opening.white,
		peer.opening.black,
		peer.middle.white,
		peer.middle.black,
		peer.end.white,
		peer.end.black
	];
	const meanOf = (getter: (x: BaselinePhaseStatsJson) => number) =>
		all.reduce((s, a) => s + getter(a), 0) / all.length;
	// Pool the per-tile SDs into an average SD. Not strictly rigorous —
	// a true pooled SD would re-sum squared deviations — but peer SDs are
	// approximate by construction and this is only used for the overall
	// tile, which the UI treats as a summary rather than a diagnostic.
	const sds = all.map((a) => a.avgCpLossSd).filter((s): s is number => s != null && s > 0);
	const sdMean = sds.length > 0 ? sds.reduce((a, b) => a + b, 0) / sds.length : undefined;
	// Peer moves: sum the per-tile sample sizes so Normal-SE uses realistic n.
	const peerMoves = all.reduce((s, a) => s + (a.moves || 0), 0);
	return {
		moves: peerMoves,
		avgCpLoss: meanOf((x) => x.avgCpLoss),
		avgCpLossSd: sdMean,
		blunderRate: meanOf((x) => x.blunderRate),
		inaccuracyRate: meanOf((x) => x.inaccuracyRate)
	};
}

function buildHeadline(
	weakest: ScorecardTile | null,
	strongest: ScorecardTile | null
): string | null {
	if (!weakest || !strongest || weakest === strongest) return null;
	const gap = weakest.cpLoss - strongest.cpLoss;
	if (gap >= 30) {
		return `Your ${sectorName(weakest)} bleeds ${Math.round(gap)} cp/move more than your ${sectorName(strongest)} (${ciRange(weakest.cpLossCI)} vs ${ciRange(strongest.cpLossCI)}).`;
	}
	if (weakest.peerZ && weakest.verdict === 'weak') {
		return `Your ${sectorName(weakest)} sits ${formatSigma(weakest.peerZ.z)} above peer average (${Math.round(weakest.peerZ.user)} vs ${Math.round(weakest.peerZ.peer)} cp/move, peer SD ${Math.round(weakest.peerZ.sd)}).`;
	}
	if (weakest.peerDelta != null && weakest.peerDelta >= 15) {
		return `Your ${sectorName(weakest)} is ${Math.round(weakest.peerDelta)} cp/move worse than peers (peer SD unavailable).`;
	}
	return null;
}

function ciRange(i: Interval): string {
	return `${Math.round(i.lo)}–${Math.round(i.hi)} cp`;
}

function formatSigma(z: number): string {
	const sign = z >= 0 ? '+' : '−';
	return `${sign}${Math.abs(z).toFixed(1)}σ`;
}

function sectorName(t: ScorecardTile): string {
	if (t.phase === 'overall') return 'overall';
	const phaseLabel =
		t.phase === 'opening' ? 'opening' : t.phase === 'middle' ? 'middlegame' : 'endgame';
	const colorLabel = t.color === 'white' ? 'White' : 'Black';
	return `${phaseLabel} as ${colorLabel}`;
}
