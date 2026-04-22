/**
 * Persistence for the user's per-move WDL at positions they've reached in
 * their own games. One row per (repertoireId, fenKey, playedSan, color),
 * accumulated across scans. Powers the builder's "you're underperforming
 * here" indicator.
 *
 * Results are stored from the side-to-move's perspective — `white` =
 * white-wins tallies, etc. — so the aggregate lines up with the Lichess
 * explorer's shape. Dedupe-on-gameId keeps re-scanning idempotent.
 */

import { getDB } from './db';
import type { PositionWdlRow } from './db';

export type { PositionWdlRow };

export interface PositionWdlHit {
	repertoireId: string;
	fenKey: string;
	playedSan: string;
	/** User's colour in the game — which side earned the result. */
	color: 'white' | 'black';
	/** Game outcome from White's POV. */
	result: 'white' | 'draws' | 'black';
	gameId: string;
	playedAt: number;
}

function rowId(h: Pick<PositionWdlHit, 'repertoireId' | 'fenKey' | 'playedSan' | 'color'>): string {
	return `${h.repertoireId}:${h.fenKey}:${h.playedSan}:${h.color}`;
}

/**
 * Upsert a batch of hits. Each (row, gameId) is counted at most once ever:
 * we keep a `countedGameIds` set so a repeat scan of the same archive
 * doesn't inflate the WDL totals.
 */
export async function recordPositionWdlHits(hits: PositionWdlHit[]): Promise<number> {
	if (hits.length === 0) return 0;
	const db = await getDB();
	if (!db.objectStoreNames.contains('position_wdl')) return 0;

	// Collapse batch by row id so each row is written at most once per call.
	const byId = new Map<string, { hits: PositionWdlHit[] }>();
	for (const h of hits) {
		const id = rowId(h);
		const slot = byId.get(id);
		if (slot) slot.hits.push(h);
		else byId.set(id, { hits: [h] });
	}

	const tx = db.transaction('position_wdl', 'readwrite');
	let modified = 0;
	for (const [id, { hits: batchHits }] of byId) {
		const existing = await tx.store.get(id);
		const counted = new Set(existing?.countedGameIds ?? []);
		let w = existing?.white ?? 0;
		let d = existing?.draws ?? 0;
		let b = existing?.black ?? 0;
		let last = existing?.lastSeenAt ?? 0;
		let added = 0;
		for (const h of batchHits) {
			if (counted.has(h.gameId)) continue;
			counted.add(h.gameId);
			if (h.result === 'white') w += 1;
			else if (h.result === 'black') b += 1;
			else d += 1;
			if (h.playedAt > last) last = h.playedAt;
			added += 1;
		}
		if (added === 0) continue;
		const first = batchHits[0];
		const row: PositionWdlRow = {
			id,
			repertoireId: first.repertoireId,
			fenKey: first.fenKey,
			playedSan: first.playedSan,
			color: first.color,
			white: w,
			draws: d,
			black: b,
			games: w + d + b,
			// Cap retained gameIds to prevent unbounded row growth. 500
			// preserves enough recent history for dedup while keeping the
			// row under a few KB.
			countedGameIds: Array.from(counted).slice(-500),
			lastSeenAt: last
		};
		await tx.store.put(row);
		modified += 1;
	}
	await tx.done;
	return modified;
}

/** All WDL rows for one fenKey in a repertoire (any SAN, any colour). */
export async function listPositionWdlAtFenKey(
	repertoireId: string,
	fenKey: string
): Promise<PositionWdlRow[]> {
	const db = await getDB();
	if (!db.objectStoreNames.contains('position_wdl')) return [];
	return db.getAllFromIndex('position_wdl', 'by-repertoire-fenKey', [repertoireId, fenKey]);
}

export async function listPositionWdlForRepertoire(
	repertoireId: string
): Promise<PositionWdlRow[]> {
	const db = await getDB();
	if (!db.objectStoreNames.contains('position_wdl')) return [];
	return db.getAllFromIndex('position_wdl', 'by-repertoire', repertoireId);
}

export async function clearPositionWdlForRepertoire(repertoireId: string): Promise<void> {
	const db = await getDB();
	if (!db.objectStoreNames.contains('position_wdl')) return;
	const tx = db.transaction('position_wdl', 'readwrite');
	const rows = await tx.store.index('by-repertoire').getAllKeys(repertoireId);
	for (const k of rows) await tx.store.delete(k);
	await tx.done;
}
