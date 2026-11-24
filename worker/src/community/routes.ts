/**
 * Community openings: publish, browse, import and moderate repertoire trees.
 *
 *   GET    /community/publications?q&color&sort&cursor   listed publications (public)
 *   POST   /community/publications                        publish a new tree (auth)
 *   GET    /community/publications/:id[?version=N]        one publication + tree (public)
 *   PUT    /community/publications/:id                    new version and/or metadata (owner)
 *   DELETE /community/publications/:id                    unpublish (owner)
 *   POST   /community/publications/:id/import             count an import (auth optional)
 *   POST   /community/publications/:id/report             report (auth)
 *   GET    /community/positions/moves?fen&color           community moves at a position (public)
 *   GET    /community/me                                  my publications + admin flag (auth)
 *   DELETE /community/me                                  delete all my community data (auth)
 *   GET    /community/admin/reports                       open reports (admin)
 *   POST   /community/admin/publications/:id/status       hide / restore / remove (admin)
 *
 * A publication's tree is validated and rebuilt by `validateTree`, so only
 * moves, comments and idea-card text are ever stored. Training progress,
 * mistakes and sync blobs never reach these tables.
 */
import { positionHash } from './hash';
import { treeOpenings } from './openings';
import { TreeError, treeMovePairs, validateTree } from './tree';
import {
	COMMUNITY_LIMITS as L,
	type CommunityTreeV1,
	type PublicationDetail,
	type PublicationSummary,
	type PublishMeta
} from './types';

export interface CommunityEnv {
	DB: D1Database;
	/** Comma-separated Lichess user ids allowed to moderate. */
	ADMIN_USER_IDS?: string;
	LICHESS_API?: string;
}

export type ResolveUser = (req: Request) => Promise<string | null>;

/** Abuse limits per publisher. */
export const COMMUNITY_RATE = {
	newPerDay: 5,
	versionsPerDay: 20,
	maxActive: 50
} as const;

/** Distinct reporters (since the last admin review) that auto-hide a publication. */
export const AUTO_HIDE_REPORTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_AFTER_MS = 30 * DAY_MS;
const AUTHOR_RECHECK_MS = 7 * DAY_MS;
const PAGE_SIZE = 24;
const REPORT_REASONS = new Set(['spam', 'offensive', 'other']);

interface PubRow {
	id: string;
	owner_id: string;
	title: string;
	description: string;
	tags: string;
	color: 'white' | 'black';
	root_fen_key: string;
	openings: string;
	visibility: 'public' | 'unlisted';
	show_author: number;
	status: 'active' | 'hidden' | 'removed';
	status_reason: string | null;
	reviewed_at: number | null;
	current_version: number;
	position_count: number;
	move_count: number;
	idea_count: number;
	import_count: number;
	forked_from: string | null;
	created_at: number;
	updated_at: number;
	removed_at: number | null;
	username?: string | null;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly extra: Record<string, unknown> = {}
	) {
		super(message);
	}
}

export async function handleCommunity(
	req: Request,
	env: CommunityEnv,
	url: URL,
	resolveUser: ResolveUser
): Promise<Response | null> {
	if (!url.pathname.startsWith('/community/')) return null;
	const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop 'community'
	const m = req.method;
	try {
		if (parts[0] === 'publications') {
			if (parts.length === 1 && m === 'GET') return await listPublications(env, url);
			if (parts.length === 1 && m === 'POST') return await createPublication(req, env, resolveUser);
			const id = parts[1];
			if (parts.length === 2 && m === 'GET') return await getPublication(req, env, url, id, resolveUser);
			if (parts.length === 2 && m === 'PUT') return await updatePublication(req, env, id, resolveUser);
			if (parts.length === 2 && m === 'DELETE') return await unpublish(req, env, id, resolveUser);
			if (parts.length === 3 && parts[2] === 'import' && m === 'POST') {
				return await countImport(req, env, id, resolveUser);
			}
			if (parts.length === 3 && parts[2] === 'report' && m === 'POST') {
				return await report(req, env, id, resolveUser);
			}
		}
		if (parts[0] === 'positions' && parts[1] === 'moves' && m === 'GET') {
			return await positionMoves(env, url);
		}
		if (parts[0] === 'me' && parts.length === 1) {
			if (m === 'GET') return await me(req, env, resolveUser);
			if (m === 'DELETE') return await deleteMe(req, env, resolveUser);
		}
		if (parts[0] === 'admin') {
			const admin = await requireAdmin(req, env, resolveUser);
			if (parts[1] === 'reports' && m === 'GET') return await adminReports(env);
			if (parts[1] === 'publications' && parts[3] === 'status' && m === 'POST') {
				return await adminSetStatus(req, env, parts[2], admin);
			}
		}
		return json({ error: 'not found' }, 404);
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
		if (e instanceof TreeError) return json({ error: e.message }, 400);
		throw e;
	}
}

