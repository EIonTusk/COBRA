/**
 * Render a middle-game aggregate (from `aggregateLines`) into a readable
 * answer string for an idea card. Plain text, soft-wrapped at section
 * boundaries; the idea-card panel renders this verbatim, so no markdown.
 *
 * Filtering rules are conservative — we'd rather show one strong row than
 * five noisy ones. Counts that don't clear the thresholds are dropped
 * silently. With small samples (e.g. 3 master games), the report shrinks
 * to whatever survived; that's the honest answer.
 */
import type { MiddlegameAggregate } from './aggregate';

export interface FormatOptions {
	/** Opening name (Lichess explorer's `opening.name`), if known. */
	openingName?: string | null;
	/** Cap on rows in each list. Default 6. */
	rowCap?: number;
	/** Minimum percentage of lines a row must appear in to be shown. Default 0.15. */
	minPct?: number;
	/** Minimum absolute count required (regardless of pct). Default 2. */
	minCount?: number;
}

export function formatGuide(agg: MiddlegameAggregate, options: FormatOptions = {}): string {
	const cap = options.rowCap ?? 6;
	const minPct = options.minPct ?? 0.15;
	const minCount = options.minCount ?? 2;
	const total = agg.totalLines;

	if (total === 0) {
		return 'No master games found from this position to draw common patterns from.';
	}

	const sections: string[] = [];

	const header = headerLine(total, agg.pliesWindow, options.openingName);
	if (header) sections.push(header);

	const continuations = topRows(
		agg.topNextMoves.map((m) => ({ label: m.san, count: m.count })),
		total,
		{ cap: Math.min(cap, 5), minPct, minCount: Math.min(minCount, 1) }
	);
	if (continuations.length) {
		sections.push('Common continuations:\n' + bulletList(continuations));
	}

	// Pawn breaks: separate per side so the user can read White's plan and
	// Black's plan without untangling them. A "break" is operationally any
	// pawn move played at least 2x and in ≥15% of lines; this catches both
	// genuine pawn breaks (…f5, c4) and routine non-break pawn moves (…d6,
	// …a6) — listing them as "common pawn moves" is fairer than tagging
	// them all as breaks when the heuristic can't distinguish reliably.
	const whitePawn = agg.pawnMoves.filter((p) => p.color === 'white');
	const blackPawn = agg.pawnMoves.filter((p) => p.color === 'black');
	const wRows = topRows(
		whitePawn.map((p) => ({ label: pawnLabel(p), count: p.count })),
		total,
		{ cap, minPct, minCount }
	);
	const bRows = topRows(
		blackPawn.map((p) => ({ label: pawnLabel(p), count: p.count })),
		total,
		{ cap, minPct, minCount }
	);
	if (wRows.length || bRows.length) {
		const parts: string[] = ['Common pawn moves:'];
		if (wRows.length) parts.push('  White:\n' + bulletList(wRows, '    '));
		if (bRows.length) parts.push('  Black:\n' + bulletList(bRows, '    '));
		sections.push(parts.join('\n'));
	}

	// Piece journeys: only "rerouting" — i.e. the piece actually moved away
	// from its starting square. A piece that stayed put (from === to) is
	// the boring default and would dominate the list otherwise.
	const reroutes = agg.pieceJourneys.filter((j) => j.to !== 'captured' && j.from !== j.to);
	const wReroutes = reroutes.filter((j) => j.color === 'white');
	const bReroutes = reroutes.filter((j) => j.color === 'black');
	const wReroRows = topRows(
		wReroutes.map((j) => ({ label: journeyLabel(j), count: j.count })),
		total,
		{ cap, minPct: Math.max(minPct, 0.2), minCount }
	);
	const bReroRows = topRows(
		bReroutes.map((j) => ({ label: journeyLabel(j), count: j.count })),
		total,
		{ cap, minPct: Math.max(minPct, 0.2), minCount }
	);
	if (wReroRows.length || bReroRows.length) {
		const parts: string[] = ['Piece rerouting (start → typical square):'];
		if (wReroRows.length) parts.push('  White:\n' + bulletList(wReroRows, '    '));
		if (bReroRows.length) parts.push('  Black:\n' + bulletList(bReroRows, '    '));
		sections.push(parts.join('\n'));
	}

	const castling = formatCastling(agg, total);
	if (castling) sections.push(castling);

	return sections.join('\n\n');
}

function headerLine(total: number, window: number, opening: string | null | undefined): string {
	const opener = opening ? `${opening} — ` : '';
	return `${opener}aggregated from ${total} master game${total === 1 ? '' : 's'}, looking ${window} plies past this position.`;
}

interface RowInput {
	label: string;
	count: number;
}

interface RowFilter {
	cap: number;
	minPct: number;
	minCount: number;
}

function topRows(rows: RowInput[], total: number, filter: RowFilter): string[] {
	const sorted = [...rows].sort((a, b) => b.count - a.count);
	const out: string[] = [];
	for (const r of sorted) {
		if (r.count < filter.minCount) continue;
		const pct = r.count / total;
		if (pct < filter.minPct) continue;
		out.push(`${r.label} — ${r.count}/${total} (${Math.round(pct * 100)}%)`);
		if (out.length >= filter.cap) break;
	}
	return out;
}

function bulletList(rows: string[], indent = '  '): string {
	return rows.map((r) => `${indent}• ${r}`).join('\n');
}

function pawnLabel(p: { san: string; from: string; to: string; isCapture: boolean }): string {
	// SAN already encodes captures (exf5) and disambiguation; show the
	// from-square in parentheses so the user can see the structural
	// origin without parsing SAN.
	return `${p.san}  (${p.from}→${p.to})`;
}

function journeyLabel(j: { role: string; from: string; to: string | 'captured' }): string {
	const initial = roleInitial(j.role);
	return `${initial}${j.from} → ${j.to}`;
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

function formatCastling(agg: MiddlegameAggregate, total: number): string | null {
	const c = agg.castling;
	const lines: string[] = [];
	const part = (label: string, short: number, long: number) => {
		if (short + long === 0) return null;
		const pieces: string[] = [];
		if (short > 0) pieces.push(`O-O ${short}/${total}`);
		if (long > 0) pieces.push(`O-O-O ${long}/${total}`);
		return `${label}: ${pieces.join('  ·  ')}`;
	};
	const w = part('White', c.white.short, c.white.long);
	const b = part('Black', c.black.short, c.black.long);
	if (w) lines.push('  ' + w);
	if (b) lines.push('  ' + b);
	if (!lines.length) return null;
	return 'Castling within the window:\n' + lines.join('\n');
}
