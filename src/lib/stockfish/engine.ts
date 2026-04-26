/**
 * Lazy-loaded Stockfish UCI client backed by lila-stockfish-web.
 *
 * Assets must be present at /stockfish/sf16-7.js, /stockfish/sf16-7.wasm, and
 * the NNUE file named by getRecommendedNnue(0). Run `npm run prep:stockfish`
 * once after cloning to populate `static/stockfish/`.
 */

export interface EngineInfo {
	depth: number;
	seldepth?: number;
	scoreCp?: number;
	scoreMate?: number;
	pv: string[];
	nps?: number;
	time?: number;
	/** 1-based index when Stockfish is running in MultiPV mode. Absent otherwise. */
	multipv?: number;
}

/**
 * Result bundle for `analyseMulti`: one info line per multipv slot plus a
 * volatility tally (how many iterations flipped the top move).
 */
export interface MultiInfoResult {
	/** Final info lines, one per multipv slot, slot order ascending. */
	lines: EngineInfo[];
	volatility: {
		/** # of iterations where the PV[0] move changed from the prior iteration. */
		topMoveChanges: number;
		/** Deepest depth the search reached. */
		finalDepth: number;
	};
}

export interface StockfishWebInstance {
	uci(command: string): void;
	listen: (line: string) => void;
	onError: (msg: string) => void;
	getRecommendedNnue(index?: number): string;
	setNnueBuffer(data: Uint8Array, index?: number): void;
}

export class StockfishUnavailable extends Error {
	constructor(msg: string) {
		super(msg);
	}
}

/**
 * Categorises non-fatal events the engine surfaces so consumers can decide
 * which to show. `stderr` is the firehose of emscripten log lines and is
 * normally too noisy to surface; the others should generally reach the user.
 */
export type EngineErrorKind = 'stderr' | 'init' | 'timeout' | 'no-info' | 'handler';

export interface EngineError {
	kind: EngineErrorKind;
	message: string;
}

export class Engine {
	private sf: StockfishWebInstance | null = null;
	private handlers: Array<(info: EngineInfo) => void> = [];
	private bestmoveHandlers: Array<() => void> = [];
	private errorHandlers: Array<(e: EngineError) => void> = [];
	private readyPromise: Promise<void> | null = null;
	private sideToMove: 'white' | 'black' = 'white';
	private currentFen: string | null = null;
	private currentMultiPV = 1;

	isReady(): boolean {
		return this.sf !== null;
	}

	/** Change MultiPV before the next go(). No-op if the engine isn't ready. */
	setMultiPV(n: number): void {
		const clamped = Math.max(1, Math.min(20, Math.floor(n)));
		if (clamped === this.currentMultiPV) return;
		this.currentMultiPV = clamped;
		if (this.sf) this.sf.uci(`setoption name MultiPV value ${clamped}`);
	}

	async init(): Promise<void> {
		if (this.readyPromise) return this.readyPromise;
		this.readyPromise = (async () => {
			if (typeof SharedArrayBuffer === 'undefined') {
				const err = new StockfishUnavailable(
					'SharedArrayBuffer unavailable — check COOP/COEP headers.'
				);
				this.emitError({ kind: 'init', message: err.message });
				throw err;
			}
			// Honour SvelteKit's base path so deployments under a subpath
			// (GH Pages at /COBRA) find the assets under the right prefix.
			const { base } = await import('$app/paths');
			const jsUrl = new URL(`${base}/stockfish/sf16-7.js`, window.location.origin).href;
			let mod: { default: () => Promise<StockfishWebInstance> };
			try {
				mod = await import(/* @vite-ignore */ jsUrl);
			} catch (_e) {
				const err = new StockfishUnavailable(
					'Stockfish script not found. Run `npm run prep:stockfish`.'
				);
				this.emitError({ kind: 'init', message: err.message });
				throw err;
			}
			const sf = await mod.default();
			sf.listen = (line: string) => this.onLine(line);
			sf.onError = (msg: string) => {
				// Emscripten surfaces stderr here; log but don't throw. Most of
				// these are routine NNUE / search-info noise — surface them as
				// the low-priority `stderr` kind so subscribers can filter.
				console.warn('[stockfish]', msg);
				this.emitError({ kind: 'stderr', message: msg });
			};
			sf.uci('uci');
			const nnueName = sf.getRecommendedNnue(0);
			const res = await fetch(`${base}/stockfish/${nnueName}`);
			if (!res.ok) {
				const err = new StockfishUnavailable(
					`Stockfish NNUE (${nnueName}) missing. Run \`npm run prep:stockfish\`.`
				);
				this.emitError({ kind: 'init', message: err.message });
				throw err;
			}
			const buf = new Uint8Array(await res.arrayBuffer());
			sf.setNnueBuffer(buf, 0);
			sf.uci('isready');
			this.sf = sf;
		})();
		return this.readyPromise;
	}

