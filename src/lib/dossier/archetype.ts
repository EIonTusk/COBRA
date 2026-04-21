/**
 * Derive a one-line "archetype" from a DossierFingerprint by combining
 * axes that individually only mean a little. The point is to give the
 * dashboard a headline a human can read in one glance — "structural
 * conservative", "active trader", etc. — instead of five percentages.
 *
 * v1 covers two combinable dimensions:
 *  - Structure: pawn-play + tension creation. Low/low = piece-player who
 *    leaves the skeleton alone. High/high = pawn-driven structural game.
 *  - Tempo: release rate + forcing rate. Low release + low forcing =
 *    patient. High release + high forcing = trader.
 */

import {
	pickBaseline,
	primarySpeed,
	type OpeningProfile,
	type DossierFingerprint
} from './fingerprint';

export interface Archetype {
	headline: string;
	subline: string;
	tags: string[];
	structure: StructureLabel;
	tempo: TempoLabel;
}

export type StructureLabel =
	| 'conservative'
	| 'aggressor'
	| 'piece_player'
	| 'pawn_driven'
	| 'balanced';

export type TempoLabel = 'patient' | 'trader' | 'forcing' | 'quiet' | 'balanced';

export interface OpeningHint {
	color: 'white' | 'black' | 'both';
	families: string[];
	structures: string[];
	rationale: string;
}

export function deriveArchetype(fp: DossierFingerprint): Archetype {
	// Compare against the rating-bucketed baseline so an archetype like
	// "structural conservative" measures the user against actual peers,
	// not against the eyeballed neutral.
	const baseline = pickBaseline(fp.avgUserRating, primarySpeed(fp));
	const pawnDelta = fp.overall.pawnPlay - baseline.axes.pawnPlay;
	const createDelta = fp.tension.creationRate - baseline.tension.creationRate;
	const releaseDelta = fp.tension.releaseRate - baseline.tension.releaseRate;
	const forcingDelta = fp.overall.forcing - baseline.axes.forcing;

	const tags: string[] = [];

	let structure: StructureLabel;
	if (pawnDelta < -0.03 && createDelta < -0.015) {
		structure = 'conservative';
		tags.push('pieces over pawns', 'avoids initiating contact');
	} else if (pawnDelta > 0.03 && createDelta > 0.015) {
		structure = 'aggressor';
		tags.push('pawn-driven', 'initiates pawn breaks');
	} else if (pawnDelta < -0.03) {
		structure = 'piece_player';
		tags.push('low pawn share');
	} else if (pawnDelta > 0.03) {
		structure = 'pawn_driven';
		tags.push('above-average pawn share');
	} else {
		structure = 'balanced';
	}

	let tempo: TempoLabel;
	if (releaseDelta < -0.03 && forcingDelta < 0.02) {
		tempo = 'patient';
		tags.push('keeps positions complex');
	} else if (releaseDelta > 0.03 && forcingDelta > 0.02) {
		tempo = 'trader';
		tags.push('resolves contact early');
	} else if (forcingDelta > 0.04) {
		tempo = 'forcing';
		tags.push('reaches for tactics');
	} else if (forcingDelta < -0.04) {
		tempo = 'quiet';
	} else {
		tempo = 'balanced';
	}

	const headline = `${labelStructure(structure)} · ${labelTempo(tempo)}`;
	const subline = sublineFor(structure, tempo);
	return { headline, subline, tags, structure, tempo };
}

function labelStructure(s: StructureLabel): string {
	return {
		conservative: 'Structural conservative',
		aggressor: 'Structural aggressor',
		piece_player: 'Piece-player',
		pawn_driven: 'Pawn-driven',
		balanced: 'Structurally balanced'
	}[s];
}

function labelTempo(t: TempoLabel): string {
	return {
		patient: 'patient',
		trader: 'trader',
		forcing: 'forcing-heavy',
		quiet: 'quiet-leaning',
		balanced: 'tempo-balanced'
	}[t];
}

function sublineFor(structure: StructureLabel, tempo: TempoLabel): string {
	if (structure === 'conservative' && tempo === 'patient')
		return 'You play the pieces and let the position simmer. Closed and semi-open structures should suit you; open tactical melees less so.';
	if (structure === 'aggressor' && tempo === 'trader')
		return 'You make the position move — pawn breaks plus resolved contact. Sharp lines reward this.';
	if (structure === 'piece_player')
		return 'You navigate by piece play more than pawn play. Watch for closed positions where you have no breaks.';
	if (tempo === 'forcing')
		return 'You reach for forcing moves often. Make sure the position is asking for them — see the leak detector.';
	if (tempo === 'patient')
		return 'You let tension build. Strong in strategic positions; check that you are not missing won material (see leaks).';
	return 'A balanced profile across the v1 axes.';
}

