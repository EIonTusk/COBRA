import { getDB } from './db';
import type { RepertoireNode, Edge } from '$lib/types';
import { markRepDirty } from '$lib/sync/dirtyMark';
import { reachableFenKeys } from '$lib/tree/traversal';

/**
 * Record (or refresh) a tombstone for the `node → toFenKey` edge, mutating
 * `node.deletedChildren` in place. Sync reads these so an edge deleted on one
 * device is dropped on the others instead of being resurrected by the
 * adds-win edge union — see `mergeNode`.
 */
function recordEdgeTombstone(node: RepertoireNode, toFenKey: string, at: number): void {
	const list = node.deletedChildren ?? [];
	const existing = list.find((t) => t.toFenKey === toFenKey);
	if (existing) existing.deletedAt = at;
	else list.push({ toFenKey, deletedAt: at });
	node.deletedChildren = list;
}

/**
 * Drop any tombstone for the `node → toFenKey` edge. Called when the edge is
 * (re-)added so a stale deletion can't suppress the fresh add on the next
 * sync. Leaves `deletedChildren` undefined once it empties.
 */
function clearEdgeTombstone(node: RepertoireNode, toFenKey: string): void {
	if (!node.deletedChildren?.length) return;
	const remaining = node.deletedChildren.filter((t) => t.toFenKey !== toFenKey);
	node.deletedChildren = remaining.length > 0 ? remaining : undefined;
}

/**
 * Bulk-replace every node of `repertoireId` with the supplied parsed edges.
 * `rootFenKey` seeds an empty root so a repertoire with no edges still has
 * its starting position. Used by the Lichess study pull to overwrite the
 * local tree with what the study currently says.
 *
 * Orphan cards/idea cards (keyed on fenKeys that no longer exist in the new
 * tree) are dropped in the same transaction so the drill queue doesn't
 * surface positions that can no longer be reached.
 */
export async function replaceRepertoireTree(
	repertoireId: string,
	rootFenKey: string,
	edges: Array<{ fromFenKey: string; edge: Edge; comment?: string; nags?: number[] }>
): Promise<{ fenKeys: Set<string>; edgeCount: number }> {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards', 'idea_cards'], 'readwrite');
	const nodes = tx.objectStore('nodes');
	const cards = tx.objectStore('cards');
	const ideas = tx.objectStore('idea_cards');

	// Wipe every existing node for this repertoire.
	const oldKeys = await nodes.index('by-repertoire').getAllKeys(repertoireId);
	for (const key of oldKeys) await nodes.delete(key);

	// Rebuild the node map. Every fenKey referenced (parent or child) gets
	// a stub node; parent comments/nags from the parsed edges land on the
	// node matching `fromFenKey`.
	const map = new Map<string, RepertoireNode>();
	const ensure = (fenKey: string): RepertoireNode => {
		let n = map.get(fenKey);
		if (!n) {
			n = { repertoireId, fenKey, children: [] };
			map.set(fenKey, n);
		}
		return n;
	};
	ensure(rootFenKey);
	const now = Date.now();
	for (const { fromFenKey, edge, comment, nags } of edges) {
		const parent = ensure(fromFenKey);
		ensure(edge.toFenKey);
		if (!parent.children.find((e) => e.toFenKey === edge.toFenKey)) {
			parent.children.push({ ...edge, updatedAt: edge.updatedAt ?? now });
		}
		// Comments/nags on the edge live on the child node (the resulting
		// position), matching how parseRepertoirePgn carries them over.
		if (comment || (nags && nags.length > 0)) {
			const child = ensure(edge.toFenKey);
			if (comment) child.comment = comment;
			if (nags && nags.length > 0) child.nags = nags;
			child.updatedAt = now;
		}
	}
	for (const node of map.values()) {
		node.updatedAt = node.updatedAt ?? now;
		await nodes.put(JSON.parse(JSON.stringify(node)) as RepertoireNode);
	}

	// Sweep orphan FSRS state: cards/ideas whose fenKey isn't in the new
	// tree. Cards still pointing at a live position keep their FSRS history.
	const liveKeys = new Set(map.keys());
	const cardKeys = await cards.index('by-repertoire').getAllKeys(repertoireId);
	for (const key of cardKeys) {
		const [, fenKey] = key as [string, string];
		if (!liveKeys.has(fenKey)) await cards.delete(key);
	}
	const ideaKeys = await ideas.index('by-repertoire').getAllKeys(repertoireId);
	for (const key of ideaKeys) {
		const [, fenKey] = key as [string, string];
		if (!liveKeys.has(fenKey)) await ideas.delete(key);
	}

	await tx.done;
	markRepDirty(repertoireId);
	return { fenKeys: liveKeys, edgeCount: edges.length };
}

