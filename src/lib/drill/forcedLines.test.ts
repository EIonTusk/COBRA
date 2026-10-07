// Forced lines (issue #86 follow-up): a run of the user's moves joined by
// forced opponent replies is unlocked, reviewed and replayed as one unit.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { State } from 'ts-fsrs';
import type { Card, Edge, MoveFrequency, Repertoire, RepertoireNode } from '$lib/types';
import { getDB } from '$lib/storage/db';
import { defaultSettings } from '$lib/storage/settings';
import { createFreshCard } from '$lib/fsrs/scheduler';
import { replaceRepertoireTree, nodesMap } from '$lib/storage/nodes';
import { buildSegment, groupForcedRuns } from './buildSegment';
import { forcedRuns, isForcedReply, MAX_FORCED_RUN, runAfter, runBefore } from './forcedLines';
import { onlyMoveVerdict } from './onlyMove';

const REP = 'rep-forced';
const f = (games: number, total = 1000): MoveFrequency => ({
	games,
	total,
	source: 'lichess',
	fetchedAt: 0
});
const e = (to: string, extra: Partial<Edge> = {}): Edge => ({
	san: to,
	uci: to,
	toFenKey: to,
	...extra
});
const n = (fenKey: string, children: Edge[], extra: Partial<RepertoireNode> = {}) => ({
	repertoireId: REP,
	fenKey,
	children,
	...extra
});

// White repertoire. After 1.e4 the opponent splits between `c` and `s`. In
// the `c` line both later replies are forced (95% of games, then an engine
// only-move), so c → cc → ccc is one run. The `s` line's reply is 50/50.
//   root w ─ o b ┬ c w ─ c2 b ═ cc w ─ c3 b ═ ccc w ─ c4 b
//                └ s w ─ s2 b ─ ss w ─ s3 b
const tree: RepertoireNode[] = [
	n('root w', [e('o b')]),
	n('o b', [e('c w', { frequency: f(500) }), e('s w', { frequency: f(500) })]),
	n('c w', [e('c2 b')]),
	n('c2 b', [e('cc w', { frequency: f(950) })]),
	n('cc w', [e('c3 b')]),
	n('c3 b', [e('ccc w', { onlyMove: { forced: true, gapCp: 400, fetchedAt: 0 } })]),
	n('ccc w', [e('c4 b')]),
	n('c4 b', []),
	n('s w', [e('s2 b')]),
	n('s2 b', [e('ss w', { frequency: f(500) })]),
	n('ss w', [e('s3 b')]),
	n('s3 b', [])
];
const nodes = new Map(tree.map((x) => [x.fenKey, x]));
const cardKeys = ['root w', 'c w', 'cc w', 'ccc w', 's w', 'ss w'];

const rep: Repertoire = {
	id: REP,
	name: 'f',
	color: 'white',
	rootFen: 'startpos',
	rootFenKey: 'root w',
	createdAt: 0,
	updatedAt: 0
};

const DAY = 24 * 60 * 60 * 1000;

/** Introduced and well past the well-learned threshold. */
function learned(fenKey: string, dueAt: number): Card {
	const c = createFreshCard(REP, fenKey, 'x', 0);
	return {
		...c,
		dueAt,
		lastReview: 1,
		lastRating: 3,
		fsrs: { ...c.fsrs, state: State.Review, stability: 100, due: new Date(dueAt) }
	};
}

async function seed(cards: Card[]) {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards'], 'readwrite');
	await tx.objectStore('nodes').clear();
	await tx.objectStore('cards').clear();
	for (const x of tree) await tx.objectStore('nodes').put(structuredClone(x));
	for (const c of cards) await tx.objectStore('cards').put(c);
	await tx.done;
}

const settings = (over: Record<string, unknown> = {}) => ({
	...defaultSettings(),
	drillSessionCap: 100,
	dailyNewCardCap: 10,
	...over
});

