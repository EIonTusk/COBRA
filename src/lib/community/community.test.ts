// Community openings: the no-progress rule and the publish → import round trip.
// Runs against fake-indexeddb so the real stores are used, and feeds the built
// tree through the Worker's own validator.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Rating } from 'ts-fsrs';
import { Chess } from 'chessops/chess';
import { parseSan } from 'chessops/san';
import { makeUci } from 'chessops/util';
import { makeFen } from 'chessops/fen';
import { getDB } from '$lib/storage/db';
import { createRepertoire } from '$lib/storage/repertoires';
import { addEdge, setEdgeDisabled, setNodeComment } from '$lib/storage/nodes';
import { addCard, getCard, upsertCard } from '$lib/storage/cards';
import { freshIdeaCard, upsertIdeaCard } from '$lib/storage/ideaCards';
import { defaultSettings } from '$lib/storage/settings';
import { createFreshCard, reviewCard } from '$lib/fsrs/scheduler';
import { STARTPOS_KEY } from '$lib/chess/fen';
import { buildCommunityTree } from './buildTree';
import { importCommunityPublication } from './importTree';
import { EDGE_FIELDS, IDEA_FIELDS, NODE_FIELDS, TREE_FIELDS, type CommunityTreeV1 } from './types';
import { validateTree } from '../../../worker/src/community/tree';

const T = new Date('2026-03-01T00:00:00Z').getTime();
const MARK = 'PRIVATE_MARKER_7f3a';

function keyAfter(sans: string): string {
	const pos = Chess.default();
	for (const s of sans.split(' ').filter(Boolean)) pos.play(parseSan(pos, s)!);
	return makeFen(pos.toSetup(), { epd: true });
}

async function addLine(repId: string, sans: string) {
	const pos = Chess.default();
	for (const san of sans.split(' ')) {
		const from = makeFen(pos.toSetup(), { epd: true });
		const move = parseSan(pos, san)!;
		pos.play(move);
		await addEdge(repId, from, {
			san,
			uci: makeUci(move),
			toFenKey: makeFen(pos.toSetup(), { epd: true })
		});
	}
}

