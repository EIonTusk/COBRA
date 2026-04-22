/**
 * Defensive resourcefulness. Looks at moves where the user was in a
 * losing position (eval ≤ −150 cp from user POV) and asks: did the game
 * flip, hold (draw), or collapse? Split by difficulty of defense, which
 * we proxy with the branching factor of the position (more legal moves =
 * easier to find a resource; few legal moves = a forced-move situation).
 *
 * The defense *rate* column: (wins + draws) / games where user entered
 * any move in that state. "Entered" = the move was made from a losing
 * eval state. One snapshot per game (earliest qualifying move) so a
 * long game can't inflate the denominator.
 */

import type { ClassifiedGame, MoveFeatures } from './classify';
import type { EvalMoveResult } from './evalAxes';
import { wilsonInterval, type Interval } from './stats';

export type DifficultyBucket = 'only-move' | 'few-options' | 'many-options';

export interface DefenseRow {
	bucket: DifficultyBucket;
	games: number;
	held: number;
	flipped: number;
	lost: number;
	defenseRate: number;
	/** Wilson 95% CI for this bucket's defense rate. */
	defenseCI95: Interval;
}

export interface DefenseSummary {
	totalLosingEntries: number;
	overallDefenseRate: number;
	overallDefenseCI95: Interval;
	byDifficulty: DefenseRow[];
	avgLegalMovesAtEntry: number;
}

const DIFFICULTY_LABEL: Record<DifficultyBucket, string> = {
	'only-move': '1–3 legal replies (only-move)',
	'few-options': '4–15 legal replies',
	'many-options': '16+ legal replies'
};

export function difficultyLabel(d: DifficultyBucket): string {
	return DIFFICULTY_LABEL[d];
}

export function analyseDefensiveResource(
	games: ClassifiedGame[],
	evalMoves: EvalMoveResult[] | null | undefined
): DefenseSummary {
	if (!evalMoves || evalMoves.length === 0)
		return {
			totalLosingEntries: 0,
			overallDefenseRate: 0,
			overallDefenseCI95: { lo: 0, hi: 0 },
			byDifficulty: [],
			avgLegalMovesAtEntry: 0
		};

	// MoveFeatures index for legalMovesBefore lookups.
	const feats = new Map<string, MoveFeatures>();
	const gameById = new Map<string, ClassifiedGame>();
	for (const g of games) {
		gameById.set(g.gameId, g);
		for (const m of g.moves) feats.set(`${g.gameId}:${m.ply}`, m);
	}

	// Group eval moves by gameId, then find the first move (by ply) where
	// userEvalBeforeCp <= -150.
	const firstLosing = new Map<string, EvalMoveResult>();
	for (const m of evalMoves) {
		if (m.userEvalBeforeCp > -150) continue;
		const prev = firstLosing.get(m.gameId);
		if (!prev || prev.ply > m.ply) firstLosing.set(m.gameId, m);
	}

	const rows: Record<DifficultyBucket, DefenseRow> = {
		'only-move': {
			bucket: 'only-move',
			games: 0,
			held: 0,
			flipped: 0,
			lost: 0,
			defenseRate: 0,
			defenseCI95: { lo: 0, hi: 0 }
		},
		'few-options': {
			bucket: 'few-options',
			games: 0,
			held: 0,
			flipped: 0,
			lost: 0,
			defenseRate: 0,
			defenseCI95: { lo: 0, hi: 0 }
		},
		'many-options': {
			bucket: 'many-options',
			games: 0,
			held: 0,
			flipped: 0,
			lost: 0,
			defenseRate: 0,
			defenseCI95: { lo: 0, hi: 0 }
		}
	};

	let legalSum = 0;
	let legalCount = 0;

	for (const [gameId, entry] of firstLosing) {
		const g = gameById.get(gameId);
		if (!g) continue;
		const f = feats.get(`${gameId}:${entry.ply}`);
		const legal = f?.legalMovesBefore ?? 0;
		legalSum += legal;
		legalCount += 1;

		const bucket: DifficultyBucket =
			legal <= 3 ? 'only-move' : legal <= 15 ? 'few-options' : 'many-options';
		const row = rows[bucket];
		row.games += 1;
		if (g.result === 'win') row.flipped += 1;
		else if (g.result === 'draw') row.held += 1;
		else row.lost += 1;
	}

	let total = 0;
	let saved = 0;
	for (const k of ['only-move', 'few-options', 'many-options'] as const) {
		const r = rows[k];
		const savedInBucket = r.held + r.flipped;
		r.defenseRate = r.games > 0 ? savedInBucket / r.games : 0;
		r.defenseCI95 = wilsonInterval(savedInBucket, r.games);
		total += r.games;
		saved += savedInBucket;
	}

	return {
		totalLosingEntries: total,
		overallDefenseRate: total > 0 ? saved / total : 0,
		overallDefenseCI95: wilsonInterval(saved, total),
		byDifficulty: [rows['only-move'], rows['few-options'], rows['many-options']],
		avgLegalMovesAtEntry: legalCount > 0 ? legalSum / legalCount : 0
	};
}
