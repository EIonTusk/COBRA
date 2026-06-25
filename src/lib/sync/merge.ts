/**
 * Per-store merge functions used by the sync v2 apply path.
 *
 * Each function takes a local row and a remote row that share a primary key,
 * plus a context object carrying tiebreaker hints (the bundle's own
 * `exportedAt`, used when neither row has a useful timestamp), and returns
 * the merged row.
 *
 * Design rules followed throughout:
 *   - **Pure functions, no IDB.** The apply layer owns transactions; this
 *     module only owns "what should the merged row look like?".
 *   - **Adds win against deletes.** Whenever the choice is between
 *     resurrecting a row the other device dropped vs. losing a row the
 *     local device kept, we resurrect. Easier to clean up extra rows than
 *     to reconstruct deleted ones.
 *   - **Missing timestamps are treated as "older than any explicit one"**,
 *     so an unstamped legacy row yields to a stamped fresh one.
 *
 * The merge log surfaces row counts back to the apply layer for the
 * post-pull toast — see `MergeStats`.
 */

import type {
	Card,
	Edge,
	EmpiricalGap,
	IdeaCard,
	Repertoire,
	RepertoireNode,
	SparGame,
	StoredMistake
} from '$lib/types';
import type { PositionWdlRow, StoredBaselineBucket } from '$lib/storage/db';

export interface MergeContext {
	/** `exportedAt` of the incoming bundle. Used as the remote timestamp
	 *  when the row itself doesn't carry one. */
	remoteExportedAt: number;
	/** Time we ran the merge — used as a default for any resurrected rows
	 *  the merge had to fabricate timestamps for. */
	mergedAt: number;
}

export interface MergeStats {
	cards: number;
	ideaCards: number;
	mistakes: number;
	empiricalGaps: number;
	positionWdl: number;
	sparGames: number;
	nodes: number;
	edges: number;
	baselines: number;
	repertoireUpdated: 0 | 1;
	settingsUpdated: 0 | 1;
	dossierReportUpdated: 0 | 1;
	mastersBaselineUpdated: 0 | 1;
}

export function emptyMergeStats(): MergeStats {
	return {
		cards: 0,
		ideaCards: 0,
		mistakes: 0,
		empiricalGaps: 0,
		positionWdl: 0,
		sparGames: 0,
		nodes: 0,
		edges: 0,
		baselines: 0,
		repertoireUpdated: 0,
		settingsUpdated: 0,
		dossierReportUpdated: 0,
		mastersBaselineUpdated: 0
	};
}

// --- Cards / idea cards (identical shape) ----------------------------------

/**
 * Last-write-wins by `lastReview`. The winner's full FSRS state — stability,
 * difficulty, due-date — comes along, so we never frankenstein a card with
 * one device's stability and another device's lapse count.
 *
 * Tiebreaker: a card that's been reviewed at all beats one that hasn't, then
 * the bundle's `exportedAt` if both sides claim no review. The cap-at-zero
 * means "two devices that have never opened this card converge on whichever
 * was pulled latest", which is fine.
 */
export function mergeCard(local: Card, remote: Card, _ctx: MergeContext): Card {
	const ls = local.lastReview ?? 0;
	const rs = remote.lastReview ?? 0;
	if (rs > ls) return remote;
	if (ls > rs) return local;
	// Both unreviewed (or somehow exactly tied): prefer the row whose FSRS
	// state has been touched (higher reps + lapses sum) — that's a
	// near-zero edge case but yields stable behaviour. Otherwise fall back
	// to the row with the higher dueAt, which is a deterministic tiebreak.
	const lWeight = (local.fsrs?.reps ?? 0) + (local.fsrs?.lapses ?? 0);
	const rWeight = (remote.fsrs?.reps ?? 0) + (remote.fsrs?.lapses ?? 0);
	if (rWeight > lWeight) return remote;
	if (lWeight > rWeight) return local;
	return remote.dueAt >= local.dueAt ? remote : local;
}

