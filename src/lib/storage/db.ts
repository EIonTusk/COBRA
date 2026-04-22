import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
	Repertoire,
	RepertoireNode,
	Card,
	IdeaCard,
	AppSettings,
	StoredMistake,
	EmpiricalGap,
	SparGame
} from '$lib/types';

export interface ExplorerStatRow {
	key: string;
	fetchedAt: number;
	data: unknown;
}

/**
 * Single-row object store holding the most recent Dossier scan so the
 * /dossier page can re-render its diagnostic sections immediately on
 * navigation without forcing another full scan + engine pass. The
 * `version` tag lets us drop incompatible payloads when the
 * scan-result shape evolves — consumers compare it and clear on
 * mismatch.
 */
export interface StoredDossierReport {
	id: 'latest';
	savedAt: number;
	version: number;
	payload: unknown;
}

export interface BaselineAxisSd {
	forcing: number;
	capture: number;
	pawnPlay: number;
	queenside: number;
	earlyCastle: number;
}

export interface StoredBaselineBucket {
	id: string; // composite "${bucket}:${ratingMin}-${ratingMax}"
	bucket?: string;
	ratingMin: number | null;
	ratingMax: number | null;
	games: number;
	totalMoves: number;
	axes: {
		forcing: number;
		capture: number;
		pawnPlay: number;
		queenside: number;
		earlyCastle: number;
	};
	/**
	 * Per-axis population standard deviations in the peer bucket. Optional
	 * because older buckets were computed before this field existed — any
	 * consumer reading z-scores must fall back gracefully.
	 * Measured per-game (earlyCastle) or per-move (the rest) depending on
	 * the axis; see calibrate.ts for the specifics.
	 */
	axesSd?: BaselineAxisSd;
	tension: { releaseRate: number; creationRate: number };
	/** Optional SD of per-game releaseRate / creationRate across the peer sample. */
	tensionSd?: { releaseRate: number; creationRate: number };
	computedAt: number;
	source: 'self-calibrated';
	seedCount: number;
	sampledUsers: number;
	/**
	 * Optional v2 peer benchmark fields. Populated when the calibration
	 * was run with the "extend with engine" option. Old buckets omit
	 * these — consumers should check for presence before using.
	 */
	evalByPhaseColor?: BaselinePhaseColor;
	criticalMoments?: BaselineCriticalMoments;
	clockSpend?: BaselineClockSpend;
	evalGamesSampled?: number;
	evalMovesAnalysed?: number;
}

export interface BaselinePhaseStats {
	moves: number;
	avgCpLoss: number;
	/**
	 * Population SD of per-move CP loss in this phase-colour bucket.
	 * Optional for backward compatibility with buckets computed before
	 * the stats refactor. Required for z-score computation downstream.
	 */
	avgCpLossSd?: number;
	blunderRate: number;
	inaccuracyRate: number;
}

export type BaselinePhaseColor = {
	opening: { white: BaselinePhaseStats; black: BaselinePhaseStats };
	middle: { white: BaselinePhaseStats; black: BaselinePhaseStats };
	end: { white: BaselinePhaseStats; black: BaselinePhaseStats };
};

export interface BaselineCriticalMoments {
	conversionRate: number;
	conversionGames: number;
	defenseRate: number;
	defenseGames: number;
	equalityWinRate: number;
	equalityLossRate: number;
	equalityGames: number;
}

export interface BaselineClockSpend {
	/** Fraction of clock budget spent in each phase. Sums to ~1. */
	opening: number;
	middle: number;
	end: number;
	/** Fraction of blunders occurring in each phase. Sums to ~1. */
	blunderOpening: number;
	blunderMiddle: number;
	blunderEnd: number;
}

export interface OpeningTrainerDB extends DBSchema {
	repertoires: {
		key: string;
		value: Repertoire;
		indexes: { 'by-updated': number };
	};
	nodes: {
		key: [string, string];
		value: RepertoireNode;
		indexes: { 'by-repertoire': string };
	};
	cards: {
		key: [string, string];
		value: Card;
		indexes: {
			'by-repertoire': string;
			'by-due': number;
			'by-repertoire-due': [string, number];
		};
	};
	settings: {
		key: string;
		value: AppSettings;
	};
	explorer_stats: {
		key: string;
		value: ExplorerStatRow;
		indexes: { 'by-fetchedAt': number };
	};
	mistakes: {
		key: string;
		value: StoredMistake;
		indexes: {
			'by-status': 'pending' | 'corrected' | 'dismissed';
			'by-detectedAt': number;
			'by-repertoire': string;
		};
	};
	empirical_gaps: {
		key: string;
		value: EmpiricalGap;
		indexes: {
			'by-repertoire': string;
			'by-count': number;
		};
	};
	idea_cards: {
		key: [string, string];
		value: IdeaCard;
		indexes: {
			'by-repertoire': string;
			'by-due': number;
			'by-repertoire-due': [string, number];
		};
	};
	baselines: {
		key: string;
		value: StoredBaselineBucket;
	};
	style_reports: {
		key: string;
		value: StoredDossierReport;
	};
	spar_games: {
		key: string;
		value: SparGame;
		indexes: {
			'by-repertoire': string;
			'by-status': 'pending' | 'analysed' | 'error';
			'by-startedAt': number;
		};
	};
}

