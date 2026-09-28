import { getDB } from './db';
import type { AppSettings, RepTombstone } from '$lib/types';
import { generatorParameters, type FSRSParameters } from 'ts-fsrs';
import { markGlobalDirty } from '$lib/sync/dirtyMark';

/**
 * Bounds for the user-facing target-retention control. Below ~0.8 the
 * intervals grow fast enough that a repertoire stops being reliable in a
 * game; above ~0.97 FSRS schedules so tightly that the due queue never
 * drains. ts-fsrs itself accepts a wider range — this is a product bound.
 */
export const MIN_REQUEST_RETENTION = 0.8;
export const MAX_REQUEST_RETENTION = 0.97;
export const DEFAULT_REQUEST_RETENTION = 0.9;

/**
 * Re-derive a full FSRS parameter set from whatever was persisted.
 *
 * `fsrsParams` is stored as a whole blob, and `getSettings` merges stored
 * settings over the defaults at the top level only — so a blob written by an
 * older build wins wholesale and never picks up a changed default. Running
 * every read through this function is the migration: app-owned invariants are
 * forced, user-tunable fields are preserved, and any parameter ts-fsrs has
 * added since the blob was written gets filled in with its current default.
 *
 * App-owned invariants:
 *  - `enable_fuzz`: on, so identical cards don't clump onto the same day.
 *  - `enable_short_term`: OFF. With it on (the ts-fsrs default), the 1m/10m
 *    learning and 10m relearning steps make every lapse due again ten minutes
 *    later. `dueCards` has no state filter, so those cards re-entered the very
 *    next session forever — the "same moves again and again" in issue #84.
 *    COBRA is not an intra-day cramming app; a missed move belongs in
 *    tomorrow's session, not this one's.
 */
export function normalizeFsrsParams(stored?: Partial<FSRSParameters>): FSRSParameters {
	const requested = stored?.request_retention ?? DEFAULT_REQUEST_RETENTION;
	const retention = Number.isFinite(requested)
		? Math.min(MAX_REQUEST_RETENTION, Math.max(MIN_REQUEST_RETENTION, requested))
		: DEFAULT_REQUEST_RETENTION;
	return generatorParameters({
		...stored,
		request_retention: retention,
		enable_fuzz: true,
		enable_short_term: false
	});
}

/**
 * How long a repertoire deletion tombstone is retained before it's pruned.
 * Long enough that every realistically-active device will have pulled the
 * deletion at least once (sync pulls on app boot), short enough that the
 * tombstone list — which rides inside the global sync chapter — stays small.
 */
export const REP_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Collapse a tombstone list to one entry per repId (keeping the latest
 * `deletedAt`) and drop anything older than {@link REP_TOMBSTONE_TTL_MS}.
 * `now` is injected so the merge layer can prune against a single clock.
 */
export function pruneRepTombstones(tombstones: RepTombstone[], now: number): RepTombstone[] {
	const latest = new Map<string, number>();
	for (const t of tombstones) {
		if (now - t.deletedAt > REP_TOMBSTONE_TTL_MS) continue;
		const prev = latest.get(t.repId);
		if (prev === undefined || t.deletedAt > prev) latest.set(t.repId, t.deletedAt);
	}
	return [...latest.entries()].map(([repId, deletedAt]) => ({ repId, deletedAt }));
}

export function defaultSettings(): AppSettings {
	return {
		key: 'root',
		theme: 'dark',
		boardTheme: 'brown',
		pieceSet: 'cburnett',
		fsrsParams: normalizeFsrsParams(),
		dailyNewCardCap: 10,
		drillSessionCap: 30,
		drillIntroSpeed: 'normal',
		drillIntermediateMoves: 'play',
		drillWellLearnedDays: 7,
		explorerSpeeds: ['blitz', 'rapid', 'classical'],
		explorerRatings: [1600, 1800, 2000, 2200, 2500],
		lichessApiToken: '',
		lichessOAuth: null,
		syncIdentityToken: null,
		useLichessServerEval: true,
		styleAdviceEnabled: false,
		soundsEnabled: true,
		soundsVolume: 1,
		openAtStartingPosition: true,
		showMiddlegameGuides: false,
		sync: { enabled: false }
	};
}

