/**
 * Shared store for an in-flight dossier review scan.
 *
 * The scan is long-running (minutes, engine-heavy) and the user should be
 * able to navigate away without losing progress. We lift the scan state
 * into a module-level singleton so both the dossier page *and* the
 * layout's persistent progress bar can read it, and so the scan keeps
 * running when the dossier page unmounts.
 *
 * Beyond the in-memory store we also write an IDB checkpoint after each
 * eval move (debounced). If the user closes the tab during a scan, the
 * next session can resume — see `loadDossierCheckpoint` and the resume
 * branch in `start()`.
 */
import type { AppSettings, ScanAccount } from '$lib/types';
import { saveDossierReport } from '$lib/storage/dossierReport';
import {
	clearDossierCheckpoint,
	loadDossierCheckpoint,
	saveDossierCheckpoint
} from '$lib/storage/dossierScanCheckpoint';
import { toast } from '$lib/ui/toast.svelte';

import {
	scanDossierAcrossAccounts,
	type DossierScanCheckpointPayload,
	type DossierScanResult
} from './scan';
import type { EvalAxesPersistedState } from './evalAxes';

export type DossierScanPhase = 'idle' | 'fetching' | 'analysing' | 'done';

export type DossierScanStartOpts = {
	settings: AppSettings;
	maxGamesPerAccount: number;
	evalDepth: number;
	accountsOverride: ScanAccount[];
};

/**
 * Throttle window for IDB writes during the eval pass. Writes happen at
 * most once per CHECKPOINT_INTERVAL_MS, plus one final write at scan end.
 * Ten seconds keeps the loss window small while staying off the IDB hot
 * path on fast scans.
 */
const CHECKPOINT_INTERVAL_MS = 10_000;

interface CheckpointPersisted {
	classified: DossierScanCheckpointPayload['classified'];
	perAccount: DossierScanCheckpointPayload['perAccount'];
	evalState: EvalAxesPersistedState;
}

/**
 * Build a stable hash of the scan inputs so a stored checkpoint can be
 * matched against a freshly-requested scan. If the user changes their
 * account list, eval depth, or game-cap between sessions we discard the
 * old checkpoint rather than silently apply it to a different scan.
 */
function computeScanHash(opts: DossierScanStartOpts): string {
	const accountKey = [...opts.accountsOverride]
		.map((a) => `${a.source}:${a.username.toLowerCase()}`)
		.sort()
		.join('|');
	const useServerEval = opts.settings.useLichessServerEval !== false;
	// Include the since-cutoff so a checkpoint produced under one window
	// can't be silently rehydrated under a different one.
	const since = opts.settings.gamesSince ?? 0;
	return [
		'v1',
		`acc=${accountKey}`,
		`max=${opts.maxGamesPerAccount}`,
		`depth=${opts.evalDepth}`,
		`server=${useServerEval ? 1 : 0}`,
		`since=${since}`
	].join(';');
}

class DossierScanStore {
	phase = $state<DossierScanPhase>('idle');
	progressText = $state('');
	scanGamesDone = $state(0);
	evalDone = $state(0);
	evalTotal = $state(0);
	/** Running count of moves whose eval was adopted from Lichess's server
	 *  annotations — surfaced live by the ScanProgressBar footer. */
	evalAdopted = $state(0);
	error = $state<string | null>(null);
	result = $state<DossierScanResult | null>(null);
	reportSavedAt = $state<number | null>(null);
	/** True for runs that picked up from a saved IDB checkpoint. The
	 *  ScanProgressBar surfaces this so the user understands why the bar
	 *  starts mid-way. */
	resumed = $state(false);

	#controller: AbortController | null = null;
	#lastCheckpointAt = 0;
	#latestCheckpoint: CheckpointPersisted | null = null;

	get running(): boolean {
		return this.phase === 'fetching' || this.phase === 'analysing';
	}

	cancel() {
		this.#controller?.abort();
		// Discard the in-flight scan completely: both the phase and every
		// progress counter. The AbortError handler below already flips the
		// phase to 'idle', but it leaves the last-seen `evalDone / evalTotal`
		// and game count behind — and the persistent footer progress bar,
		// the dossier page's progress block, and any other consumer of this
		// store would otherwise keep rendering "x% done" for a scan the
		// user explicitly cancelled.
		this.phase = 'idle';
		this.progressText = '';
		this.scanGamesDone = 0;
		this.evalDone = 0;
		this.evalTotal = 0;
		this.evalAdopted = 0;
		this.error = null;
		this.resumed = false;
		// User-initiated cancel = throw away any partial work; the next scan
		// they kick off should start clean.
		void clearDossierCheckpoint();
	}

	/** Drop an in-memory result (e.g., user discarded the report). */
	clearResult() {
		this.result = null;
		this.reportSavedAt = null;
		if (this.phase === 'done') this.phase = 'idle';
	}