export function mergeIdeaCard(local: IdeaCard, remote: IdeaCard, ctx: MergeContext): IdeaCard {
	// IdeaCard has the same (lastReview, fsrs) shape we care about.
	return mergeCard(local as unknown as Card, remote as unknown as Card, ctx) as unknown as IdeaCard;
}

// --- Mistakes --------------------------------------------------------------

/**
 * Pending always loses to a deliberate user action (corrected / dismissed):
 * once either device has handled the mistake, the other shouldn't be able
 * to drag it back to pending just because its row happens to carry an
 * older timestamp.
 */
const STATUS_RANK: Record<StoredMistake['status'], number> = {
	corrected: 1,
	dismissed: 1,
	pending: 0
};

/**
 * Pick the row carrying the more recent deliberate user action. Each row
 * exposes a per-status timestamp:
 *   - `lastDrilledAt` is set when the row is `corrected`.
 *   - `dismissedAt` (v2+) is set when the row is `dismissed`.
 *   - `detectedAt` is the floor for unstamped pre-v2 rows.
 * Whichever row has the higher action timestamp wins outright — that's
 * the right behaviour for both the "I dismissed this on phone, then the
 * laptop autoscan drilled it" and "I drilled it on laptop, then I
 * dismissed it on phone" cases. The status of the winner is preserved.
 *
 * Pending rows are pinned below any non-pending row regardless of
 * timestamp: a re-detected pending mistake on one device shouldn't
 * un-correct or un-dismiss the same mistake on the other.
 */
export function mergeMistake(local: StoredMistake, remote: StoredMistake): StoredMistake {
	const lr = STATUS_RANK[local.status];
	const rr = STATUS_RANK[remote.status];
	if (rr > lr) return remote;
	if (lr > rr) return local;

	const lAction = actionTimestamp(local);
	const rAction = actionTimestamp(remote);
	if (rAction > lAction) return remote;
	if (lAction > rAction) return local;

	// Truly equal action timestamps: prefer whichever row drilled more
	// times, then prefer the one detected later (stable sort).
	if (remote.correctCount !== local.correctCount) {
		return remote.correctCount > local.correctCount ? remote : local;
	}
	return remote.detectedAt >= local.detectedAt ? remote : local;
}

/**
 * Pick the timestamp that represents this row's most recent deliberate
 * user action. `lastDrilledAt` for corrected, `dismissedAt` for dismissed
 * (or `detectedAt` if a pre-v2 row didn't capture one), `detectedAt` for
 * pending — pending is never the "deliberate action" but the floor lets
 * us tie-break across rows that lack the richer fields.
 */
function actionTimestamp(m: StoredMistake): number {
	if (m.status === 'corrected') return m.lastDrilledAt ?? m.detectedAt;
	if (m.status === 'dismissed') return m.dismissedAt ?? m.detectedAt;
	return 0;
}

// --- Empirical gaps --------------------------------------------------------

/**
 * Sum-merge with game-id dedup. Each row tracks the set of game IDs that
 * contributed to its `count`; the merge unions both sides' sets, and `count`
 * becomes the size of the union. That's the only correct shape — naive sum
 * would double-count overlapping scans, naive max would lose hits one device
 * saw and the other didn't.
 *
 * Pre-v2 rows had only `lastGameId` to go on. We promote that to a
 * single-element set so older rows degrade gracefully (occasionally
 * over-counting by 1 when a game truly was seen by both sides).
 */
export function mergeEmpiricalGap(local: EmpiricalGap, remote: EmpiricalGap): EmpiricalGap {
	const localIds = new Set(local.gameIds ?? (local.lastGameId ? [local.lastGameId] : []));
	const remoteIds = new Set(remote.gameIds ?? (remote.lastGameId ? [remote.lastGameId] : []));
	for (const id of remoteIds) localIds.add(id);
	const merged = Array.from(localIds);
	const newer = remote.lastSeenAt >= local.lastSeenAt ? remote : local;
	return {
		...local,
		fen: newer.fen,
		count: Math.max(local.count, remote.count, merged.length),
		firstSeenAt: Math.min(local.firstSeenAt, remote.firstSeenAt),
		lastSeenAt: Math.max(local.lastSeenAt, remote.lastSeenAt),
		lastGameId: newer.lastGameId,
		gameIds: merged.slice(-500)
	};
}

