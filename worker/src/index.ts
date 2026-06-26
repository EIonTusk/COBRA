/// <reference types="@cloudflare/workers-types" />
/**
 * COBRA sync backend (Cloudflare Worker).
 *
 * A thin auth proxy + key-value store for the app's sync blobs. The app keeps
 * IndexedDB as the source of truth; this just parks revisioned blobs keyed by
 * Lichess identity, exactly like a Lichess study chapter does — but without the
 * per-chapter size ceiling (issue #68).
 *
 * Routes:
 *   POST /auth/session   Authorization: Bearer <lichess-token>
 *                        -> verify against Lichess, mint a short-lived app JWT.
 *   GET  /sync?kind&repId            Authorization: Bearer <app-jwt>  (one scope)
 *   GET  /sync?since=<cursor>        Authorization: Bearer <app-jwt>  (changed scopes)
 *   POST /sync           Authorization: Bearer <app-jwt>             (push, atomic CAS)
 *
 * Conflict model: the push UPDATE only wins when its revision is strictly newer
 * (`WHERE excluded.revision > blobs.revision`); a no-op change count returns 409
 * with the current row so the client raises SyncConflictError.
 */

export interface Env {
	DB: D1Database;
	BLOBS?: R2Bucket;
	JWT_SECRET: string;
	/** CORS allow-origin for the app. Defaults to '*' (bearer auth, no cookies). */
	ALLOWED_ORIGIN?: string;
	/** Override for tests/self-host. Defaults to https://lichess.org. */
	LICHESS_API?: string;
}

const R2_THRESHOLD = 700_000; // bytes of blob string above which we offload to R2
const JWT_TTL_SECONDS = 60 * 60;
const SCOPE_KINDS = new Set(['global', 'rep-core', 'rep-telemetry']);
const QUOTA_BYTES = 50 * 1024 * 1024; // per-user storage cap (~50 MB)
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // hard-delete soft-deletes after 30 days

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
		const url = new URL(req.url);
		try {
			if (url.pathname === '/auth/session' && req.method === 'POST') {
				return cors(env, await handleAuth(req, env));
			}
			if (url.pathname === '/sync' && req.method === 'GET') {
				return cors(env, await handlePull(req, env, url));
			}
			if (url.pathname === '/sync' && req.method === 'POST') {
				return cors(env, await handlePush(req, env));
			}
			return cors(env, json({ error: 'not found' }, 404));
		} catch (e) {
			const msg = e instanceof Error ? e.message : 'internal error';
			return cors(env, json({ error: msg }, 500));
		}
	},

	// Cron (see wrangler.toml [triggers]): hard-delete tombstones older than the
	// retention window. Their byte_len is already 0 (zeroed on soft-delete), so
	// no bytes_used reconciliation is needed; their R2 objects were dropped at
	// delete time.
	async scheduled(_event: ScheduledController, env: Env): Promise<void> {
		const cutoff = Date.now() - TOMBSTONE_TTL_MS;
		await env.DB.prepare(`DELETE FROM blobs WHERE deleted_at IS NOT NULL AND deleted_at < ?1`)
			.bind(cutoff)
			.run();
	}
};

// --- Handlers --------------------------------------------------------------

async function handleAuth(req: Request, env: Env): Promise<Response> {
	const lichessToken = bearer(req);
	if (!lichessToken) return json({ error: 'missing bearer token' }, 401);

	const api = env.LICHESS_API ?? 'https://lichess.org';
	const acct = await fetch(`${api}/api/account`, {
		headers: { Authorization: `Bearer ${lichessToken}` }
	});
	if (!acct.ok) return json({ error: 'lichess token rejected' }, 401);
	const profile = (await acct.json()) as { id?: string; username?: string };
	if (!profile.id) return json({ error: 'lichess account has no id' }, 401);

	const now = Date.now();
	// Verify-then-discard: we never persist the Lichess token, only the id.
	await env.DB.prepare(
		`INSERT INTO users (user_id, username, created_at, last_seen)
		 VALUES (?1, ?2, ?3, ?3)
		 ON CONFLICT(user_id) DO UPDATE SET username = ?2, last_seen = ?3`
	)
		.bind(profile.id, profile.username ?? null, now)
		.run();

	const token = await mintJwt({ sub: profile.id }, env.JWT_SECRET, JWT_TTL_SECONDS);
	return json({ token, userId: profile.id, username: profile.username ?? null });
}

