/**
 * Score how closely a user's played continuation from a position follows
 * the master-game "plan" captured in the saved aggregate at that
 * position. Three sub-scores — pawn moves, piece reroutings, attack
 * squares — are combined into one overall adherence score in 0..1.
 *
 * Pure: no IO. Caller supplies the user's continuation (UCI moves
 * starting from the entry position, capped to ~12 plies) and the
 * `SerializedMiddlegameAggregate` baked into the saved guide. The
 * function is intentionally agnostic about where the user's game came
 * from — Lichess scan, chess.com archive, manual paste — so it can be
 * wired into any post-game review surface later.
 *
 * Scoring intent: the score answers "of the typical plan elements at
 * this position, how many did this game cover?". A high score means the
 * user broke where masters break, rerouted pieces to typical squares,
 * and pressed the typical key squares. A low score doesn't mean the
 * game was bad — it just diverged from masters' typical handling.
 */
import type { Color, SerializedMiddlegameAggregate } from '$lib/types';

import { walkContinuation, type WalkedLine } from '$lib/middlegame/aggregate';

export interface PlanAdherenceMatch {
	kind: 'pawn' | 'piece' | 'square';
	/** Human-readable label. */
	label: string;
	/** Count in master-game aggregate (the strength of the pattern). */
	count: number;
	/** Total master lines the aggregate was based on. */
	total: number;
}

export interface PlanAdherenceMiss {
	kind: 'pawn' | 'piece' | 'square';
	/** Pattern label the user didn't follow. */
	label: string;
	/** Master count + total — useful for the UI to mark "high-weight misses". */
	count: number;
	total: number;
}

export interface PlanAdherenceSection {
	/** Score 0..1 — weighted by master-game frequency of each pattern. */
	score: number;
	/** Patterns the user covered. */
	matches: PlanAdherenceMatch[];
	/** Patterns the user diverged from. */
	misses: PlanAdherenceMiss[];
}

export interface PlanAdherence {
	pawn: PlanAdherenceSection;
	piece: PlanAdherenceSection;
	square: PlanAdherenceSection;
	/** Weighted average of the three sub-scores, 0..1. */
	overall: number;
	/** How many plies of the user's continuation were actually walked. */
	pliesScored: number;
	/** Echo of the aggregate's `totalLines` for context in the UI. */
	masterLines: number;
}

export interface ScoreOptions {
	/** Base FEN of the position the guide is pinned at. */
	baseFen: string;
	/** User's continuation in UCI, from the base position forward. */
	line: string[];
	/** The saved guide's aggregate. */
	aggregate: SerializedMiddlegameAggregate;
	/** The user's colour — patterns for this side are scored against the user's moves. */
	userColor: Color;
	/** Plies forward to walk; defaults to `aggregate.pliesWindow`. */
	maxPlies?: number;
	/**
	 * Minimum count for a master-aggregate pattern to participate in
	 * scoring at all. Sub-threshold patterns are dropped to keep the
	 * weighting honest. Default 2.
	 */
	minCount?: number;
	/**
	 * Minimum percentage of master lines a pattern must clear to count.
	 * Mirrors the thresholds used by the plan-card generator. Default 0.18.
	 */
	minPct?: number;
}

/**
 * Empty section used when scoring can't run (no walk, no patterns).
 * Score is 0 by definition — there's no positive evidence.
 */
function emptySection(): PlanAdherenceSection {
	return { score: 0, matches: [], misses: [] };
}

export function scorePlanAdherence(opts: ScoreOptions): PlanAdherence | null {
	const maxPlies = opts.maxPlies ?? opts.aggregate.pliesWindow;
	const minCount = opts.minCount ?? 2;
	const minPct = opts.minPct ?? 0.18;
	const total = opts.aggregate.totalLines;

	const walked = walkContinuation(opts.baseFen, opts.line, maxPlies);
	if (!walked || total === 0) return null;

	const pawn = scorePawn(walked, opts.aggregate, opts.userColor, total, minCount, minPct);
	const piece = scorePiece(walked, opts.aggregate, opts.userColor, total, minCount, minPct);
	const square = scoreSquare(walked, opts.aggregate, opts.userColor, total, minCount, minPct);

	// Overall is a frequency-weighted average across the three sections.
	// Each section's weight is the total count of its participating
	// patterns — so a section with one strongly-weighted pattern (e.g.
	// 9/10 master games castle short) carries more than a section with
	// three barely-qualifying ones. Sections with no qualifying patterns
	// contribute zero weight and don't drag the score down by counting
	// as a "missed" zero.
	const weights = [
		sectionWeight(pawn, total),
		sectionWeight(piece, total),
		sectionWeight(square, total)
	];
	const weighted = pawn.score * weights[0] + piece.score * weights[1] + square.score * weights[2];
	const denom = weights[0] + weights[1] + weights[2];
	const overall = denom > 0 ? weighted / denom : 0;

	return {
		pawn,
		piece,
		square,
		overall,
		pliesScored: walked.moves.length,
		masterLines: total
	};
}

function sectionWeight(s: PlanAdherenceSection, total: number): number {
	let w = 0;
	for (const m of s.matches) w += m.count / total;
	for (const m of s.misses) w += m.count / total;
	return w;
}

