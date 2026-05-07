import { getDB } from './db';
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

export async function deleteRepertoire(id: string): Promise<void> {
	const db = await getDB();
	const tx = db.transaction(['repertoires', 'nodes', 'cards'], 'readwrite');
	await tx.objectStore('repertoires').delete(id);
	const nodeKeys = await tx.objectStore('nodes').index('by-repertoire').getAllKeys(id);
	for (const key of nodeKeys) await tx.objectStore('nodes').delete(key);
	const cardKeys = await tx.objectStore('cards').index('by-repertoire').getAllKeys(id);
	for (const key of cardKeys) await tx.objectStore('cards').delete(key);
	await tx.done;
	markRepDirty(id);
}
