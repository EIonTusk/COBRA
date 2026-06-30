/**
 * Sync bundle encoding/decoding/application.
 *
 * Two bundle shapes:
 *   - RepBundle: everything scoped to one repertoire (rep, nodes, cards, idea
 *     cards, plus per-rep slices of mistakes / empirical_gaps / spar_games /
 *     position_wdl).
 *   - GlobalBundle: everything that's not rep-scoped (sanitised settings,
 *     baselines, latest dossier report, masters baseline).
 *
 * Apply is last-write-wins on the whole bundle: when we pull, the bundle from
 * the most recent push replaces the local rep/global slice wholesale. v1 has
 * no per-record merge; concurrent edits on two devices in the same rep on the
 * same day will lose one device's writes. The conflict UI gives the user the
 * choice before that happens — see syncStore.
 *
 * Encoded form is gzip + base64url, mirroring share.ts so the same payload
 * fits inside Lichess study PGN comments without needing line-wrap escapes.
 */

import { getDB } from '$lib/storage/db';
import { defaultSettings, sanitizeSettingsForSync } from '$lib/storage/settings';
import { getRepertoire, purgeRepertoireLocal } from '$lib/storage/repertoires';
import { listNodes } from '$lib/storage/nodes';
import { reachableFenKeys } from '$lib/tree/traversal';
import { listCards } from '$lib/storage/cards';
import { listIdeaCards } from '$lib/storage/ideaCards';
import { listMistakes } from '$lib/storage/mistakes';
import { listGapsForRepertoire } from '$lib/storage/empiricalGaps';
import { listSparGames } from '$lib/storage/sparGames';
import { listPositionWdlForRepertoire } from '$lib/storage/positionWdl';
import { listStoredBaselines } from '$lib/storage/baselines';
import type {
	AppSettings,
	Card,
	EmpiricalGap,
	IdeaCard,
	Repertoire,
	RepertoireNode,
	SparGame,
	StoredMistake
} from '$lib/types';
import type { PositionWdlRow, StoredBaselineBucket } from '$lib/storage/db';

/**
 * Sync wire-format version.
 *
 * v1 was the initial release: whole-bundle last-write-wins on apply.
 * v2 adds the schema fields needed for per-record merge:
 *   - `RepertoireNode.updatedAt` and `Edge.updatedAt` for tree-merge tiebreaks
 *   - `EmpiricalGap.gameIds` so sum-merge can dedup overlapping scans
 * The row shapes themselves are otherwise compatible — a v1 reader sees v2
 * rows as v1 rows with extra unknown fields, which it ignores.
 *
 * v1 receivers reject v2 bundles outright (decodeBundle throws on the
 * unrecognised version). v2 receivers accept v1 bundles and apply them
 * with the legacy wipe-and-restore path. That asymmetry is the rollout
 * story — bring devices over one at a time without losing existing data.
 */
export const BUNDLE_VERSION = 2;
export type BundleVersion = 1 | 2;

export interface RepBundle {
	version: BundleVersion;
	kind: 'rep';
	repertoireId: string;
	exportedAt: number;
	repertoire: Repertoire;
	nodes: RepertoireNode[];
	cards: Card[];
	ideaCards: IdeaCard[];
	mistakes: StoredMistake[];
	empiricalGaps: EmpiricalGap[];
	sparGames: SparGame[];
	positionWdl: PositionWdlRow[];
}

/**
 * Tier-split rep bundles (issue #68). A repertoire syncs as two independently
 * revisioned scopes instead of one combined `RepBundle`:
 *
 *   - `RepCoreBundle` — the authored tree: rep meta, nodes, cards, idea cards.
 *     Small, interactive, must stay consistent. Always synced.
 *   - `RepTelemetryBundle` — derived/append-mostly scan data: mistakes,
 *     empirical gaps, spar games, position WDL. Bulky and regenerable, so it
 *     syncs opt-in. Splitting it off is what keeps a large repertoire's core
 *     under transport size limits.
 *
 * The combined `RepBundle` above is retained for reading scopes written by
 * pre-split devices; new pushes emit the two tiers.
 */