// --- Browse -------------------------------------------------------------------

async function listPublications(env: CommunityEnv, url: URL): Promise<Response> {
	const q = ftsQuery(url.searchParams.get('q') ?? '');
	const color = url.searchParams.get('color');
	const sort = url.searchParams.get('sort') === 'new' ? 'new' : 'popular';
	const offset = Math.max(0, Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0);

	const where = [`p.status = 'active'`, `p.visibility = 'public'`];
	const binds: unknown[] = [];
	if (color === 'white' || color === 'black') {
		binds.push(color);
		where.push(`p.color = ?${binds.length}`);
	}
	if (q) {
		binds.push(q);
		where.push(
			`p.id IN (SELECT publication_id FROM publication_fts WHERE publication_fts MATCH ?${binds.length})`
		);
	}
	const order =
		sort === 'new' ? 'p.updated_at DESC' : 'p.import_count DESC, p.updated_at DESC';
	binds.push(PAGE_SIZE + 1, offset);
	const { results } = await env.DB.prepare(
		`SELECT p.*, u.username FROM publications p JOIN users u ON u.user_id = p.owner_id
		 WHERE ${where.join(' AND ')} ORDER BY ${order}
		 LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`
	)
		.bind(...binds)
		.all<PubRow>();
	const rows = results ?? [];
	const more = rows.length > PAGE_SIZE;
	return json(
		{
			publications: rows.slice(0, PAGE_SIZE).map(summary),
			cursor: more ? String(offset + PAGE_SIZE) : null
		},
		200,
		{ 'Cache-Control': 'public, max-age=60' }
	);
}

async function getPublication(
	req: Request,
	env: CommunityEnv,
	url: URL,
	id: string,
	resolveUser: ResolveUser
): Promise<Response> {
	const pub = await loadPub(env, id);
	if (!pub || pub.status === 'removed') throw new HttpError(404, 'not found');
	let cache = 'public, max-age=60';
	if (pub.status === 'hidden') {
		// Only the owner and moderators can still open a hidden publication.
		const userId = await resolveUser(req);
		if (!userId || (userId !== pub.owner_id && !isAdmin(env, userId))) {
			throw new HttpError(404, 'not found');
		}
		cache = 'private, no-store';
	}
	const v = Number.parseInt(url.searchParams.get('version') ?? '', 10);
	const version = Number.isInteger(v) && v > 0 ? v : pub.current_version;
	const row = await env.DB.prepare(
		`SELECT tree, changelog FROM publication_versions WHERE publication_id = ?1 AND version = ?2`
	)
		.bind(id, version)
		.first<{ tree: string; changelog: string }>();
	if (!row) throw new HttpError(404, 'version not found');
	const detail: PublicationDetail = {
		...summary(pub),
		version,
		tree: JSON.parse(row.tree) as CommunityTreeV1,
		changelog: row.changelog
	};
	return json(detail, 200, { 'Cache-Control': cache });
}

async function positionMoves(env: CommunityEnv, url: URL): Promise<Response> {
	const fen = url.searchParams.get('fen') ?? '';
	const color = url.searchParams.get('color');
	if (!fen || (color !== 'white' && color !== 'black')) {
		throw new HttpError(400, 'fen and color required');
	}
	const { results } = await env.DB.prepare(
		`SELECT san, owners FROM community_move_counts
		 WHERE fen_hash = ?1 AND color = ?2 ORDER BY owners DESC, san ASC LIMIT 30`
	)
		.bind(positionHash(fen), color)
		.all<{ san: string; owners: number }>();
	return json({ moves: results ?? [] }, 200, { 'Cache-Control': 'public, max-age=300' });
}

// --- Publish ------------------------------------------------------------------

interface PublishBody {
	meta?: unknown;
	tree?: unknown;
}

async function readBody(req: Request): Promise<PublishBody> {
	const text = await req.text();
	if (text.length > L.maxBytes + 20_000) throw new HttpError(413, 'publication too large');
	try {
		const body = JSON.parse(text) as PublishBody;
		if (!body || typeof body !== 'object') throw new Error();
		return body;
	} catch {
		throw new HttpError(400, 'bad request');
	}
}

