import { getDB } from './db';
import type { StoredMistake } from '$lib/types';
import type { MistakeRecord } from '$lib/lichess/mistakes';

export function toStored(r: MistakeRecord, detectedAt = Date.now()): StoredMistake {
	return {
		id: `${r.gameId}:${r.repertoireId}:${r.fenKey}`,
		gameId: r.gameId,
		gameUrl: r.gameUrl,
		playedAt: r.playedAt,
		detectedAt,
		speed: r.speed,
		opponent: r.opponent,
		color: r.color,
		repertoireId: r.repertoireId,
		repertoireName: r.repertoireName,
		fenKey: r.fenKey,
		fen: r.fen,
		playedSan: r.playedSan,
		expectedSan: r.expectedSan,
		plyOffTree: r.plyOffTree,
		status: 'pending',
		correctCount: 0
	};
}

/**
 * Upsert a batch of detected mistakes. Already-stored ids (dedup by game +
 * repertoire + position) are preserved so their status/correctCount survive.
 * Returns the number of *new* mistakes written.
 */
export async function saveMistakes(mistakes: StoredMistake[]): Promise<number> {
	if (mistakes.length === 0) return 0;
	const db = await getDB();
	const tx = db.transaction('mistakes', 'readwrite');
	let added = 0;
	for (const m of mistakes) {
		const existing = await tx.store.get(m.id);
		if (existing) {
			// Preserve user progress; just refresh the mutable fields.
			existing.detectedAt = m.detectedAt;
			existing.repertoireName = m.repertoireName;
			await tx.store.put(existing);
		} else {
			await tx.store.put(m);
			added += 1;
		}
	}
	await tx.done;
	return added;
}

export async function listMistakes(
	opts: {
		status?: StoredMistake['status'];
		limit?: number;
		repertoireId?: string;
	} = {}
): Promise<StoredMistake[]> {
	const db = await getDB();
	const all = opts.repertoireId
		? await db.getAllFromIndex('mistakes', 'by-repertoire', opts.repertoireId)
		: await db.getAll('mistakes');
	const filtered = opts.status ? all.filter((m) => m.status === opts.status) : all;
	filtered.sort((a, b) => b.detectedAt - a.detectedAt);
	return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

export async function countPendingMistakes(): Promise<number> {
	const db = await getDB();
	return db.countFromIndex('mistakes', 'by-status', 'pending');
}

export async function markMistakeCorrected(id: string): Promise<void> {
	const db = await getDB();
	const m = await db.get('mistakes', id);
	if (!m) return;
	m.status = 'corrected';
	m.correctCount += 1;
	m.lastDrilledAt = Date.now();
	await db.put('mistakes', m);
}

export async function markMistakeByPosition(repertoireId: string, fenKey: string): Promise<void> {
	const db = await getDB();
	const matches = await db.getAllFromIndex('mistakes', 'by-repertoire', repertoireId);
	const now = Date.now();
	const tx = db.transaction('mistakes', 'readwrite');
	for (const m of matches) {
		if (m.fenKey !== fenKey || m.status === 'corrected') continue;
		m.status = 'corrected';
		m.correctCount += 1;
		m.lastDrilledAt = now;
		await tx.store.put(m);
	}
	await tx.done;
}

export async function dismissMistake(id: string): Promise<void> {
	const db = await getDB();
	const m = await db.get('mistakes', id);
	if (!m) return;
	m.status = 'dismissed';
	await db.put('mistakes', m);
}