export interface RepCoreBundle {
	version: BundleVersion;
	kind: 'rep-core';
	repertoireId: string;
	exportedAt: number;
	repertoire: Repertoire;
	nodes: RepertoireNode[];
	cards: Card[];
	ideaCards: IdeaCard[];
}

export interface RepTelemetryBundle {
	version: BundleVersion;
	kind: 'rep-telemetry';
	repertoireId: string;
	exportedAt: number;
	mistakes: StoredMistake[];
	empiricalGaps: EmpiricalGap[];
	sparGames: SparGame[];
	positionWdl: PositionWdlRow[];
}

export interface GlobalBundle {
	version: BundleVersion;
	kind: 'global';
	exportedAt: number;
	/** Sanitised — no Lichess token, no nested sync block. */
	settings: ReturnType<typeof sanitizeSettingsForSync>;
	baselines: StoredBaselineBucket[];
	/** Single-row stores — null when the device has nothing yet. */
	dossierReport: { savedAt: number; version: number; payload: unknown } | null;
	mastersBaseline: {
		fetchedAt: number;
		targetsHash: string;
		payload: unknown;
	} | null;
}

export type AnyBundle = RepBundle | RepCoreBundle | RepTelemetryBundle | GlobalBundle;

// --- Build -----------------------------------------------------------------

export async function buildRepBundle(repertoireId: string): Promise<RepBundle | null> {
	const rep = await getRepertoire(repertoireId);
	if (!rep) return null;
	const [nodes, cards, ideaCards, mistakes, gaps, sparGames, wdl] = await Promise.all([
		listNodes(repertoireId),
		listCards(repertoireId),
		listIdeaCards(repertoireId),
		listMistakes({ repertoireId }),
		listGapsForRepertoire(repertoireId),
		listSparGames(repertoireId),
		listPositionWdlForRepertoire(repertoireId)
	]);
	return {
		version: BUNDLE_VERSION,
		kind: 'rep',
		repertoireId,
		exportedAt: Date.now(),
		repertoire: clone(rep),
		nodes: clone(nodes),
		cards: clone(cards),
		ideaCards: clone(ideaCards),
		mistakes: clone(mistakes),
		empiricalGaps: clone(gaps),
		sparGames: clone(sparGames),
		positionWdl: clone(wdl)
	};
}

/** Build the authored-tree tier for a rep. Null when the rep is gone. */
export async function buildRepCoreBundle(repertoireId: string): Promise<RepCoreBundle | null> {
	const rep = await getRepertoire(repertoireId);
	if (!rep) return null;
	const [nodes, cards, ideaCards] = await Promise.all([
		listNodes(repertoireId),
		listCards(repertoireId),
		listIdeaCards(repertoireId)
	]);
	return {
		version: BUNDLE_VERSION,
		kind: 'rep-core',
		repertoireId,
		exportedAt: Date.now(),
		repertoire: clone(rep),
		nodes: clone(nodes),
		cards: clone(cards),
		ideaCards: clone(ideaCards)
	};
}

/** Build the derived-telemetry tier for a rep. Null when the rep is gone. */
export async function buildRepTelemetryBundle(
	repertoireId: string
): Promise<RepTelemetryBundle | null> {
	const rep = await getRepertoire(repertoireId);
	if (!rep) return null;
	const [mistakes, gaps, sparGames, wdl] = await Promise.all([
		listMistakes({ repertoireId }),
		listGapsForRepertoire(repertoireId),
		listSparGames(repertoireId),
		listPositionWdlForRepertoire(repertoireId)
	]);
	return {
		version: BUNDLE_VERSION,
		kind: 'rep-telemetry',
		repertoireId,
		exportedAt: Date.now(),
		mistakes: clone(mistakes),
		empiricalGaps: clone(gaps),
		sparGames: clone(sparGames),
		positionWdl: clone(wdl)
	};
}

/**
 * Build the global-slice bundle. The dossier report and masters baseline
 * are deliberately *excluded* — both run into the hundreds of KB for
 * users who've done a substantial scan, which trips Lichess's per-chapter
 * PGN size limit. They're also fully regenerable by re-running the
 * dossier scan on the receiving device, so the cost of skipping them is
 * "the user runs a scan on each device" rather than data loss. See the
 * Settings disclosure for the user-facing copy.
 */
