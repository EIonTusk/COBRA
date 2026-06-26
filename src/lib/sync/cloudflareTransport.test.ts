import { describe, expect, it, vi } from 'vitest';
import { CloudflareTransport } from './cloudflareTransport';
import { SyncConflictError } from './lichessSync';
import type { BlobMeta } from './pgnWrap';

const BASE = 'https://worker.test';

// A tiny in-memory stand-in for the Worker: one map of scope rows keyed by
// `${kind}:${repId}`, an auth endpoint, and the CAS push rule.
function makeFakeWorker() {
	const rows = new Map<string, Record<string, unknown>>();
	let authCalls = 0;
	const key = (kind: string, repId: string) => `${kind}:${repId}`;

	const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
		const u = new URL(url);
		if (u.pathname === '/auth/session') {
			authCalls += 1;
			const auth = (init?.headers as Record<string, string>)?.Authorization ?? '';
			if (!auth.startsWith('Bearer ')) return jsonRes({ error: 'no token' }, 401);
			return jsonRes({ token: 'jwt-123', userId: 'user-1' });
		}
		if (u.pathname === '/sync' && (init?.method ?? 'GET') === 'GET') {
			if (u.searchParams.has('since')) {
				const since = Number(u.searchParams.get('since'));
				const out = [...rows.values()].filter((r) => (r.updatedAt as number) > since);
				return jsonRes({ rows: out, cursor: since });
			}
			const k = key(u.searchParams.get('kind') ?? '', u.searchParams.get('repId') ?? '');
			return jsonRes({ row: rows.get(k) ?? null });
		}
		if (u.pathname === '/sync' && init?.method === 'POST') {
			const body = JSON.parse(init.body as string) as Record<string, unknown>;
			const k = key(body.kind as string, (body.repId as string) ?? '');
			const prev = rows.get(k);
			if (prev && (prev.revision as number) >= (body.revision as number)) {
				return jsonRes(
					{
						conflict: true,
						current: { revision: prev.revision, deviceId: prev.deviceId, pushedAt: prev.pushedAt }
					},
					409
				);
			}
			rows.set(k, {
				kind: body.kind,
				repId: (body.repId as string) || undefined,
				revision: body.revision,
				deviceId: body.deviceId,
				pushedAt: body.pushedAt,
				deleted: body.deleted === true,
				updatedAt: (body.pushedAt as number) + 1,
				blob: body.deleted ? null : body.blob
			});
			return jsonRes({ ok: true, revision: body.revision, updatedAt: body.pushedAt });
		}
		return jsonRes({ error: 'not found' }, 404);
	}) as unknown as typeof fetch;

	return { fetchImpl, rows, authCalls: () => authCalls };
}

function jsonRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function transport(fetchImpl: typeof fetch) {
	return new CloudflareTransport({
		baseUrl: BASE,
		lichessToken: 'lichess-tok',
		deviceId: 'dev-a',
		fetchImpl,
		now: () => 1000
	});
}

const META = (over: Partial<BlobMeta> = {}): BlobMeta => ({
	kind: 'rep-core',
	repId: 'rep-1',
	revision: 0,
	deviceId: 'dev-a',
	pushedAt: 500,
	...over
});

describe('CloudflareTransport', () => {
	it('connect() authenticates and reports empty remote', async () => {
		const w = makeFakeWorker();
		const t = transport(w.fetchImpl);
		const { remoteHasData } = await t.connect();
		expect(remoteHasData).toBe(false);
		expect(t.userId).toBe('user-1');
	});

	it('push then pull round-trips a scope', async () => {
		const w = makeFakeWorker();
		const t = transport(w.fetchImpl);
		const res = await t.push('BLOB', META({ revision: 0 }), null);
		expect(res.revision).toBe(0);

		const pulled = await t.pull('rep-core', 'rep-1');
		expect(pulled?.blob).toBe('BLOB');
		expect(pulled?.kind).toBe('rep-core');
		expect(pulled?.repId).toBe('rep-1');
	});

	it('pullAll maps rows to scopes with names, skipping deletes', async () => {
		const w = makeFakeWorker();
		const t = transport(w.fetchImpl);
		await t.push('CORE', META({ kind: 'rep-core', repId: 'rep-1', revision: 0 }), null);
		await t.push('TEL', META({ kind: 'rep-telemetry', repId: 'rep-1', revision: 0 }), null);

		const scopes = await t.pullAll();
		expect(scopes).toHaveLength(2);
		const core = scopes.find((s) => s.kind === 'rep-core');
		expect(core?.scopeName).toBe('COBRA-SYNC:rep:rep-1');
		const tel = scopes.find((s) => s.kind === 'rep-telemetry');
		expect(tel?.scopeName).toBe('COBRA-SYNC:rep-telemetry:rep-1');
	});

	it('a stale-revision push raises SyncConflictError with the remote identity', async () => {
		const w = makeFakeWorker();
		const t = transport(w.fetchImpl);
		await t.push('V1', META({ revision: 3, deviceId: 'other' }), null);
		await expect(t.push('V2', META({ revision: 2 }), 1)).rejects.toMatchObject({
			remoteRevision: 3,
			remoteDeviceId: 'other'
		});
		await expect(t.push('V2', META({ revision: 2 }), 1)).rejects.toBeInstanceOf(SyncConflictError);
	});

	it('deleteRep tombstones both tiers so they pull as gone', async () => {
		const w = makeFakeWorker();
		const t = transport(w.fetchImpl);
		await t.push('CORE', META({ kind: 'rep-core', repId: 'rep-1', revision: 0 }), null);
		await t.push('TEL', META({ kind: 'rep-telemetry', repId: 'rep-1', revision: 0 }), null);

		await t.deleteRep('rep-1');
		expect(await t.pull('rep-core', 'rep-1')).toBeNull();
		expect(await t.pull('rep-telemetry', 'rep-1')).toBeNull();
		expect((await t.pullAll()).length).toBe(0);
	});

	it('re-authenticates once on a 401 and retries', async () => {
		const w = makeFakeWorker();
		let firstSyncSeen = false;
		const flaky = vi.fn(async (url: string, init?: RequestInit) => {
			const u = new URL(url);
			if (u.pathname === '/sync' && !firstSyncSeen) {
				firstSyncSeen = true;
				return jsonRes({ error: 'expired' }, 401);
			}
			return (w.fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>)(
				url,
				init
			);
		}) as unknown as typeof fetch;

		const t = transport(flaky);
		const pulled = await t.pull('global', '');
		// 401 path forced a second auth + retry; the retried GET returns null row.
		expect(pulled).toBeNull();
		expect(w.authCalls()).toBeGreaterThanOrEqual(1);
	});
});