// IDB name kept as 'openingtrainer' (pre-COBRA-rename) so existing users'
// repertoires and cards survive the rebrand. Renaming would create a
// fresh empty DB and orphan their data.
const DB_NAME = 'openingtrainer';
const DB_VERSION = 13;
const REQUIRED_STORES = [
	'repertoires',
	'nodes',
	'cards',
	'settings',
	'explorer_stats',
	'mistakes',
	'empirical_gaps',
	'idea_cards',
	'baselines',
	'style_reports',
	'spar_games'
] as const;

let dbPromise: Promise<IDBPDatabase<OpeningTrainerDB>> | null = null;

// In dev, Vite HMR can re-evaluate this module and leave the previous
// IDBDatabase handle open on the old schema. That blocks subsequent
// version-upgrade opens, so the new stores never get created. Close the
// old handle before the module is replaced so the upgrade runs cleanly.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		dbPromise?.then((db) => db.close()).catch(() => undefined);
		dbPromise = null;
	});
}

type StoreName = (typeof REQUIRED_STORES)[number];

function ensureAllStores(db: IDBPDatabase<OpeningTrainerDB>) {
	const has = (name: StoreName) =>
		(db.objectStoreNames as unknown as { contains: (n: string) => boolean }).contains(name);
	if (!has('repertoires')) {
		const reps = db.createObjectStore('repertoires', { keyPath: 'id' });
		reps.createIndex('by-updated', 'updatedAt');
	}
	if (!has('nodes')) {
		const nodes = db.createObjectStore('nodes', { keyPath: ['repertoireId', 'fenKey'] });
		nodes.createIndex('by-repertoire', 'repertoireId');
	}
	if (!has('cards')) {
		const cards = db.createObjectStore('cards', { keyPath: ['repertoireId', 'fenKey'] });
		cards.createIndex('by-repertoire', 'repertoireId');
		cards.createIndex('by-due', 'dueAt');
		cards.createIndex('by-repertoire-due', ['repertoireId', 'dueAt']);
	}
	if (!has('settings')) db.createObjectStore('settings', { keyPath: 'key' });
	if (!has('explorer_stats')) {
		const ex = db.createObjectStore('explorer_stats', { keyPath: 'key' });
		ex.createIndex('by-fetchedAt', 'fetchedAt');
	}
	if (!has('mistakes')) {
		const m = db.createObjectStore('mistakes', { keyPath: 'id' });
		m.createIndex('by-status', 'status');
		m.createIndex('by-detectedAt', 'detectedAt');
		m.createIndex('by-repertoire', 'repertoireId');
	}
	if (!has('empirical_gaps')) {
		const g = db.createObjectStore('empirical_gaps', { keyPath: 'id' });
		g.createIndex('by-repertoire', 'repertoireId');
		g.createIndex('by-count', 'count');
	}
	if (!has('idea_cards')) {
		const ic = db.createObjectStore('idea_cards', { keyPath: ['repertoireId', 'fenKey'] });
		ic.createIndex('by-repertoire', 'repertoireId');
		ic.createIndex('by-due', 'dueAt');
		ic.createIndex('by-repertoire-due', ['repertoireId', 'dueAt']);
	}
	if (!has('baselines')) {
		db.createObjectStore('baselines', { keyPath: 'id' });
	}
	if (!has('style_reports')) {
		db.createObjectStore('style_reports', { keyPath: 'id' });
	}
	if (!has('spar_games')) {
		const sg = db.createObjectStore('spar_games', { keyPath: 'id' });
		sg.createIndex('by-repertoire', 'repertoireId');
		sg.createIndex('by-status', 'status');
		sg.createIndex('by-startedAt', 'startedAt');
	}
}

/**
 * Read the current stored version of `openingtrainer` without triggering
 * an upgrade. Returns 0 if the DB doesn't exist yet.
 */
