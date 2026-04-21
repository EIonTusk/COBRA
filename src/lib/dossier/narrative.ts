/**
 * Narrative summary — a 2-3 paragraph plain-English player profile
 * generated from every axis already computed. No new data; just an
 * articulation pass. The point is to turn the dashboard into something
 * that reads like a short coach's write-up instead of a wall of numbers.
 */

import type { DossierScanResult } from './scan';
import { primarySpeed, highlightAxes, pickBaseline } from './fingerprint';
import { buildDossierProfile } from './profile';
import { buildCriticalMoments } from './criticalMoments';
import { analyseExchangePropensity } from './exchangePropensity';
import { analysePieceAffinity, minorTradeLean } from './pieceAffinity';
import { analysePlanTaste } from './planTaste';
import { analyseBlunderTiming } from './blunderTiming';
import { analyseTimeOfDay, dayLabel } from './timeOfDay';
import { analyseRecoveryArc } from './recoveryArc';
import { analyseProphylaxis } from './prophylaxis';
import { analyseOpponentStrength } from './opponentStrength';
import { analyseStructureTaste, structureLabel } from './structureTaste';
import { analyseOpeningFit } from './openingFit';
import { analyseEndgameSubtypes } from './endgameSubtypes';
import { analyseRepeatOffenders } from './repeatOffenders';
import { motifLabel } from './tacticalMotifs';

export interface NarrativeParagraph {
	heading: string;
	body: string;
}

export interface Narrative {
	headline: string;
	paragraphs: NarrativeParagraph[];
}

