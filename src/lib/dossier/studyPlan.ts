/**
 * Rating-bucket-aware study plan. Pulls from the existing analyses
 * (`buildFixFirst`, `analyseOpeningFit`, `buildLevelUp`, the scorecard
 * eval-axes summary) and produces 3–5 items framed explicitly against
 * the user's same-rating peer baseline:
 *
 *   "At your bucket (1500–1700), peers convert +1.5 advantages 71% of
 *    the time; you convert 58%. Drill the worst-conversion endgames."
 *
 * Different from `buildFixFirst` in two ways:
 *
 *   1. Bucket-aware framing — the rationale strings explicitly cite the
 *      user's rating range so the user understands "this is what's
 *      typical for someone at your level."
 *   2. Multi-source — opening-family misfits are first-class items
 *      alongside tactical motifs and phase weaknesses, so the plan
 *      includes "swap this opening" alongside "drill these motifs."
 *
 * The recommender deliberately stops short of recommending specific
 * lines (e.g. "study the Italian Two Knights") — that requires a PGN
 * line database we don't ship yet. Instead, it points at families and
 * skills that have measurable peer-relative gaps.
 */

import type { DossierScanResult } from './scan';
import type { PickedBaseline } from './fingerprint';
import { analyseOpeningFit, type FitRow } from './openingFit';
import { buildLevelUp } from './levelUp';
import { analyseRepeatOffenders } from './repeatOffenders';
import { motifLabel } from './tacticalMotifs';
import { AXIS_LABEL } from './levelUp';

export type StudyPlanCategory = 'tactics' | 'opening' | 'endgame' | 'time' | 'positional';

export interface StudyPlanItem {
	rank: number;
	category: StudyPlanCategory;
	/** Short title, e.g. "Drill back-rank patterns". */
	title: string;
	/** One-sentence rationale framed against the user's rating bucket. */
	rationale: string;
	/** Concrete action the user can take next. */
	action: string;
	/** Methodology-style provenance string (n=…, peer source …). */
	evidence: string;
}

export interface StudyPlan {
	bucketLabel: string;
	/** True when peer numbers come from a real bucket, not eyeballed defaults. */
	hasBucket: boolean;
	items: StudyPlanItem[];
}

const PEER_DELTA_TRIGGER = 0.05; // 5pp gap to flag a metric.

export function buildStudyPlan(
	result: DossierScanResult,
	activeBaseline: PickedBaseline | null
): StudyPlan {
	const bucketLabel = formatBucketLabel(activeBaseline);
	const hasBucket = activeBaseline?.bucket != null;
	const candidates: StudyPlanItem[] = [];

	const evalSummary = result.evalAxes;
	const evalMoves = evalSummary?.allMoves ?? null;

	// 1. Conversion gap. The single most actionable rating-tier signal:
	//    if peers in your bucket convert advantages and you don't, you're
	//    leaving rating points on the board on the technique side.
	if (evalSummary && activeBaseline?.criticalMoments) {
		const peer = activeBaseline.criticalMoments;
		const conversion = computeConversion(evalSummary.allMoves);
		if (
			conversion &&
			conversion.games >= 5 &&
			peer.conversionRate - conversion.rate >= PEER_DELTA_TRIGGER
		) {
			const peerPct = Math.round(peer.conversionRate * 100);
			const youPct = Math.round(conversion.rate * 100);
			candidates.push({
				rank: 0,
				category: 'endgame',
				title: 'Convert winning positions',
				rationale: `${bucketLabel} peers convert +1.5 advantages ${peerPct}% of the time; you convert ${youPct}% across ${conversion.games} winning entries.`,
				action:
					'Walk the worst-conversion games from the Critical Moments appendix; drill the endgame patterns that recur.',
				evidence: `n = ${conversion.games} winning entries · peer ${peerPct}% (n = ${peer.conversionGames})`
			});
		}
	}

	// 2. Defense gap.
	if (evalSummary && activeBaseline?.criticalMoments) {
		const peer = activeBaseline.criticalMoments;
		const defense = computeDefense(evalSummary.allMoves);
		if (defense && defense.games >= 5 && peer.defenseRate - defense.rate >= PEER_DELTA_TRIGGER) {
			const peerPct = Math.round(peer.defenseRate * 100);
			const youPct = Math.round(defense.rate * 100);
			candidates.push({
				rank: 0,
				category: 'positional',
				title: 'Salvage losing positions',
				rationale: `${bucketLabel} peers save −1.5 positions ${peerPct}% of the time; you save ${youPct}% across ${defense.games} losing entries.`,
				action:
					'Study the Defensive Resource finding in §4 — focus on the difficulty bucket where you lose most often.',
				evidence: `n = ${defense.games} losing entries · peer ${peerPct}% (n = ${peer.defenseGames})`
			});
		}
	}

	// 3. Top tactical motif from the repeat-offender stream. Bucket-aware
	//    by virtue of the avgCpLoss number being meaningful relative to
	//    the user's own baseline; we just frame it that way in the prose.
	if (evalMoves) {
		const repeats = analyseRepeatOffenders(result.classified, evalMoves);
		const top = repeats.rows[0];
		if (top && top.count >= 3) {
			candidates.push({
				rank: 0,
				category: 'tactics',
				title: `Drill ${motifLabel(top.motif).toLowerCase()} patterns`,
				rationale: `You've fallen for ${motifLabel(top.motif).toLowerCase()} ${top.count} times in this scan, averaging −${top.avgCpLoss.toFixed(0)}cp per occurrence — pattern recognition closes this kind of gap fastest.`,
				action: `Open the Repeat Offenders detail page, lichess-link the worst examples, and run them as Lichess puzzles.`,
				evidence: `n = ${top.count} occurrences · avg loss ${top.avgCpLoss.toFixed(0)}cp`
			});
		}
	}

	// 4. Worst-fit opening family — recommend a swap or shore up.
	const fit = analyseOpeningFit(result.classified, evalMoves);
	const worstFamily = pickWorstFamily(fit.rows);
	if (worstFamily) {
		const winDelta = (worstFamily.winRateDelta * 100).toFixed(0);
		candidates.push({
			rank: 0,
			category: 'opening',
			title: `Reconsider ${worstFamily.family}`,
			rationale: `Across ${worstFamily.games} games in the ${worstFamily.family}, your win rate is ${winDelta}pp below your overall — the position type isn't paying off at ${bucketLabel}.`,
			action:
				'Either drill the typical losing patterns from this family in the Blunder Atlas, or pick a different system that better fits your style axes.',
			evidence: `n = ${worstFamily.games} games · win Δ ${signed(worstFamily.winRateDelta)}pp · CP Δ ${worstFamily.avgCpLoss > 0 ? signed(worstFamily.avgCpLossDelta) : 'n/a'}cp`
		});
	}

	// 5. Biggest axis gap to the next rating band — broad-strokes
	//    "what playing style would land you a tier above" item.
	const levelUp = buildLevelUp(result.fingerprint, 200);
	const top = levelUp.biggestGap;
	if (top && top.magnitude >= 0.025) {
		const yourPct = (top.you * 100).toFixed(1);
		const targetPct = (top.target * 100).toFixed(1);
		const targetBucket =
			levelUp.targetRating > 0
				? `${Math.round(levelUp.targetRating - 100)}–${Math.round(levelUp.targetRating + 100)}`
				: 'the next band';
		candidates.push({
			rank: 0,
			category: 'positional',
			title: `Rebalance ${AXIS_LABEL[top.axis].toLowerCase()}`,
			rationale: `Players at ${targetBucket} run this axis at ${targetPct}%; you run it at ${yourPct}%. Whether or not you push to that band, this is the axis you'd need to move.`,
			action: `Study games of higher-rated players who play your openings; mimic the concrete decisions that produce the axis difference.`,
			evidence: `your ${yourPct}% vs target ${targetPct}% (${signed(top.delta)}pp${top.userZvsTarget ? ` · z=${top.userZvsTarget.z.toFixed(1)}` : ''})`
		});
	}

	candidates.forEach((c, i) => {
		c.rank = i + 1;
	});

	return {
		bucketLabel,
		hasBucket,
		items: candidates.slice(0, 5)
	};
}

