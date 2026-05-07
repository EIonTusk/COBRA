/**
 * Multi-device sync orchestration (Beta).
 *
 * Owns the runtime state of the sync feature: dirty-set, pending pushes,
 * last-sync timestamps, and the conflict-resolution prompt. The actual IDB
 * work lives in `bundle.ts`; the actual Lichess work lives in
 * `lichessSync.ts`. This store is the only thing that knows *when* to do
 * either, and is the only thing components import.
 *
 * Auto-push triggers (in priority order):
 *   1. `flushOnExit('rep:<id>')` from the editor's beforeNavigate — fires
 *      immediately, no debounce.
 *   2. `markDirty('rep:<id>' | 'global')` from any IDB write site — schedules
 *      a debounced background push 30s after the last mark.
 *   3. `syncNow()` from the Settings "Sync now" button — pulls then pushes
 *      everything dirty.
 *
 * Pull triggers:
 *   - `maybePullOnLoad()` from the root layout — fires once on app boot if
 *     the last pull was more than `MIN_PULL_INTERVAL_MS` ago.
 *   - The first-run setup flow inside `enable()` — see that method.
 *
 * Sync is opt-in, off by default. While `settings.sync.enabled !== true` the
 * store no-ops every method.
 */

import { SvelteSet } from 'svelte/reactivity';
import { saveSettings } from '$lib/storage/settings';
import { effectiveLichessToken } from '$lib/storage/settings';
import { tokenHasStudyScopes } from '$lib/lichess/oauth';
import { getSettings } from '$lib/storage/settings';
import {
	applyGlobalBundle,
	applyGlobalBundleMerge,
	applyRepBundle,
	applyRepBundleMerge,
	buildGlobalBundle,
	buildRepBundle,
	decodeBundle,
	encodeBundle,
	type GlobalBundle,
	type MergeStats,
	type RepBundle
} from './bundle';
import { emptyMergeStats } from './merge';
import { toast } from '$lib/ui';
import {
	findOrCreateSyncStudy,
	listSyncChapters,
	pullBlob,
	pushBlob,
	purgeSyncChapters,
	SyncConflictError,
	type SyncChapterRef
} from './lichessSync';
import { setDirtyHandler } from './dirtyMark';
import type { AppSettings, SyncSettings } from '$lib/types';

export type SyncStatus = 'disabled' | 'idle' | 'pulling' | 'pushing' | 'conflict' | 'error';

export type DirtyKey = 'global' | `rep:${string}`;

export interface ConflictPrompt {
	kind: 'rep' | 'global';
	repId?: string;
	localRevision: number;
	remoteRevision: number;
	remoteDeviceId: string;
	remotePushedAt: number;
}

const DEBOUNCE_MS = 30_000;
const MIN_PULL_INTERVAL_MS = 5 * 60_000;

class SyncStore {
	status = $state<SyncStatus>('disabled');
	enabled = $state<boolean>(false);
	lastPushAt = $state<number | null>(null);
	lastPullAt = $state<number | null>(null);
	error = $state<string | null>(null);
	conflict = $state<ConflictPrompt | null>(null);
	dirty = $state<SvelteSet<DirtyKey>>(new SvelteSet());
	studyId = $state<string | null>(null);

	#deviceId: string | null = null;
	#debounceTimer: ReturnType<typeof setTimeout> | null = null;
	#flightLock: Promise<void> | null = null;

	/** Hydrate from settings on app boot. Idempotent. */
	async init(): Promise<void> {
		const s = await getSettings();
		const sync: SyncSettings = s.sync ?? { enabled: false };
		this.enabled = sync.enabled === true;
		this.studyId = sync.studyId ?? null;
		this.lastPushAt = sync.lastPushAt ?? null;
		this.lastPullAt = sync.lastPullAt ?? null;
		this.#deviceId = sync.deviceId ?? null;
		this.#revisionCache = { ...(sync.lastKnownRevisions ?? {}) };
		this.status = this.enabled ? 'idle' : 'disabled';
		// Register the dirty-mark handler so storage modules' calls land here
		// regardless of whether sync is currently enabled — the markDirty
		// method itself bails early on `!this.enabled`.
		setDirtyHandler((key) => this.markDirty(key));
	}

	/** Mark `key` as needing a push; schedules a debounced push. No-op when
	 *  sync is disabled, so call sites can fire unconditionally. */
	markDirty(key: DirtyKey): void {
		if (!this.enabled) return;
		this.dirty.add(key);
		this.#scheduleDebouncedPush();
	}

