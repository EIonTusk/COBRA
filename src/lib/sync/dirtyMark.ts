/**
 * Tiny shim for storage modules to flag dirty entities without importing the
 * sync store directly — that would create a cycle (sync store → bundle.ts →
 * storage modules). The sync store registers itself via `setDirtyHandler` on
 * boot; until then (or while the user has sync disabled) every mark is a
 * no-op.
 *
 * Storage code calls these unconditionally; sync-disabled is the common case
 * so the cost has to be near zero — one function-pointer null check.
 */

type Handler = (key: 'global' | `rep:${string}`) => void;

let handler: Handler | null = null;

export function setDirtyHandler(h: Handler | null): void {
	handler = h;
}

export function markRepDirty(repertoireId: string): void {
	handler?.(`rep:${repertoireId}`);
}

export function markRepsDirty(repertoireIds: Iterable<string>): void {
	if (!handler) return;
	const seen = new Set<string>();
	for (const id of repertoireIds) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		handler(`rep:${id}`);
	}
}

export function markGlobalDirty(): void {
	handler?.('global');
}
