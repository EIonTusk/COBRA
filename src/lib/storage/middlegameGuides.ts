/**
 * IDB CRUD for `middlegame_guides`. One annotation per (repertoire,
 * fenKey) — the user pins it from the editor at a chosen position; the
 * drill reads it back to paint the same arrows mid-session when the
 * `showMiddlegameGuides` setting is on.
 *
 * The store was added at DB_VERSION 18 to hold middle-game-guide rows;
 * the schema is now general enough to hold other per-position annotation
 * sources (`manual`, `engine`) — see `SavedGuideSource`. The store name
 * is kept for back-compat; renaming it would orphan existing pinned
 * rows. Reads normalise missing `source` to `'guide'` so pre-
 * discriminator rows continue to decode without a migration.
 *
 * Access goes through `ensureStore` so a stale-tab/SW serving older code
 * can still upgrade in place rather than throwing on the first read.
 */
import { ensureStore } from './db';
import type { SavedMiddlegameGuide } from '$lib/types';

function withSource(g: SavedMiddlegameGuide): SavedMiddlegameGuide {
	return g.source ? g : { ...g, source: 'guide' };
}

export async function getMiddlegameGuide(
	repertoireId: string,
	fenKey: string
): Promise<SavedMiddlegameGuide | undefined> {
	const db = await ensureStore('middlegame_guides');
	const row = await db.get('middlegame_guides', [repertoireId, fenKey]);
	return row ? withSource(row) : undefined;
}

export async function upsertMiddlegameGuide(guide: SavedMiddlegameGuide): Promise<void> {
	const db = await ensureStore('middlegame_guides');
	// Strip non-cloneable fields before write — DrawShape modifiers are
	// plain objects but we serialise to be safe against future shape drift.
	const stamped = withSource(guide);
	await db.put('middlegame_guides', JSON.parse(JSON.stringify(stamped)));
}

export async function deleteMiddlegameGuide(repertoireId: string, fenKey: string): Promise<void> {
	const db = await ensureStore('middlegame_guides');
	await db.delete('middlegame_guides', [repertoireId, fenKey]);
}

export async function listMiddlegameGuides(repertoireId: string): Promise<SavedMiddlegameGuide[]> {
	const db = await ensureStore('middlegame_guides');
	const rows = await db.getAllFromIndex('middlegame_guides', 'by-repertoire', repertoireId);
	return rows.map(withSource);
}
