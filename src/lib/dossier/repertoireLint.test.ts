import { describe, expect, it } from 'vitest';

import { buildRepertoireLint } from './repertoireLint';
import type { EvalMoveResult } from './evalAxes';
import type { Repertoire, RepertoireNode } from '$lib/types';
import { fenKeyFromFen } from '$lib/chess/fen';

const E4_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const D4_FEN = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1';

function evalMove(overrides: Partial<EvalMoveResult>): EvalMoveResult {
	return {
		gameId: 'g1',
		playedAt: 1,
		ply: 2,
		phase: 'opening',
		san: 'e4',
		fenBefore: E4_FEN,
		fenAfter: E4_FEN,
		cpLoss: 150,
		bestUci: null,
		classification: 'mistake',
		intentionalSac: false,
		userColor: 'black',
		gameResult: 'loss',
		clockBucket: 'high',
		userEvalBeforeCp: 0,
		userEvalAfterCp: -150,
		bestWasForcing: false,
		wpLoss: 15,
		accuracyPct: 70,
		quality: 'mistake',
		alternatives: [],
		volatile: false,
		tablebase: null,
		inBook: false,
		source: 'local',
		...overrides
	};
}

function rep(id: string, name: string, color: 'white' | 'black'): Repertoire {
	return {
		id,
		name,
		color,
		rootFen: E4_FEN,
		rootFenKey: fenKeyFromFen(E4_FEN),
		coverageGoal: 100,
		createdAt: 1,
		updatedAt: 1
	} as Repertoire;
}

function node(fenKey: string, san: string): RepertoireNode {
	return {
		repertoireId: 'rep1',
		fenKey,
		children: [{ san, uci: 'x', toFenKey: 'k' }]
	};
}

describe('buildRepertoireLint', () => {
	it('finds forgotten prep when user played differs from prepared', () => {
		const black = rep('rep1', 'Black defence', 'black');
		const fenKey = fenKeyFromFen(E4_FEN);
		const nodes = [node(fenKey, 'c5')]; // prep: Sicilian
		const moves = [evalMove({ san: 'e5', fenBefore: E4_FEN })]; // user played e5 instead
		const out = buildRepertoireLint(moves, [{ repertoire: black, nodes }]);
		expect(out.deviated).toBe(1);
		expect(out.entries[0].preparedSan).toBe('c5');
		expect(out.entries[0].userPlayedSan).toBe('e5');
	});

	it('ignores matches between played and prepared', () => {
		const black = rep('rep1', 'Sicilian', 'black');
		const fenKey = fenKeyFromFen(E4_FEN);
		const nodes = [node(fenKey, 'c5')];
		const moves = [evalMove({ san: 'c5', fenBefore: E4_FEN })];
		const out = buildRepertoireLint(moves, [{ repertoire: black, nodes }]);
		expect(out.deviated).toBe(0);
	});

	it('ignores repertoires of the opposite colour', () => {
		const white = rep('rep1', 'King pawn', 'white');
		const fenKey = fenKeyFromFen(E4_FEN);
		const nodes = [node(fenKey, 'c5')];
		const moves = [evalMove({ san: 'e5', fenBefore: E4_FEN, userColor: 'black' })];
		const out = buildRepertoireLint(moves, [{ repertoire: white, nodes }]);
		expect(out.deviated).toBe(0);
	});

	it('ignores best/inaccuracy moves by policy', () => {
		const black = rep('rep1', 'Sicilian', 'black');
		const fenKey = fenKeyFromFen(E4_FEN);
		const nodes = [node(fenKey, 'c5')];
		const moves = [evalMove({ san: 'e5', fenBefore: E4_FEN, classification: 'best' })];
		const out = buildRepertoireLint(moves, [{ repertoire: black, nodes }]);
		expect(out.checked).toBe(0);
	});

	it('returns empty on no moves or no repertoires', () => {
		expect(buildRepertoireLint([], []).entries).toHaveLength(0);
		expect(buildRepertoireLint(null, []).entries).toHaveLength(0);
	});

	it('reports in-repertoire positions even when user matched prep', () => {
		// confirms inRepertoire counter increments regardless of deviation
		const black = rep('rep1', 'Sicilian', 'black');
		const fenKey = fenKeyFromFen(E4_FEN);
		const nodes = [node(fenKey, 'c5')];
		const moves = [
			evalMove({ san: 'c5', fenBefore: E4_FEN }),
			evalMove({ san: 'e5', fenBefore: E4_FEN })
		];
		const out = buildRepertoireLint(moves, [{ repertoire: black, nodes }]);
		expect(out.checked).toBe(2);
		expect(out.inRepertoire).toBe(2);
		expect(out.deviated).toBe(1);
	});

	it('sorts entries by WP loss descending', () => {
		const black = rep('rep1', 'Black', 'black');
		const fen1Key = fenKeyFromFen(E4_FEN);
		const fen2Key = fenKeyFromFen(D4_FEN);
		const nodes = [node(fen1Key, 'c5'), node(fen2Key, 'Nf6')];
		const moves = [
			evalMove({ san: 'x', fenBefore: E4_FEN, wpLoss: 10 }),
			evalMove({ san: 'y', fenBefore: D4_FEN, wpLoss: 35 })
		];
		const out = buildRepertoireLint(moves, [{ repertoire: black, nodes }]);
		expect(out.entries[0].wpLoss).toBe(35);
		expect(out.entries[1].wpLoss).toBe(10);
	});
});