export async function buildGlobalBundle(settings: AppSettings): Promise<GlobalBundle> {
	const baselines = await listStoredBaselines();
	return {
		version: BUNDLE_VERSION,
		kind: 'global',
		exportedAt: Date.now(),
		settings: sanitizeSettingsForSync(settings),
		baselines: clone(baselines),
		dossierReport: null,
		mastersBaseline: null
	};
}

// --- Apply (v1 — wipe and restore) -----------------------------------------

const REP_STORES = [
	'repertoires',
	'nodes',
	'cards',
	'idea_cards',
	'mistakes',
	'empirical_gaps',
	'spar_games',
	'position_wdl'
] as const;

// Tier-split store groupings — the union equals REP_STORES.
const REP_CORE_STORES = ['repertoires', 'nodes', 'cards', 'idea_cards'] as const;
const REP_TELEMETRY_STORES = ['mistakes', 'empirical_gaps', 'spar_games', 'position_wdl'] as const;

const GLOBAL_STORES = ['settings', 'baselines', 'style_reports', 'masters_baseline'] as const;

/**
 * Replace every IDB row scoped to `bundle.repertoireId` with the bundle's
 * contents in a single transaction. The transaction is atomic — either the
 * whole rep slice flips to the bundle's contents, or IDB rolls back and the
 * local rep is untouched.
 */
export async function applyRepBundle(bundle: RepBundle): Promise<void> {
	if (bundle.version !== BUNDLE_VERSION) {
		throw new Error(`Unsupported rep-bundle version: ${bundle.version}`);
	}
	const db = await getDB();
	const tx = db.transaction(REP_STORES, 'readwrite');

	const repId = bundle.repertoireId;
	await tx.objectStore('repertoires').put(clone(bundle.repertoire));

	const nodes = tx.objectStore('nodes');
	const oldNodeKeys = await nodes.index('by-repertoire').getAllKeys(repId);
	for (const k of oldNodeKeys) await nodes.delete(k);
	for (const row of bundle.nodes) await nodes.put(clone(row));

	const cards = tx.objectStore('cards');
	const oldCardKeys = await cards.index('by-repertoire').getAllKeys(repId);
	for (const k of oldCardKeys) await cards.delete(k);
	for (const row of bundle.cards) await cards.put(clone(row));

	const ideas = tx.objectStore('idea_cards');
	const oldIdeaKeys = await ideas.index('by-repertoire').getAllKeys(repId);
	for (const k of oldIdeaKeys) await ideas.delete(k);
	for (const row of bundle.ideaCards) await ideas.put(clone(row));

	const mistakes = tx.objectStore('mistakes');
	const oldMistakeKeys = await mistakes.index('by-repertoire').getAllKeys(repId);
	for (const k of oldMistakeKeys) await mistakes.delete(k);
	for (const row of bundle.mistakes) await mistakes.put(clone(row));

	const gaps = tx.objectStore('empirical_gaps');
	const oldGapKeys = await gaps.index('by-repertoire').getAllKeys(repId);
	for (const k of oldGapKeys) await gaps.delete(k);
	for (const row of bundle.empiricalGaps) await gaps.put(clone(row));

	const sg = tx.objectStore('spar_games');
	const oldSparKeys = await sg.index('by-repertoire').getAllKeys(repId);
	for (const k of oldSparKeys) await sg.delete(k);
	for (const row of bundle.sparGames) await sg.put(clone(row));

	const wdl = tx.objectStore('position_wdl');
	const oldWdlKeys = await wdl.index('by-repertoire').getAllKeys(repId);
	for (const k of oldWdlKeys) await wdl.delete(k);
	for (const row of bundle.positionWdl) await wdl.put(clone(row));

	await tx.done;
}

