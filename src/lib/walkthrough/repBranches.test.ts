import { describe, expect, it } from 'vitest';

import type { RepertoireNode } from '$lib/types';
import { findBranchPoint } from './repBranches';

const n = (fenKey: string, children: [string, boolean?][]): RepertoireNode => ({
	repertoireId: 'rep',
	fenKey,
	children: children.map(([to, disabled]) => ({
		san: to,
		uci: 'xxxx',
		toFenKey: to,
		...(disabled ? { disabled: true } : {})
	}))
});

describe('findBranchPoint', () => {
	it('walks past a position whose only alternative is disabled (#99)', () => {
		const nodes = new Map(
			[
				n('root', [['A']]),
				n('A', [['B', true], ['C']]),
				n('C', [['D'], ['E']]),
				n('B', []),
				n('D', []),
				n('E', [])
			].map((x) => [x.fenKey, x])
		);
		expect(findBranchPoint({ nodes, rootFenKey: 'root' })).toBe('C');
	});
});
