/**
 * Repeat-offender patterns — tactical themes you blunder repeatedly.
 * Leverages the motif labels from tacticalMotifs and counts the top
 * (motif, piece-role) pairs so you can see "you blunder knight forks"
 * or "you miss back-rank threats with your queen".
 */

import { analyseTacticalMotifs, type Motif, motifLabel } from './tacticalMotifs';
import type { EvalMoveResult } from './evalAxes';
import type { MoveFeatures, ClassifiedGame } from './classify';

export interface OffenderRow {
	motif: Motif;
	pieceInvolved: string; // user piece moving in the blunder
	count: number;
	avgCpLoss: number;
	exampleFens: string[];
}

export interface RepeatOffenderSummary {
	totalBlunders: number;
	rows: OffenderRow[];
	/** Longest streak of same-motif repeats in chronological order. */
	longestStreak: { motif: Motif; length: number } | null;
}

export function analyseRepeatOffenders(
	games: ClassifiedGame[],
	evalMoves: EvalMoveResult[] | null | undefined
): RepeatOffenderSummary {
	const motifs = analyseTacticalMotifs(evalMoves);
	if (motifs.instances.length === 0) return { totalBlunders: 0, rows: [], longestStreak: null };

	const feats = new Map<string, MoveFeatures>();
	for (const g of games) {
		for (const m of g.moves) feats.set(`${g.gameId}:${m.ply}`, m);
	}

	const key = (m: Motif, role: string) => `${m}|${role}`;
	const map = new Map<
		string,
		{ count: number; cpSum: number; fens: string[]; motif: Motif; piece: string }
	>();
	const chronological: { motif: Motif; playedAt: number; ply: number }[] = [];

	for (const inst of motifs.instances) {
		const f = feats.get(`${inst.gameId}:${inst.ply}`);
		const piece = f?.pieceRole ?? 'unknown';
		for (const motif of inst.motifs) {
			const k = key(motif, piece);
			const prev = map.get(k) ?? { count: 0, cpSum: 0, fens: [], motif, piece };
			prev.count += 1;
			prev.cpSum += inst.cpLoss;
			if (prev.fens.length < 5) prev.fens.push(inst.fenBefore);
			map.set(k, prev);
			chronological.push({ motif, playedAt: inst.playedAt, ply: inst.ply });
		}
	}

	const rows: OffenderRow[] = Array.from(map.values())
		.filter((v) => v.motif !== 'unclassified')
		.map((v) => ({
			motif: v.motif,
			pieceInvolved: v.piece,
			count: v.count,
			avgCpLoss: v.count > 0 ? v.cpSum / v.count : 0,
			exampleFens: v.fens
		}))
		.sort((a, b) => b.count - a.count);

	// Longest same-motif streak across chronological order.
	chronological.sort((a, b) => a.playedAt - b.playedAt || a.ply - b.ply);
	let longestStreak: RepeatOffenderSummary['longestStreak'] = null;
	let currentMotif: Motif | null = null;
	let streak = 0;
	for (const e of chronological) {
		if (e.motif === currentMotif) {
			streak += 1;
		} else {
			currentMotif = e.motif;
			streak = 1;
		}
		if (!longestStreak || streak > longestStreak.length) {
			if (currentMotif !== 'unclassified') longestStreak = { motif: currentMotif, length: streak };
		}
	}

	return {
		totalBlunders: motifs.total,
		rows,
		longestStreak
	};
}

export function offenderHeading(r: OffenderRow): string {
	const role = r.pieceInvolved === 'unknown' ? '' : ` with your ${r.pieceInvolved}`;
	return `${motifLabel(r.motif)}${role}`;
}
