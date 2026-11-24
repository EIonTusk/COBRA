/**
 * The slice of Cloudflare's D1 API the community routes use. Declared here
 * (rather than relying on the @cloudflare/workers-types globals) so the
 * routes also type-check inside the app's toolchain, where the browser
 * end-to-end test runs them in-process. The real `D1Database` satisfies it.
 */
export interface Stmt {
	bind(...values: unknown[]): Stmt;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta: { changes?: number } }>;
}

export interface Db {
	prepare(sql: string): Stmt;
	batch(statements: Stmt[]): Promise<unknown[]>;
}
