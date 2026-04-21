/**
 * CRUD for the spar-games ledger (IDB store `spar_games`).
 *
 * Every Lichess bot challenge launched from Cobra drops one row here. A
 * background reconciliation pass fetches the PGN once the game is over
 * and mutates the row's `status` + `result` fields. The "Recent spar"
 * strip on the repertoire page reads from this store.
 */

import { ensureStore } from './db';
import type { SparGame } from '$lib/types';

export async function upsertSparGame(game: SparGame): Promise<void> {
	const db = await ensureStore('spar_games');
	await db.put('spar_games', JSON.parse(JSON.stringify(game)));
}

export async function getSparGame(id: string): Promise<SparGame | null> {
	const db = await ensureStore('spar_games');
	return (await db.get('spar_games', id)) ?? null;
}

/**
 * List spar games for a repertoire, most-recent first. `limit` caps the
 * returned slice — the index scan is cheap but UI typically only wants
 * the last handful.
 */
export async function listSparGames(repertoireId: string, limit?: number): Promise<SparGame[]> {
	const db = await ensureStore('spar_games');
	const all = await db.getAllFromIndex('spar_games', 'by-repertoire', repertoireId);
	all.sort((a, b) => b.startedAt - a.startedAt);
	return typeof limit === 'number' ? all.slice(0, limit) : all;
}

export async function listPendingSparGames(): Promise<SparGame[]> {
	const db = await ensureStore('spar_games');
	const all = await db.getAllFromIndex('spar_games', 'by-status', 'pending');
	all.sort((a, b) => a.startedAt - b.startedAt);
	return all;
}

export async function deleteSparGame(id: string): Promise<void> {
	const db = await ensureStore('spar_games');
	await db.delete('spar_games', id);
}

/**
 * Extract a Lichess game id from any of the URL/pathname flavours the
 * challenge endpoints hand back: `https://lichess.org/<id>`,
 * `https://lichess.org/<id>/white`, `/api/board/game/stream/<id>` and
 * friends. Returns null if nothing id-shaped shows up.
 */
export function gameIdFromUrl(url: string): string | null {
	const match = url.match(/lichess\.org\/(?:[^/]*\/)*([a-zA-Z0-9]{8,12})(?:\/|$|\?|#)/);
	return match?.[1] ?? null;
}