/**
 * v2 empirical recommendations driven by the user's actual `byOpening`
 * win rates vs their overall win rate. Three buckets:
 *
 *  - **working**: families with ≥ MIN_GAMES games where you outperform
 *    your overall by ≥ EDGE_PP. Keep doing what you're doing.
 *  - **underperforming**: same sample threshold, but you score worse by
 *    ≥ EDGE_PP. Candidates to either rework or drop from the rep.
 *  - **explore**: archetype-fit families you've played < EXPLORE_MAX_GAMES
 *    times. Heuristic seeds — the only piece still derived from
 *    archetype labels rather than your data.
 *
 * Falls back entirely to the legacy heuristic when total games < 30 — at
 * that sample size win-rate noise drowns the signal and you'd just see
 * one lucky family ranked first.
 */
export interface EmpiricalRec {
	family: string;
	games: number;
	winRate: number;
	deltaVsOverall: number;
	rationale: string;
}

export interface EmpiricalRecs {
	working: EmpiricalRec[];
	underperforming: EmpiricalRec[];
	explore: EmpiricalRec[];
	dataSparse: boolean;
}

const MIN_GAMES = 8;
const EDGE_PP = 0.05; // 5 percentage points
const EXPLORE_MAX_GAMES = 5;
const SPARSE_TOTAL = 30;

export function empiricalOpeningRecs(fp: DossierFingerprint, arch: Archetype): EmpiricalRecs {
	const totalGames = fp.results.win + fp.results.loss + fp.results.draw;
	if (totalGames < SPARSE_TOTAL) {
		return { working: [], underperforming: [], explore: [], dataSparse: true };
	}
	const overallWinRate = (fp.results.win + 0.5 * fp.results.draw) / Math.max(1, totalGames);

	const working: EmpiricalRec[] = [];
	const underperforming: EmpiricalRec[] = [];

	for (const o of fp.byOpening) {
		if (o.games < MIN_GAMES) continue;
		const delta = o.winRate - overallWinRate;
		if (delta >= EDGE_PP) {
			working.push({
				family: o.family,
				games: o.games,
				winRate: o.winRate,
				deltaVsOverall: delta,
				rationale: rationaleForWorking(o, delta, arch)
			});
		} else if (delta <= -EDGE_PP) {
			underperforming.push({
				family: o.family,
				games: o.games,
				winRate: o.winRate,
				deltaVsOverall: delta,
				rationale: rationaleForUnderperforming(o, delta, arch)
			});
		}
	}
	working.sort((a, b) => b.deltaVsOverall - a.deltaVsOverall);
	underperforming.sort((a, b) => a.deltaVsOverall - b.deltaVsOverall);

	const explore = exploreCandidates(fp, arch);

	return {
		working: working.slice(0, 5),
		underperforming: underperforming.slice(0, 5),
		explore: explore.slice(0, 4),
		dataSparse: false
	};
}

function rationaleForWorking(o: OpeningProfile, delta: number, arch: Archetype): string {
	const pp = (delta * 100).toFixed(1);
	const tags: string[] = [];
	if (o.pawnPlay > 0.34 && (arch.structure === 'aggressor' || arch.structure === 'pawn_driven')) {
		tags.push('matches your pawn-driven structure');
	}
	if (
		o.pawnPlay < 0.3 &&
		(arch.structure === 'piece_player' || arch.structure === 'conservative')
	) {
		tags.push('lets you maneuver behind a fixed structure');
	}
	if (o.forcing > 0.32 && (arch.tempo === 'forcing' || arch.tempo === 'trader')) {
		tags.push('rewards forcing play');
	}
	const why = tags.length > 0 ? tags.join('; ') : 'win rate sustained over a meaningful sample';
	return `+${pp}pp vs your overall over ${o.games} games — ${why}.`;
}

function rationaleForUnderperforming(o: OpeningProfile, delta: number, arch: Archetype): string {
	const pp = Math.abs(delta * 100).toFixed(1);
	const tags: string[] = [];
	if (
		o.pawnPlay > 0.34 &&
		(arch.structure === 'piece_player' || arch.structure === 'conservative')
	) {
		tags.push('your piece-player profile struggles in pawn-heavy structures');
	}
	if (o.pawnPlay < 0.3 && (arch.structure === 'aggressor' || arch.structure === 'pawn_driven')) {
		tags.push('your pawn-driven plans get muted in piece-y positions');
	}
	if (o.forcing > 0.32 && arch.tempo === 'patient') {
		tags.push('the line asks for forcing play but your tempo is patient');
	}
	const why = tags.length > 0 ? tags.join('; ') : 'consistent underperformance — review or drop';
	return `−${pp}pp vs your overall over ${o.games} games — ${why}.`;
}

