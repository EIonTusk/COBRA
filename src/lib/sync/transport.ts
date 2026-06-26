/**
 * Backend-agnostic sync transport.
 *
 * A transport is "where blobs are parked" — the thing that copies a
 * repertoire/global blob between devices. IndexedDB is always the source of
 * truth (see `bundle.ts`); a transport is purely a pipe. Today the only
 * implementation is `LichessStudyTransport` (blobs ride inside Lichess study
 * chapters); a hosted-DB transport will implement the same interface so the
 * orchestrator (`syncStore.svelte.ts`) never has to care which backend is
 * active.
 *
 * The interface is deliberately scoped to exactly what the orchestrator
 * needs — connection setup, per-scope and bulk pull, push-with-conflict, and
 * deletion — so that adding a backend is "implement this interface", not
 * "rewrite sync".
 */

import type { BlobMeta, ParsedBlob, SyncKind } from './pgnWrap';
import type { PushResult } from './lichessSync';

export type { BlobMeta, ParsedBlob, SyncKind, PushResult };

/**
 * One blob recovered by a bulk `pullAll`, tagged with the remote slot it came
 * from. `scopeName` is the grouping key the orchestrator dedups on when the
 * same logical scope occupies more than one remote slot (e.g. duplicate
 * Lichess chapters that share an `[Event]` name); `scopeId` is the stable
 * per-slot identifier (Lichess chapter id; DB row key).
 */
export interface PulledScope extends ParsedBlob {
	scopeId: string;
	scopeName: string;
}

export interface SyncTransport {
	/**
	 * Locate (or create) the remote store and report whether it already holds
	 * data — drives the first-run "push local vs pull remote" decision.
	 */
	connect(): Promise<{ remoteHasData: boolean }>;

	/** Pull a single scope's latest blob, or null if the remote has none. */
	pull(kind: SyncKind, repId: string | undefined): Promise<ParsedBlob | null>;

	/** Pull every scope in one round trip, for the bulk pull+merge path. */
	pullAll(): Promise<PulledScope[]>;

	/**
	 * Push a scope, atomically replacing the prior blob. Throws
	 * `SyncConflictError` when the remote revision is newer than
	 * `expectedPriorRevision`.
	 */
	push(blob: string, meta: BlobMeta, expectedPriorRevision: number | null): Promise<PushResult>;

	/** Remove a repertoire's scope(s) from the remote (deletion propagation). */
	deleteRep(repId: string): Promise<void>;

	/** Remove every COBRA-managed scope from the remote (disconnect + forget). */
	purgeAll(): Promise<void>;
}