async function handlePull(req: Request, env: Env, url: URL): Promise<Response> {
	const userId = await requireUser(req, env);
	if (!userId) return json({ error: 'unauthorized' }, 401);

	const since = url.searchParams.get('since');
	if (since !== null) {
		const cursor = Number.parseInt(since, 10) || 0;
		const { results } = await env.DB.prepare(
			`SELECT * FROM blobs WHERE user_id = ?1 AND updated_at > ?2 ORDER BY updated_at ASC`
		)
			.bind(userId, cursor)
			.all<BlobRow>();
		const rows = await Promise.all((results ?? []).map((r) => hydrate(r, env)));
		const nextCursor = rows.reduce((m, r) => Math.max(m, r.updatedAt), cursor);
		return json({ rows, cursor: nextCursor });
	}

	const kind = url.searchParams.get('kind') ?? '';
	const repId = url.searchParams.get('repId') ?? '';
	if (!SCOPE_KINDS.has(kind)) return json({ error: 'bad kind' }, 400);
	const row = await env.DB.prepare(
		`SELECT * FROM blobs WHERE user_id = ?1 AND kind = ?2 AND rep_id = ?3`
	)
		.bind(userId, kind, repId)
		.first<BlobRow>();
	return json({ row: row ? await hydrate(row, env) : null });
}

interface PushBody {
	kind?: string;
	repId?: string;
	revision?: number;
	deviceId?: string;
	pushedAt?: number;
	blob?: string | null;
	contentHash?: string | null;
	deleted?: boolean;
}

async function handlePush(req: Request, env: Env): Promise<Response> {
	const userId = await requireUser(req, env);
	if (!userId) return json({ error: 'unauthorized' }, 401);

	const body = (await req.json().catch(() => null)) as PushBody | null;
	if (!body || !SCOPE_KINDS.has(body.kind ?? '')) return json({ error: 'bad request' }, 400);
	const kind = body.kind as string;
	const repId = kind === 'global' ? '' : (body.repId ?? '');
	if (kind !== 'global' && !repId) return json({ error: 'repId required' }, 400);
	if (typeof body.revision !== 'number' || !body.deviceId) {
		return json({ error: 'revision + deviceId required' }, 400);
	}
	const deleted = body.deleted === true;
	const now = Date.now();
	const pushedAt = typeof body.pushedAt === 'number' ? body.pushedAt : now;

	// Existing row (for quota delta + R2 cleanup) and the user's running total.
	const existing = await env.DB.prepare(
		`SELECT byte_len, r2_key FROM blobs WHERE user_id = ?1 AND kind = ?2 AND rep_id = ?3`
	)
		.bind(userId, kind, repId)
		.first<{ byte_len: number; r2_key: string | null }>();
	const usage = await env.DB.prepare(`SELECT bytes_used FROM users WHERE user_id = ?1`)
		.bind(userId)
		.first<{ bytes_used: number }>();

	// Decide payload storage: deleted -> neither; large -> R2; else inline.
	let blob: string | null = null;
	let r2Key: string | null = null;
	let byteLen = 0;
	if (!deleted) {
		const payload = body.blob ?? '';
		if (!payload) return json({ error: 'blob required for a live scope' }, 400);
		byteLen = payload.length;
		if (byteLen > R2_THRESHOLD && env.BLOBS) {
			r2Key = `${userId}/${kind}/${repId || 'global'}`;
		} else {
			blob = payload;
		}
	}

	// Quota: projected total after this write (delta against the old row).
	const projected = Math.max(0, (usage?.bytes_used ?? 0) - (existing?.byte_len ?? 0) + byteLen);
	if (!deleted && projected > QUOTA_BYTES) {
		return json({ error: 'storage quota exceeded', quotaBytes: QUOTA_BYTES }, 413);
	}

	// Write the R2 object before the row commits so a pull never sees a row
	// pointing at a missing object. (Note: under concurrent same-scope pushes
	// the loser can overwrite the winner's object at this deterministic key —
	// acceptable for the rare large-telemetry case; the CAS still protects D1.)
	if (r2Key) await env.BLOBS!.put(r2Key, body.blob as string);

	const res = await env.DB.prepare(
		`INSERT INTO blobs (user_id, kind, rep_id, revision, device_id, pushed_at,
		                    blob, r2_key, byte_len, content_hash, deleted_at,
		                    created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
		 ON CONFLICT(user_id, kind, rep_id) DO UPDATE SET
		   revision = excluded.revision, device_id = excluded.device_id,
		   pushed_at = excluded.pushed_at, blob = excluded.blob,
		   r2_key = excluded.r2_key, byte_len = excluded.byte_len,
		   content_hash = excluded.content_hash, deleted_at = excluded.deleted_at,
		   updated_at = excluded.updated_at
		 WHERE excluded.revision > blobs.revision`
	)
		.bind(
			userId,
			kind,
			repId,
			body.revision,
			body.deviceId,
			pushedAt,
			blob,
			r2Key,
			byteLen,
			body.contentHash ?? null,
			deleted ? now : null,
			now
		)
		.run();

	if ((res.meta?.changes ?? 0) === 0) {
		// CAS lost: the stored revision is >= ours. Return the current row so the
		// client can raise SyncConflictError with the remote's identity.
		const current = await env.DB.prepare(
			`SELECT revision, device_id, pushed_at FROM blobs
			 WHERE user_id = ?1 AND kind = ?2 AND rep_id = ?3`
		)
			.bind(userId, kind, repId)
			.first<{ revision: number; device_id: string; pushed_at: number }>();
		return json(
			{
				conflict: true,
				current: current
					? { revision: current.revision, deviceId: current.device_id, pushedAt: current.pushed_at }
					: null
			},
			409
		);
	}

	// CAS won. Reconcile the user's byte total, and drop an R2 object the row no
	// longer references (a delete, or an overwrite that moved back inline).
	await env.DB.prepare(`UPDATE users SET bytes_used = ?2, last_seen = ?3 WHERE user_id = ?1`)
		.bind(userId, projected, now)
		.run();
	if (existing?.r2_key && existing.r2_key !== r2Key && env.BLOBS) {
		await env.BLOBS.delete(existing.r2_key).catch(() => {});
	}

	return json({ ok: true, revision: body.revision, updatedAt: now });
}

