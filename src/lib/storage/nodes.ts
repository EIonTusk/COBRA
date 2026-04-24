import { getDB } from './db';
import type { RepertoireNode, Edge } from '$lib/types';

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
	for (const { fromFenKey, edge, comment, nags } of edges) {
		const parent = ensure(fromFenKey);
		ensure(edge.toFenKey);
		if (!parent.children.find((e) => e.toFenKey === edge.toFenKey)) {
			parent.children.push({ ...edge });
		}
		// Comments/nags on the edge live on the child node (the resulting
		// position), matching how parseRepertoirePgn carries them over.
		if (comment || (nags && nags.length > 0)) {
			const child = ensure(edge.toFenKey);
			if (comment) child.comment = comment;
			if (nags && nags.length > 0) child.nags = nags;
		}
	}
	for (const node of map.values()) {
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
	await db.put('nodes', node);
}

export async function ensureNode(repertoireId: string, fenKey: string): Promise<RepertoireNode> {
	const db = await getDB();
	const existing = await db.get('nodes', [repertoireId, fenKey]);
	if (existing) return existing;
	const fresh: RepertoireNode = { repertoireId, fenKey, children: [] };
	await db.put('nodes', fresh);
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
	let parent = await store.get([repertoireId, fromFenKey]);
	if (!parent) {
		parent = { repertoireId, fenKey: fromFenKey, children: [] };
	}
	let created = false;
	if (!parent.children.find((e) => e.toFenKey === edge.toFenKey)) {
		// Strip any $state proxies before the edge hits IDB — structuredClone
		// (which IDB uses) can't clone Proxy objects and throws DataCloneError.
		parent.children.push(JSON.parse(JSON.stringify(edge)) as Edge);
		created = true;
	}
	await store.put(JSON.parse(JSON.stringify(parent)) as RepertoireNode);
	const child = await store.get([repertoireId, edge.toFenKey]);
	if (!child) {
		await store.put({ repertoireId, fenKey: edge.toFenKey, children: [] });
	}
	await tx.done;
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
	node.children = node.children.filter((e) => e.toFenKey !== toFenKey);
	await db.put('nodes', node);
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
	await db.put('nodes', node);
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
	await db.put('nodes', node);
}

export async function listNodes(repertoireId: string): Promise<RepertoireNode[]> {
	const db = await getDB();
	return db.getAllFromIndex('nodes', 'by-repertoire', repertoireId);
}

export async function nodesMap(repertoireId: string): Promise<Map<string, RepertoireNode>> {
	const all = await listNodes(repertoireId);
	return new Map(all.map((n) => [n.fenKey, n]));
}
