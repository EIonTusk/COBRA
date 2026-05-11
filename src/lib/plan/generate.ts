/**
 * Synthesise a plan-card prompt + answer from a position's master-game
 * aggregate. The "plan" here is the side's typical pawn breaks + piece
 * reroutings + king location + key attack squares within the next ~12
 * plies — the cluster of decisions a human would describe when asked
 * "what should I be aiming for in this kind of position?".
 *
 * Pure: no IO. The aggregate is provided by the caller (`SavedMiddlegameGuide.aggregate`
 * for already-pinned positions, or a fresh `generateMiddlegameGuide`
 * result for a one-off card creation).
 */
import type { Color, SerializedMiddlegameAggregate } from '$lib/types';

export interface PlanCardContent {
	prompt: string;
	answer: string;
}

export interface PlanGenerateOptions {
	aggregate: SerializedMiddlegameAggregate;
	planForColor: Color;
	openingName?: string | null;
	/** Minimum percentage of master lines a row must clear to be listed. Default 0.18. */
	minPct?: number;
	/** Minimum absolute count regardless of percentage. Default 2. */
	minCount?: number;
	/** Cap on rows per section. Default 3. */
	maxRows?: number;
}

export function generatePlanCardContent(options: PlanGenerateOptions): PlanCardContent {
	const minPct = options.minPct ?? 0.18;
	const minCount = options.minCount ?? 2;
	const maxRows = options.maxRows ?? 3;
	const agg = options.aggregate;
	const color = options.planForColor;
	const total = agg.totalLines;

	const sideLabel = color === 'white' ? 'White' : 'Black';
	const promptOpening = options.openingName ? ` (${options.openingName})` : '';
	const prompt = `What's the typical middle-game plan for ${sideLabel}${promptOpening} here?`;

	if (total === 0) {
		return {
			prompt,
			answer: 'No master-game data was available when this card was generated.'
		};
	}

	const sections: string[] = [];
	sections.push(
		`Drawn from ${total} master game${total === 1 ? '' : 's'}, ~${agg.pliesWindow} plies forward.`
	);

	// Pawn breaks for the side. The aggregate stores pawn moves with the
	// originating colour; we filter by `color` and pick the top-N that
	// clear the threshold. Capture moves are kept (xf5 etc.) since they're
	// real plan elements.
	const pawnRows = topRows(
		agg.pawnMoves
			.filter((p) => p.color === color)
			.map((p) => ({ label: `${p.san} (${p.from} → ${p.to})`, count: p.count })),
		total,
		{ minPct, minCount, cap: maxRows }
	);
	if (pawnRows.length) {
		sections.push(`Pawn moves for ${sideLabel}:\n` + bulletList(pawnRows));
	}

	// Piece reroutings: drop pieces that stayed put (from===to) since they
	// don't represent a plan, and drop captured pieces (the route ended on
	// the board, but as a loss).
	const pieceRows = topRows(
		agg.pieceJourneys
			.filter(
				(j) => j.color === color && j.to !== 'captured' && j.from !== j.to && j.role !== 'pawn'
			)
			.map((j) => ({ label: `${roleInitial(j.role)}${j.from} → ${j.to}`, count: j.count })),
		total,
		{ minPct: Math.max(minPct, 0.2), minCount, cap: maxRows }
	);
	if (pieceRows.length) {
		sections.push(`Piece rerouting for ${sideLabel}:\n` + bulletList(pieceRows));
	}

	// Key squares to press: aggregate already filters per-line, so a count
	// of N means N distinct master games where the side's pieces landed
	// there. Restrict to the opponent's half (ranks 5–8 from White's side,
	// 1–4 from Black's) so we report "where am I attacking" rather than
	// "where am I parked".
	const halfFilter = (sq: string): boolean => {
		const rank = Number.parseInt(sq[1], 10) || 0;
		return color === 'white' ? rank >= 5 : rank <= 4;
	};
	const squareRows = topRows(
		agg.attackSquares
			.filter((a) => a.attacker === color && halfFilter(a.square))
			.map((a) => ({ label: a.square, count: a.count })),
		total,
		{ minPct: Math.max(minPct, 0.25), minCount, cap: maxRows }
	);
	if (squareRows.length) {
		sections.push(`Key squares ${sideLabel} presses:\n` + bulletList(squareRows));
	}

	// Castling tendency: only emit if at least one side castled in ≥30%
	// of lines, so the row carries signal. King safety in this window is
	// part of the plan — "delays castling" is itself notable when it's
	// the majority pattern.
	const c = agg.castling[color];
	if (total > 0 && c.short + c.long > 0) {
		const short = c.short;
		const long = c.long;
		const neither = total - short - long;
		const parts: string[] = [];
		if (short > 0) parts.push(`O-O ${pct(short, total)}`);
		if (long > 0) parts.push(`O-O-O ${pct(long, total)}`);
		if (neither > 0 && neither / total >= 0.3)
			parts.push(`delays / no castle ${pct(neither, total)}`);
		if (parts.length > 0) {
			sections.push(`King safety for ${sideLabel}:\n  ` + parts.join(' · '));
		}
	}

	return {
		prompt,
		answer: sections.join('\n\n')
	};
}

interface RowInput {
	label: string;
	count: number;
}

function topRows(
	rows: RowInput[],
	total: number,
	filter: { cap: number; minPct: number; minCount: number }
): string[] {
	const sorted = [...rows].sort((a, b) => b.count - a.count);
	const out: string[] = [];
	for (const r of sorted) {
		if (r.count < filter.minCount) continue;
		if (r.count / total < filter.minPct) continue;
		out.push(`${r.label} — ${r.count}/${total} (${Math.round((r.count / total) * 100)}%)`);
		if (out.length >= filter.cap) break;
	}
	return out;
}

function bulletList(rows: string[]): string {
	return rows.map((r) => `  • ${r}`).join('\n');
}

function pct(n: number, d: number): string {
	return `${n}/${d} (${Math.round((n / d) * 100)}%)`;
}

function roleInitial(role: string): string {
	switch (role) {
		case 'king':
			return 'K';
		case 'queen':
			return 'Q';
		case 'rook':
			return 'R';
		case 'bishop':
			return 'B';
		case 'knight':
			return 'N';
		default:
			return '';
	}
}
