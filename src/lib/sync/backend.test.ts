import { describe, expect, it } from 'vitest';
import { communityWorkerUrl, normalizeWorkerUrl, resolveBackend } from './backend';
import type { SyncSettings } from '$lib/types';

const HOSTED = 'https://hosted.example';
const OWN = 'https://own.example';
const off = (over: Partial<SyncSettings> = {}): SyncSettings => ({ enabled: false, ...over });

describe('resolveBackend', () => {
	it('defaults fresh installs to COBRA DB when the build has it', () => {
		expect(resolveBackend(undefined, HOSTED)).toEqual({
			backend: 'cobra',
			workerUrl: HOSTED,
			customUrl: null
		});
		expect(resolveBackend(off(), HOSTED).backend).toBe('cobra');
	});

	it('falls back to Lichess when the build has no hosted database', () => {
		expect(resolveBackend(undefined, null)).toEqual({
			backend: 'lichess',
			workerUrl: null,
			customUrl: null
		});
	});

	it('keeps existing Lichess-study users on Lichess', () => {
		expect(resolveBackend({ enabled: true }, HOSTED).backend).toBe('lichess');
		expect(resolveBackend(off({ studyId: 'abc' }), HOSTED).backend).toBe('lichess');
	});

	it('honours an explicit choice', () => {
		expect(resolveBackend(off({ backend: 'lichess' }), HOSTED).backend).toBe('lichess');
		expect(resolveBackend(off({ backend: 'cobra' }), HOSTED).workerUrl).toBe(HOSTED);
		expect(resolveBackend(off({ backend: 'custom', customWorkerUrl: `${OWN}/` }), HOSTED)).toEqual({
			backend: 'custom',
			workerUrl: OWN,
			customUrl: OWN
		});
	});

	it('never points COBRA DB at a stored address', () => {
		const r = resolveBackend(off({ backend: 'cobra', customWorkerUrl: OWN }), HOSTED);
		expect(r.workerUrl).toBe(HOSTED);
		expect(r.customUrl).toBe(OWN);
	});

	it('custom without an address has no worker', () => {
		expect(resolveBackend(off({ backend: 'custom' }), HOSTED).workerUrl).toBeNull();
	});

	it('migrates legacy "cloudflare" with a saved copy of the hosted address to COBRA DB', () => {
		expect(resolveBackend(off({ backend: 'cloudflare', cloudflareUrl: HOSTED }), HOSTED)).toEqual({
			backend: 'cobra',
			workerUrl: HOSTED,
			customUrl: null
		});
		expect(resolveBackend(off({ backend: 'cloudflare' }), HOSTED).backend).toBe('cobra');
	});

	it('migrates legacy "cloudflare" with another address to your own database', () => {
		expect(resolveBackend(off({ backend: 'cloudflare', cloudflareUrl: OWN }), HOSTED)).toEqual({
			backend: 'custom',
			workerUrl: OWN,
			customUrl: OWN
		});
		// A build without a hosted database keeps a self-hoster on their Worker.
		expect(resolveBackend(off({ backend: 'cloudflare', cloudflareUrl: OWN }), null).workerUrl).toBe(
			OWN
		);
	});
});

describe('communityWorkerUrl', () => {
	it('uses the hosted database unless the user syncs to their own', () => {
		expect(communityWorkerUrl(off({ backend: 'lichess' }), HOSTED)).toBe(HOSTED);
		expect(communityWorkerUrl(off({ backend: 'cobra' }), HOSTED)).toBe(HOSTED);
		expect(communityWorkerUrl(off({ backend: 'custom', customWorkerUrl: OWN }), HOSTED)).toBe(OWN);
		expect(communityWorkerUrl(off({ backend: 'custom', customWorkerUrl: OWN }), null)).toBe(OWN);
		expect(communityWorkerUrl(undefined, null)).toBeNull();
	});
});

describe('normalizeWorkerUrl', () => {
	it('trims whitespace and trailing slashes', () => {
		expect(normalizeWorkerUrl('  https://a.example// ')).toBe('https://a.example');
		expect(normalizeWorkerUrl('   ')).toBeNull();
		expect(normalizeWorkerUrl(undefined)).toBeNull();
	});
});