function cleanMeta(raw: unknown): Required<Omit<PublishMeta, 'forkedFrom'>> & { forkedFrom: string | null } {
	if (!raw || typeof raw !== 'object') throw new HttpError(400, 'meta required');
	const allowed = ['title', 'description', 'tags', 'visibility', 'showAuthor', 'changelog', 'forkedFrom'];
	for (const k of Object.keys(raw)) {
		if (!allowed.includes(k)) throw new HttpError(400, `meta: unexpected field "${k}"`);
	}
	const m = raw as Record<string, unknown>;
	const text = (v: unknown, max: number, name: string): string => {
		if (v === undefined || v === null) return '';
		if (typeof v !== 'string') throw new HttpError(400, `${name} must be text`);
		const t = v.trim().replace(/\s+/g, ' ');
		if (t.length > max) throw new HttpError(400, `${name} is longer than ${max} characters`);
		return t;
	};
	const title = text(m.title, L.maxTitle, 'title');
	if (!title) throw new HttpError(400, 'title required');
	const description =
		typeof m.description === 'string' ? m.description.trim() : text(m.description, 0, 'description');
	if (description.length > L.maxDescription) {
		throw new HttpError(400, `description is longer than ${L.maxDescription} characters`);
	}
	const tagsRaw = m.tags ?? [];
	if (!Array.isArray(tagsRaw) || tagsRaw.length > L.maxTags) {
		throw new HttpError(400, `at most ${L.maxTags} tags`);
	}
	const tags = [...new Set(tagsRaw.map((t) => text(t, L.maxTag, 'tag').toLowerCase()).filter(Boolean))];
	if (m.visibility !== 'public' && m.visibility !== 'unlisted') {
		throw new HttpError(400, 'visibility must be public or unlisted');
	}
	if (typeof m.showAuthor !== 'boolean') throw new HttpError(400, 'showAuthor required');
	const forkedFrom =
		typeof m.forkedFrom === 'string' && /^[A-Za-z0-9]{6,16}$/.test(m.forkedFrom) ? m.forkedFrom : null;
	return {
		title,
		description,
		tags,
		visibility: m.visibility,
		showAuthor: m.showAuthor,
		changelog: text(m.changelog, L.maxChangelog, 'changelog'),
		forkedFrom
	};
}

async function createPublication(
	req: Request,
	env: CommunityEnv,
	resolveUser: ResolveUser
): Promise<Response> {
	const userId = await requireUserId(req, resolveUser);
	const body = await readBody(req);
	const meta = cleanMeta(body.meta);
	const v = validateTree(body.tree);
	const treeJson = JSON.stringify(v.tree);
	if (treeJson.length > L.maxBytes) throw new HttpError(413, 'publication too large');
	const hash = await sha256(treeJson);
	const now = Date.now();

	const usage = await env.DB.prepare(
		`SELECT
		   (SELECT COUNT(*) FROM publications WHERE owner_id = ?1 AND created_at > ?2) AS new_today,
		   (SELECT COUNT(*) FROM publications WHERE owner_id = ?1 AND status <> 'removed') AS active,
		   (SELECT COUNT(*) FROM publication_versions pv JOIN publications p ON p.id = pv.publication_id
		      WHERE p.owner_id = ?1 AND pv.created_at > ?2) AS versions_today,
		   (SELECT p.id FROM publications p JOIN publication_versions pv
		      ON pv.publication_id = p.id AND pv.version = p.current_version
		      WHERE p.owner_id = ?1 AND p.status <> 'removed' AND pv.content_hash = ?3 LIMIT 1) AS duplicate_of`
	)
		.bind(userId, now - DAY_MS, hash)
		.first<{ new_today: number; active: number; versions_today: number; duplicate_of: string | null }>();
	if (usage?.duplicate_of) {
		throw new HttpError(409, 'you already published this tree', { id: usage.duplicate_of });
	}
	if ((usage?.new_today ?? 0) >= COMMUNITY_RATE.newPerDay) {
		throw new HttpError(429, `at most ${COMMUNITY_RATE.newPerDay} new publications a day`);
	}
	if ((usage?.versions_today ?? 0) >= COMMUNITY_RATE.versionsPerDay) {
		throw new HttpError(429, `at most ${COMMUNITY_RATE.versionsPerDay} publishes a day`);
	}
	if ((usage?.active ?? 0) >= COMMUNITY_RATE.maxActive) {
		throw new HttpError(429, `at most ${COMMUNITY_RATE.maxActive} publications per person`);
	}

	const id = newId();
	const openings = treeOpenings(v.tree);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO publications (id, owner_id, title, description, tags, color, root_fen_key,
			   openings, visibility, show_author, status, current_version, position_count, move_count,
			   idea_count, forked_from, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', 1, ?11, ?12, ?13, ?14, ?15, ?15)`
		).bind(
			id,
			userId,
			meta.title,
			meta.description,
			JSON.stringify(meta.tags),
			v.tree.color,
			v.rootFenKey,
			JSON.stringify(openings),
			meta.visibility,
			meta.showAuthor ? 1 : 0,
			v.positionCount,
			v.moveCount,
			v.ideaCount,
			meta.forkedFrom,
			now
		),
		env.DB.prepare(
			`INSERT INTO publication_versions (publication_id, version, tree, byte_len, content_hash, changelog, created_at)
			 VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6)`
		).bind(id, treeJson, treeJson.length, hash, meta.changelog, now),
		env.DB.prepare(
			`INSERT INTO community_authors (user_id) VALUES (?1) ON CONFLICT(user_id) DO NOTHING`
		).bind(userId)
	]);
	const pub = (await loadPub(env, id))!;
	await reindex(env, null, pub, null, v.tree);
	return json({ id, version: 1, publication: summary(pub) }, 201);
}

