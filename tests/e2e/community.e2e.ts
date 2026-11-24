import { expect, test, type Page, type Route } from '@playwright/test';
import { handleCommunity, type CommunityEnv } from '../../worker/src/community/routes';
import { TestD1 } from '../../worker/src/community/testing/d1';
import type { Db } from '../../worker/src/community/db';

/**
 * Community openings, end to end: publish from the repertoire page, browse
 * and search the Community page, preview a publication and import a copy.
 *
 * The Worker is not mocked: requests to its origin are answered in-process
 * by the real community routes over an in-memory D1 loaded with the real
 * schema. Only Lichess sign-in is faked (token `lip_<user>` → user id).
 */

test.use({ viewport: { width: 1280, height: 1000 } });

const WORKER = 'https://worker.test';
const MARK = 'PRIVATE_MARKER_e2e';

const PGN = `[Event "Italian"]
[White "?"]
[Black "?"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 { Aim for d4 later } 3... Bc5 (3... Nf6 4. d3) 4. c3 *
`;

let d1: TestD1;
let env: CommunityEnv;
let publishBodies: string[];

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type'
};

async function workerRoute(route: Route) {
	const r = route.request();
	if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
	const url = new URL(r.url());
	const auth = r.headers()['authorization'] ?? '';
	if (url.pathname === '/auth/session') {
		const user = /^Bearer lip_(\w+)$/.exec(auth)?.[1];
		if (!user) return route.fulfill({ status: 401, headers: CORS, body: '{}' });
		d1.rows(
			`INSERT INTO users (user_id, username, created_at, last_seen) VALUES (?1, ?2, 0, 0)
			 ON CONFLICT DO NOTHING RETURNING 1`,
			user,
			user[0].toUpperCase() + user.slice(1)
		);
		return route.fulfill({
			headers: { ...CORS, 'Content-Type': 'application/json' },
			body: JSON.stringify({ token: `jwt-${user}`, userId: user })
		});
	}
	const body = r.postData();
	if (r.method() !== 'GET' && body && url.pathname.startsWith('/community/publications')) {
		publishBodies.push(body);
	}
	const req = new Request(r.url(), {
		method: r.method(),
		headers: r.headers(),
		body: r.method() === 'GET' || r.method() === 'HEAD' ? undefined : (body ?? undefined)
	});
	const res = await handleCommunity(req, env, url, async (q) => {
		const m = /^Bearer jwt-(\w+)$/.exec(q.headers.get('Authorization') ?? '');
		return m ? m[1] : null;
	});
	if (!res) return route.fulfill({ status: 404, headers: CORS, body: '{}' });
	return route.fulfill({
		status: res.status,
		headers: { ...CORS, 'Content-Type': 'application/json' },
		body: await res.text()
	});
}

async function signIn(page: Page, user: string) {
	await page.goto('/settings');
	await page.getByLabel('Or paste a personal API token').fill(`lip_${user}`);
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByText('Saved', { exact: true })).toBeVisible();
	// Point the app at the in-process Worker.
	await page.evaluate(async (worker) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const open = indexedDB.open('openingtrainer');
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
		const tx = db.transaction('settings', 'readwrite');
		const store = tx.objectStore('settings');
		const row = await new Promise<Record<string, unknown>>((resolve) => {
			const g = store.get('root');
			g.onsuccess = () => resolve(g.result);
		});
		store.put({ ...row, sync: { ...((row.sync as object) ?? {}), cloudflareUrl: worker } });
		await new Promise((resolve) => (tx.oncomplete = resolve));
		db.close();
	}, WORKER);
}

async function importPgn(page: Page): Promise<string> {
	await page.goto('/import');
	await page.getByLabel('Title').fill('Italian');
	await page.getByLabel('PGN text').fill(PGN);
	await page.getByRole('button', { name: /^import$/i }).click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	return new URL(page.url()).pathname.match(/\/repertoire\/([a-f0-9-]+)/)![1];
}