function scorePawn(
	walked: WalkedLine,
	agg: SerializedMiddlegameAggregate,
	color: Color,
	total: number,
	minCount: number,
	minPct: number
): PlanAdherenceSection {
	// Qualifying master pawn moves for the user's colour.
	const qualifying = agg.pawnMoves.filter(
		(p) => p.color === color && p.count >= minCount && p.count / total >= minPct
	);
	if (qualifying.length === 0) return emptySection();

	// User's actual pawn moves in the window, keyed by from+to (per-game
	// dedup: a pawn doesn't move from a square twice, so set semantics
	// are correct without an explicit dedup).
	const played = new Set<string>();
	for (const m of walked.moves) {
		if (m.color !== color || m.role !== 'pawn') continue;
		played.add(`${m.from}|${m.to}`);
	}

	const matches: PlanAdherenceMatch[] = [];
	const misses: PlanAdherenceMiss[] = [];
	let matchedWeight = 0;
	let totalWeight = 0;
	for (const p of qualifying) {
		const key = `${p.from}|${p.to}`;
		const weight = p.count / total;
		totalWeight += weight;
		if (played.has(key)) {
			matchedWeight += weight;
			matches.push({
				kind: 'pawn',
				label: `${p.san} (${p.from} → ${p.to})`,
				count: p.count,
				total
			});
		} else {
			misses.push({
				kind: 'pawn',
				label: `${p.san} (${p.from} → ${p.to})`,
				count: p.count,
				total
			});
		}
	}
	return {
		score: totalWeight > 0 ? matchedWeight / totalWeight : 0,
		matches,
		misses
	};
}

function scorePiece(
	walked: WalkedLine,
	agg: SerializedMiddlegameAggregate,
	color: Color,
	total: number,
	minCount: number,
	minPct: number
): PlanAdherenceSection {
	// Master piece-journey patterns we care about: non-pawn, non-captured,
	// non-stationary, for the user's colour, above thresholds.
	const qualifying = agg.pieceJourneys.filter(
		(j) =>
			j.color === color &&
			j.role !== 'pawn' &&
			j.to !== 'captured' &&
			j.from !== j.to &&
			j.count >= minCount &&
			j.count / total >= minPct
	);
	if (qualifying.length === 0) return emptySection();

	// User's piece journeys at the end of the walked window. `walked.journeys`
	// already encodes (start square → final square) per non-pawn piece
	// for both sides.
	const userJourneys = new Map<string, string>(); // key=role|from -> finalSquare
	for (const j of walked.journeys) {
		if (j.color !== color) continue;
		if (j.role === 'pawn') continue;
		if (j.to === 'captured') continue;
		userJourneys.set(`${j.role}|${j.from}`, j.to);
	}

	const matches: PlanAdherenceMatch[] = [];
	const misses: PlanAdherenceMiss[] = [];
	let matchedWeight = 0;
	let totalWeight = 0;
	for (const j of qualifying) {
		const weight = j.count / total;
		totalWeight += weight;
		const final = userJourneys.get(`${j.role}|${j.from}`);
		const label = `${roleInitial(j.role)}${j.from} → ${j.to}`;
		if (final === j.to) {
			matchedWeight += weight;
			matches.push({ kind: 'piece', label, count: j.count, total });
		} else {
			misses.push({ kind: 'piece', label, count: j.count, total });
		}
	}
	return {
		score: totalWeight > 0 ? matchedWeight / totalWeight : 0,
		matches,
		misses
	};
}

function scoreSquare(
	walked: WalkedLine,
	agg: SerializedMiddlegameAggregate,
	color: Color,
	total: number,
	minCount: number,
	minPct: number
): PlanAdherenceSection {
	// Restrict to opponent-half squares — same convention as the plan-card
	// generator; "key squares" means squares the side is pressing, not
	// parking.
	const halfFilter = (sq: string): boolean => {
		const rank = Number.parseInt(sq[1], 10) || 0;
		return color === 'white' ? rank >= 5 : rank <= 4;
	};
	const qualifying = agg.attackSquares.filter(
		(a) =>
			a.attacker === color &&
			halfFilter(a.square) &&
			a.count >= minCount &&
			a.count / total >= minPct
	);
	if (qualifying.length === 0) return emptySection();

	// User's landed-on squares in the window for their pieces (per-line
	// dedup: each square counts once per game even if a piece pendulums).
	const userLandings = new Set<string>();
	for (const m of walked.moves) {
		if (m.color !== color) continue;
		if (m.castle) continue;
		userLandings.add(m.to);
	}

	const matches: PlanAdherenceMatch[] = [];
	const misses: PlanAdherenceMiss[] = [];
	let matchedWeight = 0;
	let totalWeight = 0;
	for (const a of qualifying) {
		const weight = a.count / total;
		totalWeight += weight;
		if (userLandings.has(a.square)) {
			matchedWeight += weight;
			matches.push({ kind: 'square', label: a.square, count: a.count, total });
		} else {
			misses.push({ kind: 'square', label: a.square, count: a.count, total });
		}
	}
	return {
		score: totalWeight > 0 ? matchedWeight / totalWeight : 0,
		matches,
		misses
	};
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