export async function getNode(
	repertoireId: string,
	fenKey: string
): Promise<RepertoireNode | undefined> {
	const db = await getDB();
	return db.get('nodes', [repertoireId, fenKey]);
}

export async function upsertNode(node: RepertoireNode): Promise<void> {
	const db = await getDB();
	const stamped: RepertoireNode = { ...node, updatedAt: Date.now() };
	await db.put('nodes', stamped);
	markRepDirty(node.repertoireId);
}

export async function ensureNode(repertoireId: string, fenKey: string): Promise<RepertoireNode> {
	const db = await getDB();
	const existing = await db.get('nodes', [repertoireId, fenKey]);
	if (existing) return existing;
	const fresh: RepertoireNode = {
		repertoireId,
		fenKey,
		children: [],
		updatedAt: Date.now()
	};
	await db.put('nodes', fresh);
	markRepDirty(repertoireId);
	return fresh;
}

export async function addEdge(
	repertoireId: string,
	fromFenKey: string,
	edge: Edge
): Promise<{ created: boolean }> {
	const db = await getDB();
	const tx = db.transaction(['nodes'], 'readwrite');
	const store = tx.objectStore('nodes');
	const now = Date.now();
	let parent = await store.get([repertoireId, fromFenKey]);
	if (!parent) {
		parent = { repertoireId, fenKey: fromFenKey, children: [], updatedAt: now };
	}
	let created = false;
	if (!parent.children.find((e) => e.toFenKey === edge.toFenKey)) {
		// Strip any $state proxies before the edge hits IDB — structuredClone
		// (which IDB uses) can't clone Proxy objects and throws DataCloneError.
		const stamped: Edge = { ...edge, updatedAt: edge.updatedAt ?? now };
		parent.children.push(JSON.parse(JSON.stringify(stamped)) as Edge);
		created = true;
	}
	// A live edge must not carry a deletion tombstone, or the re-add would be
	// suppressed on the next sync.
	clearEdgeTombstone(parent, edge.toFenKey);
	await store.put(JSON.parse(JSON.stringify(parent)) as RepertoireNode);
	const child = await store.get([repertoireId, edge.toFenKey]);
	if (!child) {
		await store.put({ repertoireId, fenKey: edge.toFenKey, children: [], updatedAt: now });
	}
	await tx.done;
	markRepDirty(repertoireId);
	return { created };
}

export async function removeEdge(
	repertoireId: string,
	fromFenKey: string,
	toFenKey: string
): Promise<void> {
	const db = await getDB();
	const node = await db.get('nodes', [repertoireId, fromFenKey]);
	if (!node) return;
	const now = Date.now();
	node.children = node.children.filter((e) => e.toFenKey !== toFenKey);
	node.updatedAt = now;
	recordEdgeTombstone(node, toFenKey, now);
	await db.put('nodes', node);
	markRepDirty(repertoireId);
}

/**
 * Remove the `fromFenKey → toFenKey` edge, then prune everything that
 * edge was holding onto. After cutting the edge we recompute the set of
 * positions still reachable from `rootFenKey` and delete any node, FSRS
 * move card, and idea card whose fenKey fell out of that set.
 *
 * Why reachability rather than "delete the subtree": positions are a
 * FEN-keyed graph, so a position below the cut edge may still transpose
 * into a live line via another path — those must be kept. Only genuinely
 * orphaned positions are dropped. Without this sweep, deleting a move in
 * the editor leaves orphaned cards behind that the drill queue keeps
 * serving (it reads cards by index, not by walking the tree).
 *
 * All deletes run in one transaction so the tree and the drill card pool
 * can't desynchronise. Mirrors the orphan sweep in `replaceRepertoireTree`.
 */