	onInfo(handler: (info: EngineInfo) => void): () => void {
		this.handlers.push(handler);
		return () => {
			this.handlers = this.handlers.filter((h) => h !== handler);
		};
	}

	/**
	 * Fires when Stockfish emits `bestmove` — i.e. the current `go` has
	 * terminated. Distinct from `onInfo` because forced-mate / single-
	 * legal-move positions can finish without ever emitting an info line
	 * at the requested depth.
	 */
	onBestmove(handler: () => void): () => void {
		this.bestmoveHandlers.push(handler);
		return () => {
			this.bestmoveHandlers = this.bestmoveHandlers.filter((h) => h !== handler);
		};
	}

	/**
	 * Subscribe to non-fatal engine errors. Use this from a layout-level
	 * listener to surface engine trouble (init failure, search timeouts) as
	 * toasts. `stderr` events are emscripten noise — most subscribers should
	 * filter them out.
	 */
	onError(handler: (e: EngineError) => void): () => void {
		this.errorHandlers.push(handler);
		return () => {
			this.errorHandlers = this.errorHandlers.filter((h) => h !== handler);
		};
	}

	private emitError(e: EngineError): void {
		// Snapshot so handlers that unsubscribe themselves don't trip iteration.
		const snapshot = this.errorHandlers.slice();
		for (const h of snapshot) {
			try {
				h(e);
			} catch (err) {
				console.warn('[stockfish] error handler threw:', err);
			}
		}
	}

	async go(fen: string, depth: number = 20, searchmoves?: string[]): Promise<void> {
		await this.init();
		if (!this.sf) return;
		const parts = fen.split(' ');
		this.sideToMove = parts[1] === 'w' ? 'white' : 'black';
		if (this.currentFen !== null) this.sf.uci('stop');
		this.currentFen = fen;
		this.sf.uci(`position fen ${fen}`);
		const searchmovesPart =
			searchmoves && searchmoves.length > 0 ? ` searchmoves ${searchmoves.join(' ')}` : '';
		this.sf.uci(`go depth ${depth}${searchmovesPart}`);
	}

	/**
	 * Kick off an unbounded iterative-deepening search (`go infinite`).
	 * Stockfish streams info at every depth until `stop()` is called.
	 *
	 * Use this for idle-analysis UX: the UI subscribes to `onInfo` and
	 * keeps the readout live, sharpening as long as the user stays on
	 * the position. On position change, callers must invoke `stop()`.
	 */
	async goInfinite(fen: string, searchmoves?: string[]): Promise<void> {
		await this.init();
		if (!this.sf) return;
		const parts = fen.split(' ');
		this.sideToMove = parts[1] === 'w' ? 'white' : 'black';
		if (this.currentFen !== null) this.sf.uci('stop');
		this.currentFen = fen;
		this.sf.uci(`position fen ${fen}`);
		const searchmovesPart =
			searchmoves && searchmoves.length > 0 ? ` searchmoves ${searchmoves.join(' ')}` : '';
		this.sf.uci(`go infinite${searchmovesPart}`);
	}

	/**
	 * Adaptive-time search: instead of a fixed depth, give Stockfish a
	 * wall-clock budget and let its iterative-deepening scheduler decide
	 * how deep to go. SOTA analysis tools use this so sharp positions get
	 * more cycles than quiet ones for the same total runtime.
	 */
	async goMovetime(fen: string, movetimeMs: number, searchmoves?: string[]): Promise<void> {
		await this.init();
		if (!this.sf) return;
		const parts = fen.split(' ');
		this.sideToMove = parts[1] === 'w' ? 'white' : 'black';
		if (this.currentFen !== null) this.sf.uci('stop');
		this.currentFen = fen;
		this.sf.uci(`position fen ${fen}`);
		const searchmovesPart =
			searchmoves && searchmoves.length > 0 ? ` searchmoves ${searchmoves.join(' ')}` : '';
		this.sf.uci(`go movetime ${movetimeMs}${searchmovesPart}`);
	}

	/**
	 * Side-to-move inferred from the most recent `go()` call. Used by
	 * callers that want to flip engine evals into the user's POV when
	 * they already know the FEN they requested.
	 */
	get lastSideToMove(): 'white' | 'black' {
		return this.sideToMove;
	}

