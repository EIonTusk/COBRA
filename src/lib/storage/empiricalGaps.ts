/**
 * Persistence for empirical gaps: positions in a repertoire where scanned
 * games show the user ran out of prep. One row per (repertoire, fenKey),
 * counted across games so the builder can surface the most-faced gap as a
 * jump target.
 */

import { getDB } from './db';
import type { EmpiricalGap } from '$lib/types';
import { markRepsDirty } from '$lib/sync/dirtyMark';

export interface GapHit {
	repertoireId: string;
	fenKey: string;
	fen: string;
	gameId: string;
	playedAt: number;
}

/**
 * Upsert a batch of gap hits. For each (repertoireId, fenKey) we increment
 * the count by the number of distinct gameIds in this batch not already
 * counted — we store `lastGameId` so a re-scan of the same game doesn't
 * double-count. Returns the number of rows modified.
 */
export async function recordGapHits(hits: GapHit[]): Promise<number> {
	if (hits.length === 0) return 0;
	const db = await getDB();
	// If the DB connection is stale (e.g. an older tab holding a pre-v4
	// connection) the store won't exist; bail quietly instead of surfacing
	// an uncaught rejection that wedges callers.
	if (!db.objectStoreNames.contains('empirical_gaps')) return 0;
	const tx = db.transaction('empirical_gaps', 'readwrite');
	// Collapse within-batch dupes per (rep, fenKey) so we write each row
	// at most once per scan.
	const byId = new Map<string, { hits: GapHit[]; latest: GapHit }>();
	for (const h of hits) {
		const id = `${h.repertoireId}:${h.fenKey}`;
		const slot = byId.get(id);
		if (!slot) {
			byId.set(id, { hits: [h], latest: h });
		} else {
			slot.hits.push(h);
			if (h.playedAt > slot.latest.playedAt) slot.latest = h;
		}
	}
	let modified = 0;
	for (const [id, { hits: batchHits, latest }] of byId) {
		const existing = await tx.store.get(id);
		const newGameIds = new Set(batchHits.map((h) => h.gameId));
		if (existing) {
			// Migrate pre-v2 rows that only carried `lastGameId`. New batch
			// IDs already in the persisted set are dedup'd here so we never
			// double-count, regardless of which device first saw the game.
			const counted = new Set(
				existing.gameIds ?? (existing.lastGameId ? [existing.lastGameId] : [])
			);
			for (const id of [...newGameIds]) {
				if (counted.has(id)) newGameIds.delete(id);
			}
			if (newGameIds.size === 0) continue;
			for (const id of newGameIds) counted.add(id);
			existing.count += newGameIds.size;
			existing.lastSeenAt = latest.playedAt;
			existing.lastGameId = latest.gameId;
			existing.fen = latest.fen;
			// Cap at the most recent 500 entries so the row stays small even
			// for users whose scans accumulate over years; the trailing IDs
			// stop being useful for dedup once they fall out of any future
			// scan window anyway.
			existing.gameIds = Array.from(counted).slice(-500);
			await tx.store.put(existing);
			modified += 1;
		} else {
			const row: EmpiricalGap = {
				id,
				repertoireId: latest.repertoireId,
				fenKey: latest.fenKey,
				fen: latest.fen,
				count: newGameIds.size,
				firstSeenAt: latest.playedAt,
				lastSeenAt: latest.playedAt,
				lastGameId: latest.gameId,
				gameIds: Array.from(newGameIds).slice(-500)
			};
			await tx.store.put(row);
			modified += 1;
		}
	}
	await tx.done;
	if (modified > 0) markRepsDirty(hits.map((h) => h.repertoireId));
	return modified;
}

export async function listGapsForRepertoire(repertoireId: string): Promise<EmpiricalGap[]> {
	const db = await getDB();
	if (!db.objectStoreNames.contains('empirical_gaps')) return [];
	const rows = await db.getAllFromIndex('empirical_gaps', 'by-repertoire', repertoireId);
	rows.sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt);
	return rows;
}

export async function topGapForRepertoire(repertoireId: string): Promise<EmpiricalGap | null> {
	const rows = await listGapsForRepertoire(repertoireId);
	return rows[0] ?? null;
}
