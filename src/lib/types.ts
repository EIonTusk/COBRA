import type { Card as FsrsCard, FSRSParameters } from 'ts-fsrs';

export type Color = 'white' | 'black';

export interface CoverageSnapshot {
	covered: number;
	needed: number;
	ratio: number;
	rootGames: number;
	thresholdGames: number;
	probed: number;
	incomplete: boolean;
	computedAt: number;
	goal: number;
	/**
	 * Total edges in the repertoire tree at compute time. Used to detect
	 * tree mutations (adds/removes from the builder) so the overview page
	 * can auto-recompute when the snapshot is structurally stale, even if
	 * the coverage goal itself hasn't moved. Optional for back-compat with
	 * snapshots stored before the field was introduced.
	 */
	edgeCount?: number;
}

export interface Repertoire {
	id: string;
	name: string;
	color: Color;
	rootFen: string;
	rootFenKey: string;
	createdAt: number;
	updatedAt: number;
	coverageGoal?: number | null;
	coverageSnapshot?: CoverageSnapshot | null;
	/**
	 * Optional link to a private (or public) Lichess study. When set, the
	 * repertoire can be synced to/from that study from the lichess-sync page.
	 * Chapters are tracked by name+hash in the link so pushes only re-upload
	 * what actually changed.
	 */
	lichessStudy?: LichessStudyLink | null;
	/**
	 * Starting position for game analysis, as an EPD fenKey. When the user
	 * plays a game, mistake/gap analysis against this repertoire only kicks
	 * in once this position is reached — games that never transpose here
	 * are skipped for this rep entirely. When `undefined` the analyzer
	 * falls back to the *nearest branching node* (walk down from the root
	 * following the unique child until 0 or 2+ children), so a rep that
	 * starts "1.e4 e5 2.Nf3 Nc6 …" auto-activates once 2.Nf3 Nc6 is on the
	 * board even without the user configuring anything. `null` means the
	 * user explicitly opted into the repertoire's rootFenKey (rare — only
	 * useful for reps whose root already has multiple children but the
	 * user wants to gate at the root anyway).
	 */
	startingFenKey?: string | null;
}

/**
 * One chapter that we pushed to Lichess, with the hash of its PGN at push
 * time. On the next push we chapterize the current tree, hash each chapter,
 * and compare name-groups: unchanged groups are reused verbatim (no delete,
 * no re-upload), so small edits don't churn every chapter ID or hit the
 * Lichess rate limiter unnecessarily.
 */
export interface LichessStudyChapter {
	/** Lichess chapter ID. */
	id: string;
	/** Local chapter name — the SAN move-path produced by chapterizeRepertoire. */
	name: string;
	/** SHA-256 hex of the PGN pushed for this chapter. */
	hash: string;
}

export interface LichessStudyLink {
	studyId: string;
	studyName: string;
	/**
	 * @deprecated Replaced by `chapters`. Retained only so that links written
	 * by pre-diff-sync builds can still be cleaned up on their first
	 * post-upgrade push — those IDs are all deleted and their content
	 * re-uploaded into the new name+hash format. New writes leave this empty.
	 */
	chapterIds?: string[];
	/**
	 * Per-chapter records from the last push, keyed by local chapter name.
	 * One push may produce several chapters — we chapterize the tree at its
	 * first branching node so a 1.e4 repertoire ends up as "1.e4 c5",
	 * "1.e4 e5", etc. rather than one monolithic chapter. Chapters the user
	 * created manually on Lichess stay untouched because we only delete IDs
	 * we saved here.
	 */
	chapters?: LichessStudyChapter[];
	lastSyncedAt?: number;
	lastSyncDirection?: 'push' | 'pull';
}

export interface Edge {
	san: string;
	uci: string;
	toFenKey: string;
	annotation?: string;
	weight?: number;
	/**
	 * When true, this move is shelved: it stays in the repertoire and is
	 * visible (greyed) in the builder, but drilling skips it and everything
	 * in the continuation reachable only through it. Flagged on the *head*
	 * edge the user disabled — the "whole continuation" behaviour is derived
	 * at read time by walking non-disabled edges (see `liveReachableFenKeys`),
	 * so a position that still transposes into a live line stays trainable.
	 * Optional/back-compat: absent means "not disabled". Carried across
	 * devices by the sync-v2 edge LWW (the whole edge is swapped by
	 * `updatedAt`, so no separate merge handling is needed).
	 */
	disabled?: boolean;
	/**
	 * Wall-clock ms-since-epoch of the most recent write to this edge.
	 * Populated by the storage layer on every mutation; used by the
	 * sync v2 merge to break ties on `annotation`/`weight`/`disabled`
	 * collisions across devices. Optional for back-compat with edges written
	 * before the field existed — sync v2 treats missing values as "older than
	 * any explicit timestamp" and lets a stamped row win.
	 */
	updatedAt?: number;
}

