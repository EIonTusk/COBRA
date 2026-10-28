import { describe, expect, it } from 'vitest';

import type { RepertoireNode } from '$lib/types';
import { annotatePlies } from './annotate';

// Fen keys only need a side to move here: "<id> w" / "<id> b".
const n = (fenKey: string, children: [string, string, boolean?][]): RepertoireNode => ({
	repertoireId: 'rep',
	fenKey,
	children: children.map(([san, to, disabled]) => ({
		san,
		uci: 'xxxx',
		toFenKey: to,
		...(disabled ? { disabled: true } : {})
	}))
});

// White rep: 1.e4 e5 2.Nf3 (live) / 2.Bc4 (disabled) Nf6 3.Ng5;
// 2.Nf3 Nc6 3.Bb5 is the only prepared move there, and it's disabled.
const rep = {
	color: 'white' as const,
	rootFenKey: 'r w',
	nodes: new Map(
		[
			n('r w', [['e4', 'a b']]),
			n('a b', [['e5', 'b w']]),
			n('b w', [
				['Nf3', 'c b'],
				['Bc4', 'd b', true]
			]),
			n('c b', [['Nc6', 'h w']]),
			n('h w', [['Bb5', 'i b', true]]),
			n('d b', [['Nf6', 'e w']]),
			n('e w', [['Ng5', 'f b']])
		].map((x) => [x.fenKey, x])
	)
};

const game = (...moves: [string, string][]) =>
	moves.map(([san, fenKeyBefore]) => ({ san, fenKeyBefore }));

describe('annotatePlies', () => {
	it('grades live prepared moves as matches', () => {
		const out = annotatePlies(game(['e4', 'r w'], ['e5', 'a b'], ['Nf3', 'b w']), rep);
		expect(out.map((p) => p.annotation)).toEqual(['match', 'opponent', 'match']);
	});

	it('marks a disabled move and the rest of its line as disabled, not a match (#108)', () => {
		const out = annotatePlies(
			game(['e4', 'r w'], ['e5', 'a b'], ['Bc4', 'b w'], ['Nf6', 'd b'], ['Ng5', 'e w']),
			rep
		);
		expect(out.map((p) => p.annotation)).toEqual([
			'match',
			'opponent',
			'disabled',
			'opponent',
			'disabled'
		]);
		// The live move is the one offered instead.
		expect(out[2].expectedSan).toBe('Nf3');
	});

	it('never suggests a disabled move as the expected move at a deviation (#99)', () => {
		const out = annotatePlies(game(['Qh5', 'b w']), rep);
		expect(out[0]).toEqual({ annotation: 'deviation', expectedSan: 'Nf3' });
	});

	it('treats a position whose only prepared move is disabled as past prep', () => {
		expect(annotatePlies(game(['Bc4', 'h w']), rep)[0]).toEqual({ annotation: 'past-tree' });
		expect(annotatePlies(game(['Bb5', 'h w']), rep)[0]).toEqual({
			annotation: 'disabled',
			expectedSan: undefined
		});
	});

	it('grades everything as opponent with no repertoire selected', () => {
		const out = annotatePlies(game(['e4', 'r w'], ['e5', 'a b']), null);
		expect(out.map((p) => p.annotation)).toEqual(['opponent', 'opponent']);
	});
});
