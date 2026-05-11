/**
 * IDB CRUD for `middlegame_guides`. One guide per (repertoire, fenKey)
 * — the user pins it from the editor at a chosen position; the drill
 * reads it back to paint the same arrows mid-session when the
 * `showMiddlegameGuides` setting is on.
 *
 * The store was added at DB_VERSION 18; access goes through `ensureStore`
 * so a stale-tab/SW serving older code can still upgrade in place rather
 * than throwing on the first read.
 */
import { ensureStore } from './db';
import type { SavedMiddlegameGuide } from '$lib/types';

export async function getMiddlegameGuide(
	repertoireId: string,
	fenKey: string
): Promise<SavedMiddlegameGuide | undefined> {
	const db = await ensureStore('middlegame_guides');
	return db.get('middlegame_guides', [repertoireId, fenKey]);
}

export async function upsertMiddlegameGuide(guide: SavedMiddlegameGuide): Promise<void> {
	const db = await ensureStore('middlegame_guides');
	// Strip non-cloneable fields before write — DrawShape modifiers are
	// plain objects but we serialise to be safe against future shape drift.
	await db.put('middlegame_guides', JSON.parse(JSON.stringify(guide)));
}

export async function deleteMiddlegameGuide(repertoireId: string, fenKey: string): Promise<void> {
	const db = await ensureStore('middlegame_guides');
	await db.delete('middlegame_guides', [repertoireId, fenKey]);
}

export async function listMiddlegameGuides(repertoireId: string): Promise<SavedMiddlegameGuide[]> {
	const db = await ensureStore('middlegame_guides');
	return db.getAllFromIndex('middlegame_guides', 'by-repertoire', repertoireId);
}
