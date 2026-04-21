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
	 * `chapterId` tracks the chapter most recently created by a push so the
	 * next push can delete+replace it rather than leaving stale chapters.
	 */
	lichessStudy?: LichessStudyLink | null;
}

export interface LichessStudyLink {
	studyId: string;
	studyName: string;
	/**
	 * IDs of chapters created by the last push. One push may produce several
	 * chapters — we chapterize the tree at its first branching node so a study
	 * like a 1.e4 repertoire ends up as "1.e4 c5", "1.e4 e5", etc. rather than
	 * one monolithic chapter. Used on the next push to delete-then-replace so
	 * we don't stack duplicates; chapters the user created manually on Lichess
	 * stay untouched because we only delete IDs we saved ourselves.
	 */
	chapterIds?: string[];
	lastSyncedAt?: number;
	lastSyncDirection?: 'push' | 'pull';
}

export interface Edge {
	san: string;
	uci: string;
	toFenKey: string;
	annotation?: string;
	weight?: number;
}

export interface RepertoireNode {
	repertoireId: string;
	fenKey: string;
	comment?: string;
	nags?: number[];
	children: Edge[];
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

export interface AppSettings {
	key: 'root';
	theme: 'dark' | 'light';
	boardTheme: string;
	pieceSet: string;
	fsrsParams: FSRSParameters;
	dailyNewCardCap: number;
	drillSessionCap: number;
	drillIntroSpeed: DrillIntroSpeed;
	explorerSpeeds: string[];
	explorerRatings: number[];
	lichessApiToken: string;
	lichessOAuth: LichessOAuthToken | null;
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
