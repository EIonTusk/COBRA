/**
 * Singleton runtime that mirrors the user's board / piece-set
 * preferences onto the document so every chessground instance picks
 * them up via CSS without having to thread props through the tree.
 *
 *   <html data-cobra-board="blue" data-cobra-pieces="merida">
 *
 * Both board and piece styling are emitted into a single dynamic
 * <style> tag — board as a tiny inline SVG checkerboard with the
 * theme's literal square colours, pieces as twelve url() rules
 * pointing at the vendored sprites under static/piece-sets/<id>/.
 *
 * The static layout.css still imports chessground.brown + cburnett so
 * the very first paint (before this runtime mounts and overwrites the
 * tag) lands on a reasonable default instead of bare squares.
 */

import { base } from '$app/paths';
import {
	BOARD_THEMES,
	PIECE_SETS,
	DEFAULT_BOARD_THEME,
	DEFAULT_PIECE_SET,
	normalizeBoardTheme,
	normalizePieceSet
} from './themes';

const STYLE_ID = 'cobra-appearance';

const PIECES: { role: string; file: string }[] = [
	{ role: 'king', file: 'K' },
	{ role: 'queen', file: 'Q' },
	{ role: 'rook', file: 'R' },
	{ role: 'bishop', file: 'B' },
	{ role: 'knight', file: 'N' },
	{ role: 'pawn', file: 'P' }
];

class Appearance {
	board = $state<string>(DEFAULT_BOARD_THEME);
	pieces = $state<string>(DEFAULT_PIECE_SET);

	setBoard(id: string | undefined | null) {
		this.board = normalizeBoardTheme(id);
	}

	setPieces(id: string | undefined | null) {
		this.pieces = normalizePieceSet(id);
	}

	/**
	 * Writes the data attributes and (re-)injects the <style> tag.
	 * Idempotent — safe to call from a $effect that re-runs whenever
	 * `board` or `pieces` change.
	 */
	apply() {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		root.dataset.cobraBoard = this.board;
		root.dataset.cobraPieces = this.pieces;

		let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
		if (!style) {
			style = document.createElement('style');
			style.id = STYLE_ID;
			document.head.appendChild(style);
		}
		style.textContent = `${boardCss(this.board)}\n${pieceSetCss(this.pieces)}`;
	}
}

function boardCss(themeId: string): string {
	const theme = BOARD_THEMES.find((t) => t.id === themeId);
	if (!theme) return '';
	const url = checkerboardDataUri(theme.dark);
	return `cg-board{background-color:${theme.light};background-image:url("${url}")}`;
}

/**
 * 8x8 SVG checkerboard with `dark` painted on every other cell over a
 * transparent background. The board's solid background-color shows
 * through the un-painted cells, so we only encode 32 squares of the
 * dark colour.
 *
 * Pattern matches chessground's default (a1-dark = bottom-left dark
 * when oriented as white-at-bottom, top-left dark in the SVG since the
 * SVG is viewed top-down).
 */
function checkerboardDataUri(dark: string): string {
	const cells: string[] = [];
	for (let y = 0; y < 8; y++) {
		for (let x = 0; x < 8; x++) {
			if ((x + y) % 2 === 1) cells.push(`M${x},${y}h1v1H${x}z`);
		}
	}
	const fill = encodeURIComponent(dark);
	const path = cells.join('');
	return (
		`data:image/svg+xml;utf8,` +
		`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8' ` +
		`shape-rendering='crispEdges'><path fill='${fill}' d='${path}'/></svg>`
	);
}

function pieceSetCss(setId: string): string {
	const safe = normalizePieceSet(setId);
	const lines: string[] = [];
	for (const { role, file } of PIECES) {
		lines.push(
			`.cg-wrap piece.${role}.white{background-image:url('${base}/piece-sets/${safe}/w${file}.svg')}`
		);
		lines.push(
			`.cg-wrap piece.${role}.black{background-image:url('${base}/piece-sets/${safe}/b${file}.svg')}`
		);
	}
	return lines.join('\n');
}

/** Module-level singleton — settings page and layout share one instance. */
export const appearance = new Appearance();

/** Re-exported for the picker UI. */
export { BOARD_THEMES, PIECE_SETS };
export type { BoardTheme, PieceSet } from './themes';
