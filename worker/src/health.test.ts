import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkHealth, handleHealth, REQUIRED_TABLES } from './health';
import { testD1 } from './community/testing/d1';

describe('GET /health', () => {
	it('lists exactly the tables schema.sql creates', () => {
		const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
		const created = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
		expect([...REQUIRED_TABLES].sort()).toEqual(created.sort());
	});

	it('is ready when the schema is applied and the JWT secret is set', async () => {
		const { DB } = testD1();
		const res = await handleHealth({ DB, JWT_SECRET: 's3cret' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			database: true,
			missingTables: [],
			jwtSecret: true
		});
	});

	it('names missing tables and a missing JWT secret, without revealing values', async () => {
		const { d1, DB } = testD1();
		await d1.exec('DROP TABLE users; DROP TABLE blobs;');
		const res = await handleHealth({ DB, JWT_SECRET: '' });
		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({
			ok: false,
			database: true,
			missingTables: ['users', 'blobs'],
			jwtSecret: false
		});
	});

	it('reports an unreachable database', async () => {
		const DB = {
			prepare: () => ({
				all: async () => {
					throw new Error('D1 binding missing');
				}
			})
		} as never;
		const report = await checkHealth({ DB, JWT_SECRET: 'x' });
		expect(report).toMatchObject({ ok: false, database: false, jwtSecret: true });
	});
});