async function seedRepertoire() {
	const rep = await createRepertoire('Italian', 'white');
	await addLine(rep.id, 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3');
	await addLine(rep.id, 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3');
	await addLine(rep.id, 'e4 c5 c3 d5 exd5'); // to be shelved
	await setEdgeDisabled(rep.id, keyAfter('e4 c5'), keyAfter('e4 c5 c3'), true);
	await setNodeComment(rep.id, keyAfter('e4 e5 Nf3 Nc6 Bc4'), 'Aim for d4 later');

	// Training progress on every own move, graded several times.
	const params = defaultSettings().fsrsParams;
	for (const [pos, san] of [
		['', 'e4'],
		['e4 e5', 'Nf3'],
		['e4 e5 Nf3 Nc6', 'Bc4'],
		['e4 c5', 'c3']
	] as const) {
		const fen = pos ? keyAfter(pos) : STARTPOS_KEY;
		await addCard(rep.id, fen, san, T);
		let card = createFreshCard(rep.id, fen, san, T);
		for (let i = 1; i <= 3; i++)
			card = reviewCard(card, Rating.Good, params, new Date(T + i * 86_400_000));
		await upsertCard({ ...card, lastRating: Rating.Good });
	}

	// An idea card with review history.
	const idea = freshIdeaCard(
		rep.id,
		keyAfter('e4 e5'),
		'What is the plan?',
		'Develop and castle',
		T
	);
	await upsertIdeaCard({ ...idea, lastReview: T + 5000, dueAt: T + 999_999 });

	// Mistakes, gaps, spar games and position stats tagged with a marker.
	const db = await getDB();
	await db.put('mistakes', {
		id: 'm1',
		repertoireId: rep.id,
		fenKey: keyAfter('e4 e5'),
		note: MARK
	} as never);
	await db.put('empirical_gaps', {
		id: 'g1',
		repertoireId: rep.id,
		fenKey: keyAfter('e4'),
		note: MARK
	} as never);
	await db.put('spar_games', { id: 's1', repertoireId: rep.id, pgn: MARK } as never);
	await db.put('position_wdl', {
		id: 'w1',
		repertoireId: rep.id,
		fenKey: keyAfter('e4'),
		note: MARK
	} as never);
	return rep;
}

/** Every object in the tree may only have allow-listed keys. */
function assertOnlyAllowedFields(tree: CommunityTreeV1) {
	const only = (obj: object, allowed: readonly string[]) =>
		expect(Object.keys(obj).filter((k) => !allowed.includes(k))).toEqual([]);
	only(tree, TREE_FIELDS);
	for (const n of tree.nodes) {
		only(n, NODE_FIELDS);
		for (const e of n.children) only(e, EDGE_FIELDS);
	}
	for (const c of tree.ideaCards) only(c, IDEA_FIELDS);
}

beforeEach(async () => {
	const db = await getDB();
	for (const s of [
		'repertoires',
		'nodes',
		'cards',
		'move_progress',
		'idea_cards',
		'mistakes',
		'empirical_gaps',
		'spar_games',
		'position_wdl'
	] as const) {
		await db.clear(s);
	}
});

describe('community tree: no progress or mistakes leave the device', () => {
	it('contains only allow-listed fields and no private data', async () => {
		const rep = await seedRepertoire();
		const built = (await buildCommunityTree(rep.id, {
			includeComments: true,
			includeIdeaCards: true
		}))!;
		assertOnlyAllowedFields(built.tree);

		const json = JSON.stringify(built.tree);
		expect(json).not.toContain(MARK);
		for (const word of [
			'fsrs',
			'dueAt',
			'lastReview',
			'lastRating',
			'stability',
			'difficulty',
			'lapses',
			'repertoireId',
			'updatedAt',
			'createdAt',
			'disabled',
			'frequency',
			rep.id
		]) {
			expect(json).not.toContain(word);
		}
		// The idea card's text is there; its schedule isn't.
		expect(built.tree.ideaCards).toEqual([
			{ fenKey: keyAfter('e4 e5'), prompt: 'What is the plan?', answer: 'Develop and castle' }
		]);
		expect(built.tree.nodes.find((n) => n.comment)?.comment).toBe('Aim for d4 later');
	});

	it('leaves out shelved lines and everything only reachable through them', async () => {
		const rep = await seedRepertoire();
		const built = (await buildCommunityTree(rep.id, {
			includeComments: true,
			includeIdeaCards: true
		}))!;
		const keys = new Set(built.tree.nodes.map((n) => n.fenKey));
		expect(keys.has(keyAfter('e4 c5'))).toBe(true);
		expect(keys.has(keyAfter('e4 c5 c3'))).toBe(false);
		expect(keys.has(keyAfter('e4 c5 c3 d5 exd5'))).toBe(false);
		expect(built.stats.shelvedSkipped).toBe(3);
	});

	it('leaves out a shelved move even when its position is reached another way', async () => {
		const rep = await createRepertoire('QG', 'white');
		await addLine(rep.id, 'd4 Nf6 c4 e6');
		await addLine(rep.id, 'c4 Nf6 d4 e6');
		// 1.c4 Nf6 2.d4 transposes to 1.d4 Nf6 2.c4, which stays live.
		await setEdgeDisabled(rep.id, keyAfter('c4 Nf6'), keyAfter('c4 Nf6 d4'), true);
		const built = (await buildCommunityTree(rep.id, {
			includeComments: true,
			includeIdeaCards: true
		}))!;
		const node = built.tree.nodes.find((n) => n.fenKey === keyAfter('c4 Nf6'))!;
		expect(node.children).toEqual([]);
		expect(built.tree.nodes.some((n) => n.fenKey === keyAfter('d4 Nf6 c4 e6'))).toBe(true);
		expect(() => validateTree(built.tree)).not.toThrow();
	});

	it('honours the comment and idea-card switches', async () => {
		const rep = await seedRepertoire();
		const built = (await buildCommunityTree(rep.id, {
			includeComments: false,
			includeIdeaCards: false
		}))!;
		expect(built.tree.nodes.some((n) => n.comment)).toBe(false);
		expect(built.tree.ideaCards).toEqual([]);
		expect(built.texts).toEqual([]);
	});

	it('passes the Worker validator unchanged (nothing is silently dropped)', async () => {
		const rep = await seedRepertoire();
		const built = (await buildCommunityTree(rep.id, {
			includeComments: true,
			includeIdeaCards: true
		}))!;
		const v = validateTree(JSON.parse(JSON.stringify(built.tree)));
		expect(v.tree).toEqual(built.tree);
		expect(v.positionCount).toBe(built.stats.positions);
		expect(v.moveCount).toBe(built.stats.moves);
	});
});

describe('community import', () => {
	it('imports as a new repertoire, keeping the importer’s own progress', async () => {
		const rep = await seedRepertoire();
		const built = (await buildCommunityTree(rep.id, {
			includeComments: true,
			includeIdeaCards: true
		}))!;
		const before = await getCard(rep.id, STARTPOS_KEY);

		const copy = await importCommunityPublication({
			id: 'Abc234xyz9',
			title: 'Community Italian',
			version: 3,
			tree: validateTree(built.tree).tree
		});
		expect(copy.id).not.toBe(rep.id);
		expect(copy.name).toBe('Community Italian');
		expect(copy.communitySource).toEqual({ publicationId: 'Abc234xyz9', version: 3 });
		expect(copy.communityPublication).toBeNull();

		// The original is untouched, and a move both train shares its progress.
		expect(await getCard(rep.id, STARTPOS_KEY)).toEqual(before);
		const shared = await getCard(copy.id, STARTPOS_KEY);
		expect(shared?.lastReview).toBe(before?.lastReview);

		// A move the importer never trained starts fresh.
		const fresh = await getCard(copy.id, keyAfter('e4 e5 Nf3 Nc6 Bc4 Bc5'));
		expect(fresh?.expectedSan).toBe('c3');
		expect(fresh?.lastReview).toBeUndefined();

		const db = await getDB();
		const ideas = await db.getAllFromIndex('idea_cards', 'by-repertoire', copy.id);
		expect(ideas).toHaveLength(1);
		expect(ideas[0].lastReview).toBeUndefined();
		expect(ideas[0].prompt).toBe('What is the plan?');
		const nodes = await db.getAllFromIndex('nodes', 'by-repertoire', copy.id);
		expect(nodes).toHaveLength(built.stats.positions);
	});
});