describe('forced-line detection', () => {
	it('links moves joined by forced replies into one run', () => {
		const runs = forcedRuns(nodes, 'root w', 'white');
		expect(runAfter(runs, 'c w')).toEqual(['cc w', 'ccc w']);
		expect(runBefore(runs, 'ccc w')).toEqual(['cc w', 'c w']);
		expect(runs.next.has('root w')).toBe(false); // two prepared replies
		expect(runs.next.has('s w')).toBe(false); // 50% isn't forced
	});

	it('counts a □ mark and the only legal move as forced', () => {
		const opp = n('x b', [e('y w')]);
		expect(isForcedReply(opp, e('y w'), n('y w', [], { nags: [7] }))).toBe(true);
		expect(isForcedReply(opp, e('y w'), n('y w', []))).toBe(false);
		// Black in check from the rook on h8; the white king covers b7, so Ka7.
		const onlyMove = n('k6R/8/2K5/8/8/8/8/8 b - -', [e('Ka7')]);
		expect(isForcedReply(onlyMove, e('Ka7'), undefined)).toBe(true);
	});

	it('ignores game shares resting on too few games', () => {
		const opp = n('x b', [e('y w', { frequency: f(10, 10) })]);
		expect(isForcedReply(opp, opp.children[0], undefined)).toBe(false);
	});

	it('does not follow a disabled reply', () => {
		const t = new Map(nodes);
		t.set('c2 b', n('c2 b', [e('cc w', { frequency: f(950), disabled: true })]));
		expect(runAfter(forcedRuns(t, 'root w', 'white'), 'c w')).toEqual([]);
	});

	it(`cuts runs every ${MAX_FORCED_RUN} moves`, () => {
		const t = new Map<string, RepertoireNode>();
		const len = MAX_FORCED_RUN + 2;
		for (let i = 0; i < len; i++) {
			t.set(`u${i} w`, n(`u${i} w`, [e(`o${i} b`)]));
			t.set(`o${i} b`, n(`o${i} b`, i + 1 < len ? [e(`u${i + 1} w`, { frequency: f(990) })] : []));
		}
		const runs = forcedRuns(t, 'u0 w', 'white');
		expect(runAfter(runs, 'u0 w')).toHaveLength(MAX_FORCED_RUN - 1);
		expect(runAfter(runs, `u${MAX_FORCED_RUN} w`)).toEqual([`u${MAX_FORCED_RUN + 1} w`]);
	});

	it('groups new moves of a run next to each other', () => {
		const runs = forcedRuns(nodes, 'root w', 'white');
		const order = ['c w', 's w', 'cc w', 'ss w', 'ccc w'].map((k) =>
			createFreshCard(REP, k, 'x', 0)
		);
		expect(groupForcedRuns(order, runs).map((c) => c.fenKey)).toEqual([
			'c w',
			'cc w',
			'ccc w',
			's w',
			'ss w'
		]);
	});
});

describe('engine only-move verdict', () => {
	// 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Bxc6: black to move.
	const fen = 'r1bqkbnr/1ppp1ppp/p1B5/4p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4';
	const ev = (cp0: number, cp1: number, best = 'd7c6') => ({
		fen,
		depth: 30,
		knodes: 1,
		pvs: [
			{ moves: [best], scoreCp: cp0 },
			{ moves: ['b7c6'], scoreCp: cp1 }
		]
	});

	it('is forced when the next-best move is much worse for the mover', () => {
		// White-POV scores: dxc6 keeps it level, the alternative is +2.5 for white.
		expect(onlyMoveVerdict(fen, 'dxc6', ev(0, 250), 5)).toEqual({
			forced: true,
			gapCp: 250,
			fetchedAt: 5
		});
	});

	it('is not forced when the alternative is close', () => {
		expect(onlyMoveVerdict(fen, 'dxc6', ev(0, 40), 5).forced).toBe(false);
	});

	it('is not forced when the prepared move is not the best one', () => {
		expect(onlyMoveVerdict(fen, 'bxc6', ev(0, 250), 5)).toEqual({
			forced: false,
			gapCp: null,
			fetchedAt: 5
		});
	});

	it('records a miss when there is no eval', () => {
		expect(onlyMoveVerdict(fen, 'dxc6', null, 5).gapCp).toBeNull();
	});
});

describe('drilling forced lines together', () => {
	const now = Date.now();

	it.each(['play', 'auto'] as const)(
		'brings the whole run when one of its moves is due (walk=%s)',
		async (walk) => {
			await seed(cardKeys.map((k) => learned(k, k === 'cc w' ? now - DAY : now + 30 * DAY)));
			const seg = await buildSegment(rep, 'due', settings({ drillIntermediateMoves: walk }));
			expect(seg.cards.map((c) => c.fenKey)).toEqual(['c w', 'cc w', 'ccc w']);
			// Only the due move is graded as a review; the rest are walk steps.
			expect([...seg.dueOriginalKeys]).toEqual(['cc w']);
		}
	);

	it('unlocks a new run in one go, even past the new-move budget', async () => {
		await seed([
			learned('root w', now + 30 * DAY),
			...['c w', 'cc w', 'ccc w', 's w', 'ss w'].map((k) => createFreshCard(REP, k, 'x', 1))
		]);
		const seg = await buildSegment(rep, 'due', settings({ dailyNewCardCap: 1 }));
		expect(seg.cards.map((c) => c.fenKey)).toEqual(['c w', 'cc w', 'ccc w']);
	});

	it('keeps engine verdicts when a study pull rebuilds the tree', async () => {
		await seed([]);
		const edges = tree.flatMap((x) =>
			x.children.map((c) => ({ fromFenKey: x.fenKey, edge: { ...c, onlyMove: undefined } }))
		);
		await replaceRepertoireTree(REP, 'root w', edges);
		const after = await nodesMap(REP);
		expect(after.get('c3 b')!.children[0].onlyMove?.forced).toBe(true);
	});
});
