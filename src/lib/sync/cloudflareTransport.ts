/**
 * `SyncTransport` backed by the COBRA Cloudflare Worker (see `worker/`).
 *
 * Speaks the Worker's HTTP contract: a Lichess-token → app-JWT exchange at
 * `/auth/session`, then bearer-authenticated `/sync` push/pull. Maps the
 * Worker's row shape onto the same `ParsedBlob`/`PulledScope` the orchestrator
 * already consumes, so it drops into the seam alongside `LichessStudyTransport`
 * with no orchestrator changes. Removes the per-chapter size ceiling that
 * motivated the hosted backend (issue #68).
 *
 * Auth is lazy and self-healing: the first call mints a JWT; a later 401 (token
 * expired) triggers exactly one re-mint + retry.
 */

import { SyncConflictError } from './lichessSync';
import { chapterNameForKind } from './pgnWrap';
import type {
	BlobMeta,
	ParsedBlob,
	PulledScope,
	PushResult,
	SyncKind,
	SyncTransport
} from './transport';

export interface CloudflareConfig {
	/** Worker origin, e.g. `https://cobra-sync.<acct>.workers.dev`. */
	baseUrl: string;
	/** Lichess token presented to `/auth/session` (ideally a scopeless identity token). */
	lichessToken: string;
	/** This device's id, stamped onto delete tombstones. */
	deviceId: string;
	/** Injected for tests; defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injected for tests; defaults to `Date.now`. */
	now?: () => number;
}

/** The Worker's hydrated row shape (see worker/src/index.ts `hydrate`). */
interface WorkerRow {
	kind: SyncKind;
	repId?: string;
	revision: number;
	deviceId: string;
	pushedAt: number;
	deleted: boolean;
	updatedAt: number;
	blob: string | null;
}

export class CloudflareTransport implements SyncTransport {
	readonly #cfg: CloudflareConfig;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#jwt: string | null = null;
	userId: string | null = null;

	constructor(cfg: CloudflareConfig) {
		this.#cfg = cfg;
		this.#fetch = cfg.fetchImpl ?? fetch;
		this.#now = cfg.now ?? Date.now;
	}

	async connect(): Promise<{ remoteHasData: boolean }> {
		await this.#auth();
		const rows = await this.#pullSince(0);
		return { remoteHasData: rows.some((r) => !r.deleted) };
	}

	async pull(kind: SyncKind, repId: string | undefined): Promise<ParsedBlob | null> {
		const res = await this.#req(
			`/sync?kind=${encodeURIComponent(kind)}&repId=${encodeURIComponent(repId ?? '')}`
		);
		const { row } = (await res.json()) as { row: WorkerRow | null };
		if (!row || row.deleted || row.blob == null) return null;
		return toParsed(row);
	}

	async pullAll(): Promise<PulledScope[]> {
		const rows = await this.#pullSince(0);
		return rows
			.filter((r) => !r.deleted && r.blob != null)
			.map((r) => ({
				...toParsed(r),
				scopeId: scopeId(r.kind, r.repId),
				scopeName: chapterNameForKind(r.kind, r.repId)
			}));
	}

	async push(
		blob: string,
		meta: BlobMeta,
		expectedPriorRevision: number | null
	): Promise<PushResult> {
		return this.#postScope(
			{
				kind: meta.kind,
				repId: meta.repId ?? '',
				revision: meta.revision,
				deviceId: meta.deviceId,
				pushedAt: meta.pushedAt,
				blob
			},
			expectedPriorRevision
		);
	}

	async deleteRep(repId: string): Promise<void> {
		// Soft-delete both rep tiers: pull the current revision, push a tombstone
		// at revision+1. Absent/already-deleted scopes pull as null → nothing to
		// do. Best-effort, mirroring the Lichess transport's delete.
		for (const kind of ['rep-core', 'rep-telemetry'] as const) {
			const cur = await this.pull(kind, repId);
			if (!cur) continue;
			try {
				await this.#postScope(
					{
						kind,
						repId,
						revision: cur.revision + 1,
						deviceId: this.#cfg.deviceId,
						pushedAt: this.#now(),
						deleted: true
					},
					cur.revision
				);
			} catch {
				/* best-effort; a lingering scope is caught by the pull-side guard */
			}
		}
	}

	async purgeAll(): Promise<void> {
		const rows = await this.#pullSince(0);
		for (const r of rows) {
			if (r.deleted) continue;
			try {
				await this.#postScope(
					{
						kind: r.kind,
						repId: r.repId ?? '',
						revision: r.revision + 1,
						deviceId: this.#cfg.deviceId,
						pushedAt: this.#now(),
						deleted: true
					},
					r.revision
				);
			} catch {
				/* best-effort */
			}
		}
	}

	// --- Internal ----------------------------------------------------------

	async #postScope(
		body: {
			kind: SyncKind;
			repId: string;
			revision: number;
			deviceId: string;
			pushedAt: number;
			blob?: string;
			deleted?: boolean;
		},
		expectedPriorRevision: number | null
	): Promise<PushResult> {
		const res = await this.#req('/sync', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (res.status === 409) {
			const { current } = (await res.json()) as {
				current: { revision: number; deviceId: string; pushedAt: number } | null;
			};
			throw new SyncConflictError({
				localRevision: expectedPriorRevision ?? -1,
				remoteRevision: current?.revision ?? body.revision,
				remoteDeviceId: current?.deviceId ?? '',
				remotePushedAt: current?.pushedAt ?? 0,
				kind: body.kind,
				repId: body.repId || undefined
			});
		}
		if (!res.ok) throw new Error(`Sync push failed: HTTP ${res.status}`);
		const out = (await res.json()) as { revision?: number };
		return {
			chapterId: scopeId(body.kind, body.repId || undefined),
			revision: out.revision ?? body.revision,
			deviceId: body.deviceId,
			pushedAt: body.pushedAt
		};
	}

	async #pullSince(cursor: number): Promise<WorkerRow[]> {
		const res = await this.#req(`/sync?since=${cursor}`);
		const { rows } = (await res.json()) as { rows: WorkerRow[] };
		return rows ?? [];
	}

	/** Ensure a valid app JWT, minting one from the Lichess token if missing. */
	async #auth(): Promise<void> {
		if (this.#jwt) return;
		const res = await this.#fetch(`${this.#cfg.baseUrl}/auth/session`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.#cfg.lichessToken}` }
		});
		if (!res.ok) throw new Error(`Sync auth failed: HTTP ${res.status}`);
		const out = (await res.json()) as { token: string; userId: string };
		this.#jwt = out.token;
		this.userId = out.userId;
	}

	/** Authenticated request with one transparent re-auth on 401. */
	async #req(path: string, init: RequestInit = {}): Promise<Response> {
		await this.#auth();
		const send = () =>
			this.#fetch(`${this.#cfg.baseUrl}${path}`, {
				...init,
				headers: { ...init.headers, Authorization: `Bearer ${this.#jwt}` }
			});
		let res = await send();
		if (res.status === 401) {
			// JWT likely expired — re-mint once and retry.
			this.#jwt = null;
			await this.#auth();
			res = await send();
		}
		return res;
	}
}

function toParsed(row: WorkerRow): ParsedBlob {
	return {
		kind: row.kind,
		repId: row.repId,
		revision: row.revision,
		deviceId: row.deviceId,
		pushedAt: row.pushedAt,
		blob: row.blob as string
	};
}

function scopeId(kind: SyncKind, repId: string | undefined): string {
	return kind === 'global' ? 'global' : `${kind}:${repId ?? ''}`;
}