/** Put training progress and a mistake (with a marker) into the local DB. */
async function seedPrivateData(page: Page, repId: string) {
	await page.evaluate(
		async ({ repId, mark }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const open = indexedDB.open('openingtrainer');
				open.onsuccess = () => resolve(open.result);
				open.onerror = () => reject(open.error);
			});
			const tx = db.transaction(['move_progress', 'mistakes'], 'readwrite');
			const mp = tx.objectStore('move_progress');
			const all = await new Promise<Array<Record<string, unknown>>>((resolve) => {
				const g = mp.getAll();
				g.onsuccess = () => resolve(g.result);
			});
			for (const p of all) mp.put({ ...p, lastReview: 1_700_000_000_000, lastRating: 3 });
			tx.objectStore('mistakes').put({ id: 'e2e-mistake', repertoireId: repId, note: mark });
			await new Promise((resolve) => (tx.oncomplete = resolve));
			db.close();
		},
		{ repId, mark: MARK }
	);
}

async function openPublishDialog(page: Page, repId: string) {
	await page.goto(`/repertoire/${repId}`);
	await page.getByTitle('Settings').click();
	await page.getByTestId('publish-community').click();
	await expect(page.getByTestId('publish-privacy-note')).toContainText(
		'training progress, mistakes and shelved lines never leave this device'
	);
}

test.beforeEach(async ({ page }) => {
	d1 = new TestD1();
	env = { DB: d1 as unknown as Db };
	publishBodies = [];
	await page.route(`${WORKER}/**`, workerRoute);
});

test('publish, find, preview and import a community opening', async ({ page }) => {
	await signIn(page, 'alice');
	const repId = await importPgn(page);
	await seedPrivateData(page, repId);

	await openPublishDialog(page, repId);
	await expect(page.getByTestId('publish-summary')).toContainText(
		'10 positions · 9 moves · 1 comment'
	);
	await page.getByLabel('Description').fill('A quiet Giuoco Piano');
	await page.getByTestId('publish-submit').click();
	await expect(page.getByTestId('publish-link')).toContainText('Published version 1');

	// What went over the wire: moves and the comment, nothing private.
	expect(publishBodies).toHaveLength(1);
	const sent = publishBodies[0];
	expect(sent).toContain('Aim for d4 later');
	for (const word of ['fsrs', 'dueAt', 'lastReview', 'lastRating', 'repertoireId', MARK]) {
		expect(sent).not.toContain(word);
	}

	// The repertoire's menu now says it's published.
	await page.keyboard.press('Escape');
	await page.getByTitle('Settings').click();
	await expect(page.getByTestId('publish-community')).toHaveText(/published v1/);

	// Browse and search.
	await page.goto('/community');
	await expect(page.getByTestId('community-card')).toHaveCount(1);
	await expect(page.getByTestId('community-card')).toContainText('Italian');
	await expect(page.getByTestId('community-card')).toContainText('Alice');
	await page.getByTestId('community-search').fill('najdorf');
	await expect(page.getByTestId('community-empty')).toBeVisible();
	await page.getByTestId('community-search').fill('giuoco');
	await expect(page.getByTestId('community-card')).toHaveCount(1);

	// Preview and import.
	await page.getByTestId('community-card').click();
	await expect(page.getByTestId('community-title')).toHaveText('Italian');
	await expect(page.getByTestId('community-tree')).toContainText('Bc4');
	await page.getByTestId('community-tree').getByText('Bc4').first().click();
	await expect(page.getByTestId('community-comment')).toHaveText('Aim for d4 later');
	await page.getByTestId('community-import').click();
	await page.waitForURL(/\/repertoire\/[a-f0-9-]+\/?$/);
	expect(new URL(page.url()).pathname).not.toContain(repId);
});

test('anonymous publishing and unpublishing', async ({ page }) => {
	await signIn(page, 'bob');
	const repId = await importPgn(page);

	await openPublishDialog(page, repId);
	await page.getByTestId('publish-show-author').uncheck();
	await page.getByTestId('publish-include-comments').uncheck();
	await expect(page.getByTestId('publish-summary')).not.toContainText('comments');
	await page.getByTestId('publish-submit').click();
	await expect(page.getByTestId('publish-link')).toBeVisible();
	expect(publishBodies[0]).not.toContain('Aim for d4 later');

	await page.goto('/community');
	await expect(page.getByTestId('community-card')).toContainText('anonymous');
	await page.getByTestId('community-card').click();
	await expect(page.getByTestId('community-author')).toHaveText('anonymous');

	// Unpublish from the repertoire page.
	await openPublishDialog(page, repId);
	await page.getByRole('button', { name: 'Unpublish' }).click();
	await page.getByRole('button', { name: 'Unpublish' }).last().click();
	await expect(page.getByTestId('publish-link')).toHaveCount(0);

	await page.goto('/community');
	await expect(page.getByTestId('community-empty')).toBeVisible();
});
