/**
 * Player profile — the "who you are" card. Drives the hero section below
 * the Scorecard. Combines v2 engine data (per-phase CP loss deltas vs
 * peers, sac tendency, conversion / defense rates, clock-bucketed CP
 * loss) with the v1 style DNA traits (tension, pawn share, forcing
 * rate) that describe *how* the user plays.
 *
 * Design: emit a small, sorted list of **badges** (concrete strengths
 * and weaknesses) with evidence strings, plus a handful of **DNA**
 * traits from v1. The UI shows the top strength large, then
 * strengths/weaknesses side-by-side, then the DNA chips.
 *
 * Every badge quotes a number so nothing is vibes-only.
 */
import type { EvalAxesSummary } from './evalAxes';
import type { DossierFingerprint, PickedBaseline } from './fingerprint';
import type { CriticalMoments } from './criticalMoments';
import type { Phase } from './classify';

export type BadgeKey =
	| 'opening_specialist'
	| 'middlegame_tactician'
	| 'endgame_grinder'
	| 'counterpuncher'
	| 'converter'
	| 'rock_solid'
	| 'opening_gap'
	| 'middlegame_drifter'
	| 'endgame_slipper'
	| 'poor_converter'
	| 'fragile_defender'
	| 'volatile'
	| 'time_troubler';

export type BadgeKind = 'strength' | 'weakness';

export interface DossierBadge {
	key: BadgeKey;
	kind: BadgeKind;
	label: string;
	tagline: string;
	evidence: string;
	/** 0..1; used to sort by strength of claim. */
	confidence: number;
}

export interface DnaTrait {
	key: string;
	label: string;
	description: string;
}

export interface DossierProfile {
	primary: DossierBadge | null;
	strengths: DossierBadge[];
	weaknesses: DossierBadge[];
	dna: DnaTrait[];
	/** Short one-liner summary combining the primary badge + DNA. */
	summary: string | null;
}

const MIN_MOVES_FOR_PHASE = 20;