export async function applyGlobalBundle(
	bundle: GlobalBundle,
	currentSettings: AppSettings
): Promise<{ mergedSettings: AppSettings }> {
	if (bundle.version !== BUNDLE_VERSION) {
		throw new Error(`Unsupported global-bundle version: ${bundle.version}`);
	}
	const db = await getDB();

	// Settings: keep the device-local secrets and the local sync block,
	// overlay the rest from the bundle. Defaults fill any newly-introduced
	// fields the remote device hasn't seen yet.
	const mergedSettings: AppSettings = {
		...defaultSettings(),
		...bundle.settings,
		// Restore device-local fields the bundle deliberately omits.
		lichessApiToken: currentSettings.lichessApiToken,
		lichessOAuth: currentSettings.lichessOAuth,
		sync: currentSettings.sync,
		key: 'root'
	};

	const tx = db.transaction(GLOBAL_STORES, 'readwrite');
	await tx.objectStore('settings').put(clone(mergedSettings));

	const baselines = tx.objectStore('baselines');
	await baselines.clear();
	for (const row of bundle.baselines) await baselines.put(clone(row));

	const reports = tx.objectStore('style_reports');
	await reports.clear();
	if (bundle.dossierReport) {
		await reports.put({
			id: 'latest',
			savedAt: bundle.dossierReport.savedAt,
			version: bundle.dossierReport.version,
			payload: bundle.dossierReport.payload
		});
	}

	const masters = tx.objectStore('masters_baseline');
	await masters.clear();
	if (bundle.mastersBaseline) {
		await masters.put({
			id: 'latest',
			fetchedAt: bundle.mastersBaseline.fetchedAt,
			targetsHash: bundle.mastersBaseline.targetsHash,
			version: 1,
			payload: bundle.mastersBaseline.payload
		});
	}

	await tx.done;
	return { mergedSettings };
}

// --- Apply (v2 — per-record merge) -----------------------------------------

import {
	emptyMergeStats,
	mergeBaseline,
	mergeCard,
	mergeDossierReport,
	mergeEmpiricalGap,
	mergeIdeaCard,
	mergeMastersBaseline,
	mergeMistake,
	mergeNode,
	mergePositionWdl,
	mergeRepertoire,
	mergeSettings,
	mergeSparGame,
	type MergeContext,
	type MergeStats
} from './merge';

export type { MergeStats } from './merge';

/**
 * Merge a v2 rep bundle into the local IDB slice. Unlike `applyRepBundle`,
 * this never wipes — it pairs each remote row with its local counterpart and
 * runs the matching `merge*` function. Rows missing on one side flow
 * through unchanged (adds-win-against-deletes).
 *
 * Returns counters describing what changed, for the post-pull merge toast.
 */
export async function applyRepBundleMerge(bundle: RepBundle): Promise<MergeStats> {
	const stats = emptyMergeStats();
	const ctx: MergeContext = { remoteExportedAt: bundle.exportedAt, mergedAt: Date.now() };
	const db = await getDB();
	const tx = db.transaction(REP_STORES, 'readwrite');

	const repId = bundle.repertoireId;

	// Repertoire row.
	{
		const store = tx.objectStore('repertoires');
		const local = await store.get(repId);
		if (!local) {
			await store.put(clone(bundle.repertoire));
			stats.repertoireUpdated = 1;
		} else {
			const merged = mergeRepertoire(local, bundle.repertoire);
			if (merged !== local) {
				await store.put(clone(merged));
				stats.repertoireUpdated = 1;
			}
		}
	}

	// Cards.
	stats.cards = await mergeStorePerKey(
		tx.objectStore('cards') as unknown as SyncMergeStore<Card>,
		repId,
		bundle.cards,
		(l, r) => mergeCard(l, r, ctx)
	);
	stats.ideaCards = await mergeStorePerKey(
		tx.objectStore('idea_cards') as unknown as SyncMergeStore<IdeaCard>,
		repId,
		bundle.ideaCards,
		(l, r) => mergeIdeaCard(l, r, ctx)
	);
	stats.mistakes = await mergeStorePerKey(
		tx.objectStore('mistakes') as unknown as SyncMergeStore<StoredMistake>,
		repId,
		bundle.mistakes,
		(l, r) => mergeMistake(l, r)
	);
	stats.empiricalGaps = await mergeStorePerKey(
		tx.objectStore('empirical_gaps') as unknown as SyncMergeStore<EmpiricalGap>,
		repId,
		bundle.empiricalGaps,
		(l, r) => mergeEmpiricalGap(l, r)
	);
	stats.positionWdl = await mergeStorePerKey(
		tx.objectStore('position_wdl') as unknown as SyncMergeStore<PositionWdlRow>,
		repId,
		bundle.positionWdl,
		(l, r) => mergePositionWdl(l, r)
	);
	stats.sparGames = await mergeStorePerKey(
		tx.objectStore('spar_games') as unknown as SyncMergeStore<SparGame>,
		repId,
		bundle.sparGames,
		(l, r) => mergeSparGame(l, r)
	);

	// Nodes (and their inner edges). Local-only nodes flow through unchanged.
	const nodeMerge = await mergeNodesForRep(
		tx.objectStore('nodes') as unknown as SyncMergeStore<RepertoireNode>,
		repId,
		bundle.nodes,
		stats,
		ctx.mergedAt
	);
	if (nodeMerge.tombstoneDrops > 0) {
		await pruneOrphansForRep(
			tx as unknown as Parameters<typeof pruneOrphansForRep>[0],
			repId,
			stats
		);
	}

	await tx.done;
	return stats;
}