/**
 * Tombstone for an edge that was deleted from a node. Sync v2 carries these
 * on the parent node so a variation deletion propagates across devices
 * instead of being resurrected by the adds-win-against-deletes edge union.
 * Mirrors the repertoire-level `repTombstones` mechanism, one level down.
 */
export interface EdgeTombstone {
	/** Target position of the edge that was removed. */
	toFenKey: string;
	/** Wall-clock ms-since-epoch of the deletion. */
	deletedAt: number;
}

export interface RepertoireNode {
	repertoireId: string;
	fenKey: string;
	comment?: string;
	nags?: number[];
	children: Edge[];
	/**
	 * Wall-clock ms-since-epoch of the most recent write to this node's
	 * own fields (`comment`/`nags`). Optional for back-compat — pre-v2
	 * rows have no timestamp, so the merge treats them as "missing" and
	 * yields to whichever side has an explicit one.
	 */
	updatedAt?: number;
	/**
	 * Edges deleted from this node, with the time they were deleted. The
	 * sync v2 merge drops an edge whose `updatedAt` is at or before a
	 * tombstone's `deletedAt`; a newer re-add wins and clears the tombstone.
	 * Garbage-collected past `EDGE_TOMBSTONE_TTL_MS`. Optional/back-compat —
	 * absent on every node written before this field existed.
	 */
	deletedChildren?: EdgeTombstone[];
}

export interface Card {
	repertoireId: string;
	fenKey: string;
	expectedSan: string;
	fsrs: FsrsCard;
	lastReview?: number;
	dueAt: number;
}

/**
 * Free-text flashcard attached to a position. Scheduled by FSRS like move
 * cards, but graded by self-assessment rather than a played move: the
 * drill shows the prompt, the user thinks, then reveals the answer and
 * picks Again/Hard/Good/Easy. Typical use: "What's the plan for White
 * here?", "Where does the bad bishop go?", "Why is …c5 premature?"
 *
 * Keyed by (repertoireId, fenKey) — one idea per position. Multi-idea
 * can come later if it turns out to be needed.
 */
export interface IdeaCard {
	repertoireId: string;
	fenKey: string;
	prompt: string;
	answer?: string;
	fsrs: FsrsCard;
	lastReview?: number;
	dueAt: number;
	createdAt: number;
}

/**
 * One pinned bundle of board annotations attached to a position. Originally
 * built only by the middle-game guide flow (`source: 'guide'`), but the
 * shape is intentionally generic — the same store will hold engine-PV
 * snapshots and free-form user arrows in future PRs. New sources should
 * keep top-level fields that don't apply (e.g. `gamesUsable`,
 * `openingName`) absent; the storage helper normalises missing `source`
 * to `'guide'` for back-compat with rows written before the discriminator
 * existed.
 */
export interface SavedGuideArrow {
	/** Origin square, e.g. "e2". For circles this is the only square. */
	orig: string;
	/**
	 * Destination square. When omitted, the shape is rendered as a circle on
	 * `orig` instead of an arrow — used for weakness markers ("squares the
	 * opponent commonly lands on" and the converse).
	 */
	dest?: string;
	/** chessground brush name (green / yellow / paleBlue / paleRed / purple / …). */
	brush: string;
	/** Optional arrow thickness override. Ignored for circle shapes. */
	lineWidth?: number;
}

/**
 * Where a saved annotation came from. `guide` = generated by the
 * middle-game-guide masters aggregator. `manual` = drawn by hand in the
 * editor (planned). `engine` = snapshot of an engine PV (planned). The
 * discriminator drives UI affordances (which control deletes vs.
 * regenerates) and tells the drill which overlays to paint when the
 * user has only opted into a subset.
 */
export type SavedGuideSource = 'guide' | 'manual' | 'engine';