	stop(): void {
		if (this.sf) this.sf.uci('stop');
		this.currentFen = null;
	}

	/**
	 * One-shot eval. Runs `go depth N` against the given FEN and resolves
	 * with the first info line that reaches the requested depth. Use for
	 * batch analyses (e.g. computing centipawn loss across a list of
	 * positions) — for live UX prefer `go()` + `onInfo()` so partial
	 * results render as they stream.
	 *
	 * Note: serial only. Calling this concurrently will cancel the prior
	 * search via `go()`'s internal `stop` and the earlier promise will
	 * never settle. Always `await` between calls.
	 */
	async analyse(fen: string, depth: number = 18, timeoutMs: number = 8000): Promise<EngineInfo> {
		return new Promise<EngineInfo>((resolve, reject) => {
			let resolved = false;
			let lastInfo: EngineInfo | null = null;
			let receivedInfoForThisSearch = false;

			const cleanup = () => {
				offInfo();
				offBest();
				if (timer != null) clearTimeout(timer);
			};

			const offInfo = this.onInfo((info) => {
				if (info.multipv && info.multipv !== 1) return;
				lastInfo = info;
				receivedInfoForThisSearch = true;
				if (info.depth >= depth && !resolved) {
					resolved = true;
					cleanup();
					this.stop();
					resolve(info);
				}
			});

			// Forced-mate / single-legal-move positions terminate before
			// reaching the target depth, so use `bestmove` as a fallback.
			//
			// Critical: only honor `bestmove` if we've actually seen an info
			// line for the *current* search. Otherwise a stale `bestmove`
			// from the previous `analyse`'s `this.stop()` (issued when the
			// prior call resolved via the depth path) would fire on this
			// listener and false-resolve the new search before its first
			// info ever arrived.
			const offBest = this.onBestmove(() => {
				if (resolved) return;
				if (!receivedInfoForThisSearch) return;
				resolved = true;
				cleanup();
				if (lastInfo) resolve(lastInfo);
				else reject(new Error('Engine returned no info before bestmove.'));
			});

			// Last-resort timeout: if neither depth nor bestmove fires (worker
			// stuck, comms dropped), give up rather than hanging the batch.
			const timer = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				cleanup();
				this.stop();
				if (lastInfo) {
					const msg = `analyse timed out at depth ${depth}; resolving with last info (depth ${lastInfo.depth}).`;
					console.warn(`[stockfish] ${msg}`);
					this.emitError({ kind: 'timeout', message: msg });
					resolve(lastInfo);
				} else {
					const msg = `analyse timed out at depth ${depth}; no info received.`;
					console.warn(`[stockfish] ${msg}`);
					this.emitError({ kind: 'no-info', message: msg });
					reject(new Error(`Engine analysis timed out at depth ${depth}.`));
				}
			}, timeoutMs);

			this.go(fen, depth).catch((e) => {
				if (!resolved) {
					resolved = true;
					cleanup();
					reject(e);
				}
			});
		});
	}

	/**
	 * Multi-PV analyse: run a search that returns top-K alternative lines
	 * at the terminal depth. Captures bestmove-stability (did the top PV
	 * flip across iterations?) as a volatility signal for downstream
	 * tactical-position detection.
	 *
	 * Opts:
	 *   - multiPV: how many top alternatives to collect (default 3)
	 *   - depth: terminal depth (omit when using movetimeMs)
	 *   - movetimeMs: adaptive-time budget (omit when using depth)
	 *
	 * Returns one EngineInfo per multipv slot, indexed 1..multiPV, plus a
	 * `volatility` field reporting how often the top move changed across
	 * the iterative-deepening iterations.
	 */
	async analyseMulti(
		fen: string,
		opts: {
			multiPV?: number;
			depth?: number;
			movetimeMs?: number;
			timeoutMs?: number;
		} = {}
	): Promise<MultiInfoResult> {
		const multiPV = Math.max(1, Math.min(20, Math.floor(opts.multiPV ?? 3)));
		const depth = opts.depth;
		const movetimeMs = opts.movetimeMs;
		const timeoutMs = opts.timeoutMs ?? 8000;
		if (depth == null && movetimeMs == null) {
			throw new Error('analyseMulti needs depth or movetimeMs');
		}
		this.setMultiPV(multiPV);

		return new Promise<MultiInfoResult>((resolve, reject) => {
			let resolved = false;
			// Latest info line per multipv slot, keyed 1..multiPV.
			const latest = new Map<number, EngineInfo>();
			// Track top-move stability across iterative deepening.
			let topMovePrev: string | null = null;
			let topMoveChanges = 0;
			let lastDepthSeen = 0;
			let receivedInfo = false;

			const cleanup = () => {
				offInfo();
				offBest();
				if (timer != null) clearTimeout(timer);
			};

			const finalise = () => {
				resolved = true;
				cleanup();
				this.stop();
				const lines: EngineInfo[] = [];
				for (let i = 1; i <= multiPV; i += 1) {
					const info = latest.get(i);
					if (info) lines.push(info);
				}
				if (lines.length === 0) {
					reject(new Error('Engine returned no info lines.'));
					return;
				}
				resolve({
					lines,
					volatility: {
						topMoveChanges,
						finalDepth: lastDepthSeen
					}
				});
			};

			const offInfo = this.onInfo((info) => {
				receivedInfo = true;
				const slot = info.multipv ?? 1;
				latest.set(slot, info);
				if (slot === 1) {
					const thisTop = info.pv[0] ?? null;
					if (topMovePrev !== null && thisTop !== null && thisTop !== topMovePrev) {
						topMoveChanges += 1;
					}
					topMovePrev = thisTop;
					lastDepthSeen = info.depth;
				}
				if (depth != null && info.depth >= depth && slot === multiPV && !resolved) {
					// We've seen the deepest slot at target depth — terminate.
					finalise();
				}
			});

			const offBest = this.onBestmove(() => {
				if (resolved) return;
				if (!receivedInfo) return;
				finalise();
			});

			const timer = setTimeout(() => {
				if (resolved) return;
				if (latest.size > 0) {
					const msg = `analyseMulti timed out at depth ${lastDepthSeen}; resolving with latest state.`;
					console.warn(`[stockfish] ${msg}`);
					this.emitError({ kind: 'timeout', message: msg });
					finalise();
				} else {
					const msg = `analyseMulti timed out before any info arrived.`;
					console.warn(`[stockfish] ${msg}`);
					this.emitError({ kind: 'no-info', message: msg });
					resolved = true;
					cleanup();
					this.stop();
					reject(new Error(msg));
				}
			}, timeoutMs);

			const goCall =
				movetimeMs != null ? this.goMovetime(fen, movetimeMs) : this.go(fen, depth as number);
			goCall.catch((e) => {
				if (!resolved) {
					resolved = true;
					cleanup();
					reject(e);
				}
			});
		});
	}

	quit(): void {
		if (this.sf) this.sf.uci('quit');
	}

	private onLine(line: string): void {
		if (line.startsWith('bestmove')) {
			// Snapshot then dispatch — handlers commonly unsubscribe themselves.
			const snapshot = this.bestmoveHandlers.slice();
			for (const h of snapshot) {
				try {
					h();
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.warn('[stockfish] bestmove handler threw:', e);
					this.emitError({ kind: 'handler', message: `bestmove handler threw: ${msg}` });
				}
			}
			return;
		}
		if (!line.startsWith('info ')) return;
		const parts = line.split(' ');
		let depth = 0;
		let seldepth: number | undefined;
		let scoreCp: number | undefined;
		let scoreMate: number | undefined;
		let nps: number | undefined;
		let time: number | undefined;
		let multipv: number | undefined;
		const pv: string[] = [];
		for (let i = 1; i < parts.length; i++) {
			const tok = parts[i];
			if (tok === 'depth') depth = parseInt(parts[++i], 10);
			else if (tok === 'seldepth') seldepth = parseInt(parts[++i], 10);
			else if (tok === 'multipv') multipv = parseInt(parts[++i], 10);
			else if (tok === 'score') {
				const kind = parts[++i];
				const val = parseInt(parts[++i], 10);
				if (kind === 'cp') scoreCp = val;
				else if (kind === 'mate') scoreMate = val;
			} else if (tok === 'nps') nps = parseInt(parts[++i], 10);
			else if (tok === 'time') time = parseInt(parts[++i], 10);
			else if (tok === 'pv') {
				for (let j = i + 1; j < parts.length; j++) pv.push(parts[j]);
				break;
			}
		}
		if (!depth || pv.length === 0) return;
		const info: EngineInfo = {
			depth,
			seldepth,
			scoreCp,
			scoreMate,
			pv,
			nps,
			time,
			multipv
		};
		for (const h of this.handlers) h(info);
	}
}

let globalEngine: Engine | null = null;
export function getEngine(): Engine {
	if (!globalEngine) globalEngine = new Engine();
	return globalEngine;
}
