import { describe, expect, it } from 'vitest';

import { buildOpeningProfileByRepertoire } from './openingProfileByRepertoire';
import type { ClassifiedGame, MoveFeatures } from './classify';
import type { Repertoire, RepertoireNode } from '$lib/types';
import { fenKeyFromFen, STARTPOS_FEN } from '$lib/chess/fen';

const STARTPOS_KEY = fenKeyFromFen(STARTPOS_FEN);
// Position after 1.d4 d5 2.c4 — a QGD-tree position, white to move.
const QGD_AFTER_2C4_FEN = 'rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq - 0 2';
// Position after 1.e4 e5 — outside any d-pawn rep.
const E4_E5_FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

function move(fenBefore: string): MoveFeatures {
	// Only `fenBefore` is read by buildOpeningProfileByRepertoire — the rest
	// is structural padding so the cast is safe in this test scope.
	return { fenBefore, san: 'd4' } as unknown as MoveFeatures;
}

function game(
	id: string,
	color: 'white' | 'black',
	openingName: string | null,
	moves: MoveFeatures[],
	result: 'win' | 'loss' | 'draw' = 'win'
): ClassifiedGame {
	return {
		gameId: id,
		playedAt: 1,
		speed: 'blitz',
		color,
		opponentRating: 1500,
		userRating: 1500,
		opponentUsername: 'opp',
		result,
		moves,
		totalPlies: moves.length * 2,
		eco: null,
		openingName,
		endgameMaterial: null,
		endgameFamily: null,
		hourOfDay: 12,
		dayOfWeek: 1
	} as ClassifiedGame;
}

function rep(id: string, name: string, color: 'white' | 'black'): Repertoire {
	return {
		id,
		name,
		color,
		rootFen: STARTPOS_FEN,
		rootFenKey: STARTPOS_KEY,
		coverageGoal: 100,
		createdAt: 1,
		updatedAt: 1
	};
}

function node(repertoireId: string, fenKey: string, san: string): RepertoireNode {
	return {
		repertoireId,
		fenKey,
		children: [{ san, uci: 'x', toFenKey: 'k' }]
	};
}

describe('buildOpeningProfileByRepertoire', () => {
	it('attributes a game to the same-colour rep whose tree it visits', () => {
		const whiteRep = rep('r-qg', "Queen's Gambit", 'white');
		const qgdKey = fenKeyFromFen(QGD_AFTER_2C4_FEN);
		const nodes = [
			node('r-qg', STARTPOS_KEY, 'd4'),
			node('r-qg', qgdKey, 'Nc3') // user-to-move position deep in the rep
		];
		const g = game('g1', 'white', "Queen's Gambit Declined", [
			move(STARTPOS_FEN),
			move(QGD_AFTER_2C4_FEN)
		]);
		const out = buildOpeningProfileByRepertoire([g], null, [{ repertoire: whiteRep, nodes }]);
		expect(out.buckets[0].games.map((x) => x.gameId)).toEqual(['g1']);
		expect(out.unattributed).toHaveLength(0);
	});

	it('does not attribute when the only match is the rep root (universal start)', () => {
		const whiteRep = rep('r-qg', "Queen's Gambit", 'white');
		// Tree contains ONLY the start position (root) — no deeper prep.
		const nodes = [node('r-qg', STARTPOS_KEY, 'd4')];
		const g = game('g1', 'white', null, [move(STARTPOS_FEN), move(E4_E5_FEN)]);
		const out = buildOpeningProfileByRepertoire([g], null, [{ repertoire: whiteRep, nodes }]);
		expect(out.buckets[0].games).toHaveLength(0);
		expect(out.unattributed).toHaveLength(1);
	});

	it('skips reps of the opposite colour', () => {
		const blackRep = rep('r-fr', 'French', 'black');
		const qgdKey = fenKeyFromFen(QGD_AFTER_2C4_FEN);
		// Black rep happens to contain the QGD position — but the game is
		// played as White, so it must not be attributed to a black rep.
		const nodes = [node('r-fr', qgdKey, 'Nf6')];
		const g = game('g1', 'white', null, [move(QGD_AFTER_2C4_FEN)]);
		const out = buildOpeningProfileByRepertoire([g], null, [{ repertoire: blackRep, nodes }]);
		expect(out.buckets[0].games).toHaveLength(0);
		expect(out.unattributed).toHaveLength(1);
	});

	it('picks the rep with the most matched non-root positions on a tie-breaker', () => {
		const repA = rep('r-a', 'Mainline', 'white');
		const repB = rep('r-b', 'Sideline', 'white');
		const qgdKey = fenKeyFromFen(QGD_AFTER_2C4_FEN);
		const e4e5Key = fenKeyFromFen(E4_E5_FEN);
		// repA has two prepped non-root positions matching the game.
		const nodesA = [node('r-a', qgdKey, 'Nc3'), node('r-a', e4e5Key, 'Nf3')];
		// repB has only one matching non-root position.
		const nodesB = [node('r-b', qgdKey, 'Nc3')];
		const g = game('g1', 'white', null, [move(QGD_AFTER_2C4_FEN), move(E4_E5_FEN)]);
		const out = buildOpeningProfileByRepertoire([g], null, [
			{ repertoire: repA, nodes: nodesA },
			{ repertoire: repB, nodes: nodesB }
		]);
		expect(out.buckets[0].games.map((x) => x.gameId)).toEqual(['g1']);
		expect(out.buckets[1].games).toHaveLength(0);
	});

	it('counts unmatched games in the unattributed bucket', () => {
		const whiteRep = rep('r-qg', "Queen's Gambit", 'white');
		const qgdKey = fenKeyFromFen(QGD_AFTER_2C4_FEN);
		const nodes = [node('r-qg', qgdKey, 'Nc3')];
		const matched = game('g1', 'white', null, [move(QGD_AFTER_2C4_FEN)]);
		const stranger = game('g2', 'white', null, [move(E4_E5_FEN)]);
		const out = buildOpeningProfileByRepertoire([matched, stranger], null, [
			{ repertoire: whiteRep, nodes }
		]);
		expect(out.buckets[0].games.map((x) => x.gameId)).toEqual(['g1']);
		expect(out.unattributed.map((x) => x.gameId)).toEqual(['g2']);
		expect(out.totalGames).toBe(2);
	});

	it('handles an empty repertoires list by routing everything to unattributed', () => {
		const g = game('g1', 'white', null, [move(QGD_AFTER_2C4_FEN)]);
		const out = buildOpeningProfileByRepertoire([g], null, []);
		expect(out.buckets).toHaveLength(0);
		expect(out.unattributed.map((x) => x.gameId)).toEqual(['g1']);
	});
});