/**
 * Serialisable subset of `AttackSquareStat` (from `middlegame/aggregate.ts`).
 * Persisted on a saved guide so the heatmap subpage can render the full
 * per-square pressure distribution without re-fetching master games.
 * `count` is master-lines (not plies); `captureCount` is the subset of
 * those lines where the landing was a capture.
 */
export interface SavedAttackSquare {
	square: string;
	attacker: Color;
	count: number;
	captureCount: number;
}

export interface SavedMiddlegameGuide {
	repertoireId: string;
	fenKey: string;
	arrows: SavedGuideArrow[];
	/**
	 * Where this annotation came from. Optional on the type so existing
	 * (pre-discriminator) rows still satisfy it; the storage helper fills
	 * missing values with `'guide'` on read. New writes should always set
	 * this explicitly.
	 */
	source?: SavedGuideSource;
	/**
	 * How many master games the aggregate behind these arrows was based on.
	 * Only meaningful when `source === 'guide'`.
	 */
	gamesUsable?: number;
	/**
	 * How many master games we *queried* for the aggregate — i.e. the count
	 * returned by the explorer's `topGames` request. The ratio
	 * `gamesUsable / gamesQueried` is a transposition-health signal: a low
	 * ratio means most top masters reach this position via a different move
	 * order than the repertoire's, which the editor surfaces as a tag.
	 * Only meaningful when `source === 'guide'`.
	 */
	gamesQueried?: number;
	/**
	 * Lichess-named opening at this position when known, else null. Only
	 * meaningful when `source === 'guide'`.
	 */
	openingName?: string | null;
	/**
	 * Full per-square attack-pressure distribution from the master-game
	 * aggregate the arrows were derived from. Powers the heatmap subpage
	 * (sortable + side-filterable per-position view). Only meaningful
	 * when `source === 'guide'`; absent on rows saved before the heatmap
	 * feature shipped.
	 */
	attackSquares?: SavedAttackSquare[];
	/**
	 * Denominator (master lines kept in the aggregate) for any percentage
	 * computed from `attackSquares.count`. Mirrors `MiddlegameAggregate.totalLines`.
	 */
	totalLines?: number;
	/**
	 * The full serialised aggregate the arrows + heatmap were derived
	 * from. Captured so downstream consumers (plan-card generator,
	 * future analysis tools) can recover the structured pawn-move /
	 * piece-journey / next-move data without re-running the masters
	 * fetch. `MiddlegameAggregate` is already plain-JSON serialisable
	 * (no chessops types, no functions) so it survives the
	 * JSON-roundtrip the storage helper performs on write.
	 *
	 * Optional for back-compat — guides pinned before this field shipped
	 * still satisfy the type; plan-card auto-generation just won't fire
	 * for those until they're regenerated.
	 */
	aggregate?: SerializedMiddlegameAggregate;
	createdAt: number;
	updatedAt: number;
}

/**
 * JSON-safe twin of `MiddlegameAggregate` from `$lib/middlegame/aggregate.ts`.
 * Declared here in `types.ts` so the storage layer doesn't have to import
 * from `middlegame/` (which pulls in chessops). Shape must stay in sync
 * with `MiddlegameAggregate`.
 */
export interface SerializedMiddlegameAggregate {
	totalLines: number;
	pliesWindow: number;
	topNextMoves: Array<{ san: string; uci: string; count: number }>;
	pawnMoves: Array<{
		color: Color;
		san: string;
		from: string;
		to: string;
		isCapture: boolean;
		count: number;
	}>;
	pieceJourneys: Array<{
		color: Color;
		role: 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn';
		from: string;
		to: string;
		count: number;
	}>;
	castling: {
		white: { short: number; long: number };
		black: { short: number; long: number };
	};
	attackSquares: SavedAttackSquare[];
}

/**
 * Auto-generated study card asking "what's the typical plan here?". The
 * prompt and answer are baked from a `SavedMiddlegameGuide.aggregate` at
 * save time, so drilling doesn't need to re-query masters. Keyed by
 * (repertoireId, fenKey) — one plan card per position, replacing the
 * prior answer when a saved guide is updated.
 *
 * Scheduled by FSRS in a *separate* drill mode (`/repertoire/[id]/plan-drill`),
 * not mixed into the move-card drill: structural-plan thinking is a
 * different cognitive task from move recall and interleaving the two
 * hurts both.
 */
