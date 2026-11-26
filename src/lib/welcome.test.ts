import { describe, expect, it } from 'vitest';
import { shouldShowWelcome, welcomeStep } from './welcome';
import { defaultSettings } from '$lib/storage/settings';
import type { AppSettings, LichessOAuthToken } from '$lib/types';

const token = (over: Partial<LichessOAuthToken> = {}): LichessOAuthToken => ({
	accessToken: 'lio_x',
	tokenType: 'Bearer',
	expiresAt: Date.now() + 3_600_000,
	scopes: [],
	...over
});
const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
	...defaultSettings(),
	...over
});

describe('welcomeStep', () => {
	it('starts at the intro until Lichess is connected', () => {
		expect(welcomeStep(settings(), true)).toBe('intro');
		expect(welcomeStep(settings({ lichessOAuth: token({ expiresAt: 1 }) }), true)).toBe('intro');
	});

	it('is done once connected when sync was not ticked', () => {
		expect(welcomeStep(settings({ lichessOAuth: token() }), true)).toBe('done');
	});

	it('asks for the sync sign-in before turning on COBRA DB', () => {
		const s = settings({ lichessOAuth: token(), syncEnablePending: true });
		expect(welcomeStep(s, true)).toBe('identity');
		expect(welcomeStep({ ...s, syncIdentityToken: token() }, true)).toBe('enable');
	});

	it('needs no second sign-in when sync goes to a Lichess study', () => {
		const s = settings({ lichessOAuth: token(), syncEnablePending: true });
		expect(welcomeStep(s, false)).toBe('enable');
	});
});

describe('shouldShowWelcome', () => {
	it('shows once, and only while Lichess is not connected', () => {
		expect(shouldShowWelcome(settings())).toBe(true);
		expect(shouldShowWelcome(settings({ welcomeSeen: true }))).toBe(false);
		expect(shouldShowWelcome(settings({ lichessOAuth: token() }))).toBe(false);
		expect(shouldShowWelcome(settings({ lichessApiToken: 'lip_x' }))).toBe(false);
	});
});
