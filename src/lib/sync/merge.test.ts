import { describe, expect, it } from 'vitest';
import { createEmptyCard, generatorParameters } from 'ts-fsrs';
import {
	emptyMergeStats,
	mergeBaseline,
	mergeCard,
	mergeDossierReport,
	mergeEmpiricalGap,
	mergeMastersBaseline,
	mergeMistake,
	mergeNode,
	mergePositionWdl,
	mergeRepertoire,
	mergeSettings,
	mergeSparGame,
	type MergeContext
} from './merge';
import type {
	Card,
	EmpiricalGap,
	Repertoire,
	RepertoireNode,
	SparGame,
	StoredMistake,
	AppSettings
} from '$lib/types';
import type { PositionWdlRow, StoredBaselineBucket } from '$lib/storage/db';
import { pruneRepTombstones, REP_TOMBSTONE_TTL_MS } from '$lib/storage/settings';

const CTX: MergeContext = { remoteExportedAt: 1_000_000, mergedAt: 1_000_500 };

function makeCard(opts: {
	lastReview?: number;
	dueAt?: number;
	reps?: number;
	lapses?: number;
}): Card {
	const fsrs = createEmptyCard(new Date(0));
	if (opts.reps != null) fsrs.reps = opts.reps;
	if (opts.lapses != null) fsrs.lapses = opts.lapses;
	return {
		repertoireId: 'r1',
		fenKey: 'fk1',
		expectedSan: 'e4',
		fsrs,
		lastReview: opts.lastReview,
		dueAt: opts.dueAt ?? 0
	};
}

describe('mergeCard', () => {
	it('picks the side with the more recent lastReview', () => {
		const a = makeCard({ lastReview: 100 });
		const b = makeCard({ lastReview: 200 });
		expect(mergeCard(a, b, CTX).lastReview).toBe(200);
		expect(mergeCard(b, a, CTX).lastReview).toBe(200);
	});

	it('falls back to FSRS effort weight when both unreviewed', () => {
		const a = makeCard({ reps: 0, lapses: 0 });
		const b = makeCard({ reps: 3, lapses: 1 });
		expect(mergeCard(a, b, CTX)).toBe(b);
	});

	it('falls back to dueAt when reviews and effort are tied', () => {
		const a = makeCard({ dueAt: 100 });
		const b = makeCard({ dueAt: 200 });
		expect(mergeCard(a, b, CTX).dueAt).toBe(200);
	});
});

describe('mergeMistake', () => {
	const base: StoredMistake = {
		id: 'g1:r1:fk1',
		gameId: 'g1',
		gameUrl: 'u',
		playedAt: 100,
		detectedAt: 100,
		speed: 'blitz',
		opponent: 'o',
		color: 'white',
		repertoireId: 'r1',
		repertoireName: 'R',
		fenKey: 'fk1',
		fen: 'f',
		playedSan: 'e4',
		expectedSan: 'd4',
		plyOffTree: 0,
		status: 'pending',
		correctCount: 0
	};

	it('corrected beats pending regardless of timestamp', () => {
		const a = { ...base, status: 'pending' as const };
		const b = { ...base, status: 'corrected' as const, lastDrilledAt: 1, correctCount: 1 };
		expect(mergeMistake(a, b).status).toBe('corrected');
	});

	it('dismissed beats pending regardless of timestamp', () => {
		const a = { ...base, status: 'pending' as const };
		const b = { ...base, status: 'dismissed' as const, dismissedAt: 1 };
		expect(mergeMistake(a, b).status).toBe('dismissed');
	});

	it('within same status, more-recent action timestamp wins', () => {
		const a = { ...base, status: 'corrected' as const, lastDrilledAt: 100 };
		const b = { ...base, status: 'corrected' as const, lastDrilledAt: 200 };
		expect(mergeMistake(a, b).lastDrilledAt).toBe(200);
	});

	it('a later dismissedAt wins over an earlier lastDrilledAt', () => {
		const drilledThenDismissed = {
			...base,
			status: 'dismissed' as const,
			dismissedAt: 200,
			lastDrilledAt: 100,
			correctCount: 1
		};
		const drilledAgain = {
			...base,
			status: 'corrected' as const,
			lastDrilledAt: 100,
			correctCount: 1
		};
		expect(mergeMistake(drilledThenDismissed, drilledAgain).status).toBe('dismissed');
		expect(mergeMistake(drilledAgain, drilledThenDismissed).status).toBe('dismissed');
	});

	it('a later lastDrilledAt wins over an earlier dismissedAt', () => {
		const dismissedFirst = {
			...base,
			status: 'dismissed' as const,
			dismissedAt: 100
		};
		const drilledLater = {
			...base,
			status: 'corrected' as const,
			lastDrilledAt: 200,
			correctCount: 1
		};
		expect(mergeMistake(dismissedFirst, drilledLater).status).toBe('corrected');
		expect(mergeMistake(drilledLater, dismissedFirst).status).toBe('corrected');
	});

	it('correctCount tiebreaks when action timestamps are equal', () => {
		const a = { ...base, status: 'corrected' as const, lastDrilledAt: 100, correctCount: 1 };
		const b = { ...base, status: 'corrected' as const, lastDrilledAt: 100, correctCount: 4 };
		expect(mergeMistake(a, b).correctCount).toBe(4);
	});
});