export interface PlanCard {
	repertoireId: string;
	fenKey: string;
	/** The structured side the plan is for — usually the rep's colour. */
	planForColor: Color;
	prompt: string;
	answer: string;
	fsrs: FsrsCard;
	lastReview?: number;
	dueAt: number;
	createdAt: number;
	/** Lichess opening name at this position when known, for the drill UI to label cards. */
	openingName?: string | null;
}

export type DrillIntroSpeed = 'off' | 'fast' | 'normal' | 'slow' | 'slowest';

export interface LichessOAuthToken {
	accessToken: string;
	tokenType: string;
	expiresAt: number;
	scopes: string[];
	username?: string;
}

/**
 * Account to include when the mistake scanner runs. Multiple entries
 * are scanned in series; each one's username is queried on its own
 * platform (Lichess NDJSON or chess.com public archives).
 */
export interface ScanAccount {
	source: 'lichess' | 'chesscom';
	username: string;
}

/**
 * Multi-device sync settings. Off by default (beta). When enabled, COBRA
 * mirrors local IDB state to a private "COBRA Sync" Lichess study, one
 * chapter per repertoire plus one GLOBAL chapter for non-rep data.
 *
 * `studyId` is set on first-run setup. `deviceId` is generated once per
 * device and embedded in pushed payloads so the conflict UI can name
 * which other device wrote a competing version. `lastKnownRevisions`
 * tracks the revision counter we expect to see for each chapter — a
 * higher remote revision triggers the conflict prompt instead of a
 * silent overwrite.
 */
export type SyncBackend = 'lichess' | 'cloudflare';

export interface SyncSettings {
	enabled: boolean;
	/**
	 * Which sync transport is active. `'lichess'` (default) stores blobs in a
	 * private Lichess study; `'cloudflare'` uses a hosted Worker + D1 backend
	 * (issue #68 — no per-chapter size ceiling). Chosen before enabling.
	 */
	backend?: SyncBackend;
	/** Worker origin when `backend === 'cloudflare'`. */
	cloudflareUrl?: string;
	studyId?: string;
	deviceId?: string;
	lastPushAt?: number;
	lastPullAt?: number;
	/**
	 * Map keyed by sync scope → last revision we wrote/read. Scope keys are
	 * `'global'`, `'rep-core:<id>'`, `'rep-telemetry:<id>'`, or the legacy
	 * `'rep:<id>'` for pre-split combined scopes.
	 */
	lastKnownRevisions?: Record<string, number>;
	/**
	 * Sync the bulky per-rep telemetry tier (mistakes / gaps / spar games /
	 * position WDL) in addition to the always-synced authored tree. Off by
	 * default (issue #68) — telemetry is regenerable scan data and the main
	 * driver of oversized payloads.
	 */
	syncTelemetry?: boolean;
}