/**
 * The one place archetype heuristics still seed recommendations: families
 * we *think* fit your style that you've barely played. Marked clearly as
 * untested in the UI; once you have 8+ games in one it'll get promoted
 * to working/underperforming on the next scan.
 */
function exploreCandidates(fp: DossierFingerprint, arch: Archetype): EmpiricalRec[] {
	const playedFamilies = new Set<string>(
		fp.byOpening.filter((o) => o.games >= EXPLORE_MAX_GAMES).map((o) => o.family)
	);

	const seeds: { family: string; rationale: string }[] = [];
	if (arch.structure === 'conservative' || arch.structure === 'piece_player') {
		seeds.push(
			{ family: 'Caro-Kann', rationale: 'Solid skeleton suits a piece-player.' },
			{ family: 'French', rationale: 'Maneuvering room behind a fixed centre.' },
			{ family: 'Spanish (Ruy Lopez)', rationale: 'Long-game pressure as White.' }
		);
	}
	if (arch.structure === 'aggressor' || arch.structure === 'pawn_driven') {
		seeds.push(
			{ family: "King's Indian", rationale: 'Pawn breaks define the game.' },
			{ family: 'Grünfeld', rationale: 'Asymmetric, dynamic counterplay.' },
			{ family: 'Sicilian', rationale: 'Sharp pawn races.' }
		);
	}
	if (arch.tempo === 'forcing' || arch.tempo === 'trader') {
		seeds.push(
			{ family: 'Sicilian', rationale: 'Open lines reward forcing instincts.' },
			{ family: 'Italian / Two Knights', rationale: 'Direct, tactical Italian lines.' }
		);
	}
	if (arch.tempo === 'patient') {
		seeds.push(
			{ family: 'Slav', rationale: 'Slow strategic play with tension on the board.' },
			{ family: "Queen's Gambit", rationale: 'Classical structures rewarding patience.' }
		);
	}

	const out: EmpiricalRec[] = [];
	const seen = new Set<string>();
	for (const s of seeds) {
		if (seen.has(s.family)) continue;
		if (playedFamilies.has(s.family)) continue;
		seen.add(s.family);
		out.push({
			family: s.family,
			games: 0,
			winRate: 0,
			deltaVsOverall: 0,
			rationale: s.rationale
		});
	}
	return out;
}

/**
 * Legacy heuristic. Kept for the sparse-data fallback only. New consumers
 * should call `empiricalOpeningRecs(fp, arch)` instead.
 */
export function archetypeOpeningHints(arch: Archetype): OpeningHint[] {
	const hints: OpeningHint[] = [];

	if (arch.structure === 'conservative' || arch.structure === 'piece_player') {
		hints.push({
			color: 'black',
			families: ['Caro-Kann', 'French Defense', "Petroff's Defense"],
			structures: ['solid pawn skeleton', 'piece play behind a fixed center'],
			rationale:
				'These give you a stable structure to maneuver behind — your strength — without forcing you into early pawn breaks.'
		});
		hints.push({
			color: 'white',
			families: ['London System', 'Colle System', 'Closed Catalan'],
			structures: ['fixed pawn triangle', 'long-game pressure'],
			rationale: 'Systems that arrive at familiar middlegames without sharp opening theory.'
		});
	}

	if (arch.structure === 'aggressor' || arch.structure === 'pawn_driven') {
		hints.push({
			color: 'white',
			families: ['Sämisch KID setups', 'English with f4', 'Bayonet KID'],
			structures: ['queenside expansion', 'space advantage'],
			rationale: 'Pawn-driven plans that reward initiating contact.'
		});
		hints.push({
			color: 'black',
			families: ['Grünfeld Defense', 'Benoni', 'Dutch Leningrad'],
			structures: ['dynamic counterplay', 'asymmetric pawn structures'],
			rationale: 'Asymmetric structures where pawn breaks decide the game.'
		});
	}

	if (arch.tempo === 'patient' && hints.length === 0) {
		hints.push({
			color: 'both',
			families: ['Slav', 'Italian Game', 'Closed Sicilian'],
			structures: ['slow strategic play'],
			rationale: 'Lines where keeping tension on the board is the main idea.'
		});
	}

	if (arch.tempo === 'forcing' || arch.tempo === 'trader') {
		hints.push({
			color: 'white',
			families: ['Open Sicilian', 'Ruy Lopez Open', 'Scotch Game'],
			structures: ['open lines', 'fast piece development'],
			rationale: 'Sharp open positions that reward your forcing instincts.'
		});
	}

	if (hints.length === 0) {
		hints.push({
			color: 'both',
			families: ['Italian Game', 'Queens Gambit Declined'],
			structures: ['classical mainlines'],
			rationale: 'Balanced classical openings while we collect more data.'
		});
	}

	return hints;
}
