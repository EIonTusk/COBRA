import { describe, expect, it } from 'vitest';
import { exportRepertoirePgn, parseRepertoirePgn, type ExportNode } from './pgn';
import type { Edge } from '$lib/types';

describe('parseRepertoirePgn', () => {
	it('captures move comments on the resulting position', () => {
		const pgn = `1. e4 { open game } e5 { symmetric reply } 2. Nf3 *`;
		const [line] = parseRepertoirePgn(pgn);
		expect(line.edges).toHaveLength(3);
		const [e4, e5] = line.edges;
		expect(e4.edge.san).toBe('e4');
		expect(e4.comment).toBe('open game');
		expect(e5.edge.san).toBe('e5');
		expect(e5.comment).toBe('symmetric reply');
	});

	it('captures NAGs alongside comments', () => {
		const pgn = `1. e4 $1 { strong } e5 $2 *`;
		const [line] = parseRepertoirePgn(pgn);
		const [e4, e5] = line.edges;
		expect(e4.nags).toEqual([1]);
		expect(e4.comment).toBe('strong');
		expect(e5.nags).toEqual([2]);
	});

	it('joins multiple comments on the same move with a space', () => {
		const pgn = `1. e4 { first } { second } e5 *`;
		const [line] = parseRepertoirePgn(pgn);
		expect(line.edges[0].comment).toBe('first second');
	});
});

describe('exportRepertoirePgn round-trip', () => {
	it('emits position-level comments and NAGs back into PGN', () => {
		const pgn = `1. e4 { open } e5 $1 { good } 2. Nf3 *`;
		const [line] = parseRepertoirePgn(pgn);

		// Mirror replaceRepertoireTree: lay edges into a node map, then attach
		// each parsed comment/nags to the destination node.
		const map = new Map<string, ExportNode>();
		const ensure = (fenKey: string): ExportNode => {
			let n = map.get(fenKey);
			if (!n) {
				n = { fenKey, children: [] };
				map.set(fenKey, n);
			}
			return n;
		};
		ensure(line.rootFenKey);
		for (const { fromFenKey, edge, comment, nags } of line.edges) {
			const parent = ensure(fromFenKey);
			ensure(edge.toFenKey);
			if (!parent.children.find((e: Edge) => e.toFenKey === edge.toFenKey)) {
				parent.children.push(edge);
			}
			if (comment) ensure(edge.toFenKey).comment = comment;
			if (nags && nags.length > 0) ensure(edge.toFenKey).nags = nags;
		}

		const out = exportRepertoirePgn(map, line.rootFenKey);
		expect(out).toContain('{ open }');
		expect(out).toContain('{ good }');
		expect(out).toContain('$1');

		// And re-parsing the export must surface the same notes again — that
		// catches accidental regressions like dropping comments on alt branches.
		const [re] = parseRepertoirePgn(out);
		expect(re.edges[0].comment).toBe('open');
		expect(re.edges[1].comment).toBe('good');
		expect(re.edges[1].nags).toEqual([1]);
	});
});
