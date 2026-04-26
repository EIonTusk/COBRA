/**
 * Persistence for an in-flight Dossier scan. Single-row store keyed by
 * `'latest'`. Enables resume-after-navigate so a 10-minute engine pass
 * isn't lost when the user clicks away mid-scan.
 *
 * Lifecycle:
 *   - scanStore.start() probes via `loadDossierCheckpoint()`. If the
 *     stored hash matches the planned scan, the eval pass picks up at
 *     `cursor`. Otherwise the row is dropped.
 *   - During scan, `saveDossierCheckpoint()` is called on a throttle.
 *   - On scan completion (success or user-abort), `clearDossierCheckpoint()`
 *     wipes the row so the next scan starts fresh.
 *
 * Payload shape is opaque here; the dossier module owns it.
 */
import { ensureStore, type StoredDossierScanCheckpoint } from './db';

export type { StoredDossierScanCheckpoint };

const KEY = 'latest';

/**
 * Bump when the checkpoint payload's shape changes in a way that would
 * crash the resume path. Old rows with a different version are dropped on
 * load — the user just starts a fresh scan instead of seeing a half-broken
 * progress state.
 *
 * v2 dropped the materialLossTotal / materialLossEndorsed runtime
 * counters in favour of deriving them from `lostMaterial` on each
 * EvalMoveResult; resuming a v1 checkpoint with the new code would
 * produce a stuck sac-tendency on the resume tail.
 */
export const DOSSIER_CHECKPOINT_VERSION = 2;

/** Conservative TTL — even a matching-hash checkpoint older than this is
 *  discarded. Past a day, the most recent games slate has likely shifted
 *  enough that resuming is more confusing than restarting. */
export const CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

export async function loadDossierCheckpoint(): Promise<StoredDossierScanCheckpoint | null> {
	try {
		const db = await ensureStore('dossier_scan_checkpoint');
		const row = (await db.get('dossier_scan_checkpoint', KEY)) ?? null;
		if (!row) return null;
		if (row.version !== DOSSIER_CHECKPOINT_VERSION) {
			await db.delete('dossier_scan_checkpoint', KEY).catch(() => undefined);
			return null;
		}
		if (Date.now() - row.savedAt > CHECKPOINT_TTL_MS) {
			await db.delete('dossier_scan_checkpoint', KEY).catch(() => undefined);
			return null;
		}
		return row;
	} catch (e) {
		console.warn('[cobra] loadDossierCheckpoint failed:', e);
		return null;
	}
}

export async function saveDossierCheckpoint(input: {
	scanHash: string;
	cursor: number;
	total: number;
	payload: unknown;
}): Promise<void> {
	const db = await ensureStore('dossier_scan_checkpoint');
	await db.put('dossier_scan_checkpoint', {
		id: KEY,
		savedAt: Date.now(),
		version: DOSSIER_CHECKPOINT_VERSION,
		scanHash: input.scanHash,
		cursor: input.cursor,
		total: input.total,
		// Defensive snapshot — Svelte $state proxies don't structured-clone.
		payload: snapshot(input.payload)
	});
}

export async function clearDossierCheckpoint(): Promise<void> {
	try {
		const db = await ensureStore('dossier_scan_checkpoint');
		await db.delete('dossier_scan_checkpoint', KEY);
	} catch (e) {
		console.warn('[cobra] clearDossierCheckpoint failed:', e);
	}
}

function snapshot<T>(v: T): T {
	if (v == null) return v;
	return JSON.parse(JSON.stringify(v)) as T;
}
