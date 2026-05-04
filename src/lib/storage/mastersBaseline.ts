/**
 * Persistence helpers for the cached masters baseline.
 *
 * The data is stable (master games don't change) so we cache forever in the
 * `masters_baseline` IDB store and only re-fetch when the user invalidates
 * (or when the targets hash drifts because the repertoire shifted).
 */

import type { ClassifiedGame } from '$lib/dossier/classify';
import type { Color } from '$lib/types';
import { ensureStore, type StoredMastersBaseline } from './db';

const MASTERS_BASELINE_VERSION = 1;

export interface MastersBaselineCoverage {
	family: string;
	color: Color;
	userGames: number;
	masterGames: number;
}

export interface MastersBaselinePayload {
	games: ClassifiedGame[];
	coverage: MastersBaselineCoverage[];
}

export interface LoadedMastersBaseline {
	fetchedAt: number;
	targetsHash: string;
	games: ClassifiedGame[];
	coverage: MastersBaselineCoverage[];
}

export async function loadMastersBaseline(): Promise<LoadedMastersBaseline | null> {
	try {
		const db = await ensureStore('masters_baseline');
		const row = await db.get('masters_baseline', 'latest');
		if (!row) return null;
		if (row.version !== MASTERS_BASELINE_VERSION) return null;
		const payload = row.payload as MastersBaselinePayload;
		return {
			fetchedAt: row.fetchedAt,
			targetsHash: row.targetsHash,
			games: payload.games,
			coverage: payload.coverage
		};
	} catch {
		return null;
	}
}

export async function saveMastersBaseline(
	targetsHash: string,
	payload: MastersBaselinePayload
): Promise<void> {
	const db = await ensureStore('masters_baseline');
	const row: StoredMastersBaseline = {
		id: 'latest',
		fetchedAt: Date.now(),
		targetsHash,
		version: MASTERS_BASELINE_VERSION,
		payload
	};
	await db.put('masters_baseline', row);
}

export async function clearMastersBaseline(): Promise<void> {
	try {
		const db = await ensureStore('masters_baseline');
		await db.delete('masters_baseline', 'latest');
	} catch {
		/* best-effort */
	}
}