async function probeVersion(): Promise<number> {
	if (typeof indexedDB === 'undefined') return 0;
	if (typeof indexedDB.databases === 'function') {
		try {
			const list = await indexedDB.databases();
			const found = list.find((d) => d.name === DB_NAME);
			return found?.version ?? 0;
		} catch {
			/* fall through */
		}
	}
	// Firefox doesn't expose indexedDB.databases(); open with no version.
	return new Promise<number>((resolve) => {
		const req = indexedDB.open(DB_NAME);
		req.onsuccess = () => {
			const v = req.result.version;
			req.result.close();
			resolve(v);
		};
		req.onerror = () => resolve(0);
		req.onblocked = () => resolve(0);
	});
}

async function openAndVerify(): Promise<IDBPDatabase<OpeningTrainerDB>> {
	// Probe the DB's current version first so we always open at
	// `max(current, DB_VERSION)`. Opening at a lower version throws
	// `VersionError`; opening at exactly `current` skips the upgrade
	// (fine if the stores are all present; `ensureAllStores` is
	// idempotent so re-running it on a future bump costs nothing).
	const currentVersion = await probeVersion();
	const targetVersion = Math.max(currentVersion, DB_VERSION);
	return await openDB<OpeningTrainerDB>(DB_NAME, targetVersion, {
		blocked(cur, blocked) {
			console.warn(`COBRA IDB upgrade blocked: ${cur} → ${blocked}. Reloading.`);
			if (typeof window !== 'undefined') window.location.reload();
		},
		upgrade(db, oldVersion) {
			console.log(`COBRA IDB upgrade: v${oldVersion} → v${targetVersion}`);
			ensureAllStores(db);
		},
		blocking() {
			dbPromise?.then((d) => d.close());
			dbPromise = null;
		}
	});
}

export function getDB(): Promise<IDBPDatabase<OpeningTrainerDB>> {
	if (!dbPromise) dbPromise = openAndVerify();
	return dbPromise;
}

/**
 * Forcibly close the cached connection and reopen at one above the
 * stored version. Use when a store turns out to be missing despite the
 * DB sitting at our nominal `DB_VERSION` — that happens when another
 * tab held an old connection through the upgrade, or a service worker
 * served stale code that opened at a higher version without the new
 * store. Bumping the version guarantees `ensureAllStores` runs.
 */
export async function forceReopen(): Promise<IDBPDatabase<OpeningTrainerDB>> {
	const stale = await dbPromise?.catch(() => null);
	if (stale) stale.close();
	dbPromise = null;
	const current = await probeVersion();
	const target = Math.max(current + 1, DB_VERSION);
	dbPromise = openDB<OpeningTrainerDB>(DB_NAME, target, {
		blocked() {
			console.warn('COBRA IDB upgrade blocked during repair. Close other COBRA tabs.');
			if (typeof window !== 'undefined') window.location.reload();
		},
		upgrade(db, oldVersion) {
			console.log(`COBRA IDB repair upgrade: v${oldVersion} → v${target}`);
			ensureAllStores(db);
		},
		blocking() {
			dbPromise?.then((d) => d.close());
			dbPromise = null;
		}
	});
	return dbPromise;
}

/**
 * Verify a specific store exists; if not, run `forceReopen()` once to
 * trigger the upgrade. Returns a DB handle guaranteed to expose the
 * named store, or throws if the repair attempt didn't add it (genuine
 * schema bug, not a stale handle).
 */
export async function ensureStore(name: StoreName): Promise<IDBPDatabase<OpeningTrainerDB>> {
	let db = await getDB();
	const has = (handle: IDBPDatabase<OpeningTrainerDB>) =>
		(handle.objectStoreNames as unknown as { contains: (n: string) => boolean }).contains(name);
	if (has(db)) return db;
	console.warn(`[cobra] store '${name}' missing — forcing IDB upgrade.`);
	db = await forceReopen();
	if (!has(db)) {
		throw new Error(`IDB store '${name}' could not be created. Close other COBRA tabs and reload.`);
	}
	return db;
}

export async function wipeAllData(): Promise<void> {
	const db = await getDB();
	const tx = db.transaction([...REQUIRED_STORES], 'readwrite');
	await Promise.all(REQUIRED_STORES.map((s) => tx.objectStore(s).clear()));
	await tx.done;
}

/**
 * Purge explorer cache entries older than `maxAgeMs`. Called opportunistically
 * from fetchExplorer so the cache doesn't grow without bound.
 */
export async function pruneExplorerCache(maxAgeMs: number): Promise<void> {
	try {
		const db = await getDB();
		const cutoff = Date.now() - maxAgeMs;
		const tx = db.transaction('explorer_stats', 'readwrite');
		const index = tx.store.index('by-fetchedAt');
		let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff));
		while (cursor) {
			await cursor.delete();
			cursor = await cursor.continue();
		}
		await tx.done;
	} catch {
		/* best-effort; cache is non-critical */
	}
}