	/** Adopt a result loaded from IDB / shared bundle so the progress bar
	 *  and the page read the same thing. Doesn't touch phase when a scan
	 *  is in flight. */
	adoptResult(r: DossierScanResult, savedAt: number | null) {
		if (this.running) return;
		this.result = r;
		this.reportSavedAt = savedAt;
		this.phase = 'done';
	}

	async start(opts: DossierScanStartOpts): Promise<DossierScanResult | null> {
		if (this.running) return null;
		this.phase = 'fetching';
		this.progressText = '';
		this.scanGamesDone = 0;
		this.evalDone = 0;
		this.evalTotal = 0;
		this.evalAdopted = 0;
		this.error = null;
		this.result = null;
		this.reportSavedAt = null;
		this.resumed = false;
		this.#controller = new AbortController();
		this.#lastCheckpointAt = 0;
		this.#latestCheckpoint = null;

		const scanHash = computeScanHash(opts);

		// Probe IDB for a matching checkpoint before kicking off the scan. A
		// non-matching one is dropped — the user changed their account list
		// or settings between sessions, and resuming under different inputs
		// would silently corrupt the aggregates.
		const checkpoint = await loadDossierCheckpoint();
		let resumeFrom:
			| {
					classified: DossierScanCheckpointPayload['classified'];
					cursor: number;
					evalState: EvalAxesPersistedState;
					perAccount: DossierScanCheckpointPayload['perAccount'];
			  }
			| undefined;
		if (checkpoint && checkpoint.scanHash === scanHash) {
			const payload = checkpoint.payload as CheckpointPersisted | null;
			if (payload?.classified && payload.evalState) {
				resumeFrom = {
					classified: payload.classified,
					cursor: checkpoint.cursor,
					evalState: payload.evalState,
					perAccount: payload.perAccount ?? []
				};
				this.resumed = true;
				this.evalDone = checkpoint.cursor;
				this.evalTotal = checkpoint.total;
				this.phase = 'analysing';
			}
		} else if (checkpoint) {
			// Different inputs since this checkpoint was written — drop it
			// rather than risk applying it to a mismatched scan.
			void clearDossierCheckpoint();
		}

		const onCheckpoint = (cursor: number, total: number, payload: DossierScanCheckpointPayload) => {
			// Always cache the latest snapshot; throttle the IDB write so a
			// fast scan doesn't pound the disk. The final save in `finally`
			// below picks up whichever cache write was most recent.
			this.#latestCheckpoint = {
				classified: payload.classified,
				perAccount: payload.perAccount,
				evalState: payload.evalState
			};
			const now = Date.now();
			if (now - this.#lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
			this.#lastCheckpointAt = now;
			void saveDossierCheckpoint({
				scanHash,
				cursor,
				total,
				payload: this.#latestCheckpoint
			}).catch((e) => {
				console.warn('[cobra] saveDossierCheckpoint failed:', e);
			});
		};

		try {
			const r = await scanDossierAcrossAccounts(opts.settings, {
				maxGamesPerAccount: opts.maxGamesPerAccount,
				rated: true,
				since: opts.settings.gamesSince,
				accountsOverride: opts.accountsOverride,
				useServerEval: opts.settings.useLichessServerEval !== false,
				signal: this.#controller.signal,
				runEvalAnalysis: true,
				evalDepth: opts.evalDepth,
				resumeFrom,
				onCheckpoint,
				onProgress: (acc, n) => {
					this.phase = 'fetching';
					this.scanGamesDone = n;
					this.progressText = `${acc.source}/${acc.username}: ${n} games fetched`;
				},
				onEvalProgress: (done, total, adopted) => {
					this.phase = 'analysing';
					this.evalDone = done;
					this.evalTotal = total;
					this.evalAdopted = adopted;
				}
			});
			this.result = r;
			this.evalAdopted = r.evalAxes?.movesFromLichess ?? 0;
			this.phase = 'done';
			this.progressText = '';
			// Successful completion — checkpoint is no longer useful; clearing
			// it ensures the next scan starts fresh instead of rehydrating
			// the just-completed work.
			void clearDossierCheckpoint();
			try {
				await saveDossierReport(r);
				this.reportSavedAt = Date.now();
			} catch (e) {
				const detail = e instanceof Error ? e.message : String(e);
				console.warn('[style] failed to persist report:', e);
				toast.warn('Dossier report not saved', {
					body: `${detail}. The report stays in memory but won't be there on next visit.`
				});
			}
			return r;
		} catch (e) {
			if ((e as Error).name === 'AbortError') {
				this.phase = 'idle';
				return null;
			}
			this.error = e instanceof Error ? e.message : String(e);
			this.phase = 'idle';
			return null;
		} finally {
			this.#controller = null;
		}
	}
}

export const dossierScan = new DossierScanStore();