/**
 * Merge a rep-core bundle (authored tree) into the local IDB slice. Same
 * per-record merge semantics as `applyRepBundleMerge`, but scoped to the
 * core stores only — telemetry is a separate tier.
 */
export async function applyRepCoreBundleMerge(bundle: RepCoreBundle): Promise<MergeStats> {
	if (bundle.version !== BUNDLE_VERSION) {
		throw new Error(`Unsupported rep-core-bundle version: ${bundle.version}`);
	}
	const stats = emptyMergeStats();
	const ctx: MergeContext = { remoteExportedAt: bundle.exportedAt, mergedAt: Date.now() };
	const db = await getDB();
	const tx = db.transaction(REP_CORE_STORES, 'readwrite');
	const repId = bundle.repertoireId;

	{
		const store = tx.objectStore('repertoires');
		const local = await store.get(repId);
		if (!local) {
			await store.put(clone(bundle.repertoire));
			stats.repertoireUpdated = 1;
		} else {
			const merged = mergeRepertoire(local, bundle.repertoire);
			if (merged !== local) {
				await store.put(clone(merged));
				stats.repertoireUpdated = 1;
			}
		}
	}

	stats.cards = await mergeStorePerKey(
		tx.objectStore('cards') as unknown as SyncMergeStore<Card>,
		repId,
		bundle.cards,
		(l, r) => mergeCard(l, r, ctx)
	);
	stats.ideaCards = await mergeStorePerKey(
		tx.objectStore('idea_cards') as unknown as SyncMergeStore<IdeaCard>,
		repId,
		bundle.ideaCards,
		(l, r) => mergeIdeaCard(l, r, ctx)
	);

	const nodeMerge = await mergeNodesForRep(
		tx.objectStore('nodes') as unknown as SyncMergeStore<RepertoireNode>,
		repId,
		bundle.nodes,
		stats,
		ctx.mergedAt
	);
	// Only sweep orphans when a synced-in deletion actually cut an edge —
	// nothing else in a merge can strand a subtree.
	if (nodeMerge.tombstoneDrops > 0) {
		await pruneOrphansForRep(
			tx as unknown as Parameters<typeof pruneOrphansForRep>[0],
			repId,
			stats
		);
	}

	await tx.done;
	return stats;
}

/**
 * Merge a rep-telemetry bundle (derived scan data) into the local IDB slice.
 * All four stores are per-key sum/LWW merges — no node/edge structure here.
 */
export async function applyRepTelemetryBundleMerge(
	bundle: RepTelemetryBundle
): Promise<MergeStats> {
	if (bundle.version !== BUNDLE_VERSION) {
		throw new Error(`Unsupported rep-telemetry-bundle version: ${bundle.version}`);
	}
	const stats = emptyMergeStats();
	const db = await getDB();
	const tx = db.transaction(REP_TELEMETRY_STORES, 'readwrite');
	const repId = bundle.repertoireId;

	stats.mistakes = await mergeStorePerKey(
		tx.objectStore('mistakes') as unknown as SyncMergeStore<StoredMistake>,
		repId,
		bundle.mistakes,
		(l, r) => mergeMistake(l, r)
	);
	stats.empiricalGaps = await mergeStorePerKey(
		tx.objectStore('empirical_gaps') as unknown as SyncMergeStore<EmpiricalGap>,
		repId,
		bundle.empiricalGaps,
		(l, r) => mergeEmpiricalGap(l, r)
	);
	stats.positionWdl = await mergeStorePerKey(
		tx.objectStore('position_wdl') as unknown as SyncMergeStore<PositionWdlRow>,
		repId,
		bundle.positionWdl,
		(l, r) => mergePositionWdl(l, r)
	);
	stats.sparGames = await mergeStorePerKey(
		tx.objectStore('spar_games') as unknown as SyncMergeStore<SparGame>,
		repId,
		bundle.sparGames,
		(l, r) => mergeSparGame(l, r)
	);

	await tx.done;
	return stats;
}

