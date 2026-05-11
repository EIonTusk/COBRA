/**
 * Convert a middle-game aggregate (from `aggregateLines`) into chessground
 * arrows so the edit-page board can paint typical pawn moves, piece
 * reroutings, and the most-popular immediate continuation.
 *
 * Brush convention:
 *   - top continuation(s) → green (matches the engine-PV convention used
 *     elsewhere; the user already reads green as "what's played next")
 *   - common pawn moves   → yellow (structural / pawn-break colour)
 *   - piece reroutings    → paleBlue (long-term piece path)
 *
 * Castling normalisation: chessops emits castling as king→own-rook
 * (e1h1 / e1a1). Drawing that as-is reads as "king takes its own rook";
 * we override to the standard king→g1/c1 square for top-continuation
 * arrows so the visual matches what a player expects.
 */
import type { DrawShape } from '@lichess-org/chessground/draw';
import type { Key } from '@lichess-org/chessground/types';

import type { Color, SavedGuideArrow } from '$lib/types';

import type { MiddlegameAggregate, PawnMoveStat, PieceJourneyStat } from './aggregate';

export interface ArrowOptions {
	/** Max top-continuation arrows. Default 2. */
	maxContinuations?: number;
	/** Hard ceiling on total pawn-move arrows (per-pawn cap is also applied). Default 12. */
	maxPawnMoves?: number;
	/** Hard ceiling on total piece-journey arrows (per-piece cap is also applied). Default 12. */
	maxPieceJourneys?: number;
	/** Per starting square (= per pawn or per piece), the max destinations to surface. Default 3. */
	maxDestsPerOrigin?: number;
	/** Max weakness circles per side. Default 3. */
	maxWeaknesses?: number;
	/** Minimum count for any non-continuation row to be drawn. Default 2. */
	minCount?: number;
	/** Minimum percentage of lines for any non-continuation row. Default 0.15. */
	minPct?: number;
	/** Minimum percentage of lines for a square to qualify as a weakness. Default 0.25. */
	minWeaknessPct?: number;
	/**
	 * The user's repertoire colour. Used to colour weakness circles from
	 * the user's perspective: opponent-attacker → paleRed (defend); user-
	 * attacker → purple (press). Omit to default to the white-perspective
	 * mapping (white attacks → purple, black attacks → paleRed).
	 */
	userColor?: Color;
}

export function aggregateToArrows(
	agg: MiddlegameAggregate,
	options: ArrowOptions = {}
): DrawShape[] {
	if (agg.totalLines === 0) return [];

	const maxCont = options.maxContinuations ?? 2;
	const maxPawn = options.maxPawnMoves ?? 12;
	const maxPiece = options.maxPieceJourneys ?? 12;
	const maxDestsPerOrigin = options.maxDestsPerOrigin ?? 3;
	const maxWeak = options.maxWeaknesses ?? 3;
	const minCount = options.minCount ?? 2;
	const minPct = options.minPct ?? 0.15;
	const minWeaknessPct = options.minWeaknessPct ?? 0.25;
	const userColor = options.userColor;

	const total = agg.totalLines;
	const shapes: DrawShape[] = [];
	const usedKeys = new Set<string>();
	const usedCircles = new Set<string>();

	const addShape = (orig: Key, dest: Key, brush: string, lineWidth: number) => {
		if (orig === dest) return;
		const key = `${orig}->${dest}`;
		if (usedKeys.has(key)) return;
		usedKeys.add(key);
		shapes.push({ orig, dest, brush, modifiers: { lineWidth } });
	};

	const addCircle = (orig: Key, brush: string) => {
		const key = `circle:${brush}:${orig}`;
		if (usedCircles.has(key)) return;
		usedCircles.add(key);
		shapes.push({ orig, brush });
	};

	// Top continuations: clear the field (highest visual weight) so the user
	// reads them first.
	const conts = agg.topNextMoves.slice(0, maxCont);
	conts.forEach((m, idx) => {
		const norm = normaliseUci(m.uci, m.san);
		const lineWidth = idx === 0 ? 14 : 10;
		addShape(norm.orig, norm.dest, 'green', lineWidth);
	});

	// Pawn moves: group by (color, from-square) so a single pawn's two
	// common destinations both show up — early-opening play diverges, and
	// hiding the second-choice break behind a global cap was confusing.
	const pawnRows = perOriginRows<PawnMoveStat>(
		agg.pawnMoves,
		(p) => `${p.color}|${p.from}`,
		total,
		minCount,
		minPct,
		maxDestsPerOrigin,
		maxPawn
	);
	for (const p of pawnRows) {
		const lineWidth = scaleWidth(p.count, total, 5, 10);
		addShape(p.from as Key, p.to as Key, 'yellow', lineWidth);
	}

	// Piece reroutings: same per-origin grouping. The g1-knight that
	// commonly goes to either f3 or e2 should show both arrows, not lose
	// the second one to a global top-N filter.
	const journeyRows = perOriginRows<PieceJourneyStat>(
		agg.pieceJourneys.filter((j) => j.to !== 'captured' && j.from !== j.to),
		(j) => `${j.color}|${j.role}|${j.from}`,
		total,
		minCount,
		minPct,
		maxDestsPerOrigin,
		maxPiece
	);
	for (const j of journeyRows) {
		const lineWidth = scaleWidth(j.count, total, 5, 10);
		addShape(j.from as Key, j.to as Key, 'paleBlue', lineWidth);
	}

	// Weaknesses: squares each side most often LANDS on inside the
	// opponent's half. The defender's half is empirically defined as ranks
	// 5–8 from white's attacker perspective (= black's territory) and
	// ranks 1–4 from black's. We only paint the top-N per attacker so the
	// board doesn't disappear under a sea of circles.
	const whiteWeak = agg.attackSquares
		.filter(
			(a) =>
				a.attacker === 'white' && squareRank(a.square) >= 5 && a.count / total >= minWeaknessPct
		)
		.slice(0, maxWeak);
	const blackWeak = agg.attackSquares
		.filter(
			(a) =>
				a.attacker === 'black' && squareRank(a.square) <= 4 && a.count / total >= minWeaknessPct
		)
		.slice(0, maxWeak);
	const userPressBrush = 'purple';
	const opponentPressBrush = 'paleRed';
	// Map attacker-colour → brush. With a userColor we colour from the
	// user's perspective; without it, default to a stable white-perspective.
	const brushFor = (attacker: Color): string => {
		if (userColor) return attacker === userColor ? userPressBrush : opponentPressBrush;
		return attacker === 'white' ? userPressBrush : opponentPressBrush;
	};
	for (const w of whiteWeak) addCircle(w.square as Key, brushFor('white'));
	for (const w of blackWeak) addCircle(w.square as Key, brushFor('black'));

	return shapes;
}

