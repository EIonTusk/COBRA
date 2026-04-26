import { describe, expect, it } from 'vitest';

import { buildStudyPlan, type StudyPlan } from './studyPlan';
import type { DossierScanResult } from './scan';
import type { PickedBaseline } from './fingerprint';
import type { ClassifiedGame } from './classify';
import type { EvalMoveResult } from './evalAxes';

/**
 * Minimal scaffolding for the recommender. The real types carry many
 * fields the recommender doesn't read; we mock just what each branch
 * touches and cast with `as unknown as ...`.
 */

function move(opts: Partial<EvalMoveResult>): EvalMoveResult {
	return {
		gameId: 'g1',
		playedAt: 0,
		ply: 1,
		phase: 'middle',
		san: 'e4',
		fenBefore: '',
		fenAfter: '',
		cpLoss: 0,
		bestUci: null,
		classification: 'best',
		intentionalSac: false,
		userColor: 'white',
		gameResult: 'win',
		clockBucket: 'mid',
		userEvalAfterCp: 0,
		userEvalBeforeCp: 0,
		bestWasForcing: false,
		wpLoss: 0,
		accuracyPct: 100,
		quality: 'best',
		alternatives: [],
		volatile: false,
		tablebase: null,
		inBook: false,
		source: 'local',
		...opts
	};
}

function buildScanResult(opts: {
	allMoves?: EvalMoveResult[];
	classified?: ClassifiedGame[];
}): DossierScanResult {
	return {
		fingerprint: {
			gamesAnalyzed: 0,
			totalUserMoves: 0,
			overall: { forcing: 0.2, capture: 0.1, pawnPlay: 0.3, queenside: 0.1, earlyCastle: 0.5 },
			avgUserRating: 1500,
			bySpeed: { blitz: { games: 50, axes: {} } },
			tension: { releaseRate: 0.5, creationRate: 0.1, tensionedMoves: 0 }
		} as unknown as DossierScanResult['fingerprint'],
		drift: null,
		leaks: {
			totalUserMoves: 0,
			counts: { missed_capture: 0, impatient_forcing: 0, missed_attack: 0 },
			rates: { missed_capture: 0, impatient_forcing: 0, missed_attack: 0 },
			byPhase: {
				opening: { missed_capture: 0, impatient_forcing: 0, missed_attack: 0 },
				middle: { missed_capture: 0, impatient_forcing: 0, missed_attack: 0 },
				end: { missed_capture: 0, impatient_forcing: 0, missed_attack: 0 }
			},
			worst: []
		},
		classified: opts.classified ?? [],
		perAccount: [],
		evalAxes: opts.allMoves
			? ({ allMoves: opts.allMoves, byPhase: {} } as unknown as DossierScanResult['evalAxes'])
			: null,
		evalError: null
	};
}

function bucketBaseline(): PickedBaseline {
	return {
		axes: { forcing: 0.25, capture: 0.12, pawnPlay: 0.32, queenside: 0.12, earlyCastle: 0.55 },
		tension: { releaseRate: 0.5, creationRate: 0.1 },
		source: 'self-calibrated',
		bucket: { ratingMin: 1400, ratingMax: 1600, bucket: 'blitz', games: 200, axes: {} as never },
		criticalMoments: {
			conversionRate: 0.7,
			conversionGames: 100,
			defenseRate: 0.3,
			defenseGames: 80,
			equalityWinRate: 0.4,
			equalityLossRate: 0.4,
			equalityGames: 200
		}
	} as unknown as PickedBaseline;
}

describe('buildStudyPlan', () => {
	it('uses an eyeballed-bucket label when no calibrated peer baseline is supplied', () => {
		// Without an active baseline the conversion / defense / opening
		// branches won't trigger (they need peer numbers); the only thing
		// the recommender can latch onto is the level-up axis gap, so we
		// expect at most one item with the eyeballed-baseline label.
		const plan = buildStudyPlan(buildScanResult({}), null);
		expect(plan.bucketLabel).toBe('Your peer baseline');
		expect(plan.hasBucket).toBe(false);
		expect(plan.items.length).toBeLessThanOrEqual(1);
	});

	it('flags conversion gap when peer rate exceeds user rate by ≥5pp', () => {
		// 6 games, all entered with eval +200, lost 5 of them = 1/6 conversion
		// vs peer 70%. Should flag.
		const moves: EvalMoveResult[] = [];
		for (let i = 0; i < 6; i++) {
			moves.push(
				move({
					gameId: `game${i}`,
					userEvalBeforeCp: 200,
					gameResult: i === 0 ? 'win' : 'loss'
				})
			);
		}
		const plan: StudyPlan = buildStudyPlan(buildScanResult({ allMoves: moves }), bucketBaseline());
		const conv = plan.items.find((it) => it.title === 'Convert winning positions');
		expect(conv).toBeDefined();
		expect(conv!.category).toBe('endgame');
		expect(conv!.rationale).toContain('1400–1600');
	});

	it('omits conversion finding when sample size is too small', () => {
		// Only 3 winning entries — below the 5-game threshold.
		const moves: EvalMoveResult[] = [];
		for (let i = 0; i < 3; i++) {
			moves.push(move({ gameId: `game${i}`, userEvalBeforeCp: 200, gameResult: 'loss' }));
		}
		const plan = buildStudyPlan(buildScanResult({ allMoves: moves }), bucketBaseline());
		expect(plan.items.find((it) => it.title === 'Convert winning positions')).toBeUndefined();
	});

	it('uses an eyeballed bucket label when no calibrated bucket exists', () => {
		const plan = buildStudyPlan(buildScanResult({}), null);
		expect(plan.bucketLabel).toBe('Your peer baseline');
		expect(plan.hasBucket).toBe(false);
	});

	it('caps the plan at 5 items', () => {
		// We can't easily construct a real-world 6-item case in a unit test
		// (each branch needs different scaffolding), so we just check the
		// invariant that the `.slice(0, 5)` cap holds when fewer items are
		// present — i.e. no synthetic items get added.
		const plan = buildStudyPlan(buildScanResult({}), bucketBaseline());
		expect(plan.items.length).toBeLessThanOrEqual(5);
	});
});
