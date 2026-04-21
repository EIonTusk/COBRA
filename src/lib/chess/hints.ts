/**
 * Convert explorer + engine signals into chessground DrawShapes painted on
 * the current board. The edit page uses this when the "hints" toggle is on.
 *
 * Palette:
 *   engine PV 1 → green, thick
 *   engine PV 2 → green, medium
 *   engine PV 3 → green, thin
 *   explorer next-popular (below coverage threshold) → paleBlue, thin
 *
 * chessground's brush list exposes green/paleGreen/blue/paleBlue/yellow/red/
 * paleRed out of the box; we use modifiers.lineWidth to vary thickness so
 * the top engine move is unmistakably dominant.
 */

import type { DrawShape } from '@lichess-org/chessground/draw';
import type { Key } from '@lichess-org/chessground/types';

import type { ExplorerMove } from '$lib/explorer/client';
import type { EngineInfo } from '$lib/stockfish/engine';

export interface EngineHintInput {
	/** Best info per multipv slot. Slot 1 is the top move. */
	byMultipv: Map<number, EngineInfo>;
}

export interface ExplorerHintInput {
	/** The position's game count (sum across all moves). */
	totalGames: number;
	/** Moves from the explorer, ordered as the API returned them. */
	moves: ExplorerMove[];
	/** Moves already in the user's tree — these are already learnt, skip. */
	knownUcis: Set<string>;
	/** Games threshold: suggestions come from moves between `threshold` and
	 *  the already-covered bracket. Pass 0 to suggest anything not in-tree. */
	threshold: number;
}

export function engineHintShapes(engine: EngineHintInput): DrawShape[] {
	const shapes: DrawShape[] = [];
	const slots = [...engine.byMultipv.entries()].sort((a, b) => a[0] - b[0]);
	for (const [slot, info] of slots) {
		if (slot > 3) break;
		const uci = info.pv[0];
		if (!uci) continue;
		const orig = uci.slice(0, 2) as Key;
		const dest = uci.slice(2, 4) as Key;
		shapes.push({
			orig,
			dest,
			brush: 'green',
			modifiers: { lineWidth: slot === 1 ? 14 : slot === 2 ? 10 : 7 }
		});
	}
	return shapes;
}

export function explorerHintShapes(explorer: ExplorerHintInput): DrawShape[] {
	const shapes: DrawShape[] = [];
	if (explorer.totalGames === 0) return shapes;
	// Pick up to 2 "next popular" moves: played below the coverage threshold
	// (not your main branches) but still meaningful (≥ 5 % of games) and
	// not already in the user's tree.
	const minGames = Math.max(explorer.threshold, explorer.totalGames * 0.05);
	const candidates = explorer.moves
		.filter((m) => !explorer.knownUcis.has(m.uci))
		.filter((m) => {
			const g = m.white + m.draws + m.black;
			return g < explorer.threshold && g >= explorer.totalGames * 0.02;
		})
		.sort((a, b) => {
			const ga = a.white + a.draws + a.black;
			const gb = b.white + b.draws + b.black;
			return gb - ga;
		})
		.slice(0, 2);

	for (const m of candidates) {
		const orig = m.uci.slice(0, 2) as Key;
		const dest = m.uci.slice(2, 4) as Key;
		shapes.push({
			orig,
			dest,
			brush: 'paleBlue',
			modifiers: { lineWidth: 6 }
		});
	}
	// Silence the unused-local warning for the helper constant.
	void minGames;
	return shapes;
}
