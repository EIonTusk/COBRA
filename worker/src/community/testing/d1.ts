/**
 * Minimal in-memory D1 for tests, backed by node:sqlite. Implements the slice
 * of the D1 API the Worker uses: prepare/bind/first/all/run, batch (in one
 * transaction, like D1) and exec. Loads the real worker/schema.sql so tests
 * run against the production schema.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db';

type Value = string | number | null;

class Stmt {
	constructor(
		readonly db: DatabaseSync,
		readonly sql: string,
		readonly args: Value[] = []
	) {}

	bind(...args: unknown[]): Stmt {
		const vals = args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));
		return new Stmt(this.db, this.sql, vals as Value[]);
	}

	async first<T>(col?: string): Promise<T | null> {
		const row = this.db.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined;
		if (!row) return null;
		const plain = { ...row };
		return (col ? plain[col] : plain) as T;
	}

	async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
		const rows = this.db.prepare(this.sql).all(...this.args) as Record<string, unknown>[];
		return { results: rows.map((r) => ({ ...r }) as T), success: true, meta: {} };
	}

	runSync(): { success: true; meta: { changes: number } } {
		const res = this.db.prepare(this.sql).run(...this.args);
		return { success: true, meta: { changes: Number(res.changes) } };
	}

	async run() {
		return this.runSync();
	}
}

export class TestD1 {
	readonly db = new DatabaseSync(':memory:');

	constructor(schemaPath = new URL('../../../schema.sql', import.meta.url)) {
		this.db.exec(readFileSync(schemaPath, 'utf8'));
	}

	prepare(sql: string): Stmt {
		return new Stmt(this.db, sql);
	}

	async batch(stmts: Stmt[]) {
		this.db.exec('BEGIN');
		try {
			const out = stmts.map((s) => s.runSync());
			this.db.exec('COMMIT');
			return out;
		} catch (e) {
			this.db.exec('ROLLBACK');
			throw e;
		}
	}

	async exec(sql: string) {
		this.db.exec(sql);
		return { count: 0, duration: 0 };
	}

	/** Test helper: run a query synchronously. */
	rows<T = Record<string, unknown>>(sql: string, ...args: Value[]): T[] {
		return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({ ...r }) as T);
	}
}

/** The test D1 typed as the binding the community routes take. */
export function testD1(): { d1: TestD1; DB: Db } {
	const d1 = new TestD1();
	return { d1, DB: d1 as unknown as Db };
}
