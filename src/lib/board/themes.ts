/**
 * Board theme catalogue + piece-set catalogue.
 *
 * Each board theme is a pair of square colours (light / dark) inspired
 * by the Lichess defaults. The CSS that paints them lives in
 * `src/routes/layout.css` under `[data-cobra-board=...]` selectors —
 * adding a theme here without adding the matching CSS block won't have
 * any effect.
 *
 * Each piece set is a folder under `static/piece-sets/<id>/<piece>.svg`.
 * Adding a piece set here without the SVGs will render empty squares.
 */

export interface BoardTheme {
	id: string;
	label: string;
	/** Light squares — what the user sees as the dominant board colour. */
	light: string;
	/** Dark squares. */
	dark: string;
}

export interface PieceSet {
	id: string;
	label: string;
}

/**
 * Order matters — this is the order shown in the settings picker.
 * `brown` stays first because it's the historical default and the only
 * one that ships in the chessground npm package as a stylesheet.
 */
export const BOARD_THEMES: readonly BoardTheme[] = [
	{ id: 'brown', label: 'Brown', light: '#f0d9b5', dark: '#b58863' },
	{ id: 'blue', label: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
	{ id: 'green', label: 'Green', light: '#ffffdd', dark: '#86a666' },
	{ id: 'ic', label: 'Ice', light: '#ececec', dark: '#c1c18e' },
	{ id: 'purple', label: 'Purple', light: '#9f90b0', dark: '#7d4a8d' },
	{ id: 'gray', label: 'Gray', light: '#bababa', dark: '#6f6f6f' },
	{ id: 'newspaper', label: 'Newspaper', light: '#f4f1ea', dark: '#a8a39a' },
	{ id: 'parchment', label: 'Parchment', light: '#ede0c4', dark: '#9d7d4f' }
] as const;

export const PIECE_SETS: readonly PieceSet[] = [
	{ id: 'cburnett', label: 'Cburnett' },
	{ id: 'merida', label: 'Merida' },
	{ id: 'alpha', label: 'Alpha' },
	{ id: 'california', label: 'California' },
	{ id: 'horsey', label: 'Horsey' },
	{ id: 'staunty', label: 'Staunty' },
	{ id: 'letter', label: 'Letter' },
	{ id: 'invisible', label: 'Invisible' }
] as const;

const BOARD_IDS = new Set(BOARD_THEMES.map((t) => t.id));
const PIECE_IDS = new Set(PIECE_SETS.map((p) => p.id));

export const DEFAULT_BOARD_THEME = 'brown';
export const DEFAULT_PIECE_SET = 'cburnett';

export function isBoardTheme(id: string | undefined | null): boolean {
	return !!id && BOARD_IDS.has(id);
}

export function isPieceSet(id: string | undefined | null): boolean {
	return !!id && PIECE_IDS.has(id);
}

export function normalizeBoardTheme(id: string | undefined | null): string {
	return isBoardTheme(id) ? (id as string) : DEFAULT_BOARD_THEME;
}

export function normalizePieceSet(id: string | undefined | null): string {
	return isPieceSet(id) ? (id as string) : DEFAULT_PIECE_SET;
}
