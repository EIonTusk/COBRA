/**
 * Shared store for an in-flight dossier review scan.
 *
 * The scan is long-running (minutes, engine-heavy) and the user should be
 * able to navigate away without losing progress. We lift the scan state
 * into a module-level singleton so both the dossier page *and* the
 * layout's persistent progress bar can read it, and so the scan keeps
 * running when the dossier page unmounts.
 */
import type { AppSettings, ScanAccount } from '$lib/types';
import { saveDossierReport } from '$lib/storage/dossierReport';

import { scanDossierAcrossAccounts, type DossierScanResult } from './scan';

export type DossierScanPhase = 'idle' | 'fetching' | 'analysing' | 'done';

export type DossierScanStartOpts = {
	settings: AppSettings;
	maxGamesPerAccount: number;
	evalDepth: number;
	accountsOverride: ScanAccount[];
};

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

	#controller: AbortController | null = null;

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
		this.#controller = new AbortController();
		try {
			const r = await scanDossierAcrossAccounts(opts.settings, {
				maxGamesPerAccount: opts.maxGamesPerAccount,
				rated: true,
				accountsOverride: opts.accountsOverride,
				useServerEval: opts.settings.useLichessServerEval !== false,
				signal: this.#controller.signal,
				runEvalAnalysis: true,
				evalDepth: opts.evalDepth,
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
			try {
				await saveDossierReport(r);
				this.reportSavedAt = Date.now();
			} catch (e) {
				console.warn('[style] failed to persist report:', e);
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
