/**
 * Describe how a chess game ended for the walkthrough's "Game complete" card.
 *
 * Detection blends three sources, in priority order so the most precise
 * signal wins:
 *
 *   1. The final position itself — checkmate / stalemate / insufficient
 *      material / 50-move halfmove clock — read straight off `endState`.
 *   2. The PGN `Termination` header (when present) — picks up "Time forfeit",
 *      "Adjudication", "Abandoned", which can't be inferred from the position.
 *   3. The full position list, scanned for threefold repetition of the final
 *      position.
 *
 * Anything left over falls back to "resigned" (decisive) or "Draw agreed"
 * (drawn) — what masters games typically end with when the rules engine
 * can't see a forced ending.
 */

import { endState } from '$lib/chess/position';
import type { Color } from '$lib/types';

export interface GameEndDescription {
	/** Printable score, e.g. "1–0" / "½–½" / "*". */
	score: string;
	/** One-sentence description, e.g. "Carlsen resigned." */
	headline: string;
	tone: 'white' | 'black' | 'draw' | 'unknown';
}

export interface GameEndInput {
	result: string;
	termination?: string;
	whiteName?: string;
	blackName?: string;
	/** Final position FEN. Omit when the game is unfinished. */
	finalFen?: string;
	/**
	 * EPD keys of every position in the game including the starting position
	 * and after every move. Used solely to detect threefold repetition.
	 */
	positionKeys?: string[];
}

function nameOrSide(name: string | undefined, side: Color): string {
	const t = name?.trim();
	return t ? t : side === 'white' ? 'White' : 'Black';
}

export function describeGameEnd(input: GameEndInput): GameEndDescription {
	const result = (input.result ?? '').trim();
	const term = (input.termination ?? '').trim().toLowerCase();
	const white = nameOrSide(input.whiteName, 'white');
	const black = nameOrSide(input.blackName, 'black');

	const decisiveWhite = result === '1-0';
	const decisiveBlack = result === '0-1';
	const drawn = result === '1/2-1/2' || result === '½-½';

	const tone: GameEndDescription['tone'] = decisiveWhite
		? 'white'
		: decisiveBlack
			? 'black'
			: drawn
				? 'draw'
				: 'unknown';

	const score = decisiveWhite ? '1–0' : decisiveBlack ? '0–1' : drawn ? '½–½' : '*';

	// Probe the final position when we have it.
	let mate = false;
	let stale = false;
	let insufficient = false;
	let halfmoves = 0;
	if (input.finalFen) {
		try {
			const s = endState(input.finalFen);
			mate = s.checkmate;
			stale = s.stalemate;
			insufficient = s.insufficientMaterial;
			halfmoves = s.halfmoves;
		} catch {
			/* malformed FEN — fall back to result-only logic */
		}
	}

	// Threefold repetition: count occurrences of the final position. Three
	// hits = the position has been reached three times = repetition draw.
	let threefold = false;
	if (drawn && input.positionKeys && input.positionKeys.length > 0) {
		const last = input.positionKeys[input.positionKeys.length - 1];
		let count = 0;
		for (const k of input.positionKeys) if (k === last) count += 1;
		threefold = count >= 3;
	}

	// Priority: rules-detected endings first (they're certain), then the
	// Termination header (which can describe extra-board outcomes), then
	// resignation / draw-agreement fallbacks.
	if (mate) {
		const winner = decisiveWhite ? white : decisiveBlack ? black : '';
		return {
			score,
			headline: winner ? `Checkmate — ${winner} wins.` : 'Checkmate.',
			tone
		};
	}
	if (stale) {
		return { score, headline: 'Stalemate — drawn.', tone };
	}
	if (term === 'time forfeit' || term === 'time') {
		if (decisiveWhite) return { score, headline: `${black} lost on time.`, tone };
		if (decisiveBlack) return { score, headline: `${white} lost on time.`, tone };
		if (drawn) return { score, headline: 'Drawn — flag fell in an equal position.', tone };
	}
	if (term === 'adjudication' || term === 'rules infraction') {
		if (decisiveWhite) return { score, headline: `Adjudicated — ${white} wins.`, tone };
		if (decisiveBlack) return { score, headline: `Adjudicated — ${black} wins.`, tone };
		if (drawn) return { score, headline: 'Adjudicated draw.', tone };
	}
	if (term === 'abandoned' || term === 'unterminated') {
		return { score, headline: 'Game abandoned.', tone };
	}
	if (decisiveWhite) return { score, headline: `${black} resigned.`, tone };
	if (decisiveBlack) return { score, headline: `${white} resigned.`, tone };
	if (drawn) {
		if (insufficient) return { score, headline: 'Drawn — insufficient material.', tone };
		if (halfmoves >= 100) return { score, headline: 'Drawn by 50-move rule.', tone };
		if (threefold) return { score, headline: 'Drawn by threefold repetition.', tone };
		return { score, headline: 'Draw agreed.', tone };
	}
	return { score, headline: 'Game complete.', tone };
}