async function updatePublication(
	req: Request,
	env: CommunityEnv,
	id: string,
	resolveUser: ResolveUser
): Promise<Response> {
	const userId = await requireUserId(req, resolveUser);
	const before = await loadPub(env, id);
	if (!before || before.status === 'removed') throw new HttpError(404, 'not found');
	if (before.owner_id !== userId) throw new HttpError(403, 'not your publication');
	const body = await readBody(req);
	const meta = cleanMeta(body.meta);
	const now = Date.now();
	const oldTree = await loadTree(env, id, before.current_version);

	let version = before.current_version;
	let newTree = oldTree;
	const stmts: D1PreparedStatement[] = [];
	let counts = {
		position_count: before.position_count,
		move_count: before.move_count,
		idea_count: before.idea_count,
		openings: before.openings
	};
	if (body.tree !== undefined) {
		const v = validateTree(body.tree);
		if (v.tree.color !== before.color) throw new HttpError(400, 'colour cannot change');
		const treeJson = JSON.stringify(v.tree);
		if (treeJson.length > L.maxBytes) throw new HttpError(413, 'publication too large');
		const hash = await sha256(treeJson);
		const cur = await env.DB.prepare(
			`SELECT content_hash FROM publication_versions WHERE publication_id = ?1 AND version = ?2`
		)
			.bind(id, before.current_version)
			.first<{ content_hash: string }>();
		if (cur?.content_hash !== hash) {
			const today = await env.DB.prepare(
				`SELECT COUNT(*) AS n FROM publication_versions pv JOIN publications p ON p.id = pv.publication_id
				 WHERE p.owner_id = ?1 AND pv.created_at > ?2`
			)
				.bind(userId, now - DAY_MS)
				.first<{ n: number }>();
			if ((today?.n ?? 0) >= COMMUNITY_RATE.versionsPerDay) {
				throw new HttpError(429, `at most ${COMMUNITY_RATE.versionsPerDay} publishes a day`);
			}
			version += 1;
			newTree = v.tree;
			counts = {
				position_count: v.positionCount,
				move_count: v.moveCount,
				idea_count: v.ideaCount,
				openings: JSON.stringify(treeOpenings(v.tree))
			};
			stmts.push(
				env.DB.prepare(
					`INSERT INTO publication_versions (publication_id, version, tree, byte_len, content_hash, changelog, created_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
				).bind(id, version, treeJson, treeJson.length, hash, meta.changelog, now)
			);
		}
	}
	stmts.push(
		env.DB.prepare(
			`UPDATE publications SET title = ?2, description = ?3, tags = ?4, visibility = ?5,
			   show_author = ?6, current_version = ?7, position_count = ?8, move_count = ?9,
			   idea_count = ?10, openings = ?11, updated_at = ?12
			 WHERE id = ?1`
		).bind(
			id,
			meta.title,
			meta.description,
			JSON.stringify(meta.tags),
			meta.visibility,
			meta.showAuthor ? 1 : 0,
			version,
			counts.position_count,
			counts.move_count,
			counts.idea_count,
			counts.openings,
			now
		)
	);
	await env.DB.batch(stmts);
	const after = (await loadPub(env, id))!;
	await reindex(env, before, after, oldTree, newTree);
	return json({ id, version, publication: summary(after) });
}

async function unpublish(
	req: Request,
	env: CommunityEnv,
	id: string,
	resolveUser: ResolveUser
): Promise<Response> {
	const userId = await requireUserId(req, resolveUser);
	const before = await loadPub(env, id);
	if (!before || before.status === 'removed') throw new HttpError(404, 'not found');
	if (before.owner_id !== userId) throw new HttpError(403, 'not your publication');
	await setStatus(env, before, 'removed', 'unpublished by author');
	return json({ ok: true });
}

// --- Imports and reports ------------------------------------------------------

async function countImport(
	req: Request,
	env: CommunityEnv,
	id: string,
	resolveUser: ResolveUser
): Promise<Response> {
	const pub = await loadPub(env, id);
	if (!pub || pub.status !== 'active') throw new HttpError(404, 'not found');
	const userId = await resolveUser(req);
	// Only signed-in imports count, once per person, so the count can't be farmed.
	if (userId && userId !== pub.owner_id) {
		const res = await env.DB.prepare(
			`INSERT INTO publication_imports (publication_id, user_id, created_at) VALUES (?1, ?2, ?3)
			 ON CONFLICT DO NOTHING`
		)
			.bind(id, userId, Date.now())
			.run();
		if ((res.meta?.changes ?? 0) > 0) {
			await env.DB.prepare(`UPDATE publications SET import_count = import_count + 1 WHERE id = ?1`)
				.bind(id)
				.run();
		}
	}
	return json({ ok: true });
}

async function report(
	req: Request,
	env: CommunityEnv,
	id: string,
	resolveUser: ResolveUser
): Promise<Response> {
	const userId = await requireUserId(req, resolveUser);
	const pub = await loadPub(env, id);
	if (!pub || pub.status === 'removed') throw new HttpError(404, 'not found');
	if (pub.owner_id === userId) throw new HttpError(400, 'you cannot report your own publication');
	const body = (await req.json().catch(() => null)) as { reason?: unknown; note?: unknown } | null;
	const reason = typeof body?.reason === 'string' ? body.reason : '';
	if (!REPORT_REASONS.has(reason)) throw new HttpError(400, 'reason must be spam, offensive or other');
	const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
	const now = Date.now();
	await env.DB.prepare(
		`INSERT INTO reports (publication_id, reporter_id, reason, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
		 ON CONFLICT (publication_id, reporter_id) DO UPDATE SET reason = ?3, note = ?4, created_at = ?5`
	)
		.bind(id, userId, reason, note, now)
		.run();
	const open = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM reports WHERE publication_id = ?1 AND created_at > ?2`
	)
		.bind(id, pub.reviewed_at ?? 0)
		.first<{ n: number }>();
	let hidden = false;
	if (pub.status === 'active' && (open?.n ?? 0) >= AUTO_HIDE_REPORTS) {
		await setStatus(env, pub, 'hidden', 'reported');
		hidden = true;
	}
	return json({ ok: true, hidden });
}

// --- Me -----------------------------------------------------------------------

async function me(req: Request, env: CommunityEnv, resolveUser: ResolveUser): Promise<Response> {
	const userId = await requireUserId(req, resolveUser);
	const { results } = await env.DB.prepare(
		`SELECT p.*, u.username FROM publications p JOIN users u ON u.user_id = p.owner_id
		 WHERE p.owner_id = ?1 AND p.status <> 'removed' ORDER BY p.updated_at DESC`
	)
		.bind(userId)
		.all<PubRow>();
	const user = await env.DB.prepare(`SELECT username FROM users WHERE user_id = ?1`)
		.bind(userId)
		.first<{ username: string | null }>();
	return json(
		{
			userId,
			username: user?.username ?? null,
			isAdmin: isAdmin(env, userId),
			publications: (results ?? []).map((r) => ({ ...summary(r), author: r.username ?? null }))
		},
		200,
		{ 'Cache-Control': 'private, no-store' }
	);
}

async function deleteMe(req: Request, env: CommunityEnv, resolveUser: ResolveUser): Promise<Response> {
	const userId = await requireUserId(req, resolveUser);
	const { results } = await env.DB.prepare(`SELECT * FROM publications WHERE owner_id = ?1`)
		.bind(userId)
		.all<PubRow>();
	for (const pub of results ?? []) {
		if (pub.status !== 'removed') await setStatus(env, pub, 'removed', 'account data deleted');
	}
	await env.DB.batch([
		...(results ?? []).flatMap((p) => purgeStatements(env, p.id)),
		env.DB.prepare(`DELETE FROM reports WHERE reporter_id = ?1`).bind(userId),
		env.DB.prepare(`DELETE FROM publication_imports WHERE user_id = ?1`).bind(userId),
		env.DB.prepare(`DELETE FROM community_authors WHERE user_id = ?1`).bind(userId)
	]);
	return json({ ok: true, deleted: (results ?? []).length });
}

// --- Moderation ---------------------------------------------------------------

function isAdmin(env: CommunityEnv, userId: string): boolean {
	return (env.ADMIN_USER_IDS ?? '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)
		.includes(userId.toLowerCase());
}

async function requireAdmin(req: Request, env: CommunityEnv, resolveUser: ResolveUser): Promise<string> {
	const userId = await requireUserId(req, resolveUser);
	if (!isAdmin(env, userId)) throw new HttpError(403, 'moderators only');
	return userId;
}

async function adminReports(env: CommunityEnv): Promise<Response> {
	const { results } = await env.DB.prepare(
		`SELECT p.*, u.username,
		   (SELECT COUNT(*) FROM reports r WHERE r.publication_id = p.id
		      AND r.created_at > COALESCE(p.reviewed_at, 0)) AS open_reports,
		   (SELECT json_group_array(json_object('reason', r.reason, 'note', r.note, 'at', r.created_at))
		      FROM reports r WHERE r.publication_id = p.id AND r.created_at > COALESCE(p.reviewed_at, 0)) AS report_list
		 FROM publications p JOIN users u ON u.user_id = p.owner_id
		 WHERE p.status <> 'removed' AND (p.status = 'hidden' OR EXISTS (
		   SELECT 1 FROM reports r WHERE r.publication_id = p.id AND r.created_at > COALESCE(p.reviewed_at, 0)))
		 ORDER BY open_reports DESC, p.updated_at DESC LIMIT 100`
	).all<PubRow & { open_reports: number; report_list: string }>();
	return json(
		{
			items: (results ?? []).map((r) => ({
				// Moderators always see who published, even an anonymous publication.
				publication: { ...summary(r), author: r.username ?? null },
				statusReason: r.status_reason,
				openReports: r.open_reports,
				reports: JSON.parse(r.report_list || '[]')
			}))
		},
		200,
		{ 'Cache-Control': 'private, no-store' }
	);
}

async function adminSetStatus(req: Request, env: CommunityEnv, id: string, admin: string): Promise<Response> {
	const pub = await loadPub(env, id);
	if (!pub) throw new HttpError(404, 'not found');
	const body = (await req.json().catch(() => null)) as { status?: unknown; reason?: unknown } | null;
	const status = body?.status;
	if (status !== 'active' && status !== 'hidden' && status !== 'removed') {
		throw new HttpError(400, 'status must be active, hidden or removed');
	}
	const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 200) : `set by ${admin}`;
	await setStatus(env, pub, status, reason, true);
	return json({ ok: true, publication: summary((await loadPub(env, id))!) });
}

// --- Cron ---------------------------------------------------------------------

/**
 * Daily housekeeping: purge publications removed more than 30 days ago, and
 * hide publications whose Lichess account has been closed.
 */
export async function communityCron(env: CommunityEnv, fetchImpl: typeof fetch = fetch): Promise<void> {
	const now = Date.now();
	const { results: stale } = await env.DB.prepare(
		`SELECT id FROM publications WHERE status = 'removed' AND removed_at < ?1 LIMIT 200`
	)
		.bind(now - PURGE_AFTER_MS)
		.all<{ id: string }>();
	if (stale?.length) await env.DB.batch(stale.flatMap((p) => purgeStatements(env, p.id)));

	const { results: authors } = await env.DB.prepare(
		`SELECT a.user_id FROM community_authors a
		 WHERE a.checked_at < ?1 AND EXISTS (
		   SELECT 1 FROM publications p WHERE p.owner_id = a.user_id AND p.status = 'active')
		 ORDER BY a.checked_at ASC LIMIT 300`
	)
		.bind(now - AUTHOR_RECHECK_MS)
		.all<{ user_id: string }>();
	if (!authors?.length) return;
	const api = env.LICHESS_API ?? 'https://lichess.org';
	const res = await fetchImpl(`${api}/api/users`, {
		method: 'POST',
		headers: { 'Content-Type': 'text/plain' },
		body: authors.map((a) => a.user_id).join(',')
	});
	if (!res.ok) return;
	const users = (await res.json()) as Array<{ id: string; disabled?: boolean; tosViolation?: boolean }>;
	const closed = new Set(users.filter((u) => u.disabled || u.tosViolation).map((u) => u.id));
	for (const a of authors) {
		const isClosed = closed.has(a.user_id);
		await env.DB.prepare(`UPDATE community_authors SET checked_at = ?2, closed = ?3 WHERE user_id = ?1`)
			.bind(a.user_id, now, isClosed ? 1 : 0)
			.run();
		if (!isClosed) continue;
		const { results: pubs } = await env.DB.prepare(
			`SELECT * FROM publications WHERE owner_id = ?1 AND status = 'active'`
		)
			.bind(a.user_id)
			.all<PubRow>();
		for (const p of pubs ?? []) await setStatus(env, p, 'hidden', 'lichess account closed');
	}
}

// --- Index maintenance --------------------------------------------------------

function listed(p: PubRow | null): boolean {
	return !!p && p.status === 'active' && p.visibility === 'public';
}

async function setStatus(
	env: CommunityEnv,
	before: PubRow,
	status: PubRow['status'],
	reason: string,
	review = false
): Promise<void> {
	const now = Date.now();
	await env.DB.prepare(
		`UPDATE publications SET status = ?2, status_reason = ?3,
		   removed_at = CASE WHEN ?2 = 'removed' THEN ?4 ELSE NULL END,
		   reviewed_at = CASE WHEN ?5 = 1 THEN ?4 ELSE reviewed_at END
		 WHERE id = ?1`
	)
		.bind(before.id, status, reason, now, review ? 1 : 0)
		.run();
	const after = (await loadPub(env, before.id))!;
	const tree = await loadTree(env, before.id, before.current_version);
	await reindex(env, before, after, tree, tree);
}

/**
 * Bring the search index and the position index in line with a change from
 * `before` to `after`. Only listed publications (active + public) contribute,
 * and only the difference between the two trees is written.
 */
async function reindex(
	env: CommunityEnv,
	before: PubRow | null,
	after: PubRow,
	oldTree: CommunityTreeV1 | null,
	newTree: CommunityTreeV1 | null
): Promise<void> {
	const stmts: D1PreparedStatement[] = [
		env.DB.prepare(`DELETE FROM publication_fts WHERE publication_id = ?1`).bind(after.id)
	];
	if (listed(after)) {
		const openings = (JSON.parse(after.openings) as Array<[string, string]>)
			.map(([eco, name]) => `${eco} ${name}`)
			.join(' · ');
		stmts.push(
			env.DB.prepare(
				`INSERT INTO publication_fts (publication_id, title, description, tags, openings)
				 VALUES (?1, ?2, ?3, ?4, ?5)`
			).bind(
				after.id,
				after.title,
				after.description,
				(JSON.parse(after.tags) as string[]).join(' '),
				openings
			)
		);
	}

	const keyOf = ([fen, san]: [string, string]) => `${positionHash(fen)}|${san}`;
	const oldSet = new Map<string, [number, string]>();
	if (listed(before) && oldTree) {
		for (const p of treeMovePairs(oldTree)) oldSet.set(keyOf(p), [positionHash(p[0]), p[1]]);
	}
	const newSet = new Map<string, [number, string]>();
	if (listed(after) && newTree) {
		for (const p of treeMovePairs(newTree)) newSet.set(keyOf(p), [positionHash(p[0]), p[1]]);
	}
	const added = [...newSet].filter(([k]) => !oldSet.has(k)).map(([, v]) => v);
	const removed = [...oldSet].filter(([k]) => !newSet.has(k)).map(([, v]) => v);
	const color = after.color;
	const owner = after.owner_id;
	const pairsSql = `SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1)`;

	if (removed.length) {
		const j = JSON.stringify(removed);
		stmts.push(
			env.DB.prepare(
				`UPDATE community_move_counts SET owners = owners - 1
				 WHERE color = ?2 AND (fen_hash, san) IN (
				   SELECT m.fen_hash, m.san FROM community_moves m
				   WHERE m.color = ?2 AND m.owner_id = ?3 AND m.refs = 1 AND (m.fen_hash, m.san) IN (${pairsSql}))`
			).bind(j, color, owner),
			env.DB.prepare(
				`UPDATE community_moves SET refs = refs - 1
				 WHERE color = ?2 AND owner_id = ?3 AND (fen_hash, san) IN (${pairsSql})`
			).bind(j, color, owner),
			env.DB.prepare(
				`DELETE FROM community_moves
				 WHERE refs <= 0 AND color = ?2 AND owner_id = ?3 AND (fen_hash, san) IN (${pairsSql})`
			).bind(j, color, owner),
			env.DB.prepare(
				`DELETE FROM community_move_counts
				 WHERE owners <= 0 AND color = ?2 AND (fen_hash, san) IN (${pairsSql})`
			).bind(j, color)
		);
	}
	if (added.length) {
		const j = JSON.stringify(added);
		stmts.push(
			env.DB.prepare(
				`INSERT INTO community_move_counts (fen_hash, san, color, owners)
				 SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), ?2, 1 FROM json_each(?1) j
				 WHERE NOT EXISTS (SELECT 1 FROM community_moves m
				   WHERE m.fen_hash = json_extract(j.value, '$[0]') AND m.san = json_extract(j.value, '$[1]')
				     AND m.color = ?2 AND m.owner_id = ?3)
				 ON CONFLICT (fen_hash, san, color) DO UPDATE SET owners = owners + 1`
			).bind(j, color, owner),
			env.DB.prepare(
				`INSERT INTO community_moves (fen_hash, san, color, owner_id, refs)
				 SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), ?2, ?3, 1 FROM json_each(?1) j
				 WHERE true
				 ON CONFLICT (fen_hash, san, color, owner_id) DO UPDATE SET refs = refs + 1`
			).bind(j, color, owner)
		);
	}
	await env.DB.batch(stmts);
}

function purgeStatements(env: CommunityEnv, id: string): D1PreparedStatement[] {
	return [
		env.DB.prepare(`DELETE FROM publication_versions WHERE publication_id = ?1`).bind(id),
		env.DB.prepare(`DELETE FROM publication_imports WHERE publication_id = ?1`).bind(id),
		env.DB.prepare(`DELETE FROM reports WHERE publication_id = ?1`).bind(id),
		env.DB.prepare(`DELETE FROM publication_fts WHERE publication_id = ?1`).bind(id),
		env.DB.prepare(`DELETE FROM publications WHERE id = ?1`).bind(id)
	];
}

// --- Helpers ------------------------------------------------------------------

async function loadPub(env: CommunityEnv, id: string): Promise<PubRow | null> {
	if (!/^[A-Za-z0-9]{6,16}$/.test(id)) return null;
	return env.DB.prepare(
		`SELECT p.*, u.username FROM publications p JOIN users u ON u.user_id = p.owner_id WHERE p.id = ?1`
	)
		.bind(id)
		.first<PubRow>();
}

async function loadTree(env: CommunityEnv, id: string, version: number): Promise<CommunityTreeV1 | null> {
	const row = await env.DB.prepare(
		`SELECT tree FROM publication_versions WHERE publication_id = ?1 AND version = ?2`
	)
		.bind(id, version)
		.first<{ tree: string }>();
	return row ? (JSON.parse(row.tree) as CommunityTreeV1) : null;
}

function summary(p: PubRow): PublicationSummary {
	return {
		id: p.id,
		title: p.title,
		description: p.description,
		tags: JSON.parse(p.tags) as string[],
		color: p.color,
		rootFenKey: p.root_fen_key,
		openings: JSON.parse(p.openings) as Array<[string, string]>,
		visibility: p.visibility,
		author: p.show_author ? (p.username ?? null) : null,
		status: p.status,
		version: p.current_version,
		positionCount: p.position_count,
		moveCount: p.move_count,
		ideaCount: p.idea_count,
		importCount: p.import_count,
		forkedFrom: p.forked_from,
		createdAt: p.created_at,
		updatedAt: p.updated_at
	};
}

async function requireUserId(req: Request, resolveUser: ResolveUser): Promise<string> {
	const userId = await resolveUser(req);
	if (!userId) throw new HttpError(401, 'sign in with Lichess to do this');
	return userId;
}

/** Words of a search box, each as an FTS5 prefix term (AND-ed). */
export function ftsQuery(q: string): string {
	const words = q.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
	return words
		.slice(0, 8)
		.map((w) => `"${w}"*`)
		.join(' ');
}

function newId(): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
	const bytes = crypto.getRandomValues(new Uint8Array(10));
	return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

async function sha256(text: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers }
	});
}
