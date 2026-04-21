/**
 * Persistence for self-calibrated style baselines. Each row is a measured
 * aggregate of axis rates for one (speed, ratingMin..ratingMax) bucket
 * derived from the user's own opponents' games. Stored in IDB so it
 * survives reloads and accumulates across scans.
 *
 * Keyed by `${bucket}:${ratingMin}-${ratingMax}` so re-running the
 * calibration with the same params overwrites cleanly.
 */

import {
	ensureStore,
	type StoredBaselineBucket,
	type BaselinePhaseColor,
	type BaselinePhaseStats,
	type BaselineCriticalMoments,
	type BaselineClockSpend
} from './db';

export type {
	StoredBaselineBucket,
	BaselinePhaseColor,
	BaselinePhaseStats,
	BaselineCriticalMoments,
	BaselineClockSpend
};

export function bucketKey(
	bucket: string | undefined,
	ratingMin: number | null,
	ratingMax: number | null
): string {
	return `${bucket ?? 'any'}:${ratingMin ?? '-inf'}-${ratingMax ?? '+inf'}`;
}

/**
 * All accessors route through `ensureStore('baselines')` so a missing
 * store (stale tab held a pre-upgrade connection, etc.) self-repairs by
 * forcing a one-shot version bump rather than throwing
 * `'baselines' is not a known object store name` at the user.
 */
export async function listStoredBaselines(): Promise<StoredBaselineBucket[]> {
	try {
		const db = await ensureStore('baselines');
		return db.getAll('baselines');
	} catch (e) {
		console.warn('[cobra] listStoredBaselines failed:', e);
		return [];
	}
}

export async function saveStoredBaseline(b: StoredBaselineBucket): Promise<void> {
	const db = await ensureStore('baselines');
	await db.put('baselines', b);
}

export async function deleteStoredBaseline(id: string): Promise<void> {
	const db = await ensureStore('baselines');
	await db.delete('baselines', id);
}
