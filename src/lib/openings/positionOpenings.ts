/**
 * Per-position opening name cache.
 *
 * Lichess explorer responses tag each query with `opening: { eco, name }`
 * when the position has a recognised ECO. We persist those mappings
 * keyed by canonical fenKey (EPD) so callers across the app can ask
 * "what's this position called?" without re-hitting the explorer.
 *
 * Used by:
 *  - The rep editor's Explorer panel: opportunistic capture on every
 *    fetched response, so the user's normal exploration warms the cache.
 *  - The walkthrough's line filter: labels each branch by its opening
 *    name (e.g. "Sicilian Defense") instead of the bare SAN move,
 *    falling back to SAN when the cache is cold.
 *
 * Mirrors the dossier's openings.ts in spirit — ECO/name driven — but
 * tailored to repertoire trees, which lack the PGN `[Opening]` tag the
 * dossier mines from played games.
 */

import { ensureStore } from '$lib/storage/db';
import type { StoredPositionOpening } from '$lib/storage/db';

export async function getPositionOpening(fenKey: string): Promise<StoredPositionOpening | null> {
	if (!fenKey) return null;
	const db = await ensureStore('position_openings');
	const row = await db.get('position_openings', fenKey);
	return row ?? null;
}

export async function getPositionOpenings(
	fenKeys: string[]
): Promise<Map<string, StoredPositionOpening>> {
	const out = new Map<string, StoredPositionOpening>();
	if (fenKeys.length === 0) return out;
	const db = await ensureStore('position_openings');
	const tx = db.transaction('position_openings', 'readonly');
	await Promise.all(
		fenKeys.map(async (k) => {
			const row = await tx.store.get(k);
			if (row) out.set(k, row);
		})
	);
	await tx.done;
	return out;
}

/**
 * Capture an explorer-tagged opening for a position. Skips empty/missing
 * inputs silently — callers can pipe a possibly-null `opening` field
 * straight in and let this guard.
 */
export async function setPositionOpening(
	fenKey: string,
	opening: { eco: string; name: string } | null | undefined
): Promise<void> {
	if (!fenKey || !opening || !opening.name) return;
	const db = await ensureStore('position_openings');
	const row: StoredPositionOpening = {
		fenKey,
		eco: opening.eco ?? '',
		name: opening.name,
		fetchedAt: Date.now()
	};
	await db.put('position_openings', row);
}

/**
 * The "family" portion of a Lichess opening name — everything before the
 * first colon. `"Sicilian Defense: Najdorf, English Attack"` → `"Sicilian
 * Defense"`. Matches the same family-root convention used by the
 * dossier's `parseOpeningName`.
 */
export function openingFamily(name: string): string {
	const colon = name.indexOf(':');
	return colon < 0 ? name.trim() : name.slice(0, colon).trim();
}