export function buildNarrative(result: DossierScanResult): Narrative {
	const fp = result.fingerprint;
	const evalAxes = result.evalAxes;
	const baseline = pickBaseline(fp.avgUserRating, primarySpeed(fp));
	const cm =
		evalAxes && evalAxes.movesAnalysed > 0
			? buildCriticalMoments(evalAxes.allMoves, baseline.criticalMoments ?? null)
			: null;
	const profile = buildDossierProfile(fp, evalAxes, cm, baseline);

	const exchange = analyseExchangePropensity(result.classified);
	const affinity = analysePieceAffinity(result.classified);
	const lean = minorTradeLean(affinity);
	const plans = analysePlanTaste(result.classified);
	const timing = evalAxes ? analyseBlunderTiming(evalAxes.allMoves) : null;
	const tod = analyseTimeOfDay(result.classified, evalAxes?.allMoves ?? null);
	const recovery = evalAxes ? analyseRecoveryArc(evalAxes.allMoves) : null;
	const prophy = evalAxes ? analyseProphylaxis(evalAxes.allMoves) : null;
	const opp = analyseOpponentStrength(result.classified, evalAxes?.allMoves ?? null);
	const structures = analyseStructureTaste(result.classified);
	const openingFit = analyseOpeningFit(result.classified, evalAxes?.allMoves ?? null);
	const endgames = analyseEndgameSubtypes(result.classified, evalAxes?.allMoves ?? null);
	const repeats = evalAxes ? analyseRepeatOffenders(result.classified, evalAxes.allMoves) : null;

	const paragraphs: NarrativeParagraph[] = [];

	// Who you are.
	const identityPieces: string[] = [];
	if (profile.primary) identityPieces.push(profile.primary.tagline.toLowerCase());
	if (plans.dominantPlan !== 'balanced') {
		identityPieces.push(
			plans.dominantPlan === 'kingside-pressure'
				? 'you lean toward kingside pressure'
				: plans.dominantPlan === 'queenside-pressure'
					? 'you push on the queenside'
					: 'you play through the center'
		);
	}
	if (lean.lean === 'bishop')
		identityPieces.push(
			`you keep the bishop pair (you trade knights for bishops ${(lean.kfbPct * 100).toFixed(0)}% of the time vs the reverse ${(lean.bfkPct * 100).toFixed(0)}%)`
		);
	else if (lean.lean === 'knight')
		identityPieces.push(
			`you prefer knights over bishops (trading bishops for knights ${(lean.bfkPct * 100).toFixed(0)}% vs ${(lean.kfbPct * 100).toFixed(0)}%)`
		);
	const highlights = highlightAxes(fp, 2);
	if (highlights.length > 0) {
		identityPieces.push(
			`your style skews ${highlights
				.map((h) => `${h.axis} ${h.direction === 'high' ? 'up' : 'down'}`)
				.join(', ')}`
		);
	}
	// Structures you gravitate towards
	const topStructure = structures.byStructure[0];
	if (topStructure && topStructure.games >= 5) {
		const delta = topStructure.winRate - structures.overallWinRate;
		const reading =
			delta >= 0.05
				? `where you outperform your overall by ${(delta * 100).toFixed(0)}pp`
				: delta <= -0.05
					? `but it drags your win rate down by ${(-delta * 100).toFixed(0)}pp`
					: 'with a neutral result rate';
		identityPieces.push(
			`the most common pawn skeleton in your games is ${structureLabel(topStructure.key).toLowerCase()} (${topStructure.games} games, ${reading})`
		);
	}
	paragraphs.push({
		heading: 'Who you are',
		body:
			(profile.summary ?? "You haven't accumulated enough data for a headline archetype yet.") +
			(identityPieces.length > 0 ? ' ' + sentenceJoin(identityPieces) + '.' : '')
	});

	// How you trade & navigate.
	const tradePieces: string[] = [];
	if (exchange.simplifyWhenAheadDelta > 0.005) {
		tradePieces.push(
			`when ahead in material, your piece-trade rate jumps ${(exchange.simplifyWhenAheadDelta * 100).toFixed(1)}pp above equal — a textbook simplifier`
		);
	} else if (exchange.simplifyWhenAheadDelta < -0.005) {
		tradePieces.push(
			`when ahead, you keep complicating (trade rate ${(exchange.simplifyWhenAheadDelta * 100).toFixed(1)}pp vs equal)`
		);
	}
	if (exchange.clingWhenBehindDelta < -0.005) {
		tradePieces.push(
			`when behind you dodge trades (${(exchange.clingWhenBehindDelta * 100).toFixed(1)}pp drop), fighting for counterplay instead`
		);
	} else if (exchange.clingWhenBehindDelta > 0.005) {
		tradePieces.push(
			`when behind your trade rate goes up (+${(exchange.clingWhenBehindDelta * 100).toFixed(1)}pp), which bleeds off your chances`
		);
	}
	if (prophy && prophy.opportunities >= 20) {
		tradePieces.push(
			`you neutralize ${(prophy.neutralizeRate * 100).toFixed(0)}% of the ${prophy.opportunities} real threats the engine flags in your games`
		);
	}
	paragraphs.push({
		heading: 'How you navigate',
		body:
			tradePieces.length > 0
				? capitalize(sentenceJoin(tradePieces)) + '.'
				: 'No strong trade or prophylaxis pattern — you play pieces as they come.'
	});

	// Where you struggle.
	const strugglePieces: string[] = [];
	if (timing && timing.peakBucketLabel) {
		strugglePieces.push(`your blunder rate peaks in ${timing.peakBucketLabel.toLowerCase()}`);
	}
	if (recovery && recovery.totalBlunders >= 10) {
		if (recovery.cascadeRate > 0.25)
			strugglePieces.push(
				`after a blunder, a second follows within three moves ${(recovery.cascadeRate * 100).toFixed(0)}% of the time`
			);
		if (recovery.steadyRate > 0.4)
			strugglePieces.push(
				`you settle down quickly after a slip (${(recovery.steadyRate * 100).toFixed(0)}% steady-rate)`
			);
	}
	if (opp.headline) strugglePieces.push(opp.headline.toLowerCase().replace(/\.$/, ''));
	if (profile.weaknesses.length > 0) {
		const w = profile.weaknesses[0];
		strugglePieces.push(`${w.tagline.toLowerCase()} (${w.evidence.toLowerCase()})`);
	}
	if (endgames.totalWithEndgame >= 10) {
		if (endgames.overallConversionRate < 0.5) {
			strugglePieces.push(
				`endgame conversion sits at ${(endgames.overallConversionRate * 100).toFixed(0)}% across ${endgames.totalWithEndgame} endgames — wins slip after the middlegame`
			);
		} else if (endgames.overallDefenseRate < 0.25) {
			strugglePieces.push(
				`you hold or flip only ${(endgames.overallDefenseRate * 100).toFixed(0)}% of losing endgames`
			);
		}
	}
	if (repeats && repeats.totalBlunders >= 15) {
		const topRepeat = repeats.rows[0];
		if (topRepeat && topRepeat.count >= 3) {
			strugglePieces.push(
				`${motifLabel(topRepeat.motif).toLowerCase()} with your ${topRepeat.pieceInvolved} has come back ${topRepeat.count} times`
			);
		}
	}
	const worstMisfit = openingFit.rows.find((r) => r.verdict === 'misfit');
	if (worstMisfit) {
		strugglePieces.push(
			`${worstMisfit.family} is a poor fit (${(worstMisfit.winRateDelta * 100).toFixed(0)}pp win rate vs your overall)`
		);
	}
	paragraphs.push({
		heading: 'Where you struggle',
		body:
			strugglePieces.length > 0
				? capitalize(sentenceJoin(strugglePieces)) + '.'
				: 'Your accuracy is stable across phases and contexts — no obvious structural weakness.'
	});

	// Tendencies.
	const tendencyPieces: string[] = [];
	if (tod.bestHour != null && tod.worstHour != null && tod.bestHour !== tod.worstHour) {
		tendencyPieces.push(`you're sharpest at ${tod.bestHour}:00 and weakest at ${tod.worstHour}:00`);
	}
	if (tod.bestDay != null && tod.worstDay != null && tod.bestDay !== tod.worstDay) {
		tendencyPieces.push(
			`${dayLabel(tod.bestDay)} is your best weekday, ${dayLabel(tod.worstDay)} your worst`
		);
	}
	if (plans.kingsideStormGames > 0 || plans.minorityAttackGames > 0) {
		tendencyPieces.push(
			`you storm pawns kingside in ${plans.kingsideStormGames} of ${plans.totalGames} games${plans.minorityAttackGames > 0 ? ` and queenside in ${plans.minorityAttackGames}` : ''}`
		);
	}
	paragraphs.push({
		heading: 'Tendencies',
		body:
			tendencyPieces.length > 0
				? capitalize(sentenceJoin(tendencyPieces)) + '.'
				: 'No clear schedule or plan pattern has emerged from the scanned sample.'
	});

	const headline = profile.primary
		? `${profile.primary.label} — ${profile.primary.tagline}`
		: 'Dossier profile';

	return { headline, paragraphs };
}

function sentenceJoin(parts: string[]): string {
	if (parts.length === 0) return '';
	if (parts.length === 1) return parts[0];
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function capitalize(s: string): string {
	if (!s) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}
