import { ensureStore, getDB } from './db';
import type { Repertoire, Color, RepertoireNode, LichessStudyLink } from '$lib/types';
import { STARTPOS_FEN, fenKeyFromFen } from '$lib/chess/fen';
import { markRepDirty } from '$lib/sync/dirtyMark';

export async function listRepertoires(): Promise<Repertoire[]> {
	const db = await getDB();
	const all = await db.getAllFromIndex('repertoires', 'by-updated');
	return all.reverse();
}

export async function getRepertoire(id: string): Promise<Repertoire | undefined> {
	const db = await getDB();
	return db.get('repertoires', id);
}

export async function createRepertoire(
	name: string,
	color: Color,
	rootFen: string = STARTPOS_FEN
): Promise<Repertoire> {
	const db = await getDB();
	const now = Date.now();
	const rootFenKey = fenKeyFromFen(rootFen);
	const rep: Repertoire = {
		id: crypto.randomUUID(),
		name: name.trim() || 'Untitled',
		color,
		rootFen,
		rootFenKey,
		coverageGoal: 100,
		createdAt: now,
		updatedAt: now
	};
	const tx = db.transaction(['repertoires', 'nodes'], 'readwrite');
	await tx.objectStore('repertoires').put(rep);
	const rootNode: RepertoireNode = {
		repertoireId: rep.id,
		fenKey: rootFenKey,
		children: []
	};
	await tx.objectStore('nodes').put(rootNode);
	await tx.done;
	markRepDirty(rep.id);
	return rep;
}

export async function touchRepertoire(id: string): Promise<void> {
	const db = await getDB();
	const rep = await db.get('repertoires', id);
	if (!rep) return;
	rep.updatedAt = Date.now();
	await db.put('repertoires', rep);
	markRepDirty(id);
}

export async function renameRepertoire(id: string, name: string): Promise<void> {
	const db = await getDB();
	const rep = await db.get('repertoires', id);
	if (!rep) return;
	rep.name = name.trim() || rep.name;
	rep.updatedAt = Date.now();
	await db.put('repertoires', rep);
	markRepDirty(id);
}

export async function setCoverageGoal(id: string, goal: number | null): Promise<void> {
	const db = await getDB();
	const rep = await db.get('repertoires', id);
	if (!rep) return;
	rep.coverageGoal = goal ?? null;
	rep.coverageSnapshot = null;
	rep.updatedAt = Date.now();
	await db.put('repertoires', JSON.parse(JSON.stringify(rep)));
	markRepDirty(id);
}

export async function saveCoverageSnapshot(
	id: string,
	snapshot: Repertoire['coverageSnapshot']
): Promise<void> {
	const db = await getDB();
	const rep = await db.get('repertoires', id);
	if (!rep) return;
	rep.coverageSnapshot = snapshot ?? null;
	rep.updatedAt = Date.now();
	await db.put('repertoires', JSON.parse(JSON.stringify(rep)));
	markRepDirty(id);
}

export async function setStartingPosition(
	id: string,
	fenKey: string | null | undefined
): Promise<void> {
	const db = await getDB();
	const rep = await db.get('repertoires', id);
	if (!rep) return;
	rep.startingFenKey = fenKey ?? undefined;
	rep.updatedAt = Date.now();
	await db.put('repertoires', JSON.parse(JSON.stringify(rep)));
	markRepDirty(id);
}

export async function setLichessStudyLink(
	id: string,
	link: LichessStudyLink | null
): Promise<void> {
	const db = await getDB();
	const rep = await db.get('repertoires', id);
	if (!rep) return;
	rep.lichessStudy = link;
	rep.updatedAt = Date.now();
	await db.put('repertoires', JSON.parse(JSON.stringify(rep)));
	markRepDirty(id);
}

/**
 * Stores that hold per-repertoire rows reachable via a `by-repertoire`
 * index. Deleting a rep should clear all of them so the user doesn't
 * accumulate orphan cards, gaps, mistakes, guides etc. that no UI surfaces
 * once the parent rep is gone. The `repertoires` row itself is deleted
 * separately by primary key.
 *
 * Keep this list in sync with new IDB stores: every new per-rep store
 * MUST be added here, otherwise rows orphan silently.
 */
const PER_REP_STORES = [
	'nodes',
	'cards',
	'idea_cards',
	'plan_cards',
	'middlegame_guides',
	'mistakes',
	'empirical_gaps',
	'spar_games',
	'position_wdl'
] as const;

export async function deleteRepertoire(id: string): Promise<void> {
	// Touch `plan_cards` via `ensureStore` first: it's the newest store
	// in the per-rep set, so requesting it forces the v19 upgrade on
	// stale-tab handles before we open a multi-store transaction. Without
	// this, a service-worker-cached v18 handle would crash the transaction
	// with NotFoundError on `plan_cards` and leave the delete half-done.
	const db = await ensureStore('plan_cards');
	const tx = db.transaction(['repertoires', ...PER_REP_STORES], 'readwrite');
	await tx.objectStore('repertoires').delete(id);
	for (const store of PER_REP_STORES) {
		const keys = await tx.objectStore(store).index('by-repertoire').getAllKeys(id);
		for (const key of keys) await tx.objectStore(store).delete(key);
	}
	await tx.done;
	markRepDirty(id);
}
