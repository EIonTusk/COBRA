import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BlobMeta, ParsedBlob } from './pgnWrap';

// Mock the Lichess implementation layer so we test the transport adapter in
// isolation — that it forwards the connection context and maps chapter
// vocabulary onto the backend-agnostic scope fields.
const mocks = vi.hoisted(() => ({
	findOrCreateSyncStudy: vi.fn(),
	listSyncChapters: vi.fn(),
	pullAllBlobs: vi.fn(),
	pullBlob: vi.fn(),
	pushBlob: vi.fn(),
	deleteRepChapters: vi.fn(),
	purgeSyncChapters: vi.fn()
}));

vi.mock('./lichessSync', () => mocks);

import { LichessStudyTransport } from './lichessTransport';

const REP_META: BlobMeta = {
	kind: 'rep',
	repId: 'rep-1',
	revision: 3,
	deviceId: 'dev-a',
	pushedAt: 1000
};

beforeEach(() => {
	for (const fn of Object.values(mocks)) fn.mockReset();
});

describe('LichessStudyTransport', () => {
	it('connect() locates/creates the study and reports remoteHasData', async () => {
		mocks.findOrCreateSyncStudy.mockResolvedValue({ studyId: 'study-xyz' });
		mocks.listSyncChapters.mockResolvedValue([{ chapterId: 'c1' }]);

		const t = new LichessStudyTransport({ token: 'tok', username: 'alice' });
		const { remoteHasData } = await t.connect();

		expect(mocks.findOrCreateSyncStudy).toHaveBeenCalledWith('tok', 'alice', undefined);
		expect(t.studyId).toBe('study-xyz');
		expect(remoteHasData).toBe(true);
	});

	it('connect() reports no data for an empty study', async () => {
		mocks.findOrCreateSyncStudy.mockResolvedValue({ studyId: 'study-xyz' });
		mocks.listSyncChapters.mockResolvedValue([]);

		const t = new LichessStudyTransport({ token: 'tok', username: 'alice', studyId: 'prefer' });
		const { remoteHasData } = await t.connect();

		expect(mocks.findOrCreateSyncStudy).toHaveBeenCalledWith('tok', 'alice', 'prefer');
		expect(remoteHasData).toBe(false);
	});

	it('connect() throws without a username', async () => {
		const t = new LichessStudyTransport({ token: 'tok' });
		await expect(t.connect()).rejects.toThrow(/username/i);
	});

	it('pull() forwards token + studyId + kind + repId', async () => {
		const parsed: ParsedBlob = { ...REP_META, blob: 'BLOB' };
		mocks.pullBlob.mockResolvedValue(parsed);

		const t = new LichessStudyTransport({ token: 'tok', studyId: 'study-1' });
		const out = await t.pull('rep', 'rep-1');

		expect(mocks.pullBlob).toHaveBeenCalledWith('tok', 'study-1', 'rep', 'rep-1');
		expect(out).toBe(parsed);
	});

	it('pullAll() maps chapter fields onto scope fields', async () => {
		mocks.pullAllBlobs.mockResolvedValue([
			{ ...REP_META, blob: 'B1', chapterId: 'chap-1', chapterName: 'COBRA-SYNC:rep:rep-1' }
		]);

		const t = new LichessStudyTransport({ token: 'tok', studyId: 'study-1' });
		const [scope] = await t.pullAll();

		expect(mocks.pullAllBlobs).toHaveBeenCalledWith('tok', 'study-1');
		expect(scope.scopeId).toBe('chap-1');
		expect(scope.scopeName).toBe('COBRA-SYNC:rep:rep-1');
		expect(scope.blob).toBe('B1');
		// chapter-specific keys must not leak through the seam
		expect('chapterId' in scope).toBe(false);
		expect('chapterName' in scope).toBe(false);
	});

	it('push() forwards the blob, meta and expected prior revision', async () => {
		const result = { chapterId: 'c1', revision: 4, deviceId: 'dev-a', pushedAt: 2000 };
		mocks.pushBlob.mockResolvedValue(result);

		const t = new LichessStudyTransport({ token: 'tok', studyId: 'study-1' });
		const out = await t.push('BLOB', REP_META, 3);

		expect(mocks.pushBlob).toHaveBeenCalledWith('tok', 'study-1', 'BLOB', REP_META, 3);
		expect(out).toBe(result);
	});

	it('deleteRep() and purgeAll() forward to the chapter ops', async () => {
		mocks.deleteRepChapters.mockResolvedValue(1);
		mocks.purgeSyncChapters.mockResolvedValue(2);

		const t = new LichessStudyTransport({ token: 'tok', studyId: 'study-1' });
		await t.deleteRep('rep-1');
		await t.purgeAll();

		expect(mocks.deleteRepChapters).toHaveBeenCalledWith('tok', 'study-1', 'rep-1');
		expect(mocks.purgeSyncChapters).toHaveBeenCalledWith('tok', 'study-1');
	});

	it('throws when an op needs a study id that was never set', async () => {
		const t = new LichessStudyTransport({ token: 'tok' });
		await expect(t.pull('global', undefined)).rejects.toThrow(/study is not configured/i);
		expect(mocks.pullBlob).not.toHaveBeenCalled();
	});
});
