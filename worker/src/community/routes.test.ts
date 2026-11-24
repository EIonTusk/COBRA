import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_HIDE_REPORTS, COMMUNITY_RATE, communityCron, handleCommunity, type CommunityEnv } from './routes';
import { positionHash } from './hash';
import { testD1, type TestD1 } from './testing/d1';
import { keyAfter, treeFromLines } from './testing/trees';
import type { CommunityTreeV1, PublicationDetail, PublicationSummary } from './types';

const BASE = 'https://worker.test';
let d1: TestD1;
let env: CommunityEnv;

beforeEach(() => {
	const t = testD1();
	d1 = t.d1;
	env = { DB: t.DB, ADMIN_USER_IDS: 'boss' };
	for (const u of ['alice', 'bob', 'carol', 'dave', 'erin', 'boss']) {
		d1.rows(
			`INSERT INTO users (user_id, username, created_at, last_seen) VALUES (?1, ?2, 0, 0) RETURNING user_id`,
			u,
			u[0].toUpperCase() + u.slice(1)
		);
	}
});

afterEach(() => vi.useRealTimers());

const resolveUser = async (req: Request) => req.headers.get('X-Test-User');

async function call(
	method: string,
	path: string,
	opts: { user?: string; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (opts.user) headers['X-Test-User'] = opts.user;
	const req = new Request(`${BASE}${path}`, {
		method,
		headers,
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
	});
	const res = await handleCommunity(req, env, new URL(req.url), resolveUser);
	if (!res) throw new Error('not a community route');
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const meta = (over: Record<string, unknown> = {}) => ({
	title: 'Italian for White',
	description: 'Quiet Giuoco Piano',
	tags: ['Italian', 'e4'],
	visibility: 'public',
	showAuthor: true,
	...over
});

const italian = () => treeFromLines('white', ['e4 e5 Nf3 Nc6 Bc4 Bc5 c3', 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3']);

async function publish(user: string, tree: CommunityTreeV1 = italian(), m = meta()) {
	const r = await call('POST', '/community/publications', { user, body: { meta: m, tree } });
	return r;
}

function counts(fenAfter: string, color = 'white'): Record<string, number> {
	const rows = d1.rows<{ san: string; owners: number }>(
		`SELECT san, owners FROM community_move_counts WHERE fen_hash = ?1 AND color = ?2`,
		positionHash(keyAfter(fenAfter)),
		color
	);
	return Object.fromEntries(rows.map((r) => [r.san, r.owners]));
}

async function list(q = '', extra = ''): Promise<PublicationSummary[]> {
	const r = await call('GET', `/community/publications?q=${encodeURIComponent(q)}${extra}`);
	return r.body.publications as PublicationSummary[];
}

describe('publish and browse', () => {
	it('publishes, lists, searches by opening name and returns the tree', async () => {
		const r = await publish('alice');
		expect(r.status).toBe(201);
		const id = r.body.id as string;

		const all = await list();
		expect(all.map((p) => p.id)).toEqual([id]);
		expect(all[0].author).toBe('Alice');
		expect(all[0].positionCount).toBe(10);

		// The tree reaches the Giuoco Piano, though it starts from 1.e4.
		expect((await list('giuoco')).map((p) => p.id)).toEqual([id]);
		expect((await list('najdorf')).length).toBe(0);
		expect((await list('', '&color=black')).length).toBe(0);

		const detail = (await call('GET', `/community/publications/${id}`)).body as unknown as PublicationDetail;
		expect(detail.tree.nodes.length).toBe(10);
		expect(detail.version).toBe(1);
	});

	it('requires sign-in to publish', async () => {
		const r = await call('POST', '/community/publications', { body: { meta: meta(), tree: italian() } });
		expect(r.status).toBe(401);
	});

	it('rejects a tree carrying training data, with nothing stored', async () => {
		const t = italian() as unknown as { nodes: Array<Record<string, unknown>> };
		t.nodes[1].fsrs = { stability: 3.2 };
		const r = await publish('alice', t as unknown as CommunityTreeV1);
		expect(r.status).toBe(400);
		expect(String(r.body.error)).toMatch(/unexpected field "fsrs"/);
		expect(d1.rows(`SELECT * FROM publications`).length).toBe(0);
		expect(d1.rows(`SELECT * FROM publication_versions`).length).toBe(0);
	});

	it('rejects unknown metadata fields', async () => {
		const r = await publish('alice', italian(), meta({ progress: 0.8 }));
		expect(r.status).toBe(400);
	});

	it('hides the author when they choose anonymous, but moderators still see it', async () => {
		const { body } = await publish('alice', italian(), meta({ showAuthor: false }));
		const id = body.id as string;
		expect((await list())[0].author).toBeNull();
		expect(((await call('GET', `/community/publications/${id}`)).body as { author: unknown }).author).toBeNull();
		await call('POST', `/community/publications/${id}/report`, { user: 'bob', body: { reason: 'spam' } });
		const admin = await call('GET', '/community/admin/reports', { user: 'boss' });
		const items = admin.body.items as Array<{ publication: PublicationSummary }>;
		expect(items[0].publication.author).toBe('Alice');
	});

	it('keeps unlisted publications out of listings and the position index', async () => {
		const { body } = await publish('alice', italian(), meta({ visibility: 'unlisted' }));
		expect(await list()).toEqual([]);
		expect(counts('')).toEqual({});
		expect((await call('GET', `/community/publications/${body.id}`)).status).toBe(200);
	});
});

describe('position index', () => {
	it('counts distinct people, not publications', async () => {
		await publish('alice');
		await publish('bob');
		expect(counts('')).toEqual({ e4: 2 });
		expect(counts('e4 e5 Nf3 Nc6 Bc4')).toEqual({ Bc5: 2, Nf6: 2 });

		// A second tree by the same person adds no extra count for shared moves.
		await publish('alice', treeFromLines('white', ['e4 e5 Nf3 Nc6 Bb5 a6 Ba4']));
		expect(counts('')).toEqual({ e4: 2 });
		expect(counts('e4 e5 Nf3 Nc6')).toEqual({ Bc4: 2, Bb5: 1 });
	});

	it('serves community moves for a position', async () => {
		await publish('alice');
		const r = await call('GET', `/community/positions/moves?fen=${encodeURIComponent(keyAfter('e4 e5 Nf3 Nc6 Bc4'))}&color=white`);
		expect(r.body.moves).toEqual([
			{ san: 'Bc5', owners: 1 },
			{ san: 'Nf6', owners: 1 }
		]);
	});

	it('applies only the difference when a new version is published', async () => {
		const { body } = await publish('alice');
		await publish('bob');
		const id = body.id as string;
		const v2 = treeFromLines('white', ['e4 e5 Nf3 Nc6 Bc4 Bc5 c3', 'e4 c5 Nf3']);
		const r = await call('PUT', `/community/publications/${id}`, {
			user: 'alice',
			body: { meta: meta({ changelog: 'Sicilian added, two knights dropped' }), tree: v2 }
		});
		expect(r.body.version).toBe(2);
		expect(counts('e4 e5 Nf3 Nc6 Bc4')).toEqual({ Bc5: 2, Nf6: 1 });
		expect(counts('e4')).toEqual({ e5: 2, c5: 1 });

		// The old version stays readable.
		const old = await call('GET', `/community/publications/${id}?version=1`);
		expect((old.body as unknown as PublicationDetail).tree.nodes.length).toBe(10);
	});

	it('does not create a version when only metadata changes', async () => {
		const { body } = await publish('alice');
		const r = await call('PUT', `/community/publications/${body.id}`, {
			user: 'alice',
			body: { meta: meta({ title: 'Renamed' }), tree: italian() }
		});
		expect(r.body.version).toBe(1);
		expect((await list('renamed')).length).toBe(1);
	});

	it('switching to unlisted removes the contribution, switching back restores it', async () => {
		const { body } = await publish('alice');
		await call('PUT', `/community/publications/${body.id}`, {
			user: 'alice',
			body: { meta: meta({ visibility: 'unlisted' }) }
		});
		expect(counts('')).toEqual({});
		await call('PUT', `/community/publications/${body.id}`, { user: 'alice', body: { meta: meta() } });
		expect(counts('')).toEqual({ e4: 1 });
	});
});

describe('owner controls', () => {
	it('only the owner can update or unpublish', async () => {
		const { body } = await publish('alice');
		expect((await call('PUT', `/community/publications/${body.id}`, { user: 'bob', body: { meta: meta() } })).status).toBe(403);
		expect((await call('DELETE', `/community/publications/${body.id}`, { user: 'bob' })).status).toBe(403);
	});

	it('unpublishing removes it from listings, the index and search at once', async () => {
		const { body } = await publish('alice');
		expect((await call('DELETE', `/community/publications/${body.id}`, { user: 'alice' })).status).toBe(200);
		expect(await list()).toEqual([]);
		expect(counts('')).toEqual({});
		expect((await call('GET', `/community/publications/${body.id}`)).status).toBe(404);
		expect(d1.rows(`SELECT * FROM publication_fts`).length).toBe(0);
	});

	it('me lists my publications, and delete-me removes all my data', async () => {
		await publish('alice', italian(), meta({ showAuthor: false }));
		const me = await call('GET', '/community/me', { user: 'alice' });
		expect(me.body.username).toBe('Alice');
		expect(me.body.isAdmin).toBe(false);
		const pubs = me.body.publications as PublicationSummary[];
		expect(pubs.length).toBe(1);
		// The owner sees their own name even on an anonymous publication.
		expect(pubs[0].author).toBe('Alice');

		await call('DELETE', '/community/me', { user: 'alice' });
		expect(d1.rows(`SELECT * FROM publications`).length).toBe(0);
		expect(d1.rows(`SELECT * FROM publication_versions`).length).toBe(0);
		expect(d1.rows(`SELECT * FROM community_moves`).length).toBe(0);
		expect(d1.rows(`SELECT * FROM community_move_counts`).length).toBe(0);
	});
});

describe('abuse limits', () => {
	it('rejects the same tree twice from one person', async () => {
		const first = await publish('alice');
		const again = await publish('alice');
		expect(again.status).toBe(409);
		expect(again.body.id).toBe(first.body.id);
	});

	it(`allows ${COMMUNITY_RATE.newPerDay} new publications a day`, async () => {
		const lines = ['e4 e5', 'e4 c5', 'e4 e6', 'e4 c6', 'e4 d5', 'e4 Nf6'];
		for (let i = 0; i < COMMUNITY_RATE.newPerDay; i++) {
			expect((await publish('alice', treeFromLines('white', [lines[i]]))).status).toBe(201);
		}
		expect((await publish('alice', treeFromLines('white', [lines[5]]))).status).toBe(429);
	});

	it('counts imports once per signed-in person, never the owner', async () => {
		const { body } = await publish('alice');
		const id = body.id as string;
		await call('POST', `/community/publications/${id}/import`, { user: 'bob' });
		await call('POST', `/community/publications/${id}/import`, { user: 'bob' });
		await call('POST', `/community/publications/${id}/import`, { user: 'alice' });
		await call('POST', `/community/publications/${id}/import`);
		await call('POST', `/community/publications/${id}/import`, { user: 'carol' });
		expect((await list())[0].importCount).toBe(2);
	});
});

describe('moderation', () => {
	it(`auto-hides after ${AUTO_HIDE_REPORTS} reporters and the admin can restore`, async () => {
		const { body } = await publish('alice');
		const id = body.id as string;
		expect((await call('POST', `/community/publications/${id}/report`, { user: 'alice', body: { reason: 'spam' } })).status).toBe(400);
		for (const u of ['bob', 'carol']) {
			await call('POST', `/community/publications/${id}/report`, { user: u, body: { reason: 'spam' } });
		}
		// The same person reporting twice still counts once.
		await call('POST', `/community/publications/${id}/report`, { user: 'carol', body: { reason: 'offensive' } });
		expect((await list()).length).toBe(1);
		const third = await call('POST', `/community/publications/${id}/report`, { user: 'dave', body: { reason: 'offensive' } });
		expect(third.body.hidden).toBe(true);

		expect(await list()).toEqual([]);
		expect(counts('')).toEqual({});
		expect((await call('GET', `/community/publications/${id}`)).status).toBe(404);
		expect((await call('GET', `/community/publications/${id}`, { user: 'alice' })).status).toBe(200);
		expect((await call('GET', `/community/publications/${id}`, { user: 'boss' })).status).toBe(200);

		const reports = await call('GET', '/community/admin/reports', { user: 'boss' });
		expect((reports.body.items as Array<{ openReports: number }>)[0].openReports).toBe(3);

		await call('POST', `/community/admin/publications/${id}/status`, { user: 'boss', body: { status: 'active' } });
		expect((await list()).length).toBe(1);
		expect(counts('')).toEqual({ e4: 1 });

		// Reports from before the review don't count again.
		await call('POST', `/community/publications/${id}/report`, { user: 'erin', body: { reason: 'spam' } });
		expect((await list()).length).toBe(1);
	});

	it('admin routes are for moderators only', async () => {
		expect((await call('GET', '/community/admin/reports', { user: 'alice' })).status).toBe(403);
		expect((await call('GET', '/community/admin/reports')).status).toBe(401);
	});
});

describe('cron', () => {
	it('purges publications removed more than 30 days ago', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const { body } = await publish('alice');
		await call('DELETE', `/community/publications/${body.id}`, { user: 'alice' });
		const noFetch = vi.fn();
		await communityCron(env, noFetch as unknown as typeof fetch);
		expect(d1.rows(`SELECT * FROM publications`).length).toBe(1);
		vi.setSystemTime(new Date('2026-02-15T00:00:00Z'));
		await communityCron(env, noFetch as unknown as typeof fetch);
		expect(d1.rows(`SELECT * FROM publications`).length).toBe(0);
		expect(d1.rows(`SELECT * FROM publication_versions`).length).toBe(0);
	});

	it('hides publications of closed Lichess accounts', async () => {
		await publish('alice');
		await publish('bob');
		const fetchImpl = vi.fn(async () =>
			Response.json([{ id: 'alice', disabled: true }, { id: 'bob' }])
		);
		await communityCron(env, fetchImpl as unknown as typeof fetch);
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect((await list()).map((p) => p.author)).toEqual(['Bob']);
		expect(counts('')).toEqual({ e4: 1 });
	});
});

/**
 * Randomised soak: after any sequence of publishes, updates, visibility
 * changes, unpublishes and moderation, the position index must equal a
 * from-scratch recount over the listed publications' current trees.
 */
describe('position index invariant (randomised)', () => {
	const pool = [
		'e4 e5 Nf3 Nc6 Bc4',
		'e4 e5 Nf3 Nc6 Bb5',
		'e4 c5 Nf3 d6 d4',
		'e4 c5 Nc3',
		'd4 d5 c4 e6 Nc3',
		'd4 Nf6 c4 g6',
		'e4 e6 d4 d5',
		'Nf3 d5 g3'
	];
	function rng(seed: number) {
		return () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
	}
	function randomTree(r: () => number): CommunityTreeV1 {
		const picks = pool.filter(() => r() < 0.4);
		return treeFromLines('white', picks.length ? picks : [pool[Math.floor(r() * pool.length)]]);
	}
	function expected(): Map<string, number> {
		const pubs = d1.rows<{ id: string; owner_id: string; current_version: number }>(
			`SELECT id, owner_id, current_version FROM publications WHERE status = 'active' AND visibility = 'public'`
		);
		const owners = new Map<string, Set<string>>();
		for (const p of pubs) {
			const [{ tree }] = d1.rows<{ tree: string }>(
				`SELECT tree FROM publication_versions WHERE publication_id = ?1 AND version = ?2`,
				p.id,
				p.current_version
			);
			for (const n of (JSON.parse(tree) as CommunityTreeV1).nodes) {
				for (const e of n.children) {
					const k = `${positionHash(n.fenKey)}|${e.san}`;
					if (!owners.has(k)) owners.set(k, new Set());
					owners.get(k)!.add(p.owner_id);
				}
			}
		}
		return new Map([...owners].map(([k, s]) => [k, s.size]));
	}
	function actual(): Map<string, number> {
		const rows = d1.rows<{ fen_hash: number; san: string; owners: number }>(
			`SELECT fen_hash, san, owners FROM community_move_counts`
		);
		return new Map(rows.map((r) => [`${r.fen_hash}|${r.san}`, r.owners]));
	}

	const seeds = Number(process.env.COBRA_SIM_SEEDS ?? 6);
	for (let seed = 1; seed <= seeds; seed++) {
		it(`seed ${seed}`, async () => {
			const r = rng(seed);
			const users = ['alice', 'bob', 'carol'];
			const ids: Array<{ id: string; owner: string }> = [];
			for (let step = 0; step < 40; step++) {
				const roll = r();
				const owner = users[Math.floor(r() * users.length)];
				if (roll < 0.35 || ids.length === 0) {
					const res = await publish(owner, randomTree(r), meta({ visibility: r() < 0.8 ? 'public' : 'unlisted' }));
					if (res.status === 201) ids.push({ id: res.body.id as string, owner });
				} else {
					const pick = ids[Math.floor(r() * ids.length)];
					if (roll < 0.6) {
						await call('PUT', `/community/publications/${pick.id}`, {
							user: pick.owner,
							body: { meta: meta({ visibility: r() < 0.8 ? 'public' : 'unlisted' }), tree: randomTree(r) }
						});
					} else if (roll < 0.7) {
						await call('DELETE', `/community/publications/${pick.id}`, { user: pick.owner });
					} else {
						const status = ['active', 'hidden', 'removed'][Math.floor(r() * 3)];
						await call('POST', `/community/admin/publications/${pick.id}/status`, {
							user: 'boss',
							body: { status }
						});
					}
				}
				// Lift the daily caps so the soak keeps going.
				d1.rows(`UPDATE publications SET created_at = 0 RETURNING 1`);
				d1.rows(`UPDATE publication_versions SET created_at = 0 RETURNING 1`);
				expect(actual()).toEqual(expected());
			}
		});
	}
});
