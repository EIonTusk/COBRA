/**
 * Persistence for the most recent Style scan. Single-row store keyed by
 * the literal `'latest'`: writing replaces the previous report so /dossier
 * always shows the freshest diagnostic on return visits without forcing
 * a re-scan (which is expensive — Stockfish runs on every user move).
 *
 * The payload is stored as `unknown` because the scan result references
 * shapes across several modules (fingerprint, drift, eval axes, etc.)
 * and baking them into the DB schema would pin those shapes. Consumers
 * are expected to validate before use.
 */
import { ensureStore, type StoredDossierReport } from './db';
import { markGlobalDirty } from '$lib/sync/dirtyMark';

export type { StoredDossierReport };

const KEY = 'latest';
/**
 * Bump this when the Style scan-result shape changes in a way that
 * breaks the page's render path (e.g. a new required field on
 * EvalAxesSummary), OR when the underlying scoring math changes such
 * that previously-cached reports would be misleading to display.
 * Reports with an older version are dropped on load rather than
 * crashing the page.
 *
 * v2 (2026-05): engine cp values were being read in the wrong POV at
 * black-to-move positions, inflating cpLoss / depressing accuracy on
 * normal moves and demoting blunders. v1 reports are silently
 * abandoned so users get correct numbers on next scan.
 */
export const DOSSIER_REPORT_VERSION = 2;

/**
 * Session-scoped override used by /dossier/shared to inject a decoded
 * share-link payload without touching IndexedDB. When set, every
 * `loadDossierReport()` call (on /dossier and on all 21 subpage drill-downs)
 * returns the override instead of the user's own stored report, so the
 * whole paper renders the shared view for free. Cleared by
 * `clearSharedReportOverride()` or by a full page reload.
 */
let sharedOverride: StoredDossierReport | null = null;

export function setSharedReportOverride(payload: unknown): void {
	sharedOverride = {
		// The id field is pinned to 'latest' on the DB row; for the runtime
		// override we keep it 'latest' too so consumers don't branch on it.
		id: 'latest',
		savedAt: Date.now(),
		version: DOSSIER_REPORT_VERSION,
		payload: snapshot(payload)
	};
}

export function getSharedReportOverride(): StoredDossierReport | null {
	return sharedOverride;
}

export function clearSharedReportOverride(): void {
	sharedOverride = null;
}

export async function loadDossierReport(): Promise<StoredDossierReport | null> {
	if (sharedOverride) return sharedOverride;
	try {
		const db = await ensureStore('style_reports');
		const row = (await db.get('style_reports', KEY)) ?? null;
		if (!row) return null;
		if (row.version !== DOSSIER_REPORT_VERSION) {
			// Stale shape — discard so the user gets a clean re-scan prompt
			// instead of a half-rendered page.
			await db.delete('style_reports', KEY).catch(() => undefined);
			return null;
		}
		return row;
	} catch (e) {
		console.warn('[cobra] loadDossierReport failed:', e);
		return null;
	}
}

export async function saveDossierReport(payload: unknown): Promise<void> {
	const db = await ensureStore('style_reports');
	// Defensive snapshot: callers often pass a Svelte 5 $state proxy, which
	// IndexedDB's structured-clone path rejects with "proxy object could not
	// be cloned". JSON-roundtripping returns plain objects that clone cleanly.
	await db.put('style_reports', {
		id: KEY,
		savedAt: Date.now(),
		version: DOSSIER_REPORT_VERSION,
		payload: snapshot(payload)
	});
	markGlobalDirty();
}

export async function clearDossierReport(): Promise<void> {
	const db = await ensureStore('style_reports');
	await db.delete('style_reports', KEY);
	markGlobalDirty();
}

function snapshot<T>(v: T): T {
	if (v == null) return v;
	return JSON.parse(JSON.stringify(v)) as T;
}