export function buildDossierProfile(
	fp: DossierFingerprint,
	evalSummary: EvalAxesSummary | null,
	criticalMoments: CriticalMoments | null,
	baseline: PickedBaseline
): DossierProfile {
	const strengths: DossierBadge[] = [];
	const weaknesses: DossierBadge[] = [];

	if (evalSummary) {
		const peer = baseline.evalByPhaseColor ?? null;

		const peerPhaseAvg = (phase: Phase) => {
			if (!peer) return null;
			return (peer[phase].white.avgCpLoss + peer[phase].black.avgCpLoss) / 2;
		};
		const phaseDelta = (phase: Phase): number | null => {
			const phaseMoves = evalSummary.byPhase[phase].moves;
			if (phaseMoves < MIN_MOVES_FOR_PHASE) return null;
			const peerAvg = peerPhaseAvg(phase);
			if (peerAvg == null) return null;
			return evalSummary.byPhase[phase].avgCpLoss - peerAvg;
		};

		const openingDelta = phaseDelta('opening');
		const middleDelta = phaseDelta('middle');
		const endDelta = phaseDelta('end');

		// STRENGTHS ─────────────────────────────────────────────────
		if (openingDelta != null && openingDelta <= -15) {
			strengths.push({
				key: 'opening_specialist',
				kind: 'strength',
				label: 'Opening specialist',
				tagline: 'You arrive at move 12 ahead of the curve.',
				evidence: `Opening CP loss ${Math.round(evalSummary.byPhase.opening.avgCpLoss)} vs peers ${Math.round(peerPhaseAvg('opening')!)} cp`,
				confidence: clamp(Math.abs(openingDelta) / 40, 0.4, 1)
			});
		}
		if (
			middleDelta != null &&
			middleDelta <= -15 &&
			evalSummary.sacTendency >= 0.12 &&
			evalSummary.movesAnalysed >= 200
		) {
			strengths.push({
				key: 'middlegame_tactician',
				kind: 'strength',
				label: 'Middlegame tactician',
				tagline: 'You find combinations others miss and the engine agrees.',
				evidence: `Middle CP loss ${Math.round(evalSummary.byPhase.middle.avgCpLoss)} cp + ${pct(evalSummary.sacTendency)} sac tendency`,
				confidence: clamp(Math.abs(middleDelta) / 40 + evalSummary.sacTendency, 0.5, 1)
			});
		}
		if (endDelta != null && endDelta <= -15) {
			strengths.push({
				key: 'endgame_grinder',
				kind: 'strength',
				label: 'Endgame grinder',
				tagline: 'Equal positions turn into points for you past move 40.',
				evidence: `Endgame CP loss ${Math.round(evalSummary.byPhase.end.avgCpLoss)} vs peers ${Math.round(peerPhaseAvg('end')!)} cp`,
				confidence: clamp(Math.abs(endDelta) / 40, 0.4, 1)
			});
		}

		// Critical-moments driven (only with peer rates)
		if (criticalMoments) {
			const convDelta = deltaOrNull(
				criticalMoments.conversion.rate,
				criticalMoments.conversion.peerRate
			);
			const defDelta = deltaOrNull(criticalMoments.defense.rate, criticalMoments.defense.peerRate);

			if (convDelta != null && convDelta >= 0.1 && criticalMoments.conversion.games >= 5) {
				strengths.push({
					key: 'converter',
					kind: 'strength',
					label: 'Converter',
					tagline: "When you're winning, the game's over.",
					evidence: `${pct(criticalMoments.conversion.rate)} conversion (peers ${pct(criticalMoments.conversion.peerRate!)})`,
					confidence: clamp(convDelta * 3, 0.4, 1)
				});
			}
			if (defDelta != null && defDelta >= 0.1 && criticalMoments.defense.games >= 5) {
				strengths.push({
					key: 'counterpuncher',
					kind: 'strength',
					label: 'Counterpuncher',
					tagline: 'You fight back from the brink more often than you should.',
					evidence: `${pct(criticalMoments.defense.rate)} saves from −1.5 (peers ${pct(criticalMoments.defense.peerRate!)})`,
					confidence: clamp(defDelta * 3, 0.4, 1)
				});
			}

			if (convDelta != null && convDelta <= -0.12 && criticalMoments.conversion.games >= 5) {
				weaknesses.push({
					key: 'poor_converter',
					kind: 'weakness',
					label: 'Winning-position wobble',
					tagline: 'Your wins leak in the last stretch.',
					evidence: `${pct(criticalMoments.conversion.rate)} conversion vs peers ${pct(criticalMoments.conversion.peerRate!)}`,
					confidence: clamp(-convDelta * 3, 0.4, 1)
				});
			}
			if (defDelta != null && defDelta <= -0.12 && criticalMoments.defense.games >= 5) {
				weaknesses.push({
					key: 'fragile_defender',
					kind: 'weakness',
					label: 'Fragile defender',
					tagline: 'When pressed, positions collapse quickly.',
					evidence: `${pct(criticalMoments.defense.rate)} saves from −1.5 vs peers ${pct(criticalMoments.defense.peerRate!)}`,
					confidence: clamp(-defDelta * 3, 0.4, 1)
				});
			}
		}

		// Time trouble — aggregate CP loss by clock bucket on the fly.
		const byClock = aggregateClockCp(evalSummary);
		if (
			byClock.low.moves >= 30 &&
			byClock.high.moves >= 30 &&
			byClock.low.avg - byClock.high.avg >= 50
		) {
			weaknesses.push({
				key: 'time_troubler',
				kind: 'weakness',
				label: 'Time troubler',
				tagline: 'Your moves under 10 s fall apart in a recognisable way.',
				evidence: `Low-clock CP loss ${Math.round(byClock.low.avg)} vs ${Math.round(byClock.high.avg)} when you have time`,
				confidence: clamp((byClock.low.avg - byClock.high.avg) / 150, 0.4, 1)
			});
		}

		// Phase weaknesses
		if (openingDelta != null && openingDelta >= 20) {
			weaknesses.push({
				key: 'opening_gap',
				kind: 'weakness',
				label: 'Opening preparation gap',
				tagline: 'You arrive at move 12 already spending material.',
				evidence: `Opening CP loss ${Math.round(evalSummary.byPhase.opening.avgCpLoss)} vs peers ${Math.round(peerPhaseAvg('opening')!)} cp`,
				confidence: clamp(openingDelta / 40, 0.4, 1)
			});
		}
		if (middleDelta != null && middleDelta >= 25) {
			weaknesses.push({
				key: 'middlegame_drifter',
				kind: 'weakness',
				label: 'Middlegame drifter',
				tagline: 'Plans stall; moves go from good to average on their own.',
				evidence: `Middle CP loss ${Math.round(evalSummary.byPhase.middle.avgCpLoss)} vs peers ${Math.round(peerPhaseAvg('middle')!)} cp`,
				confidence: clamp(middleDelta / 40, 0.4, 1)
			});
		}
		if (endDelta != null && endDelta >= 25) {
			weaknesses.push({
				key: 'endgame_slipper',
				kind: 'weakness',
				label: 'Endgame slipper',
				tagline: 'Technique leaks win a third of a pawn at a time.',
				evidence: `Endgame CP loss ${Math.round(evalSummary.byPhase.end.avgCpLoss)} vs peers ${Math.round(peerPhaseAvg('end')!)} cp`,
				confidence: clamp(endDelta / 40, 0.4, 1)
			});
		}

		// Overall blunder rate vs peers
		if (peer && evalSummary.movesAnalysed >= 200) {
			const peerBlunder =
				(peer.opening.white.blunderRate +
					peer.opening.black.blunderRate +
					peer.middle.white.blunderRate +
					peer.middle.black.blunderRate +
					peer.end.white.blunderRate +
					peer.end.black.blunderRate) /
				6;
			if (peerBlunder > 0 && evalSummary.blunderRate <= peerBlunder - 0.02) {
				strengths.push({
					key: 'rock_solid',
					kind: 'strength',
					label: 'Rock solid',
					tagline: 'You rarely throw games. Your losses are earned.',
					evidence: `Blunder rate ${pct(evalSummary.blunderRate)} vs peers ${pct(peerBlunder)}`,
					confidence: clamp((peerBlunder - evalSummary.blunderRate) * 15, 0.4, 1)
				});
			}
			if (peerBlunder > 0 && evalSummary.blunderRate >= peerBlunder + 0.025) {
				weaknesses.push({
					key: 'volatile',
					kind: 'weakness',
					label: 'Volatile',
					tagline: 'Sharp blunders, not slow drift — mistakes tend to be decisive.',
					evidence: `Blunder rate ${pct(evalSummary.blunderRate)} vs peers ${pct(peerBlunder)}`,
					confidence: clamp((evalSummary.blunderRate - peerBlunder) * 15, 0.4, 1)
				});
			}
		}
	}

	strengths.sort((a, b) => b.confidence - a.confidence);
	weaknesses.sort((a, b) => b.confidence - a.confidence);

	const dna = deriveDna(fp, baseline);
	const primary = strengths[0] ?? weaknesses[0] ?? null;
	const summary = buildSummary(primary, dna);

	return {
		primary,
		strengths: strengths.slice(0, 4),
		weaknesses: weaknesses.slice(0, 4),
		dna,
		summary
	};
}