export async function removeEdgeAndPrune(
	repertoireId: string,
	rootFenKey: string,
	fromFenKey: string,
	toFenKey: string
): Promise<void> {
	const db = await getDB();
	const tx = db.transaction(['nodes', 'cards', 'idea_cards'], 'readwrite');
	const nodes = tx.objectStore('nodes');
	const cards = tx.objectStore('cards');
	const ideas = tx.objectStore('idea_cards');

	const parent = await nodes.get([repertoireId, fromFenKey]);
	if (!parent) {
		await tx.done;
		return;
	}
	const now = Date.now();
	parent.children = parent.children.filter((e) => e.toFenKey !== toFenKey);
	parent.updatedAt = now;
	recordEdgeTombstone(parent, toFenKey, now);
	await nodes.put(parent);

	// Recompute reachability from the root over the post-cut graph.
	const all = await nodes.index('by-repertoire').getAll(repertoireId);
	const map = new Map<string, RepertoireNode>(all.map((n) => [n.fenKey, n]));
	const live = reachableFenKeys(map, rootFenKey);

	for (const n of all) {
		if (!live.has(n.fenKey)) await nodes.delete([repertoireId, n.fenKey]);
	}
	const cardKeys = await cards.index('by-repertoire').getAllKeys(repertoireId);
	for (const key of cardKeys) {
		const [, fenKey] = key as [string, string];
		if (!live.has(fenKey)) await cards.delete(key);
	}
	const ideaKeys = await ideas.index('by-repertoire').getAllKeys(repertoireId);
	for (const key of ideaKeys) {
		const [, fenKey] = key as [string, string];
		if (!live.has(fenKey)) await ideas.delete(key);
	}

	await tx.done;
	markRepDirty(repertoireId);
}

/**
 * Toggle the soft-disable flag on a single edge (the "head" of a line the
 * user is shelving). Stamps `updatedAt` so the sync-v2 edge LWW carries the
 * new state across devices. Clears the flag to `undefined` rather than
 * storing `false`, keeping edges written before the feature byte-identical.
 * The whole-continuation behaviour is derived at read time from this one
 * flag (see `liveReachableFenKeys`) — no cascade write over the subtree.
 */
export async function setEdgeDisabled(
	repertoireId: string,
	fromFenKey: string,
	toFenKey: string,
	disabled: boolean
): Promise<void> {
	const db = await getDB();
	const node = await db.get('nodes', [repertoireId, fromFenKey]);
	if (!node) return;
	const edge = node.children.find((e) => e.toFenKey === toFenKey);
	if (!edge) return;
	edge.disabled = disabled ? true : undefined;
	edge.updatedAt = Date.now();
	node.updatedAt = Date.now();
	await db.put('nodes', node);
	markRepDirty(repertoireId);
}

export async function setNodeComment(
	repertoireId: string,
	fenKey: string,
	comment: string
): Promise<void> {
	const db = await getDB();
	const node = (await db.get('nodes', [repertoireId, fenKey])) ?? {
		repertoireId,
		fenKey,
		children: []
	};
	node.comment = comment || undefined;
	node.updatedAt = Date.now();
	await db.put('nodes', node);
	markRepDirty(repertoireId);
}

/**
 * Additive note write used by import paths: lays a parsed comment / NAGs
 * onto the node for `fenKey` without touching its children or wiping
 * fields the caller didn't supply. Mirrors how `replaceRepertoireTree`
 * attaches comments/nags from the parsed-edge tuple to the resulting
 * position. No-ops when both fields are empty so import loops can call
 * it unconditionally.
 */
export async function applyImportedNote(
	repertoireId: string,
	fenKey: string,
	note: { comment?: string; nags?: number[] }
): Promise<void> {
	const hasComment = !!note.comment;
	const hasNags = !!(note.nags && note.nags.length > 0);
	if (!hasComment && !hasNags) return;
	const db = await getDB();
	const node = (await db.get('nodes', [repertoireId, fenKey])) ?? {
		repertoireId,
		fenKey,
		children: []
	};
	if (hasComment) node.comment = note.comment;
	if (hasNags) node.nags = note.nags;
	node.updatedAt = Date.now();
	await db.put('nodes', node);
	markRepDirty(repertoireId);
}

export async function listNodes(repertoireId: string): Promise<RepertoireNode[]> {
	const db = await getDB();
	return db.getAllFromIndex('nodes', 'by-repertoire', repertoireId);
}

export async function nodesMap(repertoireId: string): Promise<Map<string, RepertoireNode>> {
	const all = await listNodes(repertoireId);
	return new Map(all.map((n) => [n.fenKey, n]));
}
