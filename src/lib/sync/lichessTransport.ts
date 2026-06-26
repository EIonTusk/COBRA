/**
 * `SyncTransport` backed by a Lichess study. Blobs ride inside study chapters
 * as PGN move-comments (see `pgnWrap.ts`); the heavy lifting lives in
 * `lichessSync.ts` and this class is a thin adapter that holds the
 * `{ token, studyId }` connection context so the orchestrator doesn't have to
 * thread it through every call.
 *
 * Behavior is identical to the pre-seam direct calls — this is purely the
 * extraction of the Lichess specifics behind the backend-agnostic interface.
 */

import type {
	BlobMeta,
	ParsedBlob,
	PushResult,
	PulledScope,
	SyncKind,
	SyncTransport
} from './transport';
import {
	deleteRepChapters,
	findOrCreateSyncStudy,
	listSyncChapters,
	pullAllBlobs,
	pullBlob,
	pushBlob,
	purgeSyncChapters
} from './lichessSync';

export class LichessStudyTransport implements SyncTransport {
	readonly #token: string;
	readonly #username: string | undefined;
	studyId: string | null;

	constructor(opts: { token: string; studyId?: string | null; username?: string }) {
		this.#token = opts.token;
		this.studyId = opts.studyId ?? null;
		this.#username = opts.username;
	}

	async connect(): Promise<{ remoteHasData: boolean }> {
		if (!this.#username) throw new Error('Lichess OAuth account has no username.');
		const { studyId } = await findOrCreateSyncStudy(
			this.#token,
			this.#username,
			this.studyId ?? undefined
		);
		this.studyId = studyId;
		const chapters = await listSyncChapters(this.#token, studyId);
		return { remoteHasData: chapters.length > 0 };
	}

	async pull(kind: SyncKind, repId: string | undefined): Promise<ParsedBlob | null> {
		return pullBlob(this.#token, this.#requireStudy(), kind, repId);
	}

	async pullAll(): Promise<PulledScope[]> {
		const blobs = await pullAllBlobs(this.#token, this.#requireStudy());
		// Map Lichess's chapter vocabulary onto the backend-agnostic scope
		// fields the orchestrator dedups on.
		return blobs.map((b) => {
			const { chapterId, chapterName, ...rest } = b;
			return { ...rest, scopeId: chapterId, scopeName: chapterName };
		});
	}

	async push(
		blob: string,
		meta: BlobMeta,
		expectedPriorRevision: number | null
	): Promise<PushResult> {
		return pushBlob(this.#token, this.#requireStudy(), blob, meta, expectedPriorRevision);
	}

	async deleteRep(repId: string): Promise<void> {
		await deleteRepChapters(this.#token, this.#requireStudy(), repId);
	}

	async purgeAll(): Promise<void> {
		await purgeSyncChapters(this.#token, this.#requireStudy());
	}

	#requireStudy(): string {
		if (!this.studyId) throw new Error('Sync study is not configured. Re-enable sync in Settings.');
		return this.studyId;
	}
}
