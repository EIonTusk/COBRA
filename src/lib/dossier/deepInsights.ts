/**
 * Deep-insights summary digest. One headline finding per subpage so the
 * main /dossier report can render a scannable card grid instead of a bare
 * list of links. Each card consumes the *same* saved DossierScanResult the
 * subpage itself would — the summaries are cheap derivations over that
 * data, computed once on the main page and fanned out to the 21 cards.
 */

import type { DossierScanResult } from './scan';
import { analysePieceAffinity, minorTradeLean } from './pieceAffinity';
import { analyseStructureTaste, structureLabel } from './structureTaste';
import { analyseExchangePropensity } from './exchangePropensity';
import { analysePlanTaste } from './planTaste';
import { analyseOpeningFit } from './openingFit';
import { analyseEndgameSubtypes, endgameFamilyLabel } from './endgameSubtypes';
import { analyseTacticalMotifs, motifLabel } from './tacticalMotifs';
import { analyseCalculationDepth } from './calculationDepth';
import { analyseDefensiveResource } from './defensiveResource';
import { analyseProphylaxis } from './prophylaxis';
import { analyseBlunderTiming } from './blunderTiming';
import { analyseTimeOfDay, dayLabel } from './timeOfDay';
import { analyseSessionDecay } from './sessionDecay';
import { analyseRepeatOffenders } from './repeatOffenders';
import { analyseRecoveryArc } from './recoveryArc';
import { analyseOpponentStrength } from './opponentStrength';
import { buildNarrative } from './narrative';
import { buildFixFirst } from './fixFirst';
import { buildLevelUp, AXIS_LABEL } from './levelUp';
import { buildExemplars } from './exemplars';
import { analyseProgression } from './progression';

export type InsightGroup = 'preferences' | 'abilities' | 'tendencies' | 'synthesis';

/**
 * Audit severity per finding. Same vocabulary an engagement report would
 * use: strengths, neutral observations, concerns worth addressing, and
 * critical items that materially hurt results.
 */
export type Severity = 'strength' | 'observation' | 'concern' | 'critical' | 'inconclusive';

export interface InsightCard {
	slug: string;
	title: string;
	group: InsightGroup;
	/** One-sentence headline finding. Falls back to a hint when data is thin. */
	headline: string;
	/** Optional second line — a metric, a pointer, or supporting number. */
	detail?: string;
	/** Secondary badge — optional. e.g. "fit", "peaks game 25". */
	badge?: string;
	/** True when the card needs an engine-analysed report to be meaningful. */
	needsEngine: boolean;
	/** Audit severity classification. Drives colour + ordering. */
	severity: Severity;
	/**
	 * Raw sample size backing this finding (games, moves, blunders —
	 * whichever denominator matters). When provided and below the card's
	 * `sampleMin`, severity is auto-demoted to `inconclusive` and the UI
	 * renders a ⚠ "thin sample" badge so the reader knows not to trust
	 * the headline.
	 */
	sampleSize?: number;
	/** Threshold under which this finding is considered thin. */
	sampleMin?: number;
}

/** Shared thin-sample threshold for cards that don't set their own. */
const DEFAULT_SAMPLE_MIN = 20;

const GROUP_LABEL: Record<InsightGroup, string> = {
	preferences: 'Preferences',
	abilities: 'Abilities',
	tendencies: 'Tendencies',
	synthesis: 'Synthesis'
};

export function groupLabel(g: InsightGroup): string {
	return GROUP_LABEL[g];
}

/** Audit area label — cosmetic, used as the section heading for each finding group. */
const AUDIT_AREA: Record<InsightGroup, string> = {
	preferences: 'Stylistic preferences',
	abilities: 'Technical abilities',
	tendencies: 'Behavioural tendencies',
	synthesis: 'Synthesis & recommendations'
};

export function auditAreaLabel(g: InsightGroup): string {
	return AUDIT_AREA[g];
}

const SEVERITY_LABEL: Record<Severity, string> = {
	strength: 'Strength',
	observation: 'Observation',
	concern: 'Concern',
	critical: 'Critical',
	inconclusive: 'Inconclusive'
};