	/** Edit-page beforeNavigate hook: push this rep right now, no debounce.
	 *  Intentionally fire-and-forget — navigation cleanup must not block. */
	flushOnExit(key: DirtyKey): void {
		if (!this.enabled) return;
		if (!this.dirty.has(key)) return;
		this.#cancelDebouncedPush();
		void this.pushDirty().catch((e) => {
			console.warn('[sync] flushOnExit push failed:', e);
		});
	}

	/** Manual "Sync now" — pull everything, then push everything dirty. */
	async syncNow(): Promise<void> {
		if (!this.enabled) return;
		await this.pullAll();
		await this.pushDirty();
	}

	/** Pull on app boot if the last pull is older than MIN_PULL_INTERVAL_MS. */
	async maybePullOnLoad(): Promise<void> {
		if (!this.enabled) return;
		const last = this.lastPullAt ?? 0;
		if (Date.now() - last < MIN_PULL_INTERVAL_MS) return;
		await this.pullAll().catch((e) => {
			console.warn('[sync] background pull failed:', e);
		});
	}

	/**
	 * First-run setup. Locates or creates the COBRA Sync study, and decides
	 * whether to push local data up or pull remote data down based on what
	 * `mode` the caller supplies. Caller (Settings UI) is responsible for
	 * showing a chooser when remote already has chapters.
	 */
	async enable(opts: {
		mode: 'push-local' | 'pull-remote' | 'fresh';
	}): Promise<{ remoteHasData: boolean }> {
		const s = await getSettings();
		const token = effectiveLichessToken(s);
		if (!token) throw new Error('Connect Lichess in Settings before enabling sync.');
		if (!tokenHasStudyScopes(s.lichessOAuth)) {
			throw new Error('Lichess token is missing study:read/study:write scopes. Reconnect.');
		}
		const username = s.lichessOAuth?.username;
		if (!username) throw new Error('Lichess OAuth account has no username.');

		const { studyId } = await findOrCreateSyncStudy(token, username, s.sync?.studyId);
		this.studyId = studyId;
		this.#deviceId = this.#deviceId ?? s.sync?.deviceId ?? crypto.randomUUID();
		this.enabled = true;
		this.status = 'idle';

		const next: SyncSettings = {
			...(s.sync ?? { enabled: false }),
			enabled: true,
			studyId,
			deviceId: this.#deviceId
		};
		await saveSettings({ ...s, sync: next }, { skipDirtyMark: true });

		// Probe the study for existing COBRA-SYNC chapters.
		const chapters = await listSyncChapters(token, studyId);
		const remoteHasData = chapters.length > 0;

		if (opts.mode === 'pull-remote' && remoteHasData) {
			await this.pullAll();
		} else if (opts.mode === 'push-local') {
			await this.pushAll();
		} else if (opts.mode === 'fresh') {
			// fresh = remote was empty, or the user chose "ignore remote" —
			// just push everything.
			await this.pushAll();
		}
		return { remoteHasData };
	}

	/** Disable the feature without touching the remote study. */
	async disable(): Promise<void> {
		this.#cancelDebouncedPush();
		const s = await getSettings();
		const next: SyncSettings = { ...(s.sync ?? { enabled: false }), enabled: false };
		await saveSettings({ ...s, sync: next }, { skipDirtyMark: true });
		this.enabled = false;
		this.status = 'disabled';
		this.dirty.clear();
		this.conflict = null;
		this.error = null;
	}

	/** Disable + delete every COBRA-SYNC chapter on Lichess + clear local
	 *  revision tracking. Leaves the (now empty) study itself in place — the
	 *  user can delete it on Lichess if they care. */
	async disconnectAndForget(): Promise<void> {
		const s = await getSettings();
		const token = effectiveLichessToken(s);
		const studyId = s.sync?.studyId;
		if (token && studyId) {
			try {
				await purgeSyncChapters(token, studyId);
			} catch (e) {
				console.warn('[sync] purge failed:', e);
			}
		}
		await this.disable();
		const fresh = await getSettings();
		const next: SyncSettings = { enabled: false };
		await saveSettings({ ...fresh, sync: next }, { skipDirtyMark: true });
		this.studyId = null;
		this.lastPushAt = null;
		this.lastPullAt = null;
		this.#deviceId = null;
	}

