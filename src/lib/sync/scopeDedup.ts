/**
 * Collapse pulled scopes that share a `scopeName` down to one winner.
 *
 * Two scopes can share a name for two reasons:
 *   1. Duplicate chapters left behind when a push's same-name cleanup sweep
 *      failed (best-effort). Highest `(revision, pushedAt)` wins — newest data.
 *   2. The combined→tier migration (issue #68, option 1): a `rep-core` scope
 *      reuses the legacy `COBRA-SYNC:rep:<id8>` name. If a stale pre-split
 *      combined (`rep`) chapter transiently lingers alongside the new core
 *      chapter, they collide on name but have *independent* revision counters
 *      — so a naive highest-revision compare could wrongly keep the stale
 *      combined blob (e.g. combined rev 7 vs fresh core rev 0).
 *
 * Rule: a tier scope (`rep-core`) ALWAYS supersedes a same-named legacy
 * combined (`rep`) scope, regardless of revision — the tier is the
 * post-migration source of truth. Only when both sides are the same legacy-ness
 * do we fall back to the `(revision, pushedAt)` tiebreak.
 */

import type { SyncKind } from './pgnWrap';

export interface DedupableScope {
	scopeName: string;
	kind: SyncKind;
	revision: number;
	pushedAt: number;
}

function isLegacyCombined(kind: SyncKind): boolean {
	return kind === 'rep';
}

function recencyKey(s: DedupableScope): number {
	// revision dominates; pushedAt breaks ties between equal revisions.
	return s.revision * 1e15 + s.pushedAt;
}

export function dedupeScopesByName<T extends DedupableScope>(scopes: T[]): T[] {
	const byName: Record<string, T> = {};
	for (const s of scopes) {
		const prev = byName[s.scopeName];
		if (!prev) {
			byName[s.scopeName] = s;
			continue;
		}
		const prevLegacy = isLegacyCombined(prev.kind);
		const curLegacy = isLegacyCombined(s.kind);
		if (prevLegacy !== curLegacy) {
			// One is a tier scope, the other the legacy combined — the tier wins
			// outright (migration supersedes), revision notwithstanding.
			if (prevLegacy) byName[s.scopeName] = s;
			continue;
		}
		if (recencyKey(s) > recencyKey(prev)) byName[s.scopeName] = s;
	}
	return Object.values(byName);
}