export interface AppSettings {
	key: 'root';
	theme: 'dark' | 'light';
	boardTheme: string;
	pieceSet: string;
	fsrsParams: FSRSParameters;
	dailyNewCardCap: number;
	drillSessionCap: number;
	drillIntroSpeed: DrillIntroSpeed;
	/**
	 * Controls how the drill handles user-side positions in a line that
	 * aren't strictly due today. 'play' walks the line from the head and
	 * asks the user for every user move along the way; those prefix moves
	 * are graded like any other review (correct credits the card, wrong
	 * lapses it), once per session. 'auto' animates straight to the due card
	 * without stopping at prior positions. Defaults to 'play'.
	 */
	drillIntermediateMoves?: 'auto' | 'play';
	/**
	 * Stability threshold in days for treating a line-walk prefix/suffix
	 * card as "well-learned": a graduated FSRS card whose stability is at
	 * or above this value gets animated past during the lead-in instead
	 * of pulled into the drill. Lower values keep more cards in the pool
	 * (drill them again every session); higher values trust the schedule
	 * sooner and animate past faster. Defaults to 7.
	 */
	drillWellLearnedDays?: number;
	explorerSpeeds: string[];
	explorerRatings: number[];
	lichessApiToken: string;
	lichessOAuth: LichessOAuthToken | null;
	/**
	 * Scopeless Lichess token used ONLY to prove identity to the Cloudflare
	 * sync backend. Kept separate from `lichessOAuth` so the powerful
	 * study/challenge token never leaves the client; device-local, never synced.
	 */
	syncIdentityToken?: LichessOAuthToken | null;
	lastMistakeScanAt?: number;
	/**
	 * Created-at timestamp of the most recent Lichess game already scanned
	 * for mistakes. The dashboard's auto-scan uses `since = this + 1` so
	 * only genuinely new games get streamed each visit.
	 */
	lastScannedGameAt?: number;
	/**
	 * Extra accounts to sweep on every mistake auto-scan. The Lichess
	 * OAuth username (if connected) is scanned regardless — these are
	 * *additional* usernames across both Lichess and chess.com. Dedup
	 * is by (source, username) during the scan.
	 */
	scanAccounts?: ScanAccount[];
	/**
	 * Lower bound (ms since epoch) applied to every game-querying scan —
	 * mistakes, dossier, opponent prep, autobuild. Useful when the player's
	 * recent games stop being representative: returning after a long break,
	 * a sharp rating jump, a deliberate style shift. Empty / undefined =
	 * no cutoff (keep the last-N behaviour). Lichess passes this server-side
	 * as `since=<ms>`; chess.com filters client-side after fetching.
	 */
	gamesSince?: number;
	/**
	 * When true, the dossier review asks Lichess for per-move `%eval`
	 * annotations and adopts them wherever Fishnet has analysed the game.
	 * Adopted moves skip the local Stockfish pass — faster and typically
	 * deeper for those moves. Ungated games fall back to the local
	 * engine unchanged. No effect on chess.com games. Defaults to true;
	 * see Settings → Lichess.
	 */
	useLichessServerEval?: boolean;
	/**
	 * When true, the Explorer in the editor annotates each candidate move
	 * with a fit score derived from the most recent dossier scan. Disabled
	 * by default — requires a dossier scan to produce meaningful output.
	 */
	styleAdviceEnabled?: boolean;
	/**
	 * Master toggle for UI sounds (move / capture / correct / incorrect).
	 * Defaults to enabled.
	 */
	soundsEnabled?: boolean;
	/**
	 * Master volume multiplier for UI sounds, 0–1. Defaults to 1.
	 */
	soundsVolume?: number;
	/**
	 * When true, opening the builder and starting a drill session jump
	 * straight to the repertoire's starting position instead of the rep
	 * root. Pairs with the per-rep `startingFenKey` (or its auto-detected
	 * nearest-branching-node fallback) — reps with a deep starting
	 * position skip the forced prefix entirely, so the user lands on the
	 * first position where there's a real choice. Defaults to enabled; the
	 * builder honours it only on a fresh open (no `?jump=` deep-link, no
	 * prep walk-through), so existing flows aren't hijacked.
	 */
	openAtStartingPosition?: boolean;
	/**
	 * IDs of masters/Lichess games the user has already opened in the
	 * walkthrough page. Used to keep the dashboard's "Recommended
	 * walkthrough" rotating through fresh games instead of resurfacing the
	 * same one each session. Capped to the most-recent 200 entries to keep
	 * the settings record small.
	 */
	viewedWalkthroughGames?: Array<{ id: string; viewedAt: number }>;
	/**
	 * Multi-device sync via private Lichess study (Beta). Off by default;
	 * users opt in from Settings → Sync. See `SyncSettings`.
	 */
	sync?: SyncSettings;
	/**
	 * Deletion tombstones for repertoires removed on this (or any synced)
	 * device. Sync is otherwise additive ("adds win against deletes"), so
	 * without an explicit record a repertoire deleted on one device would be
	 * resurrected from another device's still-present sync chapter on the
	 * next pull. Each entry carries the deleted rep's id and the wall-clock
	 * ms-since-epoch of the deletion; the pull path removes a local rep whose
	 * tombstone is newer than the rep's own `updatedAt`, and skips applying
	 * any sync chapter the tombstone supersedes. Union-merged across devices
	 * (keep the latest `deletedAt` per id) and pruned by TTL — see
	 * `mergeSettings` / `pruneRepTombstones`.
	 */
	repTombstones?: RepTombstone[];
	/**
	 * When true, the drill paints saved middle-game guide arrows on the
	 * board whenever a saved guide exists for the current position. Off
	 * by default — the drill is normally a "play the move" workflow and
	 * not every user wants the strategic overlay. Editor save/load is
	 * unaffected by this flag (always available).
	 */
	showMiddlegameGuides?: boolean;
}