// --- Position WDL ----------------------------------------------------------

/**
 * Union-merge by `countedGameIds`. The row already carries a per-game
 * dedup set — we just union the two sides and recompute the W/D/L counts
 * from the union's size by preserving the larger of the two for each
 * outcome. This is conservative: we trust whoever counted more, since
 * both can be right (both devices saw different game subsets) and there's
 * no per-game outcome record on the row to reconstruct.
 */
export function mergePositionWdl(local: PositionWdlRow, remote: PositionWdlRow): PositionWdlRow {
	const counted = new Set(local.countedGameIds);
	for (const id of remote.countedGameIds) counted.add(id);
	const merged = Array.from(counted).slice(-500);
	// We can't sum w/d/b across devices because each row already counted
	// its own contribution; but we can take the max per term (the device
	// that saw more games of each outcome contributed more). After the
	// next scan that runs through `recordPositionWdlHits`, the actual
	// per-game tally will be authoritative again.
	return {
		...local,
		white: Math.max(local.white, remote.white),
		draws: Math.max(local.draws, remote.draws),
		black: Math.max(local.black, remote.black),
		games: Math.max(local.games, remote.games, merged.length),
		countedGameIds: merged,
		lastSeenAt: Math.max(local.lastSeenAt, remote.lastSeenAt)
	};
}

// --- Spar games ------------------------------------------------------------

/**
 * Spar games are practically immutable once `analysed`. The merge prefers
 * the analysed-side row over a pending one; among equal statuses, the one
 * with the more recent `lastCheckedAt` wins. The `result` payload comes
 * with the chosen row.
 */
export function mergeSparGame(local: SparGame, remote: SparGame): SparGame {
	const localAnalysed = local.status === 'analysed';
	const remoteAnalysed = remote.status === 'analysed';
	if (remoteAnalysed && !localAnalysed) return remote;
	if (localAnalysed && !remoteAnalysed) return local;
	const lc = local.lastCheckedAt ?? 0;
	const rc = remote.lastCheckedAt ?? 0;
	return rc >= lc ? remote : local;
}

// --- Repertoire row ---------------------------------------------------------

export function mergeRepertoire(local: Repertoire, remote: Repertoire): Repertoire {
	return remote.updatedAt >= local.updatedAt ? remote : local;
}

// --- Tree (nodes + their edges) --------------------------------------------

/**
 * Per-edge union with field-LWW on `annotation` / `weight`. Adds win against
 * deletes — an edge that exists on either side is in the merged result.
 *
 * Returned object exposes both the merged node and a count of edges that
 * the merge changed (added, dropped, or had a field overwritten) so the
 * caller can include it in the merge log.
 */
export function mergeNode(
	local: RepertoireNode,
	remote: RepertoireNode
): { merged: RepertoireNode; edgeChanges: number } {
	const localUpdated = local.updatedAt ?? 0;
	const remoteUpdated = remote.updatedAt ?? 0;
	// Per-node fields (`comment`, `nags`) field-LWW.
	const newer = remoteUpdated > localUpdated ? remote : local;
	const merged: RepertoireNode = {
		repertoireId: local.repertoireId,
		fenKey: local.fenKey,
		comment: newer.comment,
		nags: newer.nags ? [...newer.nags] : undefined,
		updatedAt: Math.max(localUpdated, remoteUpdated) || undefined,
		children: []
	};

	const byTo = new Map<string, Edge>();
	let changes = 0;
	for (const e of local.children) byTo.set(e.toFenKey, { ...e });
	for (const re of remote.children) {
		const existing = byTo.get(re.toFenKey);
		if (!existing) {
			byTo.set(re.toFenKey, { ...re });
			changes += 1;
			continue;
		}
		const ls = existing.updatedAt ?? 0;
		const rs = re.updatedAt ?? 0;
		if (rs > ls) {
			byTo.set(re.toFenKey, { ...re });
			changes += 1;
		} else if (ls === rs && ls === 0) {
			// Two unstamped edges to the same target — pick remote arbitrarily
			// for stability; only count as a change if the fields differ.
			if (
				existing.annotation !== re.annotation ||
				existing.weight !== re.weight ||
				existing.san !== re.san ||
				existing.uci !== re.uci
			) {
				byTo.set(re.toFenKey, { ...re });
				changes += 1;
			}
		}
	}
	merged.children = [...byTo.values()];
	return { merged, edgeChanges: changes };
}