	/** Push every dirty entity. Used by debounce + manual sync. */
	async pushDirty(): Promise<void> {
		if (!this.enabled) return;
		if (this.dirty.size === 0) return;
		await this.#withFlightLock(async () => {
			const keys = [...this.dirty];
			for (const key of keys) {
				try {
					if (key === 'global') {
						await this.#pushGlobal();
					} else {
						const repId = key.slice('rep:'.length);
						await this.#pushRep(repId);
					}
					this.dirty.delete(key);
				} catch (e) {
					if (e instanceof SyncConflictError) {
						this.conflict = {
							kind: e.kind,
							repId: e.repId,
							localRevision: e.localRevision,
							remoteRevision: e.remoteRevision,
							remoteDeviceId: e.remoteDeviceId,
							remotePushedAt: e.remotePushedAt
						};
						this.status = 'conflict';
						return; // stop the loop until the user resolves
					}
					this.#setError(e);
					return;
				}
			}
			this.status = 'idle';
		});
	}

	/** Push every repertoire + the global slice. Used on first-run-push. */
	async pushAll(): Promise<void> {
		if (!this.enabled) return;
		await this.#withFlightLock(async () => {
			try {
				this.status = 'pushing';
				const db = await (await import('$lib/storage/db')).getDB();
				const reps = await db.getAll('repertoires');
				for (const rep of reps) {
					await this.#pushRep(rep.id);
				}
				await this.#pushGlobal();
				this.dirty.clear();
				this.status = 'idle';
			} catch (e) {
				if (e instanceof SyncConflictError) {
					this.conflict = {
						kind: e.kind,
						repId: e.repId,
						localRevision: e.localRevision,
						remoteRevision: e.remoteRevision,
						remoteDeviceId: e.remoteDeviceId,
						remotePushedAt: e.remotePushedAt
					};
					this.status = 'conflict';
					return;
				}
				this.#setError(e);
			}
		});
	}

	/** Pull every COBRA-SYNC chapter from the study and apply locally. */
	async pullAll(): Promise<void> {
		if (!this.enabled) return;
		await this.#withFlightLock(async () => {
			try {
				this.status = 'pulling';
				const ctx = await this.#requireSyncContext();
				const chapters = await listSyncChapters(ctx.token, ctx.studyId);
				const settings = await getSettings();
				let mergedSettings: AppSettings | null = null;
				const aggregate = emptyMergeStats();
				for (const c of chapters) {
					const parsed = await pullBlob(ctx.token, ctx.studyId, c.kind, c.repId);
					if (!parsed) continue;
					const decoded = await decodeBundle(parsed.blob);
					if (decoded.kind === 'rep') {
						if (decoded.version === 2) {
							const stats = await applyRepBundleMerge(decoded as RepBundle);
							addStats(aggregate, stats);
						} else {
							// v1 bundle from a not-yet-upgraded device — fall back
							// to the legacy wipe-and-restore. We can't merge what
							// we don't have timestamps for.
							await applyRepBundle(decoded as RepBundle);
						}
					} else {
						if (decoded.version === 2) {
							const r = await applyGlobalBundleMerge(decoded as GlobalBundle, settings);
							mergedSettings = r.mergedSettings;
							addStats(aggregate, r.stats);
						} else {
							const r = await applyGlobalBundle(decoded as GlobalBundle, settings);
							mergedSettings = r.mergedSettings;
						}
					}
					this.#rememberRevision(c, parsed.revision);
				}
				announceMerge(aggregate);
				const now = Date.now();
				this.lastPullAt = now;
				const final = mergedSettings ?? (await getSettings());
				const sync: SyncSettings = {
					...(final.sync ?? { enabled: false }),
					enabled: true,
					studyId: ctx.studyId,
					deviceId: this.#deviceId ?? undefined,
					lastPushAt: this.lastPushAt ?? undefined,
					lastPullAt: now,
					lastKnownRevisions: this.#revisionsSnapshot()
				};
				await saveSettings({ ...final, sync }, { skipDirtyMark: true });
				this.status = 'idle';
			} catch (e) {
				this.#setError(e);
			}
		});
	}

	/** User picks "use remote" on the conflict prompt — pull, then clear. */
	async resolveConflictPullRemote(): Promise<void> {
		if (!this.conflict) return;
		const c = this.conflict;
		this.conflict = null;
		try {
			const ctx = await this.#requireSyncContext();
			const parsed = await pullBlob(ctx.token, ctx.studyId, c.kind, c.repId);
			if (parsed) {
				const decoded = await decodeBundle(parsed.blob);
				const aggregate = emptyMergeStats();
				if (decoded.kind === 'rep') {
					if (decoded.version === 2) {
						const stats = await applyRepBundleMerge(decoded as RepBundle);
						addStats(aggregate, stats);
					} else {
						await applyRepBundle(decoded as RepBundle);
					}
				} else {
					const settings = await getSettings();
					if (decoded.version === 2) {
						const r = await applyGlobalBundleMerge(decoded as GlobalBundle, settings);
						addStats(aggregate, r.stats);
					} else {
						await applyGlobalBundle(decoded as GlobalBundle, settings);
					}
				}
				announceMerge(aggregate);
				this.#rememberRevisionByKey(conflictDirtyKey(c), parsed.revision);
				this.dirty.delete(conflictDirtyKey(c));
				await this.#persistRevisions();
			}
			this.status = 'idle';
		} catch (e) {
			this.#setError(e);
		}
	}

	/** User picks "overwrite remote" on the conflict prompt — push past it. */
	async resolveConflictOverwrite(): Promise<void> {
		if (!this.conflict) return;
		const c = this.conflict;
		this.conflict = null;
		try {
			if (c.kind === 'global') {
				await this.#pushGlobal({ force: true, expectedRemote: c.remoteRevision });
			} else {
				await this.#pushRep(c.repId as string, {
					force: true,
					expectedRemote: c.remoteRevision
				});
			}
			this.dirty.delete(conflictDirtyKey(c));
			this.status = 'idle';
		} catch (e) {
			this.#setError(e);
		}
	}

	/** User picks "cancel" — leave the dirty mark, drop the prompt. The
	 *  next debounced or manual push will trigger the prompt again. */
	dismissConflict(): void {
		this.conflict = null;
		this.status = 'idle';
	}

	dismissError(): void {
		this.error = null;
		if (this.enabled) this.status = 'idle';
	}

	// --- Internal -----------------------------------------------------------

	#scheduleDebouncedPush(): void {
		this.#cancelDebouncedPush();
		this.#debounceTimer = setTimeout(() => {
			this.#debounceTimer = null;
			void this.pushDirty().catch((e) => console.warn('[sync] debounced push failed:', e));
		}, DEBOUNCE_MS);
	}

	#cancelDebouncedPush(): void {
		if (this.#debounceTimer) {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = null;
		}
	}

	async #withFlightLock(fn: () => Promise<void>): Promise<void> {
		// Serialize push/pull so the on-load pull can't race a debounced push.
		while (this.#flightLock) await this.#flightLock;
		const promise = fn().finally(() => {
			if (this.#flightLock === promise) this.#flightLock = null;
		});
		this.#flightLock = promise;
		await promise;
	}

	async #pushRep(
		repId: string,
		opts: { force?: boolean; expectedRemote?: number } = {}
	): Promise<void> {
		const ctx = await this.#requireSyncContext();
		const bundle = await buildRepBundle(repId);
		if (!bundle) return; // rep was deleted between markDirty and now
		const blob = await encodeBundle(bundle);
		const prior = opts.force
			? (opts.expectedRemote ?? null)
			: (this.#revisionFor(`rep:${repId}`) ?? null);
		const nextRevision = (prior ?? -1) + 1;
		this.status = 'pushing';
		const result = await pushBlob(
			ctx.token,
			ctx.studyId,
			blob,
			{
				kind: 'rep',
				repId,
				revision: nextRevision,
				deviceId: this.#deviceId as string,
				pushedAt: Date.now()
			},
			prior
		);
		this.#rememberRevisionByKey(`rep:${repId}`, result.revision);
		this.lastPushAt = result.pushedAt;
		await this.#persistRevisions();
	}

	async #pushGlobal(opts: { force?: boolean; expectedRemote?: number } = {}): Promise<void> {
		const ctx = await this.#requireSyncContext();
		const settings = await getSettings();
		const bundle = await buildGlobalBundle(settings);
		const blob = await encodeBundle(bundle);
		const prior = opts.force
			? (opts.expectedRemote ?? null)
			: (this.#revisionFor('global') ?? null);
		const nextRevision = (prior ?? -1) + 1;
		this.status = 'pushing';
		const result = await pushBlob(
			ctx.token,
			ctx.studyId,
			blob,
			{
				kind: 'global',
				revision: nextRevision,
				deviceId: this.#deviceId as string,
				pushedAt: Date.now()
			},
			prior
		);
		this.#rememberRevisionByKey('global', result.revision);
		this.lastPushAt = result.pushedAt;
		await this.#persistRevisions();
	}

	async #requireSyncContext(): Promise<{ token: string; studyId: string; settings: AppSettings }> {
		const settings = await getSettings();
		const token = effectiveLichessToken(settings);
		if (!token) throw new Error('Lichess token is missing — reconnect in Settings.');
		const studyId = settings.sync?.studyId ?? this.studyId;
		if (!studyId) throw new Error('Sync study is not configured. Re-enable sync in Settings.');
		this.studyId = studyId;
		this.#deviceId =
			this.#deviceId ?? settings.sync?.deviceId ?? settings.sync?.deviceId ?? crypto.randomUUID();
		return { token, studyId, settings };
	}

	#rememberRevision(c: SyncChapterRef, revision: number): void {
		const key: DirtyKey = c.kind === 'global' ? 'global' : (`rep:${c.repId as string}` as DirtyKey);
		this.#rememberRevisionByKey(key, revision);
	}

	#rememberRevisionByKey(key: DirtyKey, revision: number): void {
		this.#revisionCache[key] = revision;
	}

	#revisionFor(key: DirtyKey): number | undefined {
		return this.#revisionCache[key];
	}

	#revisionsSnapshot(): Record<string, number> {
		return { ...this.#revisionCache };
	}

	async #persistRevisions(): Promise<void> {
		const s = await getSettings();
		const sync: SyncSettings = {
			...(s.sync ?? { enabled: false }),
			enabled: this.enabled,
			studyId: this.studyId ?? undefined,
			deviceId: this.#deviceId ?? undefined,
			lastPushAt: this.lastPushAt ?? undefined,
			lastPullAt: this.lastPullAt ?? undefined,
			lastKnownRevisions: this.#revisionsSnapshot()
		};
		await saveSettings({ ...s, sync }, { skipDirtyMark: true });
	}

	#revisionCache: Record<string, number> = {};

	#setError(e: unknown): void {
		this.error = e instanceof Error ? e.message : String(e);
		this.status = 'error';
		console.warn('[sync] error:', e);
	}
}