/**
 * Merge a v2 global bundle. Same shape: each store is read locally,
 * paired with the remote, run through the merge fn, and written back.
 */
export async function applyGlobalBundleMerge(
	bundle: GlobalBundle,
	currentSettings: AppSettings
): Promise<{ mergedSettings: AppSettings; stats: MergeStats }> {
	const stats = emptyMergeStats();
	const db = await getDB();
	const tx = db.transaction(GLOBAL_STORES, 'readwrite');

	// Settings: collection-aware LWW. Re-attach device-local fields.
	const remoteSettings = bundle.settings as Partial<AppSettings>;
	const merged = mergeSettings(currentSettings, remoteSettings);
	const mergedSettings: AppSettings = {
		...defaultSettings(),
		...merged,
		lichessApiToken: currentSettings.lichessApiToken,
		lichessOAuth: currentSettings.lichessOAuth,
		sync: currentSettings.sync,
		key: 'root'
	};
	await tx.objectStore('settings').put(clone(mergedSettings));
	if (JSON.stringify(mergedSettings) !== JSON.stringify(currentSettings)) {
		stats.settingsUpdated = 1;
	}

	// Baselines: per-id LWW. The bundle is the full set, but we only
	// touch the ids it carries — local-only baselines (e.g. one device
	// has a bucket the other never computed) survive.
	{
		const store = tx.objectStore('baselines');
		for (const remote of bundle.baselines) {
			const local = await store.get(remote.id);
			if (!local) {
				await store.put(clone(remote));
				stats.baselines += 1;
				continue;
			}
			const winner = mergeBaseline(local, remote);
			if (winner !== local) {
				await store.put(clone(winner));
				stats.baselines += 1;
			}
		}
	}

	// Dossier report (single row).
	{
		const store = tx.objectStore('style_reports');
		const local = (await store.get('latest')) ?? null;
		const merged = mergeDossierReport(
			local ? { savedAt: local.savedAt, version: local.version, payload: local.payload } : null,
			bundle.dossierReport
		);
		if (merged && (!local || merged.savedAt > local.savedAt)) {
			await store.put({ id: 'latest', ...merged });
			stats.dossierReportUpdated = 1;
		}
	}

	// Masters baseline (single row).
	{
		const store = tx.objectStore('masters_baseline');
		const local = (await store.get('latest')) ?? null;
		const merged = mergeMastersBaseline(
			local
				? {
						fetchedAt: local.fetchedAt,
						targetsHash: local.targetsHash,
						payload: local.payload
					}
				: null,
			bundle.mastersBaseline
		);
		if (merged && (!local || merged.fetchedAt > local.fetchedAt)) {
			await store.put({
				id: 'latest',
				fetchedAt: merged.fetchedAt,
				targetsHash: merged.targetsHash,
				version: 1,
				payload: merged.payload
			});
			stats.mastersBaselineUpdated = 1;
		}
	}

	await tx.done;

	// Apply deletion tombstones. The merged settings now carry the union of
	// both devices' tombstones; remove any local rep a tombstone supersedes.
	// Done after the GLOBAL_STORES transaction commits because purging a rep
	// touches the per-rep stores, which aren't in this transaction's scope.
	// A rep edited locally *after* the recorded deletion (updatedAt newer than
	// deletedAt) is kept — an explicit local edit wins over a remote delete,
	// matching the "adds win against deletes" philosophy.
	for (const t of mergedSettings.repTombstones ?? []) {
		const local = await getRepertoire(t.repId);
		if (local && local.updatedAt <= t.deletedAt) {
			await purgeRepertoireLocal(t.repId);
		}
	}

	return { mergedSettings, stats };
}

