import { getDB } from './db';
import type { AppSettings } from '$lib/types';
import { generatorParameters } from 'ts-fsrs';
import { markGlobalDirty } from '$lib/sync/dirtyMark';

export function defaultSettings(): AppSettings {
	return {
		key: 'root',
		theme: 'dark',
		boardTheme: 'brown',
		pieceSet: 'cburnett',
		fsrsParams: generatorParameters({ enable_fuzz: true }),
		dailyNewCardCap: 10,
		drillSessionCap: 30,
		drillIntroSpeed: 'normal',
		drillIntermediateMoves: 'play',
		drillWellLearnedDays: 7,
		explorerSpeeds: ['blitz', 'rapid', 'classical'],
		explorerRatings: [1600, 1800, 2000, 2200, 2500],
		lichessApiToken: '',
		lichessOAuth: null,
		useLichessServerEval: true,
		styleAdviceEnabled: false,
		soundsEnabled: true,
		soundsVolume: 1,
		openAtStartingPosition: true,
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
): Omit<AppSettings, 'lichessApiToken' | 'lichessOAuth' | 'sync'> {
	const copy = JSON.parse(JSON.stringify(s)) as AppSettings;
	delete (copy as Partial<AppSettings>).lichessApiToken;
	delete (copy as Partial<AppSettings>).lichessOAuth;
	delete (copy as Partial<AppSettings>).sync;
	return copy as Omit<AppSettings, 'lichessApiToken' | 'lichessOAuth' | 'sync'>;
}

export async function getSettings(): Promise<AppSettings> {
	const db = await getDB();
	const s = await db.get('settings', 'root');
	if (!s) return defaultSettings();
	// Merge with defaults so newly-introduced fields (added after the user
	// last saved their settings) get their preset values instead of coming
	// back `undefined` and forcing every consumer to repeat the fallback.
	return { ...defaultSettings(), ...s };
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
	const plain = JSON.parse(JSON.stringify({ ...s, key: 'root' }));
	await db.put('settings', plain);
	if (!opts.skipDirtyMark) markGlobalDirty();
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
