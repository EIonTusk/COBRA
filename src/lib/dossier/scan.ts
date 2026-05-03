/**
 * Style scan: stream a user's recent games (Lichess + chess.com via the
 * existing game-source modules), classify each one's user-side moves, and
 * produce a DossierFingerprint. Sibling of `mistakeScan.ts` — same account
 * model, same source switch, but doesn't touch repertoire trees.
 */

import { streamUserGames } from '$lib/lichess/games';
import { streamChesscomGames } from '$lib/chesscom/games';
import { effectiveLichessToken } from '$lib/storage/settings';
import type { AppSettings, ScanAccount } from '$lib/types';
import { collectAccountsFromSettings } from '$lib/lichess/mistakeScan';

import { classifyGame, type ClassifiedGame } from './classify';
import {
	computeDrift,
	fingerprintFromGames,
	type FingerprintDrift,
	type DossierFingerprint
} from './fingerprint';
import { detectLeaks, type LeakSummary } from './mismatch';
import { analyseEvalAxes, type EvalAxesPersistedState, type EvalAxesSummary } from './evalAxes';

export interface DossierScanOpts {
	maxGamesPerAccount?: number;
	rated?: boolean;
	since?: number;
	signal?: AbortSignal;
	onProgress?: (account: ScanAccount, scanned: number) => void;
	/**
	 * Run the local Stockfish v2 axes pass after the v1 board-only
	 * fingerprint completes. Default true — the user explicitly opted
	 * into "always run with the scan". Heavy: ~300ms per move at depth 14.
	 */
	runEvalAnalysis?: boolean;
	/** Depth for the v2 eval pass. Default 14. */
	evalDepth?: number;
	/** Progress callback for the eval pass — runs after the scan phase. */
	onEvalProgress?: (done: number, total: number, adopted: number) => void;
	/**
	 * Override the account list derived from settings. When provided the
	 * scan walks exactly these accounts (after the same per-source token
	 * gating). Useful for baseline calibration, which can be scoped to a
	 * single configured account.
	 */
	accountsOverride?: ScanAccount[];
	/**
	 * When true, request Lichess's server-side `%eval` annotations in the
	 * games stream. Moves that come back tagged skip the local engine
	 * pass; untagged moves fall back to Stockfish per-move. No effect on
	 * chess.com games (the endpoint doesn't exist there).
	 */
	useServerEval?: boolean;
	/**
	 * Resume an interrupted scan. When provided, Phase 1 (network fetch +
	 * classify) is skipped — `resumeFrom.classified` is used directly. The
	 * eval pass starts from `resumeFrom.cursor` with the already-accumulated
	 * `resumeFrom.evalState`. Caller is responsible for verifying the
	 * checkpoint matches the requested scan (see `scanStore`'s scanHash);
	 * a mismatched resume yields garbage aggregates.
	 */
	resumeFrom?: {
		classified: ClassifiedGame[];
		cursor: number;
		evalState: EvalAxesPersistedState;
		/** Saved per-account scan counts so the dossier UI block stays
		 *  populated after a resume. */
		perAccount: DossierScanResult['perAccount'];
	};
	/**
	 * Receives a self-contained checkpoint payload after each eval move.
	 * Carries everything needed to resume — the already-classified games,
	 * per-account counts, and the running eval accumulator. Caller is
	 * expected to throttle the actual IDB writes.
	 */
	onCheckpoint?: (cursor: number, total: number, payload: DossierScanCheckpointPayload) => void;
}

export interface DossierScanCheckpointPayload {
	classified: ClassifiedGame[];
	perAccount: DossierScanResult['perAccount'];
	evalState: EvalAxesPersistedState;
}

export interface DossierScanResult {
	fingerprint: DossierFingerprint;
	drift: FingerprintDrift | null;
	leaks: LeakSummary;
	classified: ClassifiedGame[];
	perAccount: Array<{ account: ScanAccount; scanned: number; error?: string }>;
	/**
	 * v2 eval-based axes computed by Stockfish. null when the eval pass
	 * was skipped (opt-out or aborted) or failed to produce any moves.
	 */
	evalAxes: EvalAxesSummary | null;
	/** First error from the eval pass, if any — surfaced for the UI. */
	evalError: string | null;
	/**
	 * Stockfish NNUE depth the eval pass ran at. Recorded so the scope
	 * block / Engine read card can cite the actual depth instead of a
	 * hard-coded constant. Undefined on reports created before this field
	 * existed — consumers should default to 14 in that case.
	 */
	evalDepth?: number;
}