function squareRank(sq: string): number {
	return Number.parseInt(sq[1], 10) || 0;
}

/**
 * Group rows by an "origin key" (e.g. starting square + role) and emit up
 * to `perOriginCap` rows per group, all of which must clear the threshold.
 * Result is sorted globally by count desc — the strongest pattern overall
 * leads the rendered list, but every grouped origin keeps its top-N
 * options instead of being hostage to a global top-N filter that would
 * swap a piece's secondary destination for an unrelated piece's primary.
 */
function perOriginRows<T extends { count: number }>(
	rows: T[],
	keyFn: (r: T) => string,
	total: number,
	minCount: number,
	minPct: number,
	perOriginCap: number,
	totalCap: number
): T[] {
	const grouped = new Map<string, T[]>();
	for (const r of rows) {
		if (r.count < minCount) continue;
		if (r.count / total < minPct) continue;
		const k = keyFn(r);
		const arr = grouped.get(k);
		if (arr) arr.push(r);
		else grouped.set(k, [r]);
	}
	const out: T[] = [];
	for (const arr of grouped.values()) {
		arr.sort((a, b) => b.count - a.count);
		for (let i = 0; i < Math.min(arr.length, perOriginCap); i++) out.push(arr[i]);
	}
	out.sort((a, b) => b.count - a.count);
	return out.slice(0, totalCap);
}

function scaleWidth(count: number, total: number, min: number, max: number): number {
	const pct = Math.min(1, count / Math.max(1, total));
	return Math.round(min + (max - min) * pct);
}

/**
 * chessops emits castling as king→own-rook. For the *top continuation*
 * arrow we want the standard king→g/c destination so the picture matches
 * how players read O-O / O-O-O. Detect by SAN, override; everything else
 * passes through unchanged.
 */
function normaliseUci(uci: string, san: string): { orig: Key; dest: Key } {
	if (san === 'O-O' || san === 'O-O-O') {
		const rank = uci[1];
		const destFile = san === 'O-O' ? 'g' : 'c';
		return { orig: ('e' + rank) as Key, dest: (destFile + rank) as Key };
	}
	return { orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key };
}

/**
 * Reduce a chessground DrawShape to the IDB-friendly `SavedGuideArrow`
 * form. Keeps standard from→to arrows AND circles (no `dest`, used for
 * weakness markers). chessground piece overlays and label-only shapes
 * (NAG glyphs from the drill) are dropped — the saved-guide flow only
 * persists arrows + circles.
 */
export function shapesToSavedArrows(shapes: DrawShape[]): SavedGuideArrow[] {
	const out: SavedGuideArrow[] = [];
	for (const s of shapes) {
		if (!s.brush || !s.orig) continue;
		// Skip label-only shapes (no brush-driven render).
		const arrow: SavedGuideArrow = {
			orig: s.orig,
			brush: s.brush
		};
		if (s.dest) arrow.dest = s.dest;
		const lw = s.modifiers?.lineWidth;
		if (typeof lw === 'number') arrow.lineWidth = lw;
		out.push(arrow);
	}
	return out;
}

export function savedArrowsToShapes(arrows: SavedGuideArrow[]): DrawShape[] {
	return arrows.map((a) => {
		const shape: DrawShape = { orig: a.orig as Key, brush: a.brush };
		if (a.dest) shape.dest = a.dest as Key;
		if (a.lineWidth !== undefined) shape.modifiers = { lineWidth: a.lineWidth };
		return shape;
	});
}
