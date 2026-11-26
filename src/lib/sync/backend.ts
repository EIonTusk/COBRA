/**
 * Which sync backend is active, and which Worker it talks to.
 *
 * Three backends:
 * - `'cobra'`   — the hosted COBRA DB. Its Worker address is supplied at build
 *                 time (env `COBRA_SYNC_URL`, see vite.config.ts) and is never
 *                 stored in settings or shown in the UI. Builds without it
 *                 (local dev, forks) simply don't offer this option.
 * - `'lichess'` — a private Lichess study.
 * - `'custom'`  — the user's own Worker, at the address they typed.
 *
 * Only a custom address is ever persisted, so the hosted address can change
 * between releases without leaving stale copies on devices.
 */
import type { SyncBackend, SyncSettings } from '$lib/types';

/** Hosted COBRA DB Worker origin baked into this build, or null if none. */
export const HOSTED_WORKER_URL: string | null = normalizeWorkerUrl(
	typeof __COBRA_SYNC_URL__ === 'string' ? __COBRA_SYNC_URL__ : null
);

/** Trim and drop trailing slashes; empty → null. */
export function normalizeWorkerUrl(url: string | null | undefined): string | null {
	const t = url?.trim().replace(/\/+$/, '');
	return t ? t : null;
}

export interface ResolvedBackend {
	backend: SyncBackend;
	/** Worker origin for `'cobra'` / `'custom'`; null for Lichess or when unconfigured. */
	workerUrl: string | null;
	/** The user's own Worker address (kept even while another backend is selected). */
	customUrl: string | null;
}

/**
 * Resolve the effective backend from stored settings.
 *
 * - An explicit stored choice wins.
 * - Legacy `'cloudflare'` (one option for both hosted and self-hosted) maps to
 *   `'custom'` when it stored an address other than the hosted one, else to
 *   `'cobra'`. That also drops copies of the hosted address older builds
 *   saved when the option was picked.
 * - Nothing stored: fresh installs get COBRA DB when this build has it; users
 *   who already set up Lichess-study sync stay on Lichess so they're never
 *   silently switched to another remote.
 */
export function resolveBackend(
	sync: SyncSettings | undefined,
	hostedUrl: string | null = HOSTED_WORKER_URL
): ResolvedBackend {
	const legacyUrl = normalizeWorkerUrl(sync?.cloudflareUrl);
	const customUrl =
		normalizeWorkerUrl(sync?.customWorkerUrl) ??
		(legacyUrl && legacyUrl !== hostedUrl ? legacyUrl : null);

	let backend: SyncBackend;
	const stored = sync?.backend;
	if (stored === 'cobra' || stored === 'lichess' || stored === 'custom') {
		backend = stored;
	} else if (stored === 'cloudflare') {
		backend = legacyUrl && legacyUrl !== hostedUrl ? 'custom' : 'cobra';
	} else if (hostedUrl && !sync?.enabled && !sync?.studyId) {
		backend = 'cobra';
	} else {
		backend = 'lichess';
	}

	const workerUrl = backend === 'cobra' ? hostedUrl : backend === 'custom' ? customUrl : null;
	return { backend, workerUrl, customUrl };
}

/** True for the backends that talk to a COBRA Worker (hosted or own). */
export function usesWorker(backend: SyncBackend): boolean {
	return backend === 'cobra' || backend === 'custom';
}

/**
 * Worker for community features: the user's own Worker when they sync to it,
 * otherwise the hosted COBRA DB (community browsing works whatever the sync
 * backend). Null when neither exists.
 */
export function communityWorkerUrl(
	sync: SyncSettings | undefined,
	hostedUrl: string | null = HOSTED_WORKER_URL
): string | null {
	const r = resolveBackend(sync, hostedUrl);
	return r.backend === 'custom' && r.customUrl ? r.customUrl : hostedUrl;
}