function formatBucketLabel(b: PickedBaseline | null): string {
	if (!b?.bucket) return 'Your peer baseline';
	const min = b.bucket.ratingMin;
	const max = b.bucket.ratingMax;
	const speed = b.bucket.bucket;
	const range = min != null && max != null ? `${min}–${max}` : 'your bucket';
	return speed ? `At ${range} ${speed}` : `At ${range}`;
}

function signed(x: number): string {
	const sign = x >= 0 ? '+' : '';
	return `${sign}${(x * 100).toFixed(1)}`;
}

interface ConversionStats {
	rate: number;
	games: number;
}

/**
 * Crude per-game conversion / defense computed from allMoves. A "winning
 * entry" is the first move where the user's eval crossed +150cp from
 * their POV; we count it as converted if the game ended in a win. This
 * mirrors the criticalMoments builder but operates at study-plan level
 * without depending on the full builder's output shape.
 */
function computeConversion(moves: import('./evalAxes').EvalMoveResult[]): ConversionStats | null {
	const byGame = groupByGame(moves);
	let games = 0;
	let won = 0;
	for (const [, ms] of byGame) {
		const entry = ms.find((m) => m.userEvalBeforeCp >= 150);
		if (!entry) continue;
		games += 1;
		if (entry.gameResult === 'win') won += 1;
	}
	if (games === 0) return null;
	return { rate: won / games, games };
}

function computeDefense(moves: import('./evalAxes').EvalMoveResult[]): ConversionStats | null {
	const byGame = groupByGame(moves);
	let games = 0;
	let saved = 0;
	for (const [, ms] of byGame) {
		const entry = ms.find((m) => m.userEvalBeforeCp <= -150);
		if (!entry) continue;
		games += 1;
		if (entry.gameResult === 'draw' || entry.gameResult === 'win') saved += 1;
	}
	if (games === 0) return null;
	return { rate: saved / games, games };
}

function groupByGame(
	moves: import('./evalAxes').EvalMoveResult[]
): Map<string, import('./evalAxes').EvalMoveResult[]> {
	const out = new Map<string, import('./evalAxes').EvalMoveResult[]>();
	for (const m of moves) {
		const list = out.get(m.gameId);
		if (list) list.push(m);
		else out.set(m.gameId, [m]);
	}
	return out;
}

/**
 * Pick the worst-performing family from openingFit. We require ≥ 5 games
 * to avoid noise, and drop families where the eval pass had no data
 * (avgCpLoss === 0) — without engine numbers the ranking degrades to
 * noisy raw win-rate.
 */
function pickWorstFamily(rows: FitRow[]): FitRow | null {
	let worst: FitRow | null = null;
	for (const r of rows) {
		if (r.games < 5) continue;
		if (r.verdict !== 'misfit') continue;
		if (r.winRateDelta >= -0.05) continue;
		if (!worst || r.winRateDelta < worst.winRateDelta) worst = r;
	}
	return worst;
}
