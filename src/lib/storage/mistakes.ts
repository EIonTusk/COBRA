import { getDB } from './db';
import { getRepertoire } from './repertoires';
import { nodesMap } from './nodes';
import { furthestNonBranchingFenKey, pathToFenKey } from '$lib/tree/traversal';
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

/**
 * Drop mistakes that no longer sit beyond their repertoire's current
 * analysis gate — i.e. whose fenKey isn't reachable from the rep's
 * effective starting fenKey in the *current* tree. Happens when:
 *  - the user pins a deeper starting position after a scan
 *  - the user deletes/reworks the prefix so an old mistake's fenKey
 *    is no longer reachable from the gate
 *  - the tree evolved such that the furthest non-branching node moved
 * Filtering is done at read time rather than by deleting stored rows
 * because pins are reversible — unpinning should bring the hidden
 * mistakes back without a rescan.
 *
 * Repertoires + node maps are loaded once per repId encountered, so
 * this is O(N mistakes + K reps) per call.
 */
export async function filterActiveMistakes(mistakes: StoredMistake[]): Promise<StoredMistake[]> {
	if (mistakes.length === 0) return mistakes;
	const repIds = new Set<string>();
	for (const m of mistakes) repIds.add(m.repertoireId);
	const gates = new Map<
		string,
		{ startKey: string; nodes: Awaited<ReturnType<typeof nodesMap>> } | null
	>();
	for (const id of repIds) {
		const rep = await getRepertoire(id);
		if (!rep) {
			gates.set(id, null);
			continue;
		}
		const nodes = await nodesMap(id);
		const startKey =
			rep.startingFenKey === null
				? rep.rootFenKey
				: (rep.startingFenKey ?? furthestNonBranchingFenKey(nodes, rep.rootFenKey));
		gates.set(id, { startKey, nodes });
	}
	return mistakes.filter((m) => {
		const gate = gates.get(m.repertoireId);
		// Repertoire is gone — hide orphaned mistakes. A separate cleanup
		// would ideally drop them from IDB, but the UI shouldn't surface
		// them either way.
		if (!gate) return false;
		// Mistake is at or past the gate → reachable from gate via tree
		// edges. pathToFenKey returns [] when start === target, [...edges]
		// when reachable, null when unreachable.
		if (m.fenKey === gate.startKey) return true;
		return pathToFenKey(gate.nodes, gate.startKey, m.fenKey) !== null;
	});
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
