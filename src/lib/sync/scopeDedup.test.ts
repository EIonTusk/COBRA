import { describe, expect, it } from 'vitest';
import { dedupeScopesByName, type DedupableScope } from './scopeDedup';

function scope(
	p: Partial<DedupableScope> & { scopeName: string; kind: DedupableScope['kind'] }
): DedupableScope {
	return { revision: 0, pushedAt: 0, ...p };
}

describe('dedupeScopesByName', () => {
	it('keeps distinct names untouched', () => {
		const out = dedupeScopesByName([
			scope({ scopeName: 'COBRA-SYNC:rep:a', kind: 'rep-core' }),
			scope({ scopeName: 'COBRA-SYNC:rep-telemetry:a', kind: 'rep-telemetry' }),
			scope({ scopeName: 'COBRA-SYNC:global', kind: 'global' })
		]);
		expect(out).toHaveLength(3);
	});

	it('keeps the highest revision among same-name same-kind duplicates', () => {
		const out = dedupeScopesByName([
			scope({ scopeName: 'n', kind: 'rep-core', revision: 2 }),
			scope({ scopeName: 'n', kind: 'rep-core', revision: 5 }),
			scope({ scopeName: 'n', kind: 'rep-core', revision: 3 })
		]);
		expect(out).toHaveLength(1);
		expect(out[0].revision).toBe(5);
	});

	it('breaks equal-revision ties by pushedAt', () => {
		const out = dedupeScopesByName([
			scope({ scopeName: 'n', kind: 'rep-core', revision: 4, pushedAt: 100 }),
			scope({ scopeName: 'n', kind: 'rep-core', revision: 4, pushedAt: 200 })
		]);
		expect(out[0].pushedAt).toBe(200);
	});

	it('prefers a tier scope over a same-named stale legacy combined, even at lower revision', () => {
		// The migration edge: combined rev 7 vs fresh rep-core rev 0 at the
		// shared `:rep:` name. The tier must win regardless of revision.
		const out = dedupeScopesByName([
			scope({ scopeName: 'COBRA-SYNC:rep:a', kind: 'rep', revision: 7 }),
			scope({ scopeName: 'COBRA-SYNC:rep:a', kind: 'rep-core', revision: 0 })
		]);
		expect(out).toHaveLength(1);
		expect(out[0].kind).toBe('rep-core');
	});

	it('tier still wins regardless of input order', () => {
		const out = dedupeScopesByName([
			scope({ scopeName: 'COBRA-SYNC:rep:a', kind: 'rep-core', revision: 0 }),
			scope({ scopeName: 'COBRA-SYNC:rep:a', kind: 'rep', revision: 7 })
		]);
		expect(out[0].kind).toBe('rep-core');
	});
});
