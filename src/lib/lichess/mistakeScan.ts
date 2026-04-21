/**
 * Reusable mistake scan — used both by the /mistakes page (interactive) and
 * by the layout-level hourly auto-scan. Streams Lichess games, runs every
 * game through `detectMistake` against every matching-colour repertoire, and
 * saves the detected set into the persistent `mistakes` IDB store (dedup by
 * composite id so status/correctCount survive re-scans).
 */

import { streamUserGames, type LichessGameMeta } from './games';
import { analyzeGame, type CandidateRep, type MistakeRecord } from './mistakes';
import { streamChesscomGames } from '$lib/chesscom/games';
import { listRepertoires } from '$lib/storage/repertoires';
import { nodesMap } from '$lib/storage/nodes';
import { saveMistakes, toStored } from '$lib/storage/mistakes';
import { recordGapHits, type GapHit } from '$lib/storage/empiricalGaps';
import { effectiveLichessToken } from '$lib/storage/settings';
import type { AppSettings, ScanAccount, StoredMistake } from '$lib/types';

export type MistakeSource = 'lichess' | 'chesscom';

export interface ScanOpts {
	username: string;
	maxGames?: number;
	/** Required for source='lichess'. Ignored for chess.com (public API). */
	token?: string;
	source?: MistakeSource;
	rated?: boolean;
	signal?: AbortSignal;
	/** Only scan games played at or after this timestamp (ms since epoch). */
	since?: number;
	onProgress?: (seen: number, found: number) => void;
}

export interface ScanResult {
	seen: number;
	records: MistakeRecord[];
	saved: StoredMistake[];
	newlyAdded: number;
	/** Number of gap rows (repertoire × position) touched this scan. */
	gapsUpdated: number;
	/** Timestamp of the newest game scanned, or 0 if none. */
	latestGameAt: number;
}

export async function scanMistakes(opts: ScanOpts): Promise<ScanResult> {
	const username = opts.username.trim();
	if (!username) throw new Error('Missing username');
	const reps = await listRepertoires();
	const candidates: CandidateRep[] = [];
	for (const r of reps) {
		candidates.push({
			id: r.id,
			name: r.name,
			color: r.color,
			rootFenKey: r.rootFenKey,
			nodes: await nodesMap(r.id)
		});
	}
	if (candidates.length === 0)
		return { seen: 0, records: [], saved: [], newlyAdded: 0, gapsUpdated: 0, latestGameAt: 0 };

	const records: MistakeRecord[] = [];
	const saved: StoredMistake[] = [];
	const gapHits: GapHit[] = [];
	let seen = 0;

	let latestGameAt = 0;

	const source: MistakeSource = opts.source ?? 'lichess';
	const gameStream: AsyncIterable<LichessGameMeta> =
		source === 'chesscom'
			? streamChesscomGames(username, {
					max: opts.maxGames ?? 50,
					rated: opts.rated,
					since: opts.since,
					signal: opts.signal
				})
			: streamUserGames(username, {
					max: opts.maxGames ?? 50,
					token: opts.token ?? '',
					variant: 'standard',
					rated: opts.rated,
					since: opts.since,
					signal: opts.signal
				});

	for await (const game of gameStream) {
		seen += 1;
		if (game.createdAt > latestGameAt) latestGameAt = game.createdAt;
		if (game.variant !== 'standard') continue;
		const analyzed = analyzeGame(game, username, candidates);
		if (analyzed.mistake) {
			records.push(analyzed.mistake);
			saved.push(toStored(analyzed.mistake));
		}
		if (analyzed.gap) {
			gapHits.push({
				repertoireId: analyzed.gap.repertoireId,
				fenKey: analyzed.gap.fenKey,
				fen: analyzed.gap.fen,
				gameId: analyzed.gap.gameId,
				playedAt: analyzed.gap.playedAt
			});
		}
		opts.onProgress?.(seen, records.length);
	}

	const newlyAdded = saved.length > 0 ? await saveMistakes(saved) : 0;
	const gapsUpdated = await recordGapHits(gapHits);
	return { seen, records, saved, newlyAdded, gapsUpdated, latestGameAt };
}

export interface MultiAccountOpts {
	maxGamesPerAccount?: number;
	rated?: boolean;
	since?: number;
	signal?: AbortSignal;
	onProgress?: (account: ScanAccount, seen: number, found: number) => void;
}

export interface MultiAccountResult {
	totalSeen: number;
	totalNewlyAdded: number;
	totalGapsUpdated: number;
	perAccount: Array<{ account: ScanAccount; result: ScanResult | null; error?: string }>;
}

/**
 * Compose the full list of accounts to sweep: the OAuth-connected
 * Lichess username (if any) plus every extra account the user has
 * added in Settings → Accounts. Deduped by `${source}:${lower-user}`.
 */
export function collectAccountsFromSettings(settings: AppSettings): ScanAccount[] {
	const seen = new Set<string>();
	const out: ScanAccount[] = [];
	const push = (a: ScanAccount) => {
		const key = `${a.source}:${a.username.toLowerCase()}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(a);
	};
	const oauthName = settings.lichessOAuth?.username?.trim();
	if (oauthName) push({ source: 'lichess', username: oauthName });
	for (const a of settings.scanAccounts ?? []) {
		if (!a.username?.trim()) continue;
		push({ source: a.source, username: a.username.trim() });
	}
	return out;
}

/**
 * Run `scanMistakes` once per configured account and aggregate the
 * results. Accounts are scanned sequentially so we don't hammer either
 * platform's rate limits. A failure on one account doesn't abort the
 * rest — each account's error is captured in `perAccount`.
 */
export async function scanAllAccounts(
	settings: AppSettings,
	opts: MultiAccountOpts = {}
): Promise<MultiAccountResult> {
	const accounts = collectAccountsFromSettings(settings);
	const token = effectiveLichessToken(settings);
	const out: MultiAccountResult = {
		totalSeen: 0,
		totalNewlyAdded: 0,
		totalGapsUpdated: 0,
		perAccount: []
	};
	for (const account of accounts) {
		if (account.source === 'lichess' && !token) {
			out.perAccount.push({
				account,
				result: null,
				error: 'Lichess token required — connect in Settings.'
			});
			continue;
		}
		try {
			const result = await scanMistakes({
				username: account.username,
				source: account.source,
				token: account.source === 'lichess' ? token : '',
				maxGames: opts.maxGamesPerAccount ?? 50,
				rated: opts.rated,
				since: opts.since,
				signal: opts.signal,
				onProgress: (seen, found) => opts.onProgress?.(account, seen, found)
			});
			out.totalSeen += result.seen;
			out.totalNewlyAdded += result.newlyAdded;
			out.totalGapsUpdated += result.gapsUpdated;
			out.perAccount.push({ account, result });
		} catch (e) {
			out.perAccount.push({
				account,
				result: null,
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}
	return out;
}
