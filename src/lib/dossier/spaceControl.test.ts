import { describe, expect, it } from 'vitest';

import { buildSpaceControl } from './spaceControl';
import type { ClassifiedGame, Phase } from './classify';
import type { Color } from '$lib/types';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// After 1.e4 (black to move): white pawn on e4 attacks d5 and f5.
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

interface SyntheticMove {
	fenBefore: string;
	phase: Phase;
}

function syntheticGame(color: Color, moves: SyntheticMove[]): ClassifiedGame {
	return {
		color,
		moves: moves.map((m) => m as unknown as ClassifiedGame['moves'][number])
	} as unknown as ClassifiedGame;
}

function rep(fen: string, n: number, phase: Phase = 'opening'): SyntheticMove[] {
	return Array.from({ length: n }, () => ({ fenBefore: fen, phase }));
}

// Square indices in chessops layout (a1=0 .. h8=63).
const A3 = 16;
const A6 = 40;
const B3 = 17;
const D5 = 35;
const E4 = 28;
const F5 = 37;
const H6 = 47;

describe('buildSpaceControl', () => {
	it('returns null for empty input', () => {
		expect(buildSpaceControl([])).toBeNull();
	});

	it('returns null below MIN_TOTAL samples', () => {
		const game = syntheticGame('white', rep(STARTPOS, 10));
		expect(buildSpaceControl([game])).toBeNull();
	});

	it('returns null when no perspective has enough same-colour samples', () => {
		const games = [syntheticGame('white', rep(STARTPOS, 50))];
		expect(buildSpaceControl(games)).toBeNull();
	});

	it('builds white perspective when both colour pools have samples', () => {
		const games = [
			syntheticGame('white', rep(STARTPOS, 25)),
			syntheticGame('black', rep(STARTPOS, 25))
		];
		const r = buildSpaceControl(games);
		expect(r).not.toBeNull();
		if (!r) return;
		expect(r.white).not.toBeNull();
		expect(r.black).not.toBeNull();
		if (!r.white || !r.black) return;

		expect(r.white.user.squares[A3].avgAttackers).toBeCloseTo(2);
		expect(r.white.opponent.squares[A3].avgAttackers).toBeCloseTo(2);
		expect(r.white.diff[A3]).toBeCloseTo(0);

		expect(r.white.user.squares[B3].avgAttackers).toBeCloseTo(2);
		expect(r.white.diff[B3]).toBeCloseTo(0);
	});

	it('like-for-like comparison surfaces opponent space-grab', () => {
		const games = [
			syntheticGame('white', rep(STARTPOS, 50)),
			syntheticGame('black', rep(AFTER_E4, 50))
		];
		const r = buildSpaceControl(games);
		expect(r).not.toBeNull();
		if (!r || !r.white) return;

		expect(r.white.user.squares[D5].avgAttackers).toBeCloseTo(0);
		expect(r.white.opponent.squares[D5].avgAttackers).toBeCloseTo(1);
		expect(r.white.diff[D5]).toBeLessThan(0);

		expect(r.white.opponent.squares[E4].avgAttackers).toBeCloseTo(0);
		expect(r.white.diff[E4]).toBeCloseTo(0);

		expect(r.white.opponent.squares[F5].avgAttackers).toBeCloseTo(1);
		expect(r.white.diff[F5]).toBeLessThan(0);
	});

	it('keeps black-perspective data in canonical chess coordinates', () => {
		const games = [
			syntheticGame('white', rep(STARTPOS, 30)),
			syntheticGame('black', rep(STARTPOS, 30))
		];
		const r = buildSpaceControl(games);
		expect(r).not.toBeNull();
		if (!r || !r.white || !r.black) return;

		expect(r.white.user.squares[A3].avgAttackers).toBeCloseTo(2);
		expect(r.black.user.squares[A3].avgAttackers).toBeCloseTo(0);

		expect(r.white.user.squares[A6].avgAttackers).toBeCloseTo(0);
		expect(r.black.user.squares[A6].avgAttackers).toBeCloseTo(2);

		expect(r.black.user.squares[H6].avgAttackers).toBeCloseTo(2);
		expect(r.white.user.squares[H6].avgAttackers).toBeCloseTo(0);

		for (let sq = 0; sq < 64; sq++) {
			expect(r.white.user.squares[sq].avgAttackers).toBeCloseTo(
				r.black.user.squares[sq ^ 56].avgAttackers
			);
		}
	});

	it('skips unparseable FENs without aborting the scan', () => {
		const games = [
			syntheticGame('white', [...rep(STARTPOS, 30), { fenBefore: 'not-a-fen', phase: 'opening' }]),
			syntheticGame('black', rep(STARTPOS, 30))
		];
		const r = buildSpaceControl(games);
		expect(r).not.toBeNull();
		if (!r) return;
		expect(r.totalPositions).toBe(60);
	});

	it('splits diff by phase when each phase has enough samples', () => {
		// 20 opening + 20 middle + 20 end on each side. All FENs are
		// startpos so per-phase diffs are all 0, but we should see the
		// buckets populate with the expected sample counts.
		const moves: SyntheticMove[] = [
			...rep(STARTPOS, 20, 'opening'),
			...rep(STARTPOS, 20, 'middle'),
			...rep(STARTPOS, 20, 'end')
		];
		const games = [syntheticGame('white', moves), syntheticGame('black', moves)];
		const r = buildSpaceControl(games);
		expect(r).not.toBeNull();
		if (!r || !r.white) return;

		expect(r.white.byPhase.opening?.user.samples).toBe(20);
		expect(r.white.byPhase.middle?.user.samples).toBe(20);
		expect(r.white.byPhase.end?.user.samples).toBe(20);
		expect(r.white.byPhase.opening?.opponent.samples).toBe(20);

		// All-startpos fixture → diffs are zero in every phase bucket.
		for (const phase of ['opening', 'middle', 'end'] as const) {
			const slice = r.white.byPhase[phase];
			expect(slice).not.toBeNull();
			if (!slice) continue;
			for (let sq = 0; sq < 64; sq++) {
				expect(slice.diff[sq]).toBeCloseTo(0);
			}
		}
	});

	it('drops phase buckets below MIN_PER_PHASE', () => {
		// 30 opening samples on each side (overall passes), 5 middle on each.
		// Opening bucket should populate; middle should be null; end null.
		const moves: SyntheticMove[] = [...rep(STARTPOS, 30, 'opening'), ...rep(STARTPOS, 5, 'middle')];
		const games = [syntheticGame('white', moves), syntheticGame('black', moves)];
		const r = buildSpaceControl(games);
		expect(r).not.toBeNull();
		if (!r || !r.white) return;

		expect(r.white.byPhase.opening?.user.samples).toBe(30);
		expect(r.white.byPhase.middle).toBeNull();
		expect(r.white.byPhase.end).toBeNull();
	});
});