function deltaOrNull(a: number, b: number | null | undefined): number | null {
	if (b == null) return null;
	return a - b;
}

function aggregateClockCp(s: EvalAxesSummary): {
	low: { moves: number; avg: number };
	mid: { moves: number; avg: number };
	high: { moves: number; avg: number };
} {
	const buckets = {
		low: { moves: 0, sum: 0 },
		mid: { moves: 0, sum: 0 },
		high: { moves: 0, sum: 0 }
	};
	for (const m of s.allMoves) {
		if (m.clockBucket === 'none') continue;
		const b = buckets[m.clockBucket];
		b.moves += 1;
		b.sum += m.cpLoss;
	}
	return {
		low: {
			moves: buckets.low.moves,
			avg: buckets.low.moves > 0 ? buckets.low.sum / buckets.low.moves : 0
		},
		mid: {
			moves: buckets.mid.moves,
			avg: buckets.mid.moves > 0 ? buckets.mid.sum / buckets.mid.moves : 0
		},
		high: {
			moves: buckets.high.moves,
			avg: buckets.high.moves > 0 ? buckets.high.sum / buckets.high.moves : 0
		}
	};
}

function deriveDna(fp: DossierFingerprint, baseline: PickedBaseline): DnaTrait[] {
	const out: DnaTrait[] = [];
	const createDelta = fp.tension.creationRate - baseline.tension.creationRate;
	const releaseDelta = fp.tension.releaseRate - baseline.tension.releaseRate;
	const pawnDelta = fp.overall.pawnPlay - baseline.axes.pawnPlay;
	const forcingDelta = fp.overall.forcing - baseline.axes.forcing;
	const castleRate =
		(fp.byColor.white.earlyCastle * fp.byColor.white.games +
			fp.byColor.black.earlyCastle * fp.byColor.black.games) /
		Math.max(1, fp.byColor.white.games + fp.byColor.black.games);
	const castleDelta = castleRate - baseline.axes.earlyCastle;
	const qsDelta = fp.overall.queenside - baseline.axes.queenside;

	const candidates: Array<{ trait: DnaTrait; score: number }> = [];
	if (createDelta > 0.02)
		candidates.push({
			trait: {
				key: 'initiates_breaks',
				label: 'Initiates pawn breaks',
				description: 'You create pawn tension rather than steering around it.'
			},
			score: Math.abs(createDelta)
		});
	if (createDelta < -0.02)
		candidates.push({
			trait: {
				key: 'avoids_breaks',
				label: 'Avoids initiating contact',
				description: 'You keep the structure static — positions stay closed on your move.'
			},
			score: Math.abs(createDelta)
		});
	if (releaseDelta > 0.05)
		candidates.push({
			trait: {
				key: 'simplifier',
				label: 'Simplifier',
				description: 'You resolve pawn contact quickly. Trading is your default.'
			},
			score: Math.abs(releaseDelta)
		});
	if (releaseDelta < -0.05)
		candidates.push({
			trait: {
				key: 'complexity_seeker',
				label: 'Keeps positions complex',
				description: 'You let tension linger instead of committing to a resolution.'
			},
			score: Math.abs(releaseDelta)
		});
	if (pawnDelta > 0.03)
		candidates.push({
			trait: {
				key: 'pawn_driven',
				label: 'Pawn-driven',
				description: 'Higher-than-average pawn share — you play the structure.'
			},
			score: Math.abs(pawnDelta)
		});
	if (pawnDelta < -0.03)
		candidates.push({
			trait: {
				key: 'piece_player',
				label: 'Pieces over pawns',
				description: 'Lower pawn share — you lean on piece activity.'
			},
			score: Math.abs(pawnDelta)
		});
	if (forcingDelta > 0.04)
		candidates.push({
			trait: {
				key: 'forcing_heavy',
				label: 'Forcing-heavy',
				description: 'More checks and captures than peers — sharp style.'
			},
			score: Math.abs(forcingDelta)
		});
	if (forcingDelta < -0.04)
		candidates.push({
			trait: {
				key: 'quiet_mover',
				label: 'Quiet mover',
				description: 'Prefers quiet moves to forcing sequences.'
			},
			score: Math.abs(forcingDelta)
		});
	if (castleDelta > 0.08)
		candidates.push({
			trait: {
				key: 'early_castle',
				label: 'Castles early',
				description: 'King safety first — you tuck the king away before committing.'
			},
			score: Math.abs(castleDelta)
		});
	if (castleDelta < -0.1)
		candidates.push({
			trait: {
				key: 'delayed_castle',
				label: 'Delays castling',
				description: 'King often stays in the centre past move 20.'
			},
			score: Math.abs(castleDelta)
		});
	if (Math.abs(qsDelta) >= 0.04)
		candidates.push({
			trait: {
				key: 'side_bias',
				label: qsDelta > 0 ? 'Queenside-leaning' : 'Kingside-leaning',
				description:
					qsDelta > 0
						? 'Most of your activity happens on the queenside.'
						: 'Kingside play dominates your moves.'
			},
			score: Math.abs(qsDelta)
		});

	candidates.sort((a, b) => b.score - a.score);
	for (const c of candidates.slice(0, 5)) out.push(c.trait);
	return out;
}

function buildSummary(primary: DossierBadge | null, dna: DnaTrait[]): string | null {
	if (!primary && dna.length === 0) return null;
	if (primary && dna.length > 0) {
		const dnaShort = dna
			.slice(0, 2)
			.map((d) => d.label.toLowerCase())
			.join(' · ');
		return `${primary.label} — ${dnaShort}.`;
	}
	if (primary) return `${primary.label}.`;
	return dna[0]?.label ?? null;
}

function pct(x: number): string {
	return `${(x * 100).toFixed(1)}%`;
}

function clamp(x: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, x));
}