// --- Baselines -------------------------------------------------------------

export function mergeBaseline(
	local: StoredBaselineBucket,
	remote: StoredBaselineBucket
): StoredBaselineBucket {
	return remote.computedAt >= local.computedAt ? remote : local;
}

// --- Single-row globals (savedAt / fetchedAt LWW) --------------------------

export interface DossierReportLite {
	savedAt: number;
	version: number;
	payload: unknown;
}

export function mergeDossierReport(
	local: DossierReportLite | null,
	remote: DossierReportLite | null
): DossierReportLite | null {
	if (!local) return remote;
	if (!remote) return local;
	return remote.savedAt >= local.savedAt ? remote : local;
}

export interface MastersBaselineLite {
	fetchedAt: number;
	targetsHash: string;
	payload: unknown;
}

export function mergeMastersBaseline(
	local: MastersBaselineLite | null,
	remote: MastersBaselineLite | null
): MastersBaselineLite | null {
	if (!local) return remote;
	if (!remote) return local;
	return remote.fetchedAt >= local.fetchedAt ? remote : local;
}

// --- Settings (whole-object with collection-aware sub-fields) --------------

import type { AppSettings } from '$lib/types';
import { pruneRepTombstones } from '$lib/storage/settings';

/**
 * Whole-object LWW — but two collection fields get set-union semantics
 * because losing a `scanAccounts` entry the user added on the other
 * device would be silently destructive.
 */
export function mergeSettings(local: AppSettings, remote: Partial<AppSettings>): AppSettings {
	const merged: AppSettings = { ...local, ...remote, key: 'root' };

	// scanAccounts: union by (source, lower-username).
	const scanSeen = new Set<string>();
	const scan: NonNullable<AppSettings['scanAccounts']> = [];
	for (const a of [...(local.scanAccounts ?? []), ...(remote.scanAccounts ?? [])]) {
		const k = `${a.source}:${a.username.toLowerCase()}`;
		if (scanSeen.has(k)) continue;
		scanSeen.add(k);
		scan.push(a);
	}
	merged.scanAccounts = scan.length > 0 ? scan : undefined;

	// viewedWalkthroughGames: union by id, keep the later viewedAt, then re-cap.
	const seen = new Map<string, { id: string; viewedAt: number }>();
	for (const v of [
		...(local.viewedWalkthroughGames ?? []),
		...(remote.viewedWalkthroughGames ?? [])
	]) {
		const prev = seen.get(v.id);
		if (!prev || v.viewedAt > prev.viewedAt) seen.set(v.id, v);
	}
	const viewed = [...seen.values()].sort((a, b) => b.viewedAt - a.viewedAt).slice(0, 200);
	merged.viewedWalkthroughGames = viewed.length > 0 ? viewed : undefined;

	// repTombstones: union by repId (latest deletedAt wins), pruned by TTL.
	// A deletion recorded on either device must survive the merge, else a
	// rep deleted on device A would never propagate to device B.
	const tombstones = pruneRepTombstones(
		[...(local.repTombstones ?? []), ...(remote.repTombstones ?? [])],
		Date.now()
	);
	merged.repTombstones = tombstones.length > 0 ? tombstones : undefined;

	return merged;
}
