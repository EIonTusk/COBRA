/**
 * Small formatting helpers shared across the Dossier page and the
 * components extracted from it. Kept out of any module that does heavy
 * imports so they're cheap to pull into a leaf component.
 */

export const PHASE_LABEL = {
	opening: 'Opening',
	middle: 'Middlegame',
	end: 'Endgame'
} as const;

export type Phase = keyof typeof PHASE_LABEL;

/** Render a [0, 1] ratio as a percent with a single decimal place. Thin
 *  alias over `pctFmt` — kept because the one-arg call site is by far the
 *  most common; remove if/when every caller passes an explicit `digits`. */
export function pct(x: number): string {
	return pctFmt(x, 1);
}

/** Build a Lichess analysis URL for an arbitrary FEN. The page links to
 *  these for any move where the user wants to dig deeper. */
export function lichessAnalysisUrl(fen: string): string {
	return `https://lichess.org/analysis/standard/${encodeURIComponent(fen)}`;
}

/** Compact wall-clock formatter — `42s`, `7m`, `1.4h`. */
export function fmtSec(sec: number): string {
	if (sec >= 3600) return `${(sec / 3600).toFixed(1)}h`;
	if (sec >= 60) return `${Math.round(sec / 60)}m`;
	return `${Math.round(sec)}s`;
}

/** ISO yyyy-mm-dd, or `—` for null. Used in scope/methodology and the
 *  hero strip — same formatter so date strings render consistently. */
export function formatDateShort(ms: number | null): string {
	if (ms == null) return '—';
	const d = new Date(ms);
	return d.toISOString().slice(0, 10);
}

import type { Severity } from './deepInsights';

/** Tailwind class set for the bordered tile rendering of a severity tier. */
export function severityTint(s: Severity): string {
	switch (s) {
		case 'critical':
			return 'border-red-500/60 bg-red-950/20 text-red-300';
		case 'concern':
			return 'border-amber-300/50 bg-amber-950/20 text-amber-300';
		case 'strength':
			return 'border-emerald-500/50 bg-emerald-950/20 text-emerald-300';
		case 'observation':
			return 'border-[var(--color-ink-700)] bg-[var(--color-ink-950)] text-[var(--color-parchment-300)]';
		default:
			return 'border-[var(--color-ink-800)] bg-[var(--color-ink-950)] text-[var(--color-parchment-500)]';
	}
}

/** Percent with configurable decimal places — `73.4%`, `73%`. */
export function pctFmt(x: number, digits = 1): string {
	return `${(x * 100).toFixed(digits)}%`;
}

/** Signed percentage-point delta, e.g. `+3.2pp`, `−1.0pp`. */
export function signedPctFmt(x: number, digits = 1): string {
	const sign = x >= 0 ? '+' : '';
	return `${sign}${(x * 100).toFixed(digits)}pp`;
}

/** Display labels for the seven v1 style axes used in fingerprint output. */
export const AXIS_LABEL: Record<string, string> = {
	forcing: 'Forcing moves',
	capture: 'Captures',
	pawnPlay: 'Pawn moves',
	queenside: 'Queenside play',
	earlyCastle: 'Early castle',
	tensionRelease: 'Tension release rate',
	tensionCreate: 'Tension creation rate'
};

/** Bar width helper for inline progress / delta visualisations. Clamps to
 *  [2%, 100%] so a tiny but non-zero value stays visible. */
export function barWidth(value: number, max: number): string {
	if (max <= 0) return '0%';
	return `${Math.min(100, Math.max(2, (value / max) * 100)).toFixed(1)}%`;
}

/** Solid-colour Tailwind class for the small severity status dot. */
export function severityDot(s: Severity): string {
	switch (s) {
		case 'critical':
			return 'bg-red-400';
		case 'concern':
			return 'bg-amber-400';
		case 'strength':
			return 'bg-emerald-400';
		case 'observation':
			return 'bg-[var(--color-parchment-400)]';
		default:
			return 'bg-[var(--color-ink-700)]';
	}
}
