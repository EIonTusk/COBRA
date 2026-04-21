/**
 * Interpret raw v2 eval-axes output into human-readable insights.
 *
 * The numbers `analyseEvalAxes` produces (avg CP loss, blunder rate,
 * inaccuracy rate, sac tendency, per-phase split) only mean something
 * once you contrast them against typical play and against each other.
 * This module bundles those contrasts:
 *
 *  - **weakestPhase**: phase where avg CP loss is highest, with the
 *    contrast vs your best phase if the gap is meaningful.
 *  - **tacticalProfile**: 'sacrificer' / 'materialist' / 'balanced'
 *    based on sac tendency.
 *  - **consistency**: 'reliable' / 'streaky' / 'volatile' from the
 *    blunder/inaccuracy ratio (high blunders + low inaccuracies = sharp
 *    swings; balanced = steady; high inaccuracies + low blunders =
 *    "knows the right idea, drifts on execution").
 *  - **headlines**: 2–4 most informative one-liners drawn from the above.
 *
 * Rating translation is intentionally left out — CP loss alone is a
 * cleaner, speed-agnostic measure.
 */

import type { EvalAxesSummary, PhaseEvalSummary } from './evalAxes';
import type { Phase } from './classify';

export type TacticalProfile = 'sacrificer' | 'materialist' | 'balanced';
export type Consistency = 'reliable' | 'steady' | 'streaky' | 'volatile';

export interface EvalInterpretation {
	weakestPhase: { phase: Phase; cpLoss: number } | null;
	bestPhase: { phase: Phase; cpLoss: number } | null;
	tacticalProfile: TacticalProfile;
	consistency: Consistency;
	headlines: string[];
}

export function interpretEvalAxes(summary: EvalAxesSummary): EvalInterpretation {
	const { weakestPhase, bestPhase } = phaseExtremes(summary.byPhase);
	const tacticalProfile = classifyTactical(summary.sacTendency);
	const consistency = classifyConsistency(summary.blunderRate, summary.inaccuracyRate);

	const headlines: string[] = [];

	// Headline anchor — bare CP loss, no rating translation.
	if (summary.movesAnalysed >= 100) {
		headlines.push(
			`Average CP loss ${Math.round(summary.avgCpLoss)} cp over ${summary.movesAnalysed} moves.`
		);
	}

	// Phase weakness — only if the gap is meaningful.
	if (weakestPhase && bestPhase && weakestPhase.phase !== bestPhase.phase) {
		const gap = weakestPhase.cpLoss - bestPhase.cpLoss;
		if (gap >= 30) {
			headlines.push(
				`Weakest in the ${PHASE_LABEL[weakestPhase.phase]} (${Math.round(weakestPhase.cpLoss)} cp avg) — ` +
					`${gap >= 80 ? 'much higher' : 'higher'} than your ${PHASE_LABEL[bestPhase.phase]} (${Math.round(bestPhase.cpLoss)} cp).`
			);
		}
	}

	// Tactical profile.
	if (tacticalProfile === 'sacrificer') {
		headlines.push(
			`Sac tendency ${pct(summary.sacTendency)} — willing to give up material when the engine endorses it.`
		);
	} else if (tacticalProfile === 'materialist' && summary.movesAnalysed >= 100) {
		headlines.push(
			`You almost never sac material the engine likes — strict materialist (${pct(summary.sacTendency)}).`
		);
	}

	// Consistency.
	if (consistency === 'volatile') {
		headlines.push(
			`Blunders dominate over inaccuracies (${pct(summary.blunderRate)} vs ${pct(summary.inaccuracyRate)}) — ` +
				`mistakes tend to be sharp; check the time-pressure card.`
		);
	} else if (consistency === 'streaky') {
		headlines.push(
			`Inaccuracies cluster (${pct(summary.inaccuracyRate)}) without many outright blunders (${pct(summary.blunderRate)}) — ` +
				`you drift on execution rather than missing tactics.`
		);
	} else if (consistency === 'reliable') {
		headlines.push(
			`Low blunder + inaccuracy rates (${pct(summary.blunderRate)} / ${pct(summary.inaccuracyRate)}) — solid baseline.`
		);
	}

	return {
		weakestPhase,
		bestPhase,
		tacticalProfile,
		consistency,
		headlines: headlines.slice(0, 4)
	};
}

function phaseExtremes(byPhase: Record<Phase, PhaseEvalSummary>): {
	weakestPhase: { phase: Phase; cpLoss: number } | null;
	bestPhase: { phase: Phase; cpLoss: number } | null;
} {
	const eligible: Array<{ phase: Phase; cpLoss: number; moves: number }> = [];
	for (const phase of ['opening', 'middle', 'end'] as const) {
		const p = byPhase[phase];
		if (p.moves < 10) continue;
		eligible.push({ phase, cpLoss: p.avgCpLoss, moves: p.moves });
	}
	if (eligible.length === 0) return { weakestPhase: null, bestPhase: null };
	const sorted = [...eligible].sort((a, b) => a.cpLoss - b.cpLoss);
	return {
		bestPhase: { phase: sorted[0].phase, cpLoss: sorted[0].cpLoss },
		weakestPhase: {
			phase: sorted[sorted.length - 1].phase,
			cpLoss: sorted[sorted.length - 1].cpLoss
		}
	};
}

function classifyTactical(sacTendency: number): TacticalProfile {
	if (sacTendency >= 0.25) return 'sacrificer';
	if (sacTendency <= 0.05) return 'materialist';
	return 'balanced';
}

function classifyConsistency(blunderRate: number, inaccuracyRate: number): Consistency {
	if (blunderRate <= 0.03 && inaccuracyRate <= 0.1) return 'reliable';
	if (blunderRate >= 0.08 && inaccuracyRate < blunderRate * 1.5) return 'volatile';
	if (inaccuracyRate >= 0.2 && blunderRate <= 0.05) return 'streaky';
	return 'steady';
}

const PHASE_LABEL: Record<Phase, string> = {
	opening: 'opening',
	middle: 'middlegame',
	end: 'endgame'
};

function pct(x: number): string {
	return `${(x * 100).toFixed(1)}%`;
}