describe('mergeEmpiricalGap', () => {
	const make = (gameIds: string[], count: number, last: string): EmpiricalGap => ({
		id: 'r1:fk1',
		repertoireId: 'r1',
		fenKey: 'fk1',
		fen: 'f',
		count,
		firstSeenAt: 100,
		lastSeenAt: 200,
		lastGameId: last,
		gameIds: [...gameIds]
	});

	it('unions disjoint game id sets and sums', () => {
		const a = make(['g1', 'g2'], 2, 'g2');
		const b = make(['g3', 'g4'], 2, 'g4');
		const m = mergeEmpiricalGap(a, b);
		expect(m.count).toBe(4);
		expect(m.gameIds?.sort()).toEqual(['g1', 'g2', 'g3', 'g4']);
	});

	it('does not double-count overlapping games', () => {
		const a = make(['g1', 'g2'], 2, 'g2');
		const b = make(['g2', 'g3'], 2, 'g3');
		const m = mergeEmpiricalGap(a, b);
		expect(m.count).toBe(3);
		expect(m.gameIds?.sort()).toEqual(['g1', 'g2', 'g3']);
	});

	it('promotes pre-v2 lastGameId to a single-element set', () => {
		const a: EmpiricalGap = {
			id: 'r1:fk1',
			repertoireId: 'r1',
			fenKey: 'fk1',
			fen: 'f',
			count: 1,
			firstSeenAt: 50,
			lastSeenAt: 100,
			lastGameId: 'g1'
		};
		const b: EmpiricalGap = {
			id: 'r1:fk1',
			repertoireId: 'r1',
			fenKey: 'fk1',
			fen: 'f',
			count: 1,
			firstSeenAt: 60,
			lastSeenAt: 120,
			lastGameId: 'g2'
		};
		const m = mergeEmpiricalGap(a, b);
		expect(m.count).toBe(2);
		expect(m.gameIds?.sort()).toEqual(['g1', 'g2']);
	});
});

describe('mergePositionWdl', () => {
	const make = (w: number, d: number, b: number, ids: string[]): PositionWdlRow => ({
		id: 'r1:fk1:e4:white',
		repertoireId: 'r1',
		fenKey: 'fk1',
		playedSan: 'e4',
		color: 'white',
		white: w,
		draws: d,
		black: b,
		games: w + d + b,
		countedGameIds: [...ids],
		lastSeenAt: 100
	});

	it('unions countedGameIds and takes per-term max', () => {
		const a = make(3, 1, 0, ['g1', 'g2', 'g3', 'g4']);
		const b = make(2, 2, 1, ['g3', 'g4', 'g5', 'g6', 'g7']);
		const m = mergePositionWdl(a, b);
		expect(new Set(m.countedGameIds)).toEqual(new Set(['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7']));
		expect(m.white).toBe(3);
		expect(m.draws).toBe(2);
		expect(m.black).toBe(1);
	});
});

describe('mergeSparGame', () => {
	const base: SparGame = {
		id: 'g1',
		repertoireId: 'r1',
		repertoireName: 'R',
		startFen: 'f',
		userColor: 'white',
		opponent: 'stockfish',
		opponentLabel: 'SF',
		opponentStrength: 5,
		gameUrl: 'u',
		startedAt: 100,
		status: 'pending'
	};

	it('analysed beats pending', () => {
		const a = { ...base, status: 'pending' as const, lastCheckedAt: 999 };
		const b = {
			...base,
			status: 'analysed' as const,
			lastCheckedAt: 1,
			result: { outcome: 'win' as const, plies: 60 }
		};
		expect(mergeSparGame(a, b).status).toBe('analysed');
	});

	it('within equal status, lastCheckedAt wins', () => {
		const a = { ...base, status: 'pending' as const, lastCheckedAt: 100 };
		const b = { ...base, status: 'pending' as const, lastCheckedAt: 200 };
		expect(mergeSparGame(a, b).lastCheckedAt).toBe(200);
	});
});