// --- Encoding --------------------------------------------------------------

export async function encodeBundle(bundle: AnyBundle): Promise<string> {
	const json = JSON.stringify(bundle);
	const bytes = new TextEncoder().encode(json);
	const gz = await gzip(bytes);
	return bytesToBase64Url(gz);
}

export async function decodeBundle(encoded: string): Promise<AnyBundle> {
	const bytes = base64UrlToBytes(encoded);
	const raw = await gunzip(bytes);
	const json = new TextDecoder().decode(raw);
	const parsed = JSON.parse(json) as AnyBundle;
	if (parsed.version !== 1 && parsed.version !== 2) {
		throw new Error(`Unsupported bundle version: ${parsed.version}`);
	}
	if (
		parsed.kind !== 'rep' &&
		parsed.kind !== 'rep-core' &&
		parsed.kind !== 'rep-telemetry' &&
		parsed.kind !== 'global'
	) {
		throw new Error(`Unknown bundle kind: ${(parsed as { kind?: string }).kind}`);
	}
	return parsed;
}

// --- Helpers ---------------------------------------------------------------

function clone<T>(v: T): T {
	return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Merge a per-rep slice (one IDB store) by primary key.
 *
 *   - For every remote row: if no local row exists with the same key, put
 *     the remote row in. If one exists, run `merge(local, remote)` and put
 *     the result back (only if it differs from `local`).
 *   - Local rows that have no remote counterpart flow through unchanged
 *     (adds-win-against-deletes — the other device may have just not
 *     touched this row).
 *
 * Returns the count of rows that ended up changed.
 *
 * Typed loosely as `unknown`-shaped IDB stores because the merge functions
 * are typed correctly upstream and dragging the full IDB generic chain
 * through here adds noise without catching real bugs.
 */
// The store handle is typed loosely because the underlying IDB generic
// chain is parameterised on every store name and would force this helper
// to be re-implemented per store. Callers pass `tx.objectStore(...) as
// SyncMergeStore<T>` so the strict types catch errors at the actual write
// site, not here.
type SyncMergeStore<T> = {
	index: (name: string) => {
		getAllKeys: (key: string) => Promise<unknown[]>;
	};
	get: (key: unknown) => Promise<T | undefined>;
	put: (row: T) => Promise<unknown>;
};

/**
 * Merge a rep's nodes (and their inner edges) into a nodes store. Shared by
 * the legacy combined apply and the tier-split core apply — the node/edge
 * merge is structural and identical between them. Local-only nodes flow
 * through unchanged (adds-win-against-deletes).
 */
async function mergeNodesForRep(
	store: SyncMergeStore<RepertoireNode>,
	repId: string,
	remoteNodes: RepertoireNode[],
	stats: MergeStats,
	mergedAt: number
): Promise<{ tombstoneDrops: number }> {
	const localKeys = await store.index('by-repertoire').getAllKeys(repId);
	const localByKey = new Map<string, RepertoireNode>();
	for (const key of localKeys) {
		const row = await store.get(key);
		if (row) localByKey.set(row.fenKey, row);
	}
	let tombstoneDrops = 0;
	const remoteByKey = new Map(remoteNodes.map((n) => [n.fenKey, n]));
	for (const [fenKey, remote] of remoteByKey) {
		const local = localByKey.get(fenKey);
		if (!local) {
			await store.put(clone(remote));
			stats.nodes += 1;
			stats.edges += remote.children.length;
			continue;
		}
		const merge = mergeNode(local, remote, mergedAt);
		tombstoneDrops += merge.tombstoneDrops;
		const merged = merge.merged;
		if (
			merge.edgeChanges > 0 ||
			merged.comment !== local.comment ||
			JSON.stringify(merged.nags ?? null) !== JSON.stringify(local.nags ?? null) ||
			merged.children.length !== local.children.length ||
			// Persist tombstone-set changes even when no edge was added/dropped
			// this merge, so the union propagates onward on the next push.
			JSON.stringify(merged.deletedChildren ?? null) !==
				JSON.stringify(local.deletedChildren ?? null)
		) {
			await store.put(clone(merged));
			stats.nodes += 1;
			stats.edges += merge.edgeChanges;
		}
	}
	return { tombstoneDrops };
}

/**
 * After a node merge, drop nodes/cards/idea cards that an edge-tombstone
 * deletion just orphaned. Recomputes reachability from the repertoire root
 * over the post-merge tree and removes anything outside it — the same sweep
 * `removeEdgeAndPrune` runs locally, so a deletion that syncs in cleans up its
 * stranded subtree (and the drill cards that hang off it) instead of leaving
 * orphans the drill queue would keep serving. Transposition-safe: a position
 * still reachable via another path stays.
 */
async function pruneOrphansForRep(
	tx: {
		objectStore: (name: 'repertoires' | 'nodes' | 'cards' | 'idea_cards') => {
			get: (key: unknown) => Promise<unknown>;
			delete: (key: unknown) => Promise<unknown>;
			index: (name: string) => {
				getAll: (key: string) => Promise<RepertoireNode[]>;
				getAllKeys: (key: string) => Promise<unknown[]>;
			};
		};
	},
	repId: string,
	stats: MergeStats
): Promise<void> {
	const repRow = (await tx.objectStore('repertoires').get(repId)) as
		| { rootFenKey: string }
		| undefined;
	if (!repRow) return;

	const nodesStore = tx.objectStore('nodes');
	const all = await nodesStore.index('by-repertoire').getAll(repId);
	const map = new Map<string, RepertoireNode>(all.map((n) => [n.fenKey, n]));
	const live = reachableFenKeys(map, repRow.rootFenKey);

	for (const n of all) {
		if (!live.has(n.fenKey)) {
			await nodesStore.delete([repId, n.fenKey]);
			stats.nodes += 1;
		}
	}
	const cardsStore = tx.objectStore('cards');
	for (const key of await cardsStore.index('by-repertoire').getAllKeys(repId)) {
		const [, fenKey] = key as [string, string];
		if (!live.has(fenKey)) await cardsStore.delete(key);
	}
	const ideasStore = tx.objectStore('idea_cards');
	for (const key of await ideasStore.index('by-repertoire').getAllKeys(repId)) {
		const [, fenKey] = key as [string, string];
		if (!live.has(fenKey)) await ideasStore.delete(key);
	}
}

async function mergeStorePerKey<T extends { repertoireId?: string }>(
	store: SyncMergeStore<T>,
	repertoireId: string,
	remoteRows: T[],
	merge: (local: T, remote: T) => T
): Promise<number> {
	const localByKey = new Map<string, T>();
	const localKeys = (await store.index('by-repertoire').getAllKeys(repertoireId)) as unknown[];
	for (const key of localKeys) {
		const row = await store.get(key);
		if (row) localByKey.set(JSON.stringify(key), row);
	}
	let changed = 0;
	for (const remote of remoteRows) {
		const remoteKey = inferStoreKey(remote);
		const keyJson = JSON.stringify(remoteKey);
		const local = localByKey.get(keyJson);
		if (!local) {
			await store.put(clone(remote));
			changed += 1;
			continue;
		}
		const merged = merge(local, remote);
		if (merged !== local || JSON.stringify(merged) !== JSON.stringify(local)) {
			await store.put(clone(merged));
			changed += 1;
		}
	}
	return changed;
}

/**
 * Reconstructs the IDB primary key for a row by matching the shapes the
 * stores actually use:
 *   - `[repertoireId, fenKey]` for nodes / cards / idea_cards
 *   - `id` for everything else (mistakes / gaps / spar_games / position_wdl)
 */
function inferStoreKey(row: Record<string, unknown>): unknown {
	if (typeof row.id === 'string') return row.id;
	if (typeof row.fenKey === 'string' && typeof row.repertoireId === 'string') {
		return [row.repertoireId, row.fenKey];
	}
	return undefined;
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
	const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'));
	const out = await new Response(stream).arrayBuffer();
	return new Uint8Array(out);
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
	const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
	const out = await new Response(stream).arrayBuffer();
	return new Uint8Array(out);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
	const pad = '='.repeat((4 - (s.length % 4)) % 4);
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
