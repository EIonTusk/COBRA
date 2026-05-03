/**
 * Pre-compute every finding's exhibit data so the dossier page can render
 * inline charts and tables without each section running its own analyser.
 * Each entry is a pure function over the already-loaded scan result, so
 * the whole bundle costs milliseconds, not seconds.
 *
 * Lives in its own module (rather than inline on the page) so the same
 * type can be shared across extracted exhibit components without forcing
 * each consumer to re-derive it.
 */
import { analysePieceAffinity } from './pieceAffinity';
import { analyseStructureTaste } from './structureTaste';
import { analyseExchangePropensity } from './exchangePropensity';
import { analysePlanTaste } from './planTaste';
import { buildOpeningProfile } from './openingProfile';
import { analyseEndgameSubtypes } from './endgameSubtypes';
import { analyseTacticalMotifs } from './tacticalMotifs';
import { analyseCalculationDepth } from './calculationDepth';
import { analyseDefensiveResource } from './defensiveResource';
import { analyseProphylaxis } from './prophylaxis';
import { analyseBlunderTiming } from './blunderTiming';
import { analyseTimeOfDay } from './timeOfDay';
import { analyseSessionDecay } from './sessionDecay';
import { analyseRepeatOffenders } from './repeatOffenders';
import { analyseRecoveryArc } from './recoveryArc';
import { analyseOpponentStrength } from './opponentStrength';
import { buildLevelUp } from './levelUp';
import { buildExemplars } from './exemplars';
import { analyseProgression } from './progression';
import type { DossierScanResult } from './scan';

export function buildExhibits(result: DossierScanResult) {
	const evalMoves = result.evalAxes?.allMoves ?? null;
	return {
		pieceAffinity: analysePieceAffinity(result.classified),
		structureTaste: analyseStructureTaste(result.classified),
		exchangePropensity: analyseExchangePropensity(result.classified),
		planTaste: analysePlanTaste(result.classified),
		openingFit: buildOpeningProfile(result.classified, evalMoves),
		endgameSubtypes: analyseEndgameSubtypes(result.classified, evalMoves),
		tacticalMotifs: analyseTacticalMotifs(evalMoves),
		calculationDepth: analyseCalculationDepth(result.classified, evalMoves),
		defensiveResource: analyseDefensiveResource(result.classified, evalMoves),
		prophylaxis: analyseProphylaxis(evalMoves),
		blunderTiming: analyseBlunderTiming(evalMoves),
		timeOfDay: analyseTimeOfDay(result.classified, evalMoves),
		sessionDecay: analyseSessionDecay(result.classified, evalMoves),
		repeatOffenders: analyseRepeatOffenders(result.classified, evalMoves),
		recoveryArc: analyseRecoveryArc(evalMoves),
		opponentStrength: analyseOpponentStrength(result.classified, evalMoves),
		levelUp: buildLevelUp(result.fingerprint, 200),
		exemplars: buildExemplars(result.classified),
		progression: analyseProgression(result.classified, evalMoves)
	};
}

export type DossierExhibits = ReturnType<typeof buildExhibits>;