describe('mergeNode', () => {
	const baseNode = (children: RepertoireNode['children']): RepertoireNode => ({
		repertoireId: 'r1',
		fenKey: 'fk1',
		children,
		updatedAt: 100
	});

	it('unions edges, keeping ones from either side', () => {
		const a = baseNode([{ san: 'e4', uci: 'e2e4', toFenKey: 'A', updatedAt: 100 }]);
		const b = baseNode([{ san: 'd4', uci: 'd2d4', toFenKey: 'B', updatedAt: 100 }]);
		const { merged, edgeChanges } = mergeNode(a, b);
		expect(merged.children.map((e) => e.toFenKey).sort()).toEqual(['A', 'B']);
		expect(edgeChanges).toBe(1);
	});

	it('field-LWW per edge using updatedAt', () => {
		const a = baseNode([
			{ san: 'e4', uci: 'e2e4', toFenKey: 'A', annotation: 'old', updatedAt: 100 }
		]);
		const b = baseNode([
			{ san: 'e4', uci: 'e2e4', toFenKey: 'A', annotation: 'new', updatedAt: 200 }
		]);
		const { merged } = mergeNode(a, b);
		expect(merged.children[0].annotation).toBe('new');
	});

	it("does not let an older edge clobber a newer edge's fields", () => {
		const a = baseNode([
			{ san: 'e4', uci: 'e2e4', toFenKey: 'A', annotation: 'newer', updatedAt: 200 }
		]);
		const b = baseNode([
			{ san: 'e4', uci: 'e2e4', toFenKey: 'A', annotation: 'older', updatedAt: 100 }
		]);
		const { merged, edgeChanges } = mergeNode(a, b);
		expect(merged.children[0].annotation).toBe('newer');
		expect(edgeChanges).toBe(0);
	});

	it('per-node comment field-LWW', () => {
		const a: RepertoireNode = {
			...baseNode([]),
			comment: 'old',
			updatedAt: 100
		};
		const b: RepertoireNode = {
			...baseNode([]),
			comment: 'new',
			updatedAt: 200
		};
		expect(mergeNode(a, b).merged.comment).toBe('new');
		expect(mergeNode(b, a).merged.comment).toBe('new');
	});
});

describe('mergeRepertoire', () => {
	it('higher updatedAt wins', () => {
		const a: Repertoire = {
			id: 'r1',
			name: 'A',
			color: 'white',
			rootFen: 'f',
			rootFenKey: 'fk',
			createdAt: 0,
			updatedAt: 100
		};
		const b: Repertoire = { ...a, name: 'B', updatedAt: 200 };
		expect(mergeRepertoire(a, b).name).toBe('B');
	});
});

describe('mergeBaseline', () => {
	const base: StoredBaselineBucket = {
		id: 'any:1500-1600',
		ratingMin: 1500,
		ratingMax: 1600,
		games: 50,
		totalMoves: 2000,
		axes: { forcing: 0.4, capture: 0.3, pawnPlay: 0.5, queenside: 0.1, earlyCastle: 0.6 },
		tension: { releaseRate: 0.2, creationRate: 0.3 },
		computedAt: 100,
		source: 'self-calibrated',
		seedCount: 50,
		sampledUsers: 10
	};

	it('newer computedAt wins', () => {
		const a = { ...base, computedAt: 100, games: 50 };
		const b = { ...base, computedAt: 200, games: 100 };
		expect(mergeBaseline(a, b).games).toBe(100);
	});
});

describe('mergeDossierReport / mergeMastersBaseline', () => {
	it('LWW by savedAt with null tolerance', () => {
		expect(mergeDossierReport(null, { savedAt: 1, version: 1, payload: {} })).toEqual({
			savedAt: 1,
			version: 1,
			payload: {}
		});
		expect(mergeDossierReport({ savedAt: 1, version: 1, payload: 'a' }, null)).toEqual({
			savedAt: 1,
			version: 1,
			payload: 'a'
		});
		const merged = mergeDossierReport(
			{ savedAt: 1, version: 1, payload: 'old' },
			{ savedAt: 2, version: 1, payload: 'new' }
		);
		expect(merged?.payload).toBe('new');
	});

	it('mergeMastersBaseline by fetchedAt', () => {
		const merged = mergeMastersBaseline(
			{ fetchedAt: 100, targetsHash: 'h', payload: 'a' },
			{ fetchedAt: 200, targetsHash: 'h', payload: 'b' }
		);
		expect(merged?.payload).toBe('b');
	});
});