function conflictDirtyKey(c: { kind: 'rep' | 'global'; repId?: string }): DirtyKey {
	return c.kind === 'global' ? 'global' : (`rep:${c.repId as string}` as DirtyKey);
}

/** Sum a per-chapter merge result into the running pull-aggregate. */
function addStats(into: MergeStats, from: MergeStats): void {
	into.cards += from.cards;
	into.ideaCards += from.ideaCards;
	into.mistakes += from.mistakes;
	into.empiricalGaps += from.empiricalGaps;
	into.positionWdl += from.positionWdl;
	into.sparGames += from.sparGames;
	into.nodes += from.nodes;
	into.edges += from.edges;
	into.baselines += from.baselines;
	if (from.repertoireUpdated) into.repertoireUpdated = 1;
	if (from.settingsUpdated) into.settingsUpdated = 1;
	if (from.dossierReportUpdated) into.dossierReportUpdated = 1;
	if (from.mastersBaselineUpdated) into.mastersBaselineUpdated = 1;
}

/**
 * Surface a one-line summary of what a pull merged. Silent when nothing
 * changed (the common case — pull was a no-op or only updated unchanged
 * rows). The user gets noticed only when the merge actually touched
 * something.
 */
function announceMerge(s: MergeStats): void {
	const parts: string[] = [];
	if (s.cards) parts.push(`${s.cards} card${s.cards === 1 ? '' : 's'}`);
	if (s.ideaCards) parts.push(`${s.ideaCards} idea${s.ideaCards === 1 ? '' : 's'}`);
	if (s.edges) parts.push(`${s.edges} edge${s.edges === 1 ? '' : 's'}`);
	if (s.mistakes) parts.push(`${s.mistakes} mistake${s.mistakes === 1 ? '' : 's'}`);
	if (s.empiricalGaps) parts.push(`${s.empiricalGaps} gap${s.empiricalGaps === 1 ? '' : 's'}`);
	if (s.sparGames) parts.push(`${s.sparGames} spar`);
	if (s.positionWdl) parts.push(`${s.positionWdl} WDL row${s.positionWdl === 1 ? '' : 's'}`);
	if (s.baselines) parts.push(`${s.baselines} baseline${s.baselines === 1 ? '' : 's'}`);
	if (s.dossierReportUpdated) parts.push('dossier');
	if (s.mastersBaselineUpdated) parts.push('masters baseline');
	if (s.settingsUpdated) parts.push('settings');
	if (parts.length === 0) return;
	toast.info('Synced from another device', {
		body: `Merged ${parts.join(' · ')}.`,
		dedupKey: 'sync-merge'
	});
}

export const sync = new SyncStore();