export async function scanDossierAcrossAccounts(
	settings: AppSettings,
	opts: DossierScanOpts = {}
): Promise<DossierScanResult> {
	const accounts = opts.accountsOverride ?? collectAccountsFromSettings(settings);
	const token = effectiveLichessToken(settings);
	let perAccount: DossierScanResult['perAccount'] = [];
	let classified: ClassifiedGame[];

	if (opts.resumeFrom) {
		// Phase 1 already done in the original session. Trust the supplied
		// classified set and per-account counts captured at checkpoint time.
		classified = opts.resumeFrom.classified;
		perAccount = opts.resumeFrom.perAccount;
	} else {
		classified = [];
		for (const account of accounts) {
			if (account.source === 'lichess' && !token) {
				perAccount.push({
					account,
					scanned: 0,
					error: 'Lichess token required — connect in Settings.'
				});
				continue;
			}
			try {
				const stream =
					account.source === 'chesscom'
						? streamChesscomGames(account.username, {
								max: opts.maxGamesPerAccount ?? 100,
								rated: opts.rated,
								since: opts.since,
								signal: opts.signal
							})
						: streamUserGames(account.username, {
								max: opts.maxGamesPerAccount ?? 100,
								token,
								variant: 'standard',
								rated: opts.rated,
								since: opts.since,
								evals: opts.useServerEval,
								signal: opts.signal
							});

				// `scanned` counts every game pulled from the stream (the
				// raw API throughput); `kept` counts games that survived
				// the variant filter AND classified. The progress callback
				// reports `kept` because that matches the user's mental
				// model of "games gathered for the dossier" — `scanned`
				// can momentarily overshoot the limit (e.g. a chess.com
				// monthly archive yielding more games before the
				// client-side cap kicks in, or a Lichess perfType-misclass
				// game that gets dropped by `variant !== 'standard'`),
				// which previously made the counter visibly jump above
				// the configured max and then snap back to the limit.
				let scanned = 0;
				let kept = 0;
				for await (const game of stream) {
					scanned += 1;
					if (game.variant !== 'standard') continue;
					const c = classifyGame(game, account.username);
					if (c) {
						classified.push(c);
						kept += 1;
					}
					opts.onProgress?.(account, kept);
				}
				perAccount.push({ account, scanned });
			} catch (e) {
				perAccount.push({
					account,
					scanned: 0,
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}
	}

	const fingerprint = fingerprintFromGames(classified);
	const drift = computeDrift(classified);
	const leaks = detectLeaks(classified, 12);

	let evalAxes: EvalAxesSummary | null = null;
	let evalError: string | null = null;
	const runEval = opts.runEvalAnalysis !== false;
	const effectiveDepth = opts.evalDepth ?? 14;
	if (runEval && classified.length > 0 && !opts.signal?.aborted) {
		// Wrap the user's onCheckpoint so it sees the full payload (classified
		// + perAccount), not just the eval accumulator. analyseEvalAxes only
		// knows about its own state; this layer adds the Phase-1 outputs.
		const onCheckpoint = opts.onCheckpoint;
		const wrappedOnCheckpoint = onCheckpoint
			? (cursor: number, total: number, evalState: EvalAxesPersistedState) =>
					onCheckpoint(cursor, total, { classified, perAccount, evalState })
			: undefined;
		try {
			evalAxes = await analyseEvalAxes(classified, {
				depth: effectiveDepth,
				// Adaptive scoring: every move gets a cheap shallow pass; only
				// positions where the engine itself is unsure (top-1 vs top-2
				// gap < ambiguityGap) get the full deep re-pass. Cuts the
				// average per-move work to roughly the shallow-only budget
				// while preserving precision exactly where it matters for
				// cpLoss / blunder classification.
				adaptive: true,
				signal: opts.signal,
				onProgress: opts.onEvalProgress,
				lichessToken: token ?? undefined,
				resumeFrom: opts.resumeFrom
					? { cursor: opts.resumeFrom.cursor, state: opts.resumeFrom.evalState }
					: undefined,
				onCheckpoint: wrappedOnCheckpoint
			});
		} catch (e) {
			evalError = e instanceof Error ? e.message : String(e);
		}
	}

	return {
		fingerprint,
		drift,
		leaks,
		classified,
		perAccount,
		evalAxes,
		evalError,
		evalDepth: evalAxes ? effectiveDepth : undefined
	};
}