describe('mergeSettings', () => {
	const baseSettings = (): AppSettings => ({
		key: 'root',
		theme: 'dark',
		boardTheme: 'brown',
		pieceSet: 'cburnett',
		fsrsParams: generatorParameters({ enable_fuzz: true }),
		dailyNewCardCap: 10,
		drillSessionCap: 30,
		drillIntroSpeed: 'normal',
		explorerSpeeds: ['blitz'],
		explorerRatings: [1600],
		lichessApiToken: '',
		lichessOAuth: null
	});

	it('unions scanAccounts by (source, lower-username)', () => {
		const a = baseSettings();
		a.scanAccounts = [{ source: 'lichess', username: 'foo' }];
		const remote: Partial<AppSettings> = {
			scanAccounts: [
				{ source: 'lichess', username: 'FOO' },
				{ source: 'chesscom', username: 'bar' }
			]
		};
		const m = mergeSettings(a, remote);
		expect(m.scanAccounts?.length).toBe(2);
		expect(m.scanAccounts?.map((x) => x.source).sort()).toEqual(['chesscom', 'lichess']);
	});

	it('unions viewedWalkthroughGames by id and re-caps at 200', () => {
		const a = baseSettings();
		a.viewedWalkthroughGames = Array.from({ length: 150 }, (_, i) => ({
			id: `local-${i}`,
			viewedAt: i
		}));
		const remote: Partial<AppSettings> = {
			viewedWalkthroughGames: Array.from({ length: 150 }, (_, i) => ({
				id: `remote-${i}`,
				viewedAt: 1000 + i
			}))
		};
		const m = mergeSettings(a, remote);
		expect(m.viewedWalkthroughGames?.length).toBe(200);
		// All remote entries (newer) should be in; oldest local entries get evicted.
		const ids = new Set(m.viewedWalkthroughGames?.map((x) => x.id));
		for (let i = 0; i < 150; i++) expect(ids.has(`remote-${i}`)).toBe(true);
	});

	it('unions repTombstones by repId, keeping the latest deletedAt', () => {
		const now = Date.now();
		const a = baseSettings();
		a.repTombstones = [
			{ repId: 'rep-a', deletedAt: now - 1000 },
			{ repId: 'rep-b', deletedAt: now - 1000 }
		];
		const remote: Partial<AppSettings> = {
			repTombstones: [
				{ repId: 'rep-a', deletedAt: now }, // newer than local
				{ repId: 'rep-c', deletedAt: now }
			]
		};
		const m = mergeSettings(a, remote);
		const byId = new Map(m.repTombstones?.map((t) => [t.repId, t.deletedAt]));
		expect(byId.size).toBe(3);
		expect(byId.get('rep-a')).toBe(now); // latest deletedAt wins
		expect(byId.get('rep-b')).toBe(now - 1000);
		expect(byId.get('rep-c')).toBe(now);
	});
});

describe('pruneRepTombstones', () => {
	it('dedups by repId keeping the latest deletedAt', () => {
		const now = 10_000_000;
		const out = pruneRepTombstones(
			[
				{ repId: 'x', deletedAt: now - 5000 },
				{ repId: 'x', deletedAt: now - 1000 },
				{ repId: 'y', deletedAt: now - 2000 }
			],
			now
		);
		expect(out.length).toBe(2);
		expect(out.find((t) => t.repId === 'x')?.deletedAt).toBe(now - 1000);
	});

	it('drops tombstones older than the TTL', () => {
		const now = REP_TOMBSTONE_TTL_MS + 100_000;
		const out = pruneRepTombstones(
			[
				{ repId: 'fresh', deletedAt: now - 1000 },
				{ repId: 'stale', deletedAt: now - REP_TOMBSTONE_TTL_MS - 1 }
			],
			now
		);
		expect(out.map((t) => t.repId)).toEqual(['fresh']);
	});
});

describe('emptyMergeStats', () => {
	it('zeros every counter', () => {
		const s = emptyMergeStats();
		expect(s.cards).toBe(0);
		expect(s.edges).toBe(0);
		expect(s.repertoireUpdated).toBe(0);
	});
});
