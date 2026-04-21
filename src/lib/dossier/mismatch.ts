/**
 * Leak detector. Compares each user move's actual response to what the
 * position demanded (computed in `demand.ts`) and flags mismatches.
 *
 * v1 leak types:
 *  - missed_capture: a winning capture was on offer (≥2 pawns of material)
 *    and the user played a non-capture instead.
 *  - impatient_forcing: closed center + no winning capture available, but
 *    the user played a forcing move (capture or check) anyway. Often a
 *    structural waste of tempo.
 *
 * Each leak is scored 0..1 by severity (currently a thin proxy:
 * bestCaptureGain / 9 capped at 1). Aggregated counts and a top-N list of
 * the worst leaks are surfaced for the UI.
 */

import type { ClassifiedGame, MoveFeatures, Phase } from './classify';
import type { Color } from '$lib/types';

export type LeakType = 'missed_capture' | 'impatient_forcing' | 'missed_attack';

export interface LeakInstance {
	gameId: string;
	playedAt: number;
	color: Color;
	phase: Phase;
	ply: number;
	type: LeakType;
	severity: number;
	san: string;
	fenBefore: string;
	bestCaptureGain: number;
}

export interface LeakSummary {
	totalUserMoves: number;
	counts: Record<LeakType, number>;
	rates: Record<LeakType, number>;
	byPhase: Record<Phase, Record<LeakType, number>>;
	worst: LeakInstance[];
}

export function detectLeaks(games: ClassifiedGame[], topN = 10): LeakSummary {
	const counts: Record<LeakType, number> = {
		missed_capture: 0,
		impatient_forcing: 0,
		missed_attack: 0
	};
	const byPhase: Record<Phase, Record<LeakType, number>> = {
		opening: { missed_capture: 0, impatient_forcing: 0, missed_attack: 0 },
		middle: { missed_capture: 0, impatient_forcing: 0, missed_attack: 0 },
		end: { missed_capture: 0, impatient_forcing: 0, missed_attack: 0 }
	};
	const all: LeakInstance[] = [];
	let totalUserMoves = 0;

	for (const g of games) {
		for (const m of g.moves) {
			totalUserMoves += 1;
			const leak = classifyLeak(m);
			if (!leak) continue;
			counts[leak] += 1;
			byPhase[m.phase][leak] += 1;
			all.push({
				gameId: g.gameId,
				playedAt: g.playedAt,
				color: g.color,
				phase: m.phase,
				ply: m.ply,
				type: leak,
				severity: leakSeverity(leak, m),
				san: m.san,
				fenBefore: m.fenBefore,
				bestCaptureGain: m.demand.bestCaptureGain
			});
		}
	}

	const safe = totalUserMoves || 1;
	const rates: Record<LeakType, number> = {
		missed_capture: counts.missed_capture / safe,
		impatient_forcing: counts.impatient_forcing / safe,
		missed_attack: counts.missed_attack / safe
	};

	all.sort((a, b) => b.severity - a.severity);

	return {
		totalUserMoves,
		counts,
		rates,
		byPhase,
		worst: all.slice(0, topN)
	};
}

function classifyLeak(m: MoveFeatures): LeakType | null {
	if (m.demand.hangingCapture && !m.isCapture) return 'missed_capture';
	// kingExposed reads as a missed attack only when the user *also* didn't
	// just take material on offer — captures and checks are themselves
	// attacking moves and shouldn't be flagged. Pawn moves are exempted
	// because pawn pushes are often the actual attacking try (e.g., g4-g5).
	if (
		m.demand.kingExposed &&
		!m.demand.hangingCapture &&
		!m.isCapture &&
		!m.isCheck &&
		!m.isPawnMove &&
		!m.isCastle
	)
		return 'missed_attack';
	if (m.demand.closedCenter && !m.demand.hangingCapture && (m.isCapture || m.isCheck))
		return 'impatient_forcing';
	return null;
}

function leakSeverity(type: LeakType, m: MoveFeatures): number {
	if (type === 'missed_capture') {
		return Math.min(1, m.demand.bestCaptureGain / 9);
	}
	if (type === 'missed_attack') return 0.5;
	return 0.4;
}