export function severityLabel(s: Severity): string {
	return SEVERITY_LABEL[s];
}

/** Rank used for sorting findings — highest-severity first. */
const SEVERITY_RANK: Record<Severity, number> = {
	critical: 0,
	concern: 1,
	strength: 2,
	observation: 3,
	inconclusive: 4
};

export function severityRank(s: Severity): number {
	return SEVERITY_RANK[s];
}

const AXIS_TITLE: Record<string, string> = {
	forcing: 'Forcing moves',
	capture: 'Captures',
	pawnPlay: 'Pawn moves',
	queenside: 'Queenside play',
	earlyCastle: 'Early castle',
	tensionRelease: 'Tension release',
	tensionCreate: 'Tension creation'
};

export function buildDeepInsightCards(result: DossierScanResult): InsightCard[] {
	const hasEval = !!result.evalAxes && result.evalAxes.movesAnalysed > 0;
	const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
	const signedPp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;

	const cards: InsightCard[] = [];

	// === Preferences ===
	{
		const s = analysePieceAffinity(result.classified);
		const lean = minorTradeLean(s);
		let headline = `${s.totalCaptures.toLocaleString()} captures analysed — minor-piece trades balanced.`;
		if (lean.lean === 'bishop')
			headline = `You prefer keeping bishops: trade N×B ${pct(lean.kfbPct)} vs B×N ${pct(lean.bfkPct)}.`;
		else if (lean.lean === 'knight')
			headline = `You prefer keeping knights: trade B×N ${pct(lean.bfkPct)} vs N×B ${pct(lean.kfbPct)}.`;
		cards.push({
			slug: 'piece-affinity',
			title: 'Piece affinity',
			group: 'preferences',
			headline,
			detail: `Captures while ahead: ${pct(s.capturesWhileAhead)} · while behind: ${pct(s.capturesWhileBehind)}.`,
			needsEngine: false,
			severity: s.totalCaptures < 20 ? 'inconclusive' : 'observation'
		});
	}
	{
		const s = analyseStructureTaste(result.classified);
		const top = s.byStructure[0];
		let headline = 'Not enough games with recognised structures yet.';
		let detail: string | undefined;
		if (top) {
			const deltaPp = (top.winRate - s.overallWinRate) * 100;
			const sign = deltaPp >= 0 ? '+' : '';
			headline = `Most common structure: ${structureLabel(top.key)} — ${top.games} games, ${pct(top.winRate)} win rate (${sign}${deltaPp.toFixed(1)}pp vs you).`;
			detail = `Avg open files ${s.openFileAverage.toFixed(2)} · your pawn islands ${s.avgPawnIslandsUser.toFixed(2)}.`;
		}
		let structureSeverity: Severity = 'observation';
		if (!top) structureSeverity = 'inconclusive';
		else if (top.winRate - s.overallWinRate < -0.1 && top.games >= 10)
			structureSeverity = 'concern';
		else if (top.winRate - s.overallWinRate > 0.1 && top.games >= 10)
			structureSeverity = 'strength';
		cards.push({
			slug: 'structure-taste',
			title: 'Structure taste',
			group: 'preferences',
			headline,
			detail,
			needsEngine: false,
			severity: structureSeverity
		});
	}
	{
		const s = analyseExchangePropensity(result.classified);
		const ahead = s.simplifyWhenAheadDelta;
		const behind = s.clingWhenBehindDelta;
		let headline: string;
		if (ahead > 0.005 && behind < -0.005)
			headline = `Textbook simplifier: trades ${signedPp(ahead)} when ahead, dodges ${signedPp(behind)} when behind.`;
		else if (ahead > 0.005)
			headline = `Simplifies when ahead: trade rate ${signedPp(ahead)} vs equal.`;
		else if (behind > 0.005)
			headline = `Trades more when losing (${signedPp(behind)}) — bleeding off chances.`;
		else headline = 'No strong trade bias across material states.';
		let exchangeSeverity: Severity = 'observation';
		if (ahead > 0.005 && behind < -0.005) exchangeSeverity = 'strength';
		else if (behind > 0.01 && s.byState.behind.moves >= 100) exchangeSeverity = 'concern';
		cards.push({
			slug: 'exchange-propensity',
			title: 'Exchange propensity',
			group: 'preferences',
			headline,
			detail: `Piece-trade rate equal state: ${pct(s.byState.equal.pieceTradeRate)}.`,
			needsEngine: false,
			severity: exchangeSeverity
		});
	}
	{
		const s = analysePlanTaste(result.classified);
		const label =
			s.dominantPlan === 'kingside-pressure'
				? 'Kingside pressure'
				: s.dominantPlan === 'queenside-pressure'
					? 'Queenside pressure'
					: s.dominantPlan === 'central-play'
						? 'Central play'
						: 'Balanced plan';
		cards.push({
			slug: 'plan-taste',
			title: 'Plan taste',
			group: 'preferences',
			headline: `Dominant plan: ${label}.`,
			detail: `Kingside storms ${s.kingsideStormGames}/${s.totalGames} · queenside ${s.minorityAttackGames}/${s.totalGames}.`,
			badge: label,
			needsEngine: false,
			severity: s.totalGames < 10 ? 'inconclusive' : 'observation'
		});
	}
	{
		const s = analyseOpeningFit(result.classified, result.evalAxes?.allMoves ?? null);
		const fit = s.rows.filter((r) => r.verdict === 'fit').length;
		const misfit = s.rows.filter((r) => r.verdict === 'misfit').length;
		const bestFit = s.rows.find((r) => r.verdict === 'fit');
		const worstMisfit = s.rows.find((r) => r.verdict === 'misfit');
		let headline = 'No strong fit or misfit openings detected yet.';
		if (bestFit)
			headline = `Best fit: ${bestFit.family} — ${signedPp(bestFit.winRateDelta)} vs your overall win rate.`;
		else if (worstMisfit)
			headline = `Biggest misfit: ${worstMisfit.family} — ${signedPp(worstMisfit.winRateDelta)} vs your overall win rate.`;
		let openingSeverity: Severity = 'observation';
		if (s.rows.length === 0) openingSeverity = 'inconclusive';
		else if (bestFit && fit >= misfit) openingSeverity = 'strength';
		else if (misfit >= 2 || (worstMisfit && worstMisfit.winRateDelta <= -0.1))
			openingSeverity = 'concern';
		cards.push({
			slug: 'opening-fit',
			title: 'Opening fit',
			group: 'preferences',
			headline,
			detail: `${fit} fit · ${misfit} misfit · ${s.rows.length - fit - misfit} neutral across ${s.rows.length} family rows.`,
			needsEngine: false,
			severity: openingSeverity
		});
	}

	// === Abilities ===
	{
		const s = analyseEndgameSubtypes(result.classified, result.evalAxes?.allMoves ?? null);
		let headline = 'Not enough endgames reached yet.';
		let detail: string | undefined;
		if (s.totalWithEndgame > 0) {
			const top = s.buckets[0];
			const frag = top ? `Most common: ${endgameFamilyLabel(top.family)} (${top.games}).` : '';
			headline = `Reached ${s.totalWithEndgame} endgames. Conversion ${pct(s.overallConversionRate)} · defense ${pct(s.overallDefenseRate)}.`;
			detail = frag;
		}
		let endgameSeverity: Severity = 'observation';
		if (s.totalWithEndgame < 5) endgameSeverity = 'inconclusive';
		else if (s.overallConversionRate < 0.5 && s.overallConversionRate > 0)
			endgameSeverity = 'critical';
		else if (s.overallConversionRate < 0.65) endgameSeverity = 'concern';
		else if (s.overallConversionRate >= 0.8) endgameSeverity = 'strength';
		cards.push({
			slug: 'endgame-subtypes',
			title: 'Endgame subtypes',
			group: 'abilities',
			headline,
			detail,
			needsEngine: true,
			severity: endgameSeverity,
			sampleSize: s.totalWithEndgame,
			sampleMin: 10
		});
	}
	{
		const s = analyseTacticalMotifs(result.evalAxes?.allMoves ?? null);
		let headline = 'Run a scan with Stockfish on to classify motifs.';
		let detail: string | undefined;
		if (s.total > 0) {
			const top = s.byMotif.filter((m) => m.motif !== 'unclassified').slice(0, 3);
			if (top.length > 0) {
				headline = `Top motifs missed: ${top.map((m) => `${motifLabel(m.motif)} (${m.count})`).join(' · ')}.`;
				detail = `${s.total} categorised blunder/mistake moves.`;
			} else {
				headline = `${s.total} blunders categorised — no motif dominates.`;
			}
		}
		let motifSeverity: Severity = 'observation';
		if (s.total < 5) motifSeverity = 'inconclusive';
		else if (s.total >= 40) motifSeverity = 'concern';
		cards.push({
			slug: 'tactical-motifs',
			title: 'Tactical motifs',
			group: 'abilities',
			headline,
			detail,
			needsEngine: true,
			severity: motifSeverity,
			sampleSize: s.total,
			sampleMin: 15
		});
	}
	{
		const s = analyseCalculationDepth(result.classified, result.evalAxes?.allMoves ?? null);
		let headline = 'Needs engine analysis to measure.';
		let detail: string | undefined;
		if (s.overallMoves > 0) {
			const low = s.byBranching.find((b) => b.min === 1);
			const high = s.byBranching.find((b) => b.min === 41);
			if (low && high && low.moves > 0 && high.moves > 0) {
				const delta = high.avgCpLoss - low.avgCpLoss;
				headline = `CP loss at 41+ legal moves: ${high.avgCpLoss.toFixed(1)} vs ${low.avgCpLoss.toFixed(1)} at 1–20 — ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}cp under branching.`;
			} else {
				headline = `Avg CP loss ${s.avgCpLoss.toFixed(1)} across ${s.overallMoves.toLocaleString()} moves.`;
			}
			detail = `${s.overallMoves.toLocaleString()} analysed moves.`;
		}
		let calcSeverity: Severity = 'observation';
		if (s.overallMoves === 0) calcSeverity = 'inconclusive';
		else {
			const low = s.byBranching.find((b) => b.min === 1);
			const high = s.byBranching.find((b) => b.min === 41);
			if (low && high && low.moves > 50 && high.moves > 50) {
				const delta = high.avgCpLoss - low.avgCpLoss;
				if (delta >= 25) calcSeverity = 'critical';
				else if (delta >= 15) calcSeverity = 'concern';
				else if (delta <= 0) calcSeverity = 'strength';
			}
		}
		cards.push({
			slug: 'calculation-depth',
			title: 'Calculation depth',
			group: 'abilities',
			headline,
			detail,
			needsEngine: true,
			severity: calcSeverity
		});
	}
	{
		const s = analyseDefensiveResource(result.classified, result.evalAxes?.allMoves ?? null);
		let headline = 'No losing entries detected yet.';
		let detail: string | undefined;
		if (s.totalLosingEntries > 0) {
			headline = `Defense rate ${pct(s.overallDefenseRate)} across ${s.totalLosingEntries} losing entries.`;
			const hard = s.byDifficulty.find((b) => b.bucket === 'only-move');
			const easy = s.byDifficulty.find((b) => b.bucket === 'many-options');
			if (hard && easy && hard.games > 0 && easy.games > 0) {
				const profile =
					easy.defenseRate > hard.defenseRate + 0.1
						? 'creative defender'
						: hard.defenseRate > easy.defenseRate + 0.1
							? 'calm technician'
							: null;
				if (profile) detail = `Profile: ${profile}.`;
			}
		}
		let defenseSeverity: Severity = 'observation';
		if (s.totalLosingEntries < 3) defenseSeverity = 'inconclusive';
		else if (s.overallDefenseRate < 0.15) defenseSeverity = 'critical';
		else if (s.overallDefenseRate < 0.3) defenseSeverity = 'concern';
		else if (s.overallDefenseRate >= 0.5) defenseSeverity = 'strength';
		cards.push({
			slug: 'defensive-resource',
			title: 'Defensive resource',
			group: 'abilities',
			headline,
			detail,
			needsEngine: true,
			severity: defenseSeverity,
			sampleSize: s.totalLosingEntries,
			sampleMin: 10
		});
	}
	{
		const s = analyseProphylaxis(result.evalAxes?.allMoves ?? null);
		let headline = 'Needs engine analysis.';
		let detail: string | undefined;
		if (s.opportunities > 0) {
			headline = `Neutralises ${pct(s.neutralizeRate)} of ${s.opportunities} real threats the engine flags.`;
			detail = `Compounded: ${s.compounded}.`;
		}
		let prophySeverity: Severity = 'observation';
		if (s.opportunities < 10) prophySeverity = 'inconclusive';
		else if (s.neutralizeRate >= 0.65) prophySeverity = 'strength';
		else if (s.neutralizeRate < 0.35) prophySeverity = 'concern';
		cards.push({
			slug: 'prophylaxis',
			title: 'Prophylaxis',
			group: 'abilities',
			headline,
			detail,
			needsEngine: true,
			severity: prophySeverity,
			sampleSize: s.opportunities,
			sampleMin: 20
		});
	}

	// === Tendencies ===
	{
		const s = analyseBlunderTiming(result.evalAxes?.allMoves ?? null);
		let headline = 'Needs engine analysis.';
		let detail: string | undefined;
		if (s.totalMoves > 0) {
			headline = s.peakBucketLabel
				? `Blunder rate peaks in ${s.peakBucketLabel.toLowerCase()}.`
				: `${s.totalBlunders} blunders — flat across move ranges.`;
			detail = `${s.totalBlunders} blunders across ${s.totalMoves.toLocaleString()} moves.`;
		}
		let timingSeverity: Severity = 'observation';
		if (s.totalMoves < 100) timingSeverity = 'inconclusive';
		else {
			const peak = s.buckets.find((b) => b.label === s.peakBucketLabel);
			if (peak && peak.rate >= 0.12) timingSeverity = 'concern';
		}
		cards.push({
			slug: 'blunder-timing',
			title: 'Blunder timing',
			group: 'tendencies',
			headline,
			detail,
			needsEngine: true,
			severity: timingSeverity,
			sampleSize: s.totalBlunders,
			sampleMin: 10
		});
	}
	{
		const s = analyseTimeOfDay(result.classified, result.evalAxes?.allMoves ?? null);
		let headline = 'Not enough games to separate hour / weekday.';
		const detail: string | undefined = undefined;
		const parts: string[] = [];
		if (s.bestHour != null && s.worstHour != null && s.bestHour !== s.worstHour) {
			parts.push(
				`best ${s.bestHour.toString().padStart(2, '0')}:00, worst ${s.worstHour.toString().padStart(2, '0')}:00`
			);
		}
		if (s.bestDay != null && s.worstDay != null && s.bestDay !== s.worstDay) {
			parts.push(`best ${dayLabel(s.bestDay)}, worst ${dayLabel(s.worstDay)}`);
		}
		if (parts.length > 0) {
			headline = `Schedule pattern: ${parts.join('; ')}.`;
		}
		let todSeverity: Severity = 'observation';
		if (parts.length === 0) todSeverity = 'inconclusive';
		else {
			const bestH = s.byHour.find((h) => h.hour === s.bestHour);
			const worstH = s.byHour.find((h) => h.hour === s.worstHour);
			if (bestH && worstH && worstH.winRate + 0.2 < bestH.winRate && worstH.games >= 10)
				todSeverity = 'concern';
		}
		cards.push({
			slug: 'time-of-day',
			title: 'Time of day / day',
			group: 'tendencies',
			headline,
			detail,
			needsEngine: false,
			severity: todSeverity
		});
	}
	{
		const s = analyseSessionDecay(result.classified, result.evalAxes?.allMoves ?? null);
		let headline = 'Not enough multi-game sessions yet.';
		let detail: string | undefined;
		if (s) {
			if (s.worstPhase && s.worstPhaseDelta != null && s.worstPhaseDelta > 10) {
				const phaseLabel =
					s.worstPhase === 'opening'
						? 'Opening'
						: s.worstPhase === 'middle'
							? 'Middlegame'
							: 'Endgame';
				headline = `${phaseLabel} degrades most across a session — game 4+ is +${s.worstPhaseDelta.toFixed(0)}cp vs game 1.`;
			} else {
				headline = `${s.multiGameSessions} multi-game sessions · no big phase-level decay.`;
			}
			detail = `${s.sessions} total sessions scanned.`;
		}
		let decaySeverity: Severity = 'observation';
		if (!s || s.multiGameSessions < 5) decaySeverity = 'inconclusive';
		else if (s.worstPhaseDelta != null && s.worstPhaseDelta >= 25) decaySeverity = 'critical';
		else if (s.worstPhaseDelta != null && s.worstPhaseDelta >= 12) decaySeverity = 'concern';
		cards.push({
			slug: 'session-decay',
			title: 'Session decay',
			group: 'tendencies',
			headline,
			detail,
			needsEngine: true,
			severity: decaySeverity,
			sampleSize: s?.multiGameSessions ?? 0,
			sampleMin: 5
		});
	}
	{
		const s = analyseRepeatOffenders(result.classified, result.evalAxes?.allMoves ?? null);
		let headline = 'Needs engine analysis.';
		let detail: string | undefined;
		if (s.totalBlunders > 0) {
			const top = s.rows[0];
			if (top) {
				headline = `Top repeat: ${motifLabel(top.motif)} with your ${top.pieceInvolved} (${top.count}×).`;
			} else {
				headline = `${s.totalBlunders} blunders — no repeat pattern yet.`;
			}
			if (s.longestStreak && s.longestStreak.length >= 2) {
				detail = `Longest streak: ${s.longestStreak.length}× ${motifLabel(s.longestStreak.motif)}.`;
			}
		}
		let repeatSeverity: Severity = 'observation';
		if (s.totalBlunders < 10) repeatSeverity = 'inconclusive';
		else if (s.rows[0] && s.rows[0].count >= 5) repeatSeverity = 'concern';
		else if (s.longestStreak && s.longestStreak.length >= 4) repeatSeverity = 'concern';
		cards.push({
			slug: 'repeat-offenders',
			title: 'Repeat offenders',
			group: 'tendencies',
			headline,
			detail,
			needsEngine: true,
			severity: repeatSeverity,
			sampleSize: s.totalBlunders,
			sampleMin: 15
		});
	}
	{
		const s = analyseRecoveryArc(result.evalAxes?.allMoves ?? null);
		let headline = 'Needs engine analysis.';
		let detail: string | undefined;
		if (s.totalBlunders > 0) {
			if (s.cascadeRate > s.steadyRate + 0.05)
				headline = `Cascade-prone: ${pct(s.cascadeRate)} of blunders chain within 3 moves.`;
			else if (s.steadyRate > s.cascadeRate + 0.05)
				headline = `Steadies well: ${pct(s.steadyRate)} blunders followed by 3 clean moves.`;
			else
				headline = `Mixed recovery — ${pct(s.cascadeRate)} cascade vs ${pct(s.steadyRate)} steady.`;
			detail = `${s.totalBlunders} blunders analysed.`;
		}
		let recoverySeverity: Severity = 'observation';
		if (s.totalBlunders < 10) recoverySeverity = 'inconclusive';
		else if (s.cascadeRate > 0.35) recoverySeverity = 'critical';
		else if (s.cascadeRate > s.steadyRate + 0.1) recoverySeverity = 'concern';
		else if (s.steadyRate > s.cascadeRate + 0.15) recoverySeverity = 'strength';
		cards.push({
			slug: 'recovery-arc',
			title: 'Recovery arc',
			group: 'tendencies',
			headline,
			detail,
			needsEngine: true,
			severity: recoverySeverity,
			sampleSize: s.totalBlunders,
			sampleMin: 10
		});
	}
	{
		const s = analyseOpponentStrength(result.classified, result.evalAxes?.allMoves ?? null);
		let headline = 'Not enough opponent-rating variance yet.';
		if (s.headline) {
			headline = s.headline;
		} else {
			const peer = s.buckets.find((b) => b.key === 'peer');
			if (peer && peer.games > 0) {
				headline = `Peer win rate ${pct(peer.winRate)} across ${peer.games} games.`;
			}
		}
		const detail: string | undefined = s.buckets
			.filter((b) => b.games > 0)
			.map((b) => `${b.label.split(' ')[0]}: ${b.games}`)
			.join(' · ');
		// Drift — style vs your past self. Promoted from Appendix G.
		{
			const d = result.drift;
			let headline =
				'Not enough games in both the recent 30-day window and the prior 90-day window to compute drift.';
			let detail: string | undefined;
			let driftSeverity: Severity = 'inconclusive';
			if (d) {
				const winDelta = d.results.winRateDelta;
				const sortedAxes = [...d.axes].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
				const leader = sortedAxes[0];
				if (leader && Math.abs(leader.delta) >= 0.03) {
					const dir = leader.delta >= 0 ? 'up' : 'down';
					headline = `${AXIS_TITLE[leader.axis] ?? leader.axis} is trending ${dir} ${signedPp(leader.delta)} over the last 30 days vs the prior 90.`;
					driftSeverity =
						Math.abs(leader.delta) >= 0.08 || Math.abs(winDelta) >= 0.1 ? 'concern' : 'observation';
				} else {
					headline =
						'Your style is stable vs your past self — no axis moved ≥ 3pp in the last 30 days.';
					driftSeverity = 'observation';
				}
				detail = `Recent ${d.recentGames} games · prior ${d.priorGames} games · win rate ${signedPp(winDelta)}.`;
				if (winDelta >= 0.1) driftSeverity = 'strength';
				else if (winDelta <= -0.1) driftSeverity = 'concern';
			}
			cards.push({
				slug: 'drift',
				title: 'Drift',
				group: 'tendencies',
				headline,
				detail,
				needsEngine: false,
				severity: driftSeverity
			});
		}

		// Consensus alignment — how often you play peer-popular moves. Opt-in eval
		// pass; this card is always inconclusive on its own because the data
		// isn't in the base scan. The subpage runs the Lichess Explorer pass on
		// demand and renders the full results.
		{
			cards.push({
				slug: 'consensus-alignment',
				title: 'Consensus alignment',
				group: 'tendencies',
				headline:
					'Run the Lichess Explorer pass on the detail page to compare your moves against peer-popular picks.',
				detail: undefined,
				needsEngine: false,
				severity: 'inconclusive'
			});
		}

		let oppSeverity: Severity = 'observation';
		const strongBucket = s.buckets.find((b) => b.key === 'stronger' || b.key === 'much-stronger');
		const peerBucket = s.buckets.find((b) => b.key === 'peer');
		if (
			strongBucket &&
			peerBucket &&
			strongBucket.games >= 5 &&
			strongBucket.avgCpLoss != null &&
			peerBucket.avgCpLoss != null
		) {
			const delta = strongBucket.avgCpLoss - peerBucket.avgCpLoss;
			if (delta >= 25) oppSeverity = 'concern';
			else if (delta <= -10) oppSeverity = 'strength';
		}
		cards.push({
			slug: 'opponent-strength',
			title: 'Opponent strength',
			group: 'tendencies',
			headline,
			detail,
			needsEngine: false,
			severity: oppSeverity
		});
	}

	// === Synthesis ===
	{
		const n = buildNarrative(result);
		cards.push({
			slug: 'narrative',
			title: 'Narrative',
			group: 'synthesis',
			headline: n.headline,
			detail: n.paragraphs[0]?.body ? truncate(n.paragraphs[0].body, 140) : undefined,
			needsEngine: false,
			severity: 'observation'
		});
	}
	{
		const s = buildFixFirst(result);
		const top = s.candidates[0];
		let headline = 'Not enough signal to prioritise a fix yet.';
		let detail: string | undefined;
		if (top) {
			headline = `#1 fix: ${top.title}.`;
			detail = top.action;
		}
		cards.push({
			slug: 'fix-first',
			title: 'Fix this first',
			group: 'synthesis',
			headline,
			detail,
			needsEngine: false,
			severity: top ? 'observation' : 'inconclusive'
		});
	}
	{
		const s = buildLevelUp(result.fingerprint, 200);
		let headline = 'Too few rating points recorded.';
		if (s.biggestGap) {
			const dir =
				s.biggestGap.direction === 'raise'
					? 'up'
					: s.biggestGap.direction === 'lower'
						? 'down'
						: 'hold';
			headline = `Biggest gap to +200 rating: ${AXIS_LABEL[s.biggestGap.axis]} (${signedPp(s.biggestGap.delta)}, ${dir}).`;
		}
		cards.push({
			slug: 'level-up',
			title: 'Level-up diff',
			group: 'synthesis',
			headline,
			detail: s.sourceRating
				? `You ${s.sourceRating.toFixed(0)} → target ${s.targetRating} (${s.targetSource}).`
				: undefined,
			needsEngine: false,
			severity: s.biggestGap ? 'observation' : 'inconclusive'
		});
	}
	{
		const s = buildExemplars(result.classified);
		let headline = 'Not enough games to pick exemplars.';
		let detail: string | undefined;
		if (s.representative.length > 0) {
			const r = s.representative[0];
			const c = s.contradictory[0];
			headline = `Most representative game: #${r.gameId.slice(0, 6)} (${r.result} as ${r.color}).`;
			if (c)
				detail = `Most contradictory: #${c.gameId.slice(0, 6)} (${c.result}, distance ${c.distance.toFixed(2)}).`;
		}
		cards.push({
			slug: 'exemplars',
			title: 'Exemplars',
			group: 'synthesis',
			headline,
			detail,
			needsEngine: false,
			severity: s.representative.length > 0 ? 'observation' : 'inconclusive'
		});
	}
	{
		const s = analyseProgression(result.classified, result.evalAxes?.allMoves ?? null);
		let headline = 'Not enough monthly spread yet.';
		let detail: string | undefined;
		if (s.months.length >= 2 && s.direction) {
			const first = s.months[0];
			const last = s.months[s.months.length - 1];
			const dirLabel =
				s.direction === 'improving'
					? 'improving'
					: s.direction === 'slipping'
						? 'slipping'
						: 'stable';
			headline = `${first.label} → ${last.label}: ${dirLabel}.`;
			const parts: string[] = [];
			if (s.deltaRating != null)
				parts.push(`rating ${s.deltaRating >= 0 ? '+' : ''}${s.deltaRating.toFixed(0)}`);
			if (s.deltaCpLoss != null)
				parts.push(`CP loss ${s.deltaCpLoss >= 0 ? '+' : ''}${s.deltaCpLoss.toFixed(1)}`);
			if (parts.length > 0) detail = parts.join(' · ');
		}
		let progSeverity: Severity = 'inconclusive';
		if (s.direction === 'improving') progSeverity = 'strength';
		else if (s.direction === 'slipping') progSeverity = 'concern';
		else if (s.direction === 'stable') progSeverity = 'observation';
		cards.push({
			slug: 'progression',
			title: 'Progression',
			group: 'synthesis',
			headline,
			detail,
			needsEngine: false,
			severity: progSeverity
		});
	}

	// Fallback: blank out engine-dependent cards when no eval data, so
	// their summaries don't silently show misleading defaults.
	for (const c of cards) {
		if (c.needsEngine && !hasEval) {
			c.headline = 'Run a scan with Stockfish on to populate this card.';
			c.detail = undefined;
			c.severity = 'inconclusive';
		}
	}

	// Thin-sample guardrail: when a card declared a sample denominator and
	// it falls below the card's (or the default) minimum, demote severity
	// so the report doesn't shout "critical" off a 3-game run. We preserve
	// the original headline so the reader still sees the finding — just
	// with reduced weight.
	for (const c of cards) {
		if (c.sampleSize == null) continue;
		const min = c.sampleMin ?? DEFAULT_SAMPLE_MIN;
		if (c.sampleSize < min && c.severity !== 'inconclusive') {
			c.severity = 'inconclusive';
		}
	}

	return cards;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1).trimEnd() + '…';
}
