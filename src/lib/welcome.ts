/**
 * First-launch welcome flow (/welcome): connect Lichess, optionally turn on
 * sync. Pure step logic so the page and its tests agree on where a user is.
 *
 * With COBRA DB, sync signs in with a second, scopeless Lichess token (the
 * "sync identity"), so the Worker never sees the token that can act on the
 * account. That costs a second Lichess approval, which is the `'identity'`
 * step. Builds without COBRA DB sync via a Lichess study, which the main
 * token (requested with study scopes) already covers.
 */
import { effectiveLichessToken } from '$lib/storage/settings';
import type { AppSettings } from '$lib/types';

export type WelcomeStep = 'intro' | 'identity' | 'enable' | 'done';

export function welcomeStep(s: AppSettings, hostedAvailable: boolean): WelcomeStep {
	if (!effectiveLichessToken(s)) return 'intro';
	if (!s.welcomeSyncPending) return 'done';
	if (hostedAvailable && !s.syncIdentityToken?.accessToken) return 'identity';
	return 'enable';
}

/** Whether app start on the home page should open the welcome page instead. */
export function shouldShowWelcome(s: AppSettings): boolean {
	return !s.welcomeSeen && !effectiveLichessToken(s);
}