/**
 * AppSettings minus device-local secrets, ready to ship through the sync
 * layer. The Lichess OAuth token and pasted API token never leave the
 * originating device — pulling on a second device should not auto-log
 * that device into Lichess. The `sync` block is also stripped because
 * each device tracks its own revision counters and study ID.
 */
export function sanitizeSettingsForSync(
	s: AppSettings
): Omit<AppSettings, 'lichessApiToken' | 'lichessOAuth' | 'syncIdentityToken' | 'sync'> {
	const copy = JSON.parse(JSON.stringify(s)) as AppSettings;
	delete (copy as Partial<AppSettings>).lichessApiToken;
	delete (copy as Partial<AppSettings>).lichessOAuth;
	delete (copy as Partial<AppSettings>).syncIdentityToken;
	delete (copy as Partial<AppSettings>).sync;
	return copy as Omit<
		AppSettings,
		'lichessApiToken' | 'lichessOAuth' | 'syncIdentityToken' | 'sync'
	>;
}

export async function getSettings(): Promise<AppSettings> {
	const db = await getDB();
	const s = await db.get('settings', 'root');
	if (!s) return defaultSettings();
	// Merge with defaults so newly-introduced fields (added after the user
	// last saved their settings) get their preset values instead of coming
	// back `undefined` and forcing every consumer to repeat the fallback.
	// The merge is top-level, so `fsrsParams` — a nested blob — would survive
	// wholesale from an older build; re-derive it so app-owned invariants and
	// newly-added ts-fsrs parameters apply to existing users too.
	return { ...defaultSettings(), ...s, fsrsParams: normalizeFsrsParams(s.fsrsParams) };
}

/**
 * Persist app settings. By default the write also marks the global sync
 * slice dirty so a debounced push can pick the change up. The sync store
 * itself passes `{ skipDirtyMark: true }` when it's writing back its own
 * revision counters / last-pushed timestamps — those mutations would
 * otherwise echo back into another push and never settle.
 */
export async function saveSettings(
	s: AppSettings,
	opts: { skipDirtyMark?: boolean } = {}
): Promise<void> {
	const db = await getDB();
	// Defensive: callers may pass a Svelte $state proxy, which IndexedDB's
	// structured clone can't handle. Round-trip strips any proxy wrappers;
	// settings are JSON-safe (no Dates, no Maps).
	const plain = JSON.parse(
		JSON.stringify({ ...s, key: 'root', fsrsParams: normalizeFsrsParams(s.fsrsParams) })
	);
	await db.put('settings', plain);
	if (!opts.skipDirtyMark) markGlobalDirty();
}

/**
 * Record that a repertoire was deleted on this device. Appends a tombstone
 * to settings (pruned + deduped) and marks the global slice dirty so the
 * next push carries the deletion to other devices. See
 * `AppSettings.repTombstones`.
 */
export async function recordRepTombstone(repId: string, deletedAt: number): Promise<void> {
	const settings = await getSettings();
	const next = pruneRepTombstones(
		[...(settings.repTombstones ?? []), { repId, deletedAt }],
		deletedAt
	);
	await saveSettings({ ...settings, repTombstones: next });
}

/**
 * Pick the most appropriate Lichess token: a fresh OAuth token if present,
 * otherwise the manually-pasted personal token. Returns an empty string if
 * nothing is configured so callers can treat it as "not set".
 */
export function effectiveLichessToken(s: AppSettings | null | undefined): string {
	if (!s) return '';
	const oauth = s.lichessOAuth;
	if (oauth && oauth.accessToken && oauth.expiresAt > Date.now()) {
		return oauth.accessToken;
	}
	return s.lichessApiToken ?? '';
}
