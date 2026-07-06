import { describe, expect, it } from 'vitest';
import type { Edge, RepertoireNode } from '$lib/types';
import { buildTreeRows } from './treeView';

function node(fenKey: string, children: Edge[]): RepertoireNode {
	return { repertoireId: 'r', fenKey, children };
}

function edge(san: string, toFenKey: string, disabled = false): Edge {
	return { san, uci: 'xxxx', toFenKey, ...(disabled ? { disabled: true } : {}) };
}

/** Flatten rows to "depth: san san ..." lines for compact assertions. */
function sketch(rows: ReturnType<typeof buildTreeRows>): string[] {
	return rows.map((r) => `${r.depth}: ${r.moves.map((m) => m.san).join(' ')}`);
}

describe('buildTreeRows', () => {
	it('marks branch points and opening moves as foldable', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b'), edge('c5', 'sic')]));
		m.set('b', node('b', []));
		m.set('sic', node('sic', []));
		const flat = buildTreeRows(m, 'r').flatMap((row) => row.moves);
		// e4 is the opening move → foldable; a-branch (the e5 move sits on the
		// branching position `a`… actually the branching node is `a`, reached by
		// e4) → e4 foldable. e5/c5 are leaves → not foldable.
		expect(flat.find((x) => x.san === 'e4')!.foldable).toBe(true);
		expect(flat.find((x) => x.san === 'e5')!.foldable).toBe(false);
	});

	it('collapses a position, hiding its subtree with a count', () => {
		// e4 opens; after 1.e4 e5 2.Nf3 the position branches (Nc6 / c5).
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b')]));
		m.set('b', node('b', [edge('Nf3', 'c')]));
		m.set('c', node('c', [edge('Nc6', 'd'), edge('c5', 'e')]));
		m.set('d', node('d', []));
		m.set('e', node('e', []));

		const full = buildTreeRows(m, 'r');
		expect(full.flatMap((row) => row.moves).map((x) => x.san)).toContain('Nc6');

		// Collapse the branching position `c` (reached by Nf3).
		const folded = buildTreeRows(m, 'r', { collapsed: new Set(['c']) });
		const moves = folded.flatMap((row) => row.moves);
		const nf3 = moves.find((x) => x.san === 'Nf3')!;
		expect(nf3.collapsed).toBe(true);
		expect(nf3.hiddenCount).toBe(2); // Nc6 and c5 hidden
		// The hidden continuation isn't drawn anywhere.
		expect(moves.map((x) => x.san)).not.toContain('Nc6');
		expect(moves.map((x) => x.san)).not.toContain('c5');
	});

	it('folds an entire opening when its first move is collapsed', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a'), edge('d4', 'x')]));
		m.set('a', node('a', [edge('e5', 'b')]));
		m.set('b', node('b', []));
		m.set('x', node('x', []));
		const folded = buildTreeRows(m, 'r', { collapsed: new Set(['a']) });
		const moves = folded.flatMap((row) => row.moves);
		const e4 = moves.find((x) => x.san === 'e4')!;
		expect(e4.collapsed).toBe(true);
		expect(e4.hiddenCount).toBe(1); // e5 hidden
		expect(moves.map((x) => x.san)).not.toContain('e5');
		// The other opening is unaffected.
		expect(moves.map((x) => x.san)).toContain('d4');
	});

	it('returns nothing for an empty tree', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', []));
		expect(buildTreeRows(m, 'r')).toEqual([]);
	});

	it('draws a linear mainline as a single depth-0 row', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b')]));
		m.set('b', node('b', [edge('Nf3', 'c')]));
		m.set('c', node('c', []));
		expect(sketch(buildTreeRows(m, 'r'))).toEqual(['0: e4 e5 Nf3']);
	});

	it('assigns plies from the root', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b')]));
		m.set('b', node('b', []));
		const rows = buildTreeRows(m, 'r');
		expect(rows[0].moves.map((x) => x.ply)).toEqual([1, 2]);
	});

	it('keeps the mainline move inline and indents the sideline beneath it', () => {
		// r: e4 -> a; a branches e5 (main) and c5 (sideline)
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b'), edge('c5', 'sic')]));
		m.set('b', node('b', [edge('Nf3', 'c')]));
		m.set('c', node('c', []));
		m.set('sic', node('sic', [edge('Nf3', 'sic2')]));
		m.set('sic2', node('sic2', []));
		expect(sketch(buildTreeRows(m, 'r'))).toEqual([
			'0: e4 e5', // mainline move e5 stays on the row with e4
			'1: c5 Nf3', // indented alternative to e5, right beneath it
			'0: Nf3' // mainline resumes at depth 0
		]);
	});

	it('treats each distinct first move as its own depth-0 block', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a'), edge('d4', 'b')]));
		m.set('a', node('a', []));
		m.set('b', node('b', []));
		expect(sketch(buildTreeRows(m, 'r'))).toEqual(['0: e4', '0: d4']);
	});

	it('marks a transposition and stops expanding the second arrival', () => {
		// Two move orders reach shared node X. Mainline (e4 first) expands X;
		// the d4 order reaches X and must stop there, flagged transposition.
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'e4p'), edge('d4', 'd4p')]));
		m.set('e4p', node('e4p', [edge('d5', 'X')]));
		m.set('d4p', node('d4p', [edge('e5?!', 'X')])); // both reach X
		m.set('X', node('X', [edge('exd5', 'Y')]));
		m.set('Y', node('Y', []));
		const rows = buildTreeRows(m, 'r');
		// e4 block expands X -> exd5; d4 block stops at X (transposition).
		const flat = rows.flatMap((r) => r.moves);
		const firstX = flat.find((mo) => mo.fenKey === 'X' && !mo.transposition);
		const secondX = flat.find((mo) => mo.fenKey === 'X' && mo.transposition);
		expect(firstX).toBeTruthy();
		expect(secondX).toBeTruthy();
		// exd5 is only drawn once (under the first X).
		expect(flat.filter((mo) => mo.san === 'exd5')).toHaveLength(1);
	});

	it('terminates on a cyclic graph (threefold repetition)', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('Nf3', 'a')]));
		m.set('a', node('a', [edge('Ng1', 'r')])); // loops back to root
		const rows = buildTreeRows(m, 'r');
		// Nf3 then Ng1-back-to-root (flagged transposition), no infinite loop.
		const flat = rows.flatMap((x) => x.moves);
		expect(flat.map((x) => x.san)).toEqual(['Nf3', 'Ng1']);
		expect(flat[1].transposition).toBe(true);
	});

	it('inherits disabled state down a shelved line', () => {
		const m = new Map<string, RepertoireNode>();
		m.set('r', node('r', [edge('e4', 'a')]));
		m.set('a', node('a', [edge('e5', 'b', true)])); // e5 disabled
		m.set('b', node('b', [edge('Nf3', 'c')]));
		m.set('c', node('c', []));
		const flat = buildTreeRows(m, 'r').flatMap((x) => x.moves);
		expect(flat.find((x) => x.san === 'e4')!.disabled).toBe(false);
		expect(flat.find((x) => x.san === 'e5')!.disabled).toBe(true);
		expect(flat.find((x) => x.san === 'Nf3')!.disabled).toBe(true); // inherited
	});

	it('respects the maxRows safety cap', () => {
		// A wide fan of sidelines from one node; cap keeps output bounded.
		const kids: Edge[] = [];
		const m = new Map<string, RepertoireNode>();
		for (let i = 0; i < 50; i++) {
			kids.push(edge(`m${i}`, `n${i}`));
			m.set(`n${i}`, node(`n${i}`, []));
		}
		m.set('r', node('r', kids));
		const rows = buildTreeRows(m, 'r', { maxRows: 10 });
		expect(rows.length).toBeLessThanOrEqual(10);
	});
});
