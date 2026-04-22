import { getDB } from './db';
import type { AppSettings } from '$lib/types';
import { generatorParameters } from 'ts-fsrs';

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
		explorerSpeeds: ['blitz', 'rapid', 'classical'],
		explorerRatings: [1600, 1800, 2000, 2200, 2500],
		lichessApiToken: '',
		lichessOAuth: null,
		useLichessServerEval: true,
		styleAdviceEnabled: false,
		soundsEnabled: true,
		soundsVolume: 1,
		openAtStartingPosition: true
	};
}

export async function getSettings(): Promise<AppSettings> {
	const db = await getDB();
	const s = await db.get('settings', 'root');
	return s ?? defaultSettings();
}

export async function saveSettings(s: AppSettings): Promise<void> {
	const db = await getDB();
	// Defensive: callers may pass a Svelte $state proxy, which IndexedDB's
	// structured clone can't handle. Round-trip strips any proxy wrappers;
	// settings are JSON-safe (no Dates, no Maps).
	const plain = JSON.parse(JSON.stringify({ ...s, key: 'root' }));
	await db.put('settings', plain);
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