/** A record that a repertoire was deleted, propagated through sync so the
 *  deletion reaches every device. See `AppSettings.repTombstones`. */
export interface RepTombstone {
	repId: string;
	/** Wall-clock ms-since-epoch of the deletion. */
	deletedAt: number;
}

export interface StoredMistake {
	id: string; // composite gameId:repertoireId:fenKey
	gameId: string;
	gameUrl: string;
	playedAt: number;
	detectedAt: number;
	speed: string;
	opponent: string;
	color: Color;
	repertoireId: string;
	repertoireName: string;
	fenKey: string;
	fen: string;
	playedSan: string;
	expectedSan: string;
	plyOffTree: number;
	status: 'pending' | 'corrected' | 'dismissed';
	correctCount: number;
	lastDrilledAt?: number;
	/**
	 * Wall-clock ms-since-epoch the row was last marked `dismissed`. Lets
	 * the sync v2 merge break ties between a `dismissed` row on one device
	 * and a `corrected` row on another by picking the more recent
	 * deliberate action. Pre-v2 dismissed rows have no value here and
	 * yield to any stamped row of either status. Cleared back to
	 * `undefined` if a row is later un-dismissed (not a flow today, but
	 * documented for the future).
	 */
	dismissedAt?: number;
}

/**
 * A position, derived from scanned Lichess games, where the user ran out of
 * prep — either hit a known user-side leaf empty of replies, or the opponent
 * played a move that took them to a position not yet in the tree. `fenKey`
 * always points at the last in-tree node before prep was exhausted, so it's
 * guaranteed to be jumpable from the repertoire root.
 */
export interface EmpiricalGap {
	id: string; // composite `${repertoireId}:${fenKey}`
	repertoireId: string;
	fenKey: string;
	fen: string;
	count: number;
	firstSeenAt: number;
	lastSeenAt: number;
	lastGameId: string;
	/**
	 * Game IDs that have already been counted into `count`. Sync v2's
	 * sum-merge uses the union of two devices' sets so overlapping scans
	 * don't double-count. Capped at ~500 most-recent entries to keep the
	 * row size bounded; older IDs fall off but `count` keeps the running
	 * total. Optional for back-compat with rows written before the field
	 * existed — the v2 merge treats missing values as `[lastGameId]`.
	 */
	gameIds?: string[];
}

export const DRILL_INTRO_MS: Record<DrillIntroSpeed, number> = {
	off: 0,
	fast: 200,
	normal: 300,
	slow: 400,
	slowest: 500
};

/**
 * A "spar" game — a Lichess bot challenge launched from inside Cobra.
 * Stored when the challenge fires; reconciled (PGN pulled, deviations
 * detected) once the game is over. Acts as the ledger the "Recent spar"
 * strip reads from and the mistake pipeline routes through.
 */
export interface SparGame {
	/** Lichess game id. Also the IDB primary key. */
	id: string;
	repertoireId: string;
	repertoireName: string;
	/** FEN we launched the challenge from (board state at launch time). */
	startFen: string;
	/** Whose side we're playing in this game — derived from challenge colour. */
	userColor: Color;
	opponent: 'stockfish' | 'maia';
	opponentLabel: string;
	/** Numeric difficulty for sorting/display — SF level 1–8 or Maia 1100/1500/1900. */
	opponentStrength: number;
	gameUrl: string;
	startedAt: number;
	/**
	 * Reconciliation state:
	 *   pending  — game not yet known to be over; will retry on next visit
	 *   analysed — PGN pulled, deviation check run, any mistake saved
	 *   error    — PGN fetch or analysis failed (transient, retried)
	 */
	status: 'pending' | 'analysed' | 'error';
	/** Present when `status === 'analysed'`. */
	result?: {
		/** 'win' | 'loss' | 'draw' | 'unfinished' from the user's perspective. */
		outcome: 'win' | 'loss' | 'draw' | 'unfinished';
		/** Ply count in the game. */
		plies: number;
		/**
		 * First off-tree user move, if any. When present, a matching
		 * StoredMistake was also written to the mistakes pipeline.
		 */
		deviationPly?: number;
		deviationFenKey?: string;
		deviationPlayedSan?: string;
		deviationExpectedSan?: string;
	};
	/** Last reconciliation attempt — used to throttle retries. */
	lastCheckedAt?: number;
	/** Error message from the last failed reconcile, if any. */
	lastError?: string;
}
