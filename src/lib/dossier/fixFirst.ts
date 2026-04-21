/**
 * Fix-first ranking — orders candidate leaks by
 *    (frequency × fixability × rating impact)
 * so the user has one concrete "this move would be worth a rating point"
 * recommendation.
 *
 * Sources of candidate leaks:
 *  1. Blunder-atlas buckets (high-signal, labeled with motifs already).
 *  2. Tactical-motif repeat offenders.
 *  3. Phase with highest CP loss delta vs baseline (scorecard).
 *
 * Scoring:
 *  - frequency: number of occurrences.
 *  - fixability: 1.0 for targeted/trainable (motif + piece), 0.5 for
 *    generic phase, 0.3 for broad axes.
 *  - impact: avg CP loss × frequency, scaled to a 0..1 range.
 *
 * A single fix-first object is emitted with rank 1..N. Because we're
 * comparing heterogeneous leak sources, scores are only meaningful as
 * relative rank — not absolute numbers.
 */

import { buildBlunderAtlas, type BlunderCluster } from './blunderAtlas';
import { analyseRepeatOffenders } from './repeatOffenders';
import { motifLabel } from './tacticalMotifs';
import type { DossierScanResult } from './scan';

export type FixCategory = 'tactical-motif' | 'blunder-atlas' | 'phase' | 'time-pressure';

export interface FixCandidate {
	rank: number;
	title: string;
	category: FixCategory;
	frequency: number;
	avgCpLoss: number;
	fixability: number;
	impact: number;
	score: number;
	action: string;
}

export interface FixFirstSummary {
	candidates: FixCandidate[];
	totalTrackedLeaks: number;
}

export function buildFixFirst(result: DossierScanResult): FixFirstSummary {
	const candidates: FixCandidate[] = [];
	const evalMoves = result.evalAxes?.allMoves ?? null;

	// 1. Motif repeat offenders.
	const repeats = analyseRepeatOffenders(result.classified, evalMoves);
	for (const r of repeats.rows.slice(0, 8)) {
		candidates.push({
			rank: 0,
			title: `${motifLabel(r.motif)} with your ${r.pieceInvolved}`,
			category: 'tactical-motif',
			frequency: r.count,
			avgCpLoss: r.avgCpLoss,
			fixability: 1.0,
			impact: 0,
			score: 0,
			action: `Drill ${motifLabel(r.motif).toLowerCase()} patterns — open the examples from the repeat-offenders page on Lichess.`
		});
	}

	// 2. Blunder-atlas clusters.
	if (evalMoves) {
		const atlas = buildBlunderAtlas(evalMoves);
		if (atlas) {
			for (const cluster of atlas.clusters.slice(0, 5)) {
				candidates.push({
					rank: 0,
					title: cluster.title,
					category: 'blunder-atlas',
					frequency: cluster.items.length,
					avgCpLoss: avgCp(cluster),
					fixability: 0.9,
					impact: 0,
					score: 0,
					action: `Save this cluster from the main report as drills — there's a dedicated button for it.`
				});
			}
		}
	}

	// 3. Worst phase by CP loss.
	const evalSummary = result.evalAxes;
	if (evalSummary) {
		const phases = (['opening', 'middle', 'end'] as const)
			.map((phase) => ({ phase, stats: evalSummary.byPhase[phase] }))
			.filter((p) => p.stats.moves >= 30);
		phases.sort((a, b) => b.stats.avgCpLoss - a.stats.avgCpLoss);
		const worst = phases[0];
		if (worst) {
			candidates.push({
				rank: 0,
				title: `${labelPhase(worst.phase)} accuracy`,
				category: 'phase',
				frequency: worst.stats.moves,
				avgCpLoss: worst.stats.avgCpLoss,
				fixability: 0.5,
				impact: 0,
				score: 0,
				action: `Focus study time on ${labelPhase(worst.phase).toLowerCase()}: review your worst ${labelPhase(worst.phase).toLowerCase()} moves from the Blunder Atlas.`
			});
		}
	}

	// 4. Time-pressure leak.
	const byClock = result.fingerprint.byClock;
	if (byClock && byClock.low.moves >= 40) {
		const lowBlunderRate = byClock.low.forcing - byClock.high.forcing; // proxy
		if (lowBlunderRate > 0.05) {
			candidates.push({
				rank: 0,
				title: 'Time-pressure forcing-move spike',
				category: 'time-pressure',
				frequency: byClock.low.moves,
				avgCpLoss: 0,
				fixability: 0.6,
				impact: 0,
				score: 0,
				action: `Practise playing quieter moves under 10s — your forcing-move rate jumps under time pressure.`
			});
		}
	}

	// Scoring.
	const maxFreq = Math.max(...candidates.map((c) => c.frequency), 1);
	const maxCp = Math.max(...candidates.map((c) => c.avgCpLoss || 1), 1);
	for (const c of candidates) {
		const freqN = c.frequency / maxFreq;
		const cpN = (c.avgCpLoss || 50) / maxCp;
		c.impact = freqN * cpN;
		c.score = c.impact * c.fixability;
	}
	candidates.sort((a, b) => b.score - a.score);
	candidates.forEach((c, i) => {
		c.rank = i + 1;
	});

	return { candidates, totalTrackedLeaks: candidates.length };
}

function avgCp(cluster: BlunderCluster): number {
	if (cluster.items.length === 0) return 0;
	return cluster.items.reduce((s, it) => s + (it.move.cpLoss ?? 0), 0) / cluster.items.length;
}

function labelPhase(p: 'opening' | 'middle' | 'end'): string {
	return p === 'opening' ? 'Opening' : p === 'middle' ? 'Middlegame' : 'Endgame';
}
