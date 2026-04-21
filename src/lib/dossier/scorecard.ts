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

export interface ScorecardTile {
	phase: Phase | 'overall';
	color: Color | 'overall';
	moves: number;
	cpLoss: number;
	blunderRate: number;
	/** Peer CP loss from the picked baseline bucket, or null when unavailable. */
	peerCpLoss: number | null;
	/** cpLoss - peerCpLoss: positive = worse than peers. null when unavailable. */
	peerDelta: number | null;
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
const MEANINGFUL_DELTA_CP = 10;

export function buildScorecard(summary: EvalAxesSummary, baseline: PickedBaseline): Scorecard {
	const peer = baseline.evalByPhaseColor ?? null;
	const tiles: ScorecardTile[] = [];
	for (const phase of ['opening', 'middle', 'end'] as const) {
		for (const color of ['white', 'black'] as const) {
			const stats = summary.byPhaseColor[phase][color];
			const peerStats = peer ? peer[phase][color] : null;
			tiles.push(tileFor(phase, color, stats, peerStats));
		}
	}

	const overallPeer = peer ? averagePeerOverall(peer) : null;
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
		overallPeer
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
	peerStats: BaselinePhaseStatsJson | null
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
	let verdict: ScorecardTile['verdict'] = 'unknown';
	if (peerDelta != null) {
		if (peerDelta <= -MEANINGFUL_DELTA_CP) verdict = 'strong';
		else if (peerDelta >= MEANINGFUL_DELTA_CP) verdict = 'weak';
		else verdict = 'even';
	}
	return {
		phase,
		color,
		moves: stats.moves,
		cpLoss: stats.avgCpLoss,
		blunderRate: stats.blunderRate,
		peerCpLoss,
		peerDelta,
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
	const mean = (key: keyof BaselinePhaseStatsJson) =>
		all.reduce((s, a) => s + (a[key] as number), 0) / all.length;
	return {
		moves: 0,
		avgCpLoss: mean('avgCpLoss'),
		blunderRate: mean('blunderRate'),
		inaccuracyRate: mean('inaccuracyRate')
	};
}

function buildHeadline(
	weakest: ScorecardTile | null,
	strongest: ScorecardTile | null
): string | null {
	if (!weakest || !strongest || weakest === strongest) return null;
	const gap = weakest.cpLoss - strongest.cpLoss;
	if (gap >= 30) {
		return `Your ${sectorName(weakest)} bleeds ${Math.round(gap)} cp/move more than your ${sectorName(strongest)}. Train the weak sector first.`;
	}
	if (weakest.peerDelta != null && weakest.peerDelta >= 15) {
		return `Your ${sectorName(weakest)} is ${Math.round(weakest.peerDelta)} cp/move worse than peers. Target this sector.`;
	}
	return null;
}

function sectorName(t: ScorecardTile): string {
	if (t.phase === 'overall') return 'overall';
	const phaseLabel =
		t.phase === 'opening' ? 'opening' : t.phase === 'middle' ? 'middlegame' : 'endgame';
	const colorLabel = t.color === 'white' ? 'White' : 'Black';
	return `${phaseLabel} as ${colorLabel}`;
}
