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
	private bestmoveHandlers: Array<(bestmove: string) => void> = [];
	private readyokHandlers: Array<() => void> = [];
	private errorHandlers: Array<(e: EngineError) => void> = [];
	private readyPromise: Promise<void> | null = null;
	private sideToMove: 'white' | 'black' = 'white';
	private currentFen: string | null = null;
	private currentMultiPV = 1;
	/**
	 * True between a `go *` and the corresponding `bestmove`.
	 * Stockfish silently drops `setoption` while a search is running, so
	 * any new search has to wait for `bestmove` from the previous one
	 * before re-configuring (e.g. switching MultiPV from 3 to 1 between
	 * the dossier's before- and after-position evals).
	 */
	private isSearching = false;

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

			// Performance options. lila-stockfish-web defaults to 1 thread
			// and 16 MB hash, which makes the dossier scan crawl and triggers
			// "no info arrived" timeouts on complex positions. Bump both to
			// numbers that match what Lichess analysis itself uses in the
			// browser. `hardwareConcurrency` is widely supported (workers
			// included); the Math.min cap protects users on extreme machines
			// where running too many threads against a small NNUE wastes
			// CPU on synchronisation.
			const cores =
				typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
					? navigator.hardwareConcurrency
					: 4;
			const threads = Math.max(1, Math.min(cores, 8));
			sf.uci(`setoption name Threads value ${threads}`);
			sf.uci(`setoption name Hash value 64`);

			this.sf = sf;
			// Block until Stockfish has acknowledged init + the setoptions
			// above. Without this, the first analyseMulti can race the
			// option apply and search at depth 1 with stale Threads=1.
			await this.sync();
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
	onBestmove(handler: (bestmove: string) => void): () => void {
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
		this.isSearching = true;
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
		this.isSearching = true;
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
		this.isSearching = true;
		const searchmovesPart =
			searchmoves && searchmoves.length > 0 ? ` searchmoves ${searchmoves.join(' ')}` : '';
		this.sf.uci(`go movetime ${movetimeMs}${searchmovesPart}`);
	}

	/**
	 * Side-to-move inferred from the most recent `go()` call.
	 *
	 * `info.scoreCp` and `info.scoreMate` arrive in **side-to-move POV**
	 * per the UCI standard (positive = good for whoever is on move at the
	 * analysed FEN). Callers that want a different POV — e.g. white-POV
	 * for display alongside Lichess cloud-eval, or user-POV for dossier
	 * scoring — must flip using this side. See `stmPovToUserPov` in
	 * `src/lib/dossier/sota.ts` for the canonical user-POV conversion.
	 */
	get lastSideToMove(): 'white' | 'black' {
		return this.sideToMove;
	}

	stop(): void {
		if (this.sf) this.sf.uci('stop');
		this.currentFen = null;
	}

	/**
	 * UCI `isready` synchronisation. Sends `isready`, resolves on the
	 * next `readyok`. Useful for waiting on slow non-search operations
	 * like NNUE load or Hash resize. **Does not wait for a running
	 * search to finish** — Stockfish replies `readyok` immediately even
	 * mid-`go`. For "wait until the engine has finished its current
	 * search" use `awaitIdle()` instead.
	 */
	async sync(): Promise<void> {
		if (!this.sf) return;
		return new Promise<void>((resolve) => {
			this.readyokHandlers.push(resolve);
			this.sf!.uci('isready');
		});
	}

	/**
	 * Wait for the engine to finish its current search and emit
	 * `bestmove`. Resolves immediately when no search is in flight.
	 *
	 * This is the synchronisation primitive that prevents the
	 * `setoption MultiPV value N` mid-search drop. The dossier scan
	 * alternates MultiPV between 3 (before-position) and 1 (after-
	 * position) on every move; without waiting for the previous
	 * search's bestmove, the next setoption arrives while Stockfish is
	 * still searching and is silently ignored, which on certain inputs
	 * caused the next `go` to never emit a single info line within the
	 * timeout — surfacing as "analyseMulti timed out before any info
	 * arrived" in the user's console.
	 *
	 * The fallback `setTimeout` exists because we can't tell from JS
	 * whether the engine truly emitted bestmove or got stuck. 1.5s is
	 * generous for the worst case Stockfish takes to wind down a
	 * stopped search at multi-thread + 64MB hash.
	 */
	async awaitIdle(timeoutMs: number = 1500): Promise<void> {
		if (!this.sf) return;
		if (!this.isSearching) return;
		// Make sure the engine is being asked to stop — `analyseMulti`'s
		// `finalise` already calls `this.stop()` before returning, but a
		// caller that arrived here without that path (e.g. an interrupted
		// scan) needs the kick.
		this.sf.uci('stop');
		return new Promise<void>((resolve) => {
			let settled = false;
			const off = this.onBestmove(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				off();
				resolve();
			});
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				off();
				console.warn('[stockfish] awaitIdle timeout — bestmove not received in', timeoutMs, 'ms');
				// Force the flag — engine may have died but we shouldn't
				// jam every subsequent search waiting on a bestmove that
				// will never come.
				this.isSearching = false;
				resolve();
			}, timeoutMs);
		});
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
	async analyse(fen: string, depth: number = 18, timeoutMs: number = 20000): Promise<EngineInfo> {
		// Wait for any prior search to fully finish (bestmove emitted)
		// before starting this one. Without this guard the new go can
		// race the previous search's tail and Stockfish doesn't emit
		// info reliably.
		await this.awaitIdle();
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
			const offBest = this.onBestmove((bestmove) => {
				if (resolved) return;
				// Terminal-position synthesis (mirror analyseMulti): no
				// info + bestmove (none)/0000 means the position is
				// checkmate or stalemate. Return mate 0 from STM POV.
				if (!receivedInfoForThisSearch && (bestmove === '(none)' || bestmove === '0000')) {
					resolved = true;
					cleanup();
					resolve({ depth: 0, scoreMate: 0, pv: [] });
					return;
				}
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
		// 20s default — the dossier scan hits genuinely complex positions
		// where multi-PV depth-14 in WASM can take >8s. Callers wanting a
		// tighter budget pass `timeoutMs` explicitly.
		const timeoutMs = opts.timeoutMs ?? 20000;
		if (depth == null && movetimeMs == null) {
			throw new Error('analyseMulti needs depth or movetimeMs');
		}
		// Wait for the previous search to fully finish before changing
		// MultiPV. Stockfish silently drops `setoption` mid-search; if
		// the dossier scan called `setMultiPV(1)` here while the prior
		// `setMultiPV(3) + go` was still running, the value-1 was lost,
		// the next `go` searched at value 3, and on certain inputs no
		// info ever surfaced — surfacing as "analyseMulti timed out
		// before any info arrived". Awaiting idle first eliminates the
		// race; the setoption then lands while the engine is quiescent.
		await this.awaitIdle();
		this.setMultiPV(multiPV);
		// `isready` after `setoption` so we know the option was
		// acknowledged (Stockfish processes setoption synchronously
		// when idle, but the readyok round-trip is cheap insurance).
		await this.sync();

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

			const offBest = this.onBestmove((bestmove) => {
				if (resolved) return;
				// Terminal position (checkmate / stalemate): Stockfish
				// emits `bestmove (none)` (or `0000`) without ANY info
				// lines because there's nothing to search. Synthesise a
				// result so callers (dossier scoring) get a usable score
				// instead of hanging on the 20s timeout.
				if (!receivedInfo && (bestmove === '(none)' || bestmove === '0000')) {
					// Determine mate vs stalemate from the FEN: in a king-
					// in-check position with no legal moves, it's mate;
					// otherwise stalemate. We don't have a chess engine
					// available here, so we use a cheap heuristic: assume
					// mate (the much more common terminal state hit in
					// game analysis), and represent it as `mate 0` from
					// side-to-move's POV (STM is mated). Stalemate gets
					// the same score in dossier accuracy aggregates
					// (both = "game over"); the half-point distinction
					// would only matter for outcome-classification, and
					// the dossier already takes outcome from the PGN.
					const synthetic: EngineInfo = {
						depth: 0,
						scoreMate: 0,
						pv: []
					};
					latest.set(1, synthetic);
					finalise();
					return;
				}
				// Otherwise honour bestmove only if we actually got info
				// for this search — that's the "engine completed naturally
				// before reaching target depth" path.
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
			// Engine is now idle — clear the flag BEFORE dispatching so
			// any handler that immediately starts a new search sees the
			// correct state.
			this.isSearching = false;
			// `bestmove (none)` / `bestmove 0000` = position is terminal
			// (checkmate or stalemate); pass the raw payload so callers
			// can synthesise a result instead of waiting for info that
			// will never come.
			const bestmoveText = line.slice('bestmove '.length).split(' ')[0] ?? '';
			// Snapshot then dispatch — handlers commonly unsubscribe themselves.
			const snapshot = this.bestmoveHandlers.slice();
			for (const h of snapshot) {
				try {
					h(bestmoveText);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.warn('[stockfish] bestmove handler threw:', e);
					this.emitError({ kind: 'handler', message: `bestmove handler threw: ${msg}` });
				}
			}
			return;
		}
		if (line === 'readyok') {
			// `isready` synchronisation. Snapshot then drain — every pending
			// `sync()` waiter resolves on the next readyok.
			const snapshot = this.readyokHandlers.slice();
			this.readyokHandlers = [];
			for (const h of snapshot) {
				try {
					h();
				} catch (e) {
					console.warn('[stockfish] readyok handler threw:', e);
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
