import { describe, expect, it } from 'vitest';
import { openingAt, treeOpenings } from './openings';
import { positionHash } from './hash';
import { TreeError, validateTree } from './tree';
import { keyAfter, treeFromLines } from './testing/trees';

const italian = () =>
	treeFromLines('white', ['e4 e5 Nf3 Nc6 Bc4 Bc5 c3', 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3', 'e4 c5 Nf3'], {
		comments: { Bc4: 'Italian setup' }
	});

describe('validateTree', () => {
	it('accepts a well-formed tree and rebuilds it canonically', () => {
		const v = validateTree(italian());
		expect(v.positionCount).toBe(12);
		expect(v.moveCount).toBe(11);
		expect(v.tree.nodes[0].fenKey).toBe(v.rootFenKey);
		expect(v.tree.nodes.find((n) => n.comment)?.comment).toBe('Italian setup');
	});

	// The no-progress rule: anything outside the allow-list is a hard error,
	// never silently dropped, so a client bug can't leak training data.
	it.each([
		['top level', (t: Record<string, unknown>) => (t.mistakes = [{ ply: 3 }])],
		['top level cards', (t: Record<string, unknown>) => (t.cards = [])],
		['node fsrs', (t: Record<string, unknown>) => ((t.nodes as Record<string, unknown>[])[0].fsrs = {})],
		[
			'node repertoireId',
			(t: Record<string, unknown>) => ((t.nodes as Record<string, unknown>[])[0].repertoireId = 'x')
		],
		[
			'edge dueAt',
			(t: Record<string, unknown>) =>
				(((t.nodes as Record<string, unknown>[])[0].children as Record<string, unknown>[])[0].dueAt = 1)
		],
		[
			'edge frequency',
			(t: Record<string, unknown>) =>
				(((t.nodes as Record<string, unknown>[])[0].children as Record<string, unknown>[])[0].frequency = {
					games: 10
				})
		],
		[
			'idea card fsrs',
			(t: Record<string, unknown>) =>
				(t.ideaCards = [{ fenKey: (t.nodes as { fenKey: string }[])[0].fenKey, prompt: 'p', fsrs: {} }])
		],
		[
			'idea card lastReview',
			(t: Record<string, unknown>) =>
				(t.ideaCards = [{ fenKey: (t.nodes as { fenKey: string }[])[0].fenKey, prompt: 'p', lastReview: 1 }])
		]
	])('rejects an unexpected field (%s)', (_name, mutate) => {
		const t = italian() as unknown as Record<string, unknown>;
		mutate(t);
		expect(() => validateTree(t)).toThrow(/unexpected field/);
	});

	it('rejects illegal moves, wrong SAN and wrong resulting positions', () => {
		const illegal = italian();
		illegal.nodes[0].children[0].uci = 'e2e5';
		expect(() => validateTree(illegal)).toThrow(/illegal move/);

		const san = italian();
		san.nodes[0].children[0].san = 'd4';
		expect(() => validateTree(san)).toThrow(/does not match/);

		const to = italian();
		to.nodes[0].children[0].toFenKey = keyAfter('d4');
		expect(() => validateTree(to)).toThrow(/wrong resulting position/);
	});

	it('rejects positions not reachable from the root', () => {
		const t = italian();
		t.nodes.push({ fenKey: keyAfter('d4 d5'), children: [] });
		expect(() => validateTree(t)).toThrow(/not reachable/);
	});

	it('rejects a move into a position with no node', () => {
		const t = italian();
		const last = t.nodes.findIndex((n) => n.fenKey === keyAfter('e4 c5 Nf3'));
		t.nodes.splice(last, 1);
		expect(() => validateTree(t)).toThrow(TreeError);
	});

	it('enforces text caps and idea-card rules', () => {
		const long = italian();
		long.nodes[0].comment = 'x'.repeat(5000);
		expect(() => validateTree(long)).toThrow(/longer than/);

		const idea = italian();
		idea.ideaCards = [{ fenKey: keyAfter('d4'), prompt: 'Plan?' }];
		expect(() => validateTree(idea)).toThrow(/not in the tree/);

		const ok = italian();
		ok.ideaCards = [{ fenKey: keyAfter('e4 e5'), prompt: ' Plan? ', answer: 'd4 break' }];
		expect(validateTree(ok).tree.ideaCards).toEqual([
			{ fenKey: keyAfter('e4 e5'), prompt: 'Plan?', answer: 'd4 break' }
		]);
	});

	it('accepts a custom root position', () => {
		const t = treeFromLines('black', ['d5 exd5'], {
			rootFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
		});
		expect(validateTree(t).moveCount).toBe(2);
	});
});

describe('openings', () => {
	it('names positions from the bundled table', () => {
		expect(openingAt(keyAfter('e4 e5 Nf3 Nc6 Bc4'))?.[1]).toBe('Italian Game');
		const names = treeOpenings(validateTree(italian()).tree).map(([, n]) => n);
		expect(names).toContain('Italian Game');
		expect(names).toContain('Sicilian Defense');
	});
});

describe('positionHash', () => {
	it('is a stable safe integer', () => {
		const h = positionHash(keyAfter('e4'));
		expect(Number.isSafeInteger(h)).toBe(true);
		expect(positionHash(keyAfter('e4'))).toBe(h);
		expect(positionHash(keyAfter('d4'))).not.toBe(h);
	});
});
