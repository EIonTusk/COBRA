/**
 * Shared store for an in-flight baseline calibration.
 *
 * Mirrors `dossierScan` for the same reason: the calibration runs over a
 * snowball of peer games (~45–90s, network-heavy) and the user shouldn't
 * lose progress just because they navigate away from /settings. The store
 * lives at module scope so the layout's persistent progress strip can
 * read live state from anywhere.
 *
 * Unlike the dossier scan, we don't IDB-checkpoint mid-flight here —
 * calibration's state is per-opponent and small enough that "in-memory
 * for the session" is enough. Closing the tab does lose the work; a
 * later session just re-runs the calibration from scratch.
 */
import type { AppSettings, ScanAccount } from '$lib/types';
import {
	listStoredBaselines,
	saveStoredBaseline,
	type StoredBaselineBucket
} from '$lib/storage/baselines';
import { setRuntimeBaselines, type PickedBaseline } from './fingerprint';
import { scanDossierAcrossAccounts } from './scan';
import { calibrateBaseline } from './calibrate';
import { toast } from '$lib/ui/toast.svelte';

export type BaselineCalibrationPhase = 'idle' | 'fetching' | 'snowball' | 'engine' | 'done';

export interface BaselineCalibrationStartOpts {
	settings: AppSettings;
	gamesPerAccount: number;
	accountsOverride?: ScanAccount[];
	includeChesscom: boolean;
	/** Run the optional v2 engine pass over peer games. Heavy. */
	runEval?: boolean;
	evalDepth?: number;
	evalGameCap?: number;
}

class BaselineCalibrationStore {
	phase = $state<BaselineCalibrationPhase>('idle');
	progressText = $state('');
	/** Numeric progress fraction in [0, 1] when known; null when indeterminate. */
	fraction = $state<number | null>(null);
	error = $state<string | null>(null);
	/** Last-saved bucket so callers can update local state on completion. */
	lastBucket = $state<StoredBaselineBucket | null>(null);
	/** Skip-reasons returned by the calibrator — informational. */
	skipped = $state<Array<{ reason: string; count: number }>>([]);
	/** True while phase is in any active state. `$derived` rather than a
	 *  getter so consumers tracking `running` directly always see the
	 *  freshest value without going through getter dispatch. */
	running = $derived(
		this.phase === 'fetching' || this.phase === 'snowball' || this.phase === 'engine'
	);

	#controller: AbortController | null = null;

	cancel(): void {
		this.#controller?.abort();
		this.phase = 'idle';
		this.progressText = '';
		this.fraction = null;
	}

	clearResult(): void {
		if (this.running) return;
		this.lastBucket = null;
		this.skipped = [];
		this.error = null;
		if (this.phase === 'done') this.phase = 'idle';
	}

	async start(opts: BaselineCalibrationStartOpts): Promise<StoredBaselineBucket | null> {
		if (this.running) return null;
		this.phase = 'fetching';
		this.progressText = 'scanning your games…';
		this.fraction = null;
		this.error = null;
		this.lastBucket = null;
		this.skipped = [];
		this.#controller = new AbortController();

		try {
			const scan = await scanDossierAcrossAccounts(opts.settings, {
				maxGamesPerAccount: opts.gamesPerAccount,
				rated: true,
				accountsOverride: opts.accountsOverride,
				signal: this.#controller.signal,
				onProgress: (acc, n) => {
					this.phase = 'fetching';
					this.progressText = `scan: ${acc.source}/${acc.username} · ${n} games`;
				}
			});
			if (scan.classified.length === 0) {
				throw new Error('Scan returned no games — add a scan account or check your token.');
			}

			this.phase = 'snowball';
			const out = await calibrateBaseline({
				settings: opts.settings,
				scan,
				includeChesscom: opts.includeChesscom,
				signal: this.#controller.signal,
				runEval: opts.runEval,
				evalDepth: opts.evalDepth,
				evalGameCap: opts.evalGameCap,
				onProgress: (done, total, label) => {
					this.phase = 'snowball';
					this.progressText = `calibrate: ${done}/${total} · ${label}`;
					this.fraction = total > 0 ? done / total : null;
				},
				onEvalProgress: (done, total) => {
					this.phase = 'engine';
					this.progressText = `engine: ${done}/${total} moves`;
					this.fraction = total > 0 ? done / total : null;
				}
			});

			await saveStoredBaseline(out.bucket);
			// Re-register every stored bucket at runtime so the next dossier
			// load picks the right peer baseline. Caller can refresh its own
			// list view; the runtime registration here is what matters for
			// the rest of the app.
			const baselines = await listStoredBaselines();
			setRuntimeBaselines(baselines);

			this.lastBucket = out.bucket;
			this.skipped = out.skipped;
			this.phase = 'done';
			this.progressText = '';
			this.fraction = null;
			return out.bucket;
		} catch (e) {
			if ((e as Error).name === 'AbortError') {
				this.phase = 'idle';
				this.progressText = '';
				this.fraction = null;
				return null;
			}
			const detail = e instanceof Error ? e.message : String(e);
			this.error = detail;
			this.phase = 'idle';
			this.progressText = '';
			this.fraction = null;
			toast.warn('Baseline calibration failed', { body: detail });
			return null;
		} finally {
			this.#controller = null;
		}
	}
}

export const baselineCalibration = new BaselineCalibrationStore();

export type { PickedBaseline };
