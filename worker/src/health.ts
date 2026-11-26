/**
 * GET /health — setup check for operators and the app.
 *
 * Reports whether the Worker is ready to serve sync: the D1 binding answers,
 * every table in schema.sql exists (i.e. `npm run schema` was applied), and
 * the JWT_SECRET secret is set. Reveals no data and no secret values, so it
 * needs no auth. 200 when ready, 503 otherwise, with what is missing.
 */
import type { Db } from './community/db';

/** Every table schema.sql creates. health.test.ts keeps this in step with the file. */
export const REQUIRED_TABLES = [
	'users',
	'blobs',
	'publications',
	'publication_versions',
	'community_moves',
	'community_move_counts',
	'publication_imports',
	'reports',
	'community_authors'
] as const;

export interface HealthEnv {
	DB?: Db;
	JWT_SECRET?: string;
}

export interface HealthReport {
	ok: boolean;
	database: boolean;
	missingTables: string[];
	jwtSecret: boolean;
}

export async function checkHealth(env: HealthEnv): Promise<HealthReport> {
	const jwtSecret = typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
	let database = false;
	let missingTables: string[] = [...REQUIRED_TABLES];
	if (env.DB) {
		try {
			const { results } = await env.DB.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table'`
			).all<{ name: string }>();
			const have = new Set((results ?? []).map((r) => r.name));
			database = true;
			missingTables = REQUIRED_TABLES.filter((t) => !have.has(t));
		} catch {
			database = false;
		}
	}
	return { ok: database && missingTables.length === 0 && jwtSecret, database, missingTables, jwtSecret };
}

export async function handleHealth(env: HealthEnv): Promise<Response> {
	const report = await checkHealth(env);
	return new Response(JSON.stringify(report), {
		status: report.ok ? 200 : 503,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
	});
}