// --- Row shaping -----------------------------------------------------------

interface BlobRow {
	kind: string;
	rep_id: string;
	revision: number;
	device_id: string;
	pushed_at: number;
	blob: string | null;
	r2_key: string | null;
	deleted_at: number | null;
	updated_at: number;
}

async function hydrate(row: BlobRow, env: Env) {
	let blob = row.blob;
	if (blob === null && row.r2_key && env.BLOBS) {
		const obj = await env.BLOBS.get(row.r2_key);
		blob = obj ? await obj.text() : null;
	}
	return {
		kind: row.kind,
		repId: row.rep_id || undefined,
		revision: row.revision,
		deviceId: row.device_id,
		pushedAt: row.pushed_at,
		deleted: row.deleted_at !== null,
		updatedAt: row.updated_at,
		blob
	};
}

// --- Auth / JWT ------------------------------------------------------------

function bearer(req: Request): string | null {
	const h = req.headers.get('Authorization') ?? '';
	const m = /^Bearer\s+(.+)$/i.exec(h);
	return m ? m[1].trim() : null;
}

async function requireUser(req: Request, env: Env): Promise<string | null> {
	const token = bearer(req);
	if (!token) return null;
	const payload = await verifyJwt(token, env.JWT_SECRET);
	return payload && typeof payload.sub === 'string' ? payload.sub : null;
}

interface JwtPayload {
	sub: string;
	exp?: number;
}

async function mintJwt(payload: JwtPayload, secret: string, ttlSeconds: number): Promise<string> {
	const header = { alg: 'HS256', typ: 'JWT' };
	const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
	const body = b64urlJson({ ...payload, exp });
	const head = b64urlJson(header);
	const data = `${head}.${body}`;
	const sig = await hmac(data, secret);
	return `${data}.${sig}`;
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [head, body, sig] = parts;
	const expected = await hmac(`${head}.${body}`, secret);
	if (!timingSafeEqual(sig, expected)) return null;
	try {
		const payload = JSON.parse(b64urlDecode(body)) as JwtPayload;
		if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
		return payload;
	} catch {
		return null;
	}
}

async function hmac(data: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return b64urlBytes(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let out = 0;
	for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return out === 0;
}

// --- Encoding / HTTP helpers ----------------------------------------------

function b64urlJson(obj: unknown): string {
	return b64urlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

function b64urlBytes(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
	const pad = '='.repeat((4 - (s.length % 4)) % 4);
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
	return atob(b64);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function cors(env: Env, res: Response): Response {
	const h = new Headers(res.headers);
	h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN ?? '*');
	h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
	h.set('Vary', 'Origin');
	return new Response(res.body, { status: res.status, headers: h });
}
