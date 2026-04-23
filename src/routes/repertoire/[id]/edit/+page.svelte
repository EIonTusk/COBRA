<script lang="ts">
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { createEmptyCard } from 'ts-fsrs';
	import {
		ArrowLeft,
		Bookmark,
		Bot,
		ChevronDown,
		ChevronFirst,
		ChevronLeft,
		Check,
		Compass,
		Eye,
		EyeOff,
		Copy,
		Flame,
		Lightbulb,
		Menu,
		Save,
		Star,
		Target,
		X as XIcon
	} from 'lucide-svelte';
	import type { Key, MoveMetadata } from '@lichess-org/chessground/types';
	import type { DrawShape } from '@lichess-org/chessground/draw';

	import Board from '$lib/chess/Board.svelte';
	import Explorer from '$lib/explorer/Explorer.svelte';
	import { listGapsForRepertoire } from '$lib/storage/empiricalGaps';
	import { listPositionWdlAtFenKey, type PositionWdlRow } from '$lib/storage/positionWdl';
	import { getRepertoire, touchRepertoire, setStartingPosition } from '$lib/storage/repertoires';
	import { nodesMap, addEdge, removeEdge, setNodeComment } from '$lib/storage/nodes';
	import {
		deleteIdeaCard,
		freshIdeaCard,
		getIdeaCard,
		upsertIdeaCard
	} from '$lib/storage/ideaCards';
	import { upsertCard, getCard, deleteCard } from '$lib/storage/cards';
	import { colorToMove } from '$lib/chess/fen';
	import {
		edgeFromUci,
		edgeFromSan,
		fenAfterMove,
		legalDests,
		isPromotionMove,
		sanAtFen
	} from '$lib/chess/position';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import { pathToFenKey, furthestNonBranchingFenKey } from '$lib/tree/traversal';
	import {
		collectMissingMoves,
		collectSaveableLeaves,
		firstMissingOnLine,
		type MissingMove
	} from '$lib/tree/missing';
	import { fetchExplorer } from '$lib/explorer/client';
	import { fetchCloudEval, type CloudEval } from '$lib/lichess/cloudEval';
	import {
		challengeStockfishAi,
		challengeMaia,
		BotChallengeError,
		TOKEN_WITH_SCOPES_URL,
		type ChallengeColor
	} from '$lib/lichess/botChallenge';
	import { gameIdFromUrl, upsertSparGame } from '$lib/storage/sparGames';
	import { getEngine, type EngineInfo } from '$lib/stockfish/engine';
	import { engineHintShapes, explorerHintShapes } from '$lib/chess/hints';
	import { Button, Textarea } from '$lib/ui';
	import type {
		AppSettings,
		EmpiricalGap,
		IdeaCard,
		Repertoire,
		RepertoireNode,
		Edge
	} from '$lib/types';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analyseOpeningFit, type OpeningFitSummary } from '$lib/dossier/openingFit';
	import type { DossierFingerprint } from '$lib/dossier/fingerprint';
	import type { DossierScanResult } from '$lib/dossier/scan';

	interface HistoryStep {
		fen: string;
		fenKey: string;
		san?: string;
		lastMove?: [Key, Key];
	}

	let rep = $state<Repertoire | null>(null);
	let nodes = $state<Map<string, RepertoireNode>>(new Map());
	let currentFen = $state('');
	let history = $state<HistoryStep[]>([]);
	let loading = $state(true);
	let comment = $state('');
	let commentDirty = $state(false);

	// Style advisor: fingerprint + openingFit from the most-recent dossier
	// scan. Loaded opportunistically on mount; Explorer ignores these when
	// null, so the absence of a scan degrades gracefully. Gated by the
	// user's settings.styleAdviceEnabled flag (off by default).
	let styleFingerprint = $state<DossierFingerprint | null>(null);
	let styleOpeningFit = $state<OpeningFitSummary | null>(null);

	// Idea card attached to the current position, if any. Loaded from IDB
	// every time `currentFenKey` changes; saved explicitly via the panel's
	// Save button (not autosaved on blur like the Notes field — an idea
	// card has two linked fields and the user expects an atomic commit).
	let ideaCard = $state<IdeaCard | null>(null);
	let ideaPrompt = $state('');
	let ideaAnswer = $state('');
	let ideaDirty = $state(false);
	let settings = $state<AppSettings | null>(null);
	let jumpStatus = $state<string | null>(null);
	let jumpBusy = $state(false);
	// On narrow viewports the three "…missing" buttons get rolled up into a
	// single "Find missing" dropdown so they don't push the board below the
	// fold. Desktop still shows them as individual buttons.
	let findMissingOpen = $state(false);

	// Opponent-prep walk-through. Populated from sessionStorage when the
	// editor is opened with `?prep=walk&gapIdx=N`. The banner (near the top
	// of the work area) guides the user through each uncovered opponent
	// move one by one: add your reply, then click "Next gap".
	interface WalkGap {
		fromFenKey: string;
		san: string;
		uci: string;
		count: number;
		line: string;
	}
	interface WalkPayload {
		repertoireId: string;
		repertoireName: string;
		opponent: string;
		created: number;
		gaps: WalkGap[];
	}
	const WALK_STORAGE_KEY = 'cobra:opp-prep-walk';
	let walkPayload = $state<WalkPayload | null>(null);
	let walkIndex = $state(0);

	// Cached list of uncovered threshold-popular opponent moves, sorted by
	// games desc. Populated by a background probe so "Biggest/Most popular
	// missing" clicks can answer instantly instead of re-probing every time.
	// Kept in sync locally: as edges are added (commitMove) or saved
	// (flushPending), matching entries are removed; after a save the cache is
	// refreshed in the background to pick up newly-reachable positions.
	let missingCache = $state<MissingMove[]>([]);
	let missingCacheLoading = $state(false);
	let missingCacheToken = 0;
	let empiricalGaps = $state<EmpiricalGap[]>([]);
	// User-performance aggregate at the current position, keyed by played
	// SAN. Reloaded whenever the current fenKey changes. Drives the
	// "underperforming vs DB" indicator on saved Candidate rows.
	let userWdlAtCurrent = $state<Map<string, PositionWdlRow>>(new SvelteMap());
	let userWdlToken = 0;
	// Engine is always on (auto-started on every position). The toggle
	// below only controls whether its suggestions are painted on the
	// board as arrows; the inline eval readout and explorer cp column
	// remain live regardless.
	let boardHintsEnabled = $state(false);
	let engineByMultipv = $state<Map<number, EngineInfo>>(new Map());
	let cloudEval = $state<CloudEval | null>(null);
	let explorerShapes = $state<DrawShape[]>([]);
	let engineUnsub: (() => void) | null = null;
	let cloudEvalAbort: AbortController | null = null;

	// Count of complete saveable lines — root-to-leaf paths that end on the
	// user's own move (i.e. the terminating leaf is opponent-to-move). Lines
	// that stop on a user-turn position aren't counted: they're open work.
	const _saveableLineCount = $derived(
		rep ? collectSaveableLeaves(nodes, rep.rootFenKey, rep.color).length : 0
	);

	const currentFenKey = $derived(history.at(-1)?.fenKey ?? rep?.rootFenKey ?? '');
	const currentNode = $derived(nodes.get(currentFenKey));
	const lastMove = $derived<[Key, Key] | undefined>(history.at(-1)?.lastMove);
	const sideToMove = $derived<'white' | 'black'>(
		currentFenKey ? colorToMove(currentFenKey) : 'white'
	);
	const isOurTurn = $derived(rep ? sideToMove === rep.color : false);
	const orientation = $derived<'white' | 'black'>(rep?.color ?? 'white');
	// SANs of moves already recorded as children at this position, passed
	// to the Explorer so it can bookmark them inline instead of us
	// maintaining a separate "Continuations in your tree" panel.
	const knownChildSans = $derived<Set<string>>(
		new Set((currentNode?.children ?? []).map((e) => e.san))
	);

	// Load per-SAN user WDL for the current position whenever rep or
	// fenKey changes. Scoped to this repertoire's side only — the store
	// keys by `color`, so we filter to rows matching the builder's colour.
	// Token-guarded against stale async settles if the user steps through
	// positions quickly.
	$effect(() => {
		const repId = rep?.id;
		const key = currentFenKey;
		const color = rep?.color;
		if (!repId || !key || !color) {
			userWdlAtCurrent = new SvelteMap();
			return;
		}
		const myToken = ++userWdlToken;
		void (async () => {
			const rows = await listPositionWdlAtFenKey(repId, key);
			if (myToken !== userWdlToken) return;
			const next = new SvelteMap<string, PositionWdlRow>();
			for (const r of rows) {
				if (r.color !== color) continue;
				next.set(r.playedSan, r);
			}
			userWdlAtCurrent = next;
		})();
	});

	// Unified eval view: one entry per UCI move, keeping whichever source
	// (local Stockfish's iterative deepening or Lichess cloud eval) has
	// the greater search depth. Cloud evals seed the panel instantly for
	// popular positions; local then takes over as it passes cloud depth.
	type UciEval = {
		uci: string;
		depth: number;
		scoreCp?: number;
		scoreMate?: number;
		source: 'local' | 'cloud';
	};
	const combinedByUci = $derived.by<Map<string, UciEval>>(() => {
		const out = new SvelteMap<string, UciEval>();
		const consider = (e: UciEval) => {
			if (e.scoreCp === undefined && e.scoreMate === undefined) return;
			const prev = out.get(e.uci);
			if (!prev || e.depth >= prev.depth) out.set(e.uci, e);
		};
		if (cloudEval) {
			for (const pv of cloudEval.pvs) {
				const uci = pv.moves[0];
				if (!uci) continue;
				consider({
					uci,
					depth: cloudEval.depth,
					scoreCp: pv.scoreCp,
					scoreMate: pv.scoreMate,
					source: 'cloud'
				});
			}
		}
		for (const info of engineByMultipv.values()) {
			const uci = info.pv[0];
			if (!uci) continue;
			consider({
				uci,
				depth: info.depth,
				scoreCp: info.scoreCp,
				scoreMate: info.scoreMate,
				source: 'local'
			});
		}
		return out;
	});

	function formatEval(e: UciEval): { text: string; tone: string } {
		if (e.scoreMate !== undefined) {
			const sign = e.scoreMate > 0 ? '+' : '-';
			const text = `${sign}M${Math.abs(e.scoreMate)}`;
			const tone =
				e.scoreMate > 0 ? 'text-[var(--color-olive-300)]' : 'text-[var(--color-oxblood-300)]';
			return { text, tone };
		}
		const cp = (e.scoreCp ?? 0) / 100;
		const text = cp >= 0 ? `+${cp.toFixed(2)}` : cp.toFixed(2);
		let tone: string;
		if ((e.scoreCp ?? 0) > 80) tone = 'text-[var(--color-olive-300)]';
		else if ((e.scoreCp ?? 0) < -80) tone = 'text-[var(--color-oxblood-300)]';
		else tone = 'text-[var(--color-parchment-300)]';
		return { text, tone };
	}

	// Top move, picking whichever source has the deepest search. Local
	// slot 1 and cloud PV 0 both represent "engine's best"; we just take
	// whichever one has searched further.
	const enginePrimary = $derived.by<UciEval | null>(() => {
		const local1 = engineByMultipv.get(1);
		const localEntry: UciEval | null = local1?.pv[0]
			? {
					uci: local1.pv[0],
					depth: local1.depth,
					scoreCp: local1.scoreCp,
					scoreMate: local1.scoreMate,
					source: 'local' as const
				}
			: null;
		const cloudPv = cloudEval?.pvs?.[0];
		const cloudEntry: UciEval | null =
			cloudPv && cloudPv.moves[0]
				? {
						uci: cloudPv.moves[0],
						depth: cloudEval!.depth,
						scoreCp: cloudPv.scoreCp,
						scoreMate: cloudPv.scoreMate,
						source: 'cloud' as const
					}
				: null;
		if (!localEntry && !cloudEntry) return null;
		if (!localEntry) return cloudEntry;
		if (!cloudEntry) return localEntry;
		return cloudEntry.depth > localEntry.depth ? cloudEntry : localEntry;
	});

	// Full engine rows for every move we have an eval for. Used as the
	// explorer fallback list when Lichess has no games for this position.
	type EngineRow = { uci: string; san: string; text: string; tone: string };
	const engineRows = $derived.by<EngineRow[]>(() => {
		if (!currentFen) return [];
		const out: EngineRow[] = [];
		const seen = new SvelteSet<string>();
		// Prefer the order local engine returned (sorted by slot = engine
		// ranking); then fill with any cloud-only moves.
		const localSorted = Array.from(engineByMultipv.entries()).sort(([a], [b]) => a - b);
		const orderedUcis: string[] = [];
		for (const [, info] of localSorted) {
			const uci = info.pv[0];
			if (uci && !seen.has(uci)) {
				orderedUcis.push(uci);
				seen.add(uci);
			}
		}
		if (cloudEval) {
			for (const pv of cloudEval.pvs) {
				const uci = pv.moves[0];
				if (uci && !seen.has(uci)) {
					orderedUcis.push(uci);
					seen.add(uci);
				}
			}
		}
		for (const uci of orderedUcis) {
			const ev = combinedByUci.get(uci);
			if (!ev) continue;
			const { text, tone } = formatEval(ev);
			try {
				const orig = uci.slice(0, 2);
				const dest = uci.slice(2, 4);
				const promo = uci.length > 4 ? (uci[4] as 'q' | 'r' | 'b' | 'n') : undefined;
				const edge = edgeFromUci(currentFen, orig, dest, promo);
				if (!edge) continue;
				out.push({ uci, san: edge.san, text, tone });
			} catch {
				continue;
			}
		}
		return out;
	});

	// Map-shape consumed by the explorer's inline per-move eval column.
	const engineEvalByUci = $derived.by<Map<string, { text: string; tone: string }>>(() => {
		const out = new SvelteMap<string, { text: string; tone: string }>();
		for (const ev of combinedByUci.values()) out.set(ev.uci, formatEval(ev));
		return out;
	});
	const engineScore = $derived.by(() => {
		const i = enginePrimary;
		if (!i) return '…';
		if (i.scoreMate !== undefined) {
			const sign = i.scoreMate > 0 ? '+' : '';
			return `${sign}M${Math.abs(i.scoreMate)}`;
		}
		if (i.scoreCp !== undefined) {
			const cp = i.scoreCp / 100;
			return cp >= 0 ? `+${cp.toFixed(2)}` : cp.toFixed(2);
		}
		return '…';
	});
	const engineScoreTone = $derived.by(() => {
		const i = enginePrimary;
		if (!i) return 'text-[var(--color-parchment-200)]';
		if (i.scoreMate !== undefined) {
			return i.scoreMate > 0 ? 'text-[var(--color-olive-300)]' : 'text-[var(--color-oxblood-300)]';
		}
		const cp = i.scoreCp ?? 0;
		if (cp > 80) return 'text-[var(--color-olive-300)]';
		if (cp < -80) return 'text-[var(--color-oxblood-300)]';
		return 'text-[var(--color-parchment-100)]';
	});
	const engineTopSan = $derived.by(() => {
		const i = enginePrimary;
		if (!i || !currentFen) return '';
		try {
			const uci = i.uci;
			const orig = uci.slice(0, 2);
			const dest = uci.slice(2, 4);
			const promo = uci.length > 4 ? (uci[4] as 'q' | 'r' | 'b' | 'n') : undefined;
			const edge = edgeFromUci(currentFen, orig, dest, promo);
			return edge?.san ?? '';
		} catch {
			return '';
		}
	});
	// Deepest depth reached across local + cloud — surfaced in the UI so
	// the user can see iterative deepening progressing while idle.
	const engineDepth = $derived.by(() => {
		let d = 0;
		for (const info of engineByMultipv.values()) {
			if (info.depth > d) d = info.depth;
		}
		if (cloudEval && cloudEval.depth > d) d = cloudEval.depth;
		return d;
	});
	const engineSourceLabel = $derived.by(() => {
		if (!enginePrimary) return '';
		return enginePrimary.source === 'cloud' ? 'cloud' : 'local';
	});

	// Transposition indicators: for every legal move from the current
	// position, check whether the resulting fenKey is already in the tree
	// but NOT already a child of the current node. Those are the moves
	// that would *transpose* into existing prep — we surface them as a
	// small icon next to the matching move in the explorer list, so the
	// user doesn't accidentally build a parallel line for the same
	// position.
	// A fenKey only counts as "existing prep" if some edge in the tree
	// (including the root) actually points to it. Orphaned node records
	// — left behind by removeEdge — must not trigger a transposition
	// flag; otherwise deleting a line makes its dest square claim to
	// "transpose into existing prep" that isn't actually reachable.
	const reachableFenKeys = $derived.by<Set<string>>(() => {
		const set = new SvelteSet<string>();
		if (rep?.rootFenKey) set.add(rep.rootFenKey);
		for (const node of nodes.values()) {
			for (const edge of node.children) set.add(edge.toFenKey);
		}
		return set;
	});

	const transposesSans = $derived.by<Set<string>>(() => {
		const out = new SvelteSet<string>();
		if (!currentFen || !currentFenKey) return out;
		const existingChildren = new Set((currentNode?.children ?? []).map((e) => e.toFenKey));
		try {
			const { Chess } = getChessSync();
			const { parseFen, makeFen } = getFenSync();
			const setup = parseFen(currentFen).unwrap();
			const pos = Chess.fromSetup(setup).unwrap();
			const ctx = pos.ctx();
			for (const sq of pos.board[pos.turn]) {
				const legal = pos.dests(sq, ctx);
				for (const to of legal) {
					const clone = pos.clone();
					clone.play({ from: sq, to });
					const toFenKey = makeFen(clone.toSetup(), { epd: true });
					if (toFenKey === currentFenKey) continue;
					if (existingChildren.has(toFenKey)) continue;
					if (!reachableFenKeys.has(toFenKey)) continue;
					const san = sanAtFen(currentFen, { from: sq, to });
					if (san) out.add(san);
				}
			}
		} catch {
			/* best-effort; don't break the UI on a parsing edge case */
		}
		return out;
	});

	const boardShapes = $derived.by<DrawShape[]>(() => {
		const shapes: DrawShape[] = [];
		if (!boardHintsEnabled) return shapes;
		if (engineByMultipv.size > 0) {
			shapes.push(...engineHintShapes({ byMultipv: engineByMultipv }));
		}
		shapes.push(...explorerShapes);
		return shapes;
	});

	// chessops imports lazily — the shape above needs Chess/fen parsing.
	// Cache the modules once to avoid await inside a derived.
	let cachedChess: typeof import('chessops/chess') | null = null;
	let cachedFen: typeof import('chessops/fen') | null = null;
	void (async () => {
		cachedChess = await import('chessops/chess');
		cachedFen = await import('chessops/fen');
	})();
	function getChessSync(): typeof import('chessops/chess') {
		if (!cachedChess) throw new Error('chessops not ready');
		return cachedChess;
	}
	function getFenSync(): typeof import('chessops/fen') {
		if (!cachedFen) throw new Error('chessops not ready');
		return cachedFen;
	}
	function _squareKey(sq: number): string {
		const file = 'abcdefgh'[sq & 7];
		const rank = '12345678'[sq >> 3];
		return file + rank;
	}

	const dests = $derived.by<Map<Key, Key[]>>(() => {
		if (!currentFen) return new Map();
		try {
			const raw = legalDests(currentFen);
			return new Map(Array.from(raw, ([k, v]) => [k as Key, v as Key[]]));
		} catch {
			return new Map();
		}
	});

	$effect(() => {
		if (currentNode) {
			comment = currentNode.comment ?? '';
			commentDirty = false;
		} else {
			comment = '';
			commentDirty = false;
		}
	});

	$effect(() => {
		// Reload the idea card whenever the position changes.
		const rep0 = rep;
		const key = currentFenKey;
		if (!rep0 || !key) {
			ideaCard = null;
			ideaPrompt = '';
			ideaAnswer = '';
			ideaDirty = false;
			return;
		}
		let cancelled = false;
		void getIdeaCard(rep0.id, key).then((card) => {
			if (cancelled) return;
			ideaCard = card ?? null;
			ideaPrompt = card?.prompt ?? '';
			ideaAnswer = card?.answer ?? '';
			ideaDirty = false;
		});
		return () => {
			cancelled = true;
		};
	});

	async function saveIdeaCard() {
		if (!rep || !ideaPrompt.trim()) return;
		const next: IdeaCard = ideaCard
			? {
					...ideaCard,
					prompt: ideaPrompt.trim(),
					answer: ideaAnswer.trim() || undefined
				}
			: freshIdeaCard(rep.id, currentFenKey, ideaPrompt, ideaAnswer);
		await upsertIdeaCard(next);
		ideaCard = next;
		ideaDirty = false;
	}

	async function removeIdeaCard() {
		if (!rep || !ideaCard) return;
		await deleteIdeaCard(rep.id, currentFenKey);
		ideaCard = null;
		ideaPrompt = '';
		ideaAnswer = '';
		ideaDirty = false;
	}

	// Engine + explorer data pipeline. Runs on every position change,
	// independent of the board-hints toggle — so the inline eval, the
	// explorer's cp column, and the engine-only fallback rows stay live
	// even when the user doesn't want arrows painted on the board.
	//
	// Two engines run concurrently:
	//   1. Lichess cloud eval — one-shot FEN lookup. Instantly returns a
	//      deep precomputed eval for popular positions; misses silently
	//      for obscure middlegames.
	//   2. Local Stockfish in `go infinite` mode — iteratively deepens
	//      for as long as the user stays on this position. Replaces the
	//      cloud reading once it passes cloud depth.
	// When the user moves, cleanup stops local search and aborts cloud.
	$effect(() => {
		if (!currentFen || !rep) {
			engineByMultipv = new Map();
			cloudEval = null;
			explorerShapes = [];
			engineUnsub?.();
			engineUnsub = null;
			cloudEvalAbort?.abort();
			cloudEvalAbort = null;
			return;
		}
		engineByMultipv = new Map();
		cloudEval = null;
		explorerShapes = [];

		const fen = currentFen;
		const knownUcis = new Set<string>((currentNode?.children ?? []).map((e) => e.uci));
		const localSettings = settings;
		const token = localSettings ? effectiveLichessToken(localSettings) : null;

		// Cloud eval: fire-and-forget, result lands in state when ready.
		cloudEvalAbort?.abort();
		const abort = new AbortController();
		cloudEvalAbort = abort;
		void fetchCloudEval(fen, 5, { token: token ?? undefined, signal: abort.signal }).then((res) => {
			if (abort.signal.aborted) return;
			if (res) cloudEval = res;
		});

		(async () => {
			let engine: ReturnType<typeof getEngine> | null = null;
			try {
				engine = getEngine();
				await engine.init();
				engineUnsub?.();
				engineUnsub = engine.onInfo((info) => {
					if (!info.multipv) return;
					const map = new SvelteMap(engineByMultipv);
					map.set(info.multipv, info);
					engineByMultipv = map;
				});
			} catch {
				/* engine not available — explorer hints alone are fine */
			}

			let candidateUcis: string[] | undefined;
			if (token) {
				try {
					const res = await fetchExplorer({
						fen,
						speeds: localSettings?.explorerSpeeds,
						ratings: localSettings?.explorerRatings,
						token,
						moves: 10
					});
					candidateUcis = res.moves.map((m) => m.uci);
					const totalGames = res.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
					const threshold = rep?.coverageGoal ? totalGames / rep.coverageGoal : 0;
					explorerShapes = explorerHintShapes({
						totalGames,
						moves: res.moves,
						knownUcis,
						threshold
					});
				} catch {
					/* non-fatal */
				}
			}

			if (engine) {
				try {
					if (candidateUcis && candidateUcis.length > 0) {
						// Ask Stockfish for one PV per candidate, restricted to
						// those exact moves. Guarantees every explorer row has
						// an eval, regardless of ranking.
						engine.setMultiPV(candidateUcis.length);
						await engine.goInfinite(fen, candidateUcis);
					} else {
						engine.setMultiPV(10);
						await engine.goInfinite(fen);
					}
				} catch {
					/* engine died mid-search — silently skip */
				}
			}
		})();

		return () => {
			engineUnsub?.();
			engineUnsub = null;
			cloudEvalAbort?.abort();
			cloudEvalAbort = null;
			try {
				getEngine().stop();
			} catch {
				/* ignore */
			}
		};
	});

	onMount(async () => {
		const id = page.params.id;
		if (!id) {
			loading = false;
			return;
		}
		rep = (await getRepertoire(id)) ?? null;
		if (!rep) {
			loading = false;
			return;
		}
		nodes = await nodesMap(rep.id);
		settings = await getSettings();
		empiricalGaps = await listGapsForRepertoire(rep.id);
		currentFen = rep.rootFen;
		loading = false;
		// Deep-link support: `?jump=<fenKey>` lands the board at that node.
		// Used by the Opponent-prep page to drop you straight at the
		// position whose reply you need to add.
		const jumpKey = page.url.searchParams.get('jump');
		const isPrepWalk = page.url.searchParams.get('prep') === 'walk';
		if (jumpKey && nodes.has(jumpKey)) {
			jumpToFenKey(jumpKey);
		} else if (!isPrepWalk && settings?.openAtStartingPosition !== false && nodes.size > 0) {
			// Per-user default: open the builder straight at the rep's
			// starting position (explicit pin, else nearest branching
			// node) so the user doesn't have to click through the forced
			// prefix every time. Skipped when a deep-link target, a prep
			// walk-through, or the starting position resolves to the
			// root (nothing to skip).
			const startKey = rep.startingFenKey ?? furthestNonBranchingFenKey(nodes, rep.rootFenKey);
			if (startKey && startKey !== rep.rootFenKey && nodes.has(startKey)) {
				jumpToFenKey(startKey);
			}
		}
		// Walk-through from the Opponent-prep page. Loads the queued list of
		// gaps from sessionStorage, jumps to the first one, and surfaces a
		// banner that advances through the rest on demand.
		if (page.url.searchParams.get('prep') === 'walk') {
			const raw =
				typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(WALK_STORAGE_KEY) : null;
			if (raw) {
				try {
					const parsed = JSON.parse(raw) as WalkPayload;
					if (parsed.repertoireId === rep.id && parsed.gaps?.length) {
						walkPayload = parsed;
						const idxParam = parseInt(page.url.searchParams.get('gapIdx') ?? '0', 10);
						walkIndex = Number.isFinite(idxParam)
							? Math.max(0, Math.min(idxParam, parsed.gaps.length - 1))
							: 0;
						const target = parsed.gaps[walkIndex];
						if (target) landOnGap(target);
					}
				} catch {
					/* ignore malformed payload */
				}
			}
		}
		// Warm the missing-moves cache so the Biggest/Most-popular buttons
		// respond instantly on first click.
		void refreshMissingCache();

		// Pull the cached dossier, if any, and derive the fingerprint +
		// openingFit pair the Explorer uses for style advice. Failures here
		// are non-fatal — Explorer renders without advice. Skipped unless
		// the user has opted in via settings.
		if (settings?.styleAdviceEnabled) {
			void (async () => {
				try {
					const saved = await loadDossierReport();
					if (!saved?.payload) return;
					const payload = saved.payload as DossierScanResult;
					if (payload.fingerprint) styleFingerprint = payload.fingerprint;
					if (payload.classified) {
						styleOpeningFit = analyseOpeningFit(
							payload.classified,
							payload.evalAxes?.allMoves ?? null
						);
					}
				} catch (e) {
					console.warn('[edit] failed to load dossier for style advice:', e);
				}
			})();
		}
	});

	const walkCurrent = $derived<WalkGap | null>(
		walkPayload ? (walkPayload.gaps[walkIndex] ?? null) : null
	);
	const walkTotal = $derived(walkPayload?.gaps.length ?? 0);

	/**
	 * Walk the builder to a gap's position and auto-play the opponent's
	 * move one more ply. That way the user always arrives on the
	 * user-to-move position where their reply goes — same UX as
	 * `jumpToMissing`.
	 */
	async function landOnGap(gap: WalkGap) {
		if (!rep) return;
		if (!nodes.has(gap.fromFenKey)) {
			await jumpToFenKey(rep.rootFenKey);
			return;
		}
		await jumpToFenKey(gap.fromFenKey);
		const edge = edgeFromSan(currentFen, gap.san);
		if (!edge) return;
		const newFen = fenAfterMove(currentFen, edge);
		history = [
			...history,
			{
				fen: newFen,
				fenKey: edge.toFenKey,
				san: edge.san,
				lastMove: [edge.uci.slice(0, 2) as Key, edge.uci.slice(2, 4) as Key]
			}
		];
		currentFen = newFen;
	}

	async function advanceWalk(delta: number) {
		if (!walkPayload || !rep) return;
		// Auto-save any pending reply the user has just added before moving on.
		if (pendingEdges.length > 0) await flushPending();
		const nextIdx = walkIndex + delta;
		if (nextIdx < 0 || nextIdx >= walkPayload.gaps.length) {
			exitWalk();
			return;
		}
		walkIndex = nextIdx;
		const target = walkPayload.gaps[walkIndex];
		if (target) landOnGap(target);
		// Keep the URL in sync so reloads land on the same gap.
		const url = new URL(page.url);
		url.searchParams.set('gapIdx', String(walkIndex));
		window.history.replaceState(window.history.state, '', url);
	}

	function exitWalk() {
		walkPayload = null;
		walkIndex = 0;
		try {
			sessionStorage.removeItem(WALK_STORAGE_KEY);
		} catch {
			/* ignore */
		}
		const url = new URL(page.url);
		url.searchParams.delete('prep');
		url.searchParams.delete('gapIdx');
		window.history.replaceState(window.history.state, '', url);
	}

	const topGap = $derived<EmpiricalGap | null>(empiricalGaps[0] ?? null);

	function _sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	/**
	 * Shared pipeline for adding a move: from the board, from the explorer, or
	 * from anywhere else. Adds the edge, maybe seeds a Card (if the parent
	 * position is our colour to move), refreshes the node map, advances the
	 * line, and touches the repertoire's updatedAt.
	 */
	// Pending buffer: moves played on the board but not yet persisted.
	// We only write to the repertoire store when the user clicks Save.
	type PendingEdge = { fromKey: string; fromFen: string; edge: Edge };
	let pendingEdges = $state<PendingEdge[]>([]);

	async function commitMove(edge: Edge) {
		if (!rep) return;
		cancelJumpAnim();
		// "Saved" pill is a one-shot confirmation. The moment the user
		// plays a new move we're measuring a new line, so the stale
		// checkmark doesn't belong on screen anymore — a fresh "+N" pill
		// will take over as movesSinceSave grows again.
		clearJustSaved();
		const fromKey = currentFenKey;
		const fromFen = currentFen;
		const persistedNode = nodes.get(fromKey);
		const alreadyPersisted = persistedNode?.children.some((c) => c.uci === edge.uci) ?? false;
		const alreadyPending = pendingEdges.some(
			(p) => p.fromKey === fromKey && p.edge.uci === edge.uci
		);
		if (!alreadyPersisted && !alreadyPending) {
			pendingEdges = [...pendingEdges, { fromKey, fromFen, edge }];
			// Only count the user's own moves — an opponent move on its own
			// doesn't close a saveable line, so it shouldn't bump "+N this
			// session". The mover's side is the side-to-move at `fromKey`.
			if (colorToMove(fromKey) === rep.color) movesSinceSave += 1;
			evictCoveredFromCache(fromKey, edge.uci);
		}
		const newFen = fenAfterMove(fromFen, edge);
		const orig = edge.uci.slice(0, 2) as Key;
		const dest = edge.uci.slice(2, 4) as Key;
		history = [
			...history,
			{ fen: newFen, fenKey: edge.toFenKey, san: edge.san, lastMove: [orig, dest] }
		];
		currentFen = newFen;
	}

	async function flushPending() {
		if (!rep || pendingEdges.length === 0) return;
		for (const p of pendingEdges) {
			await addEdge(rep.id, p.fromKey, p.edge);
			const parentSide = colorToMove(p.fromKey);
			if (rep.color === parentSide) {
				const existing = await getCard(rep.id, p.fromKey);
				if (!existing) {
					const now = Date.now();
					await upsertCard({
						repertoireId: rep.id,
						fenKey: p.fromKey,
						expectedSan: p.edge.san,
						fsrs: createEmptyCard(new Date(now)),
						dueAt: now
					});
				}
			}
		}
		nodes = await nodesMap(rep.id);
		await touchRepertoire(rep.id);
		pendingEdges = [];
		// Save has closed some gaps and may have opened deeper ones; kick
		// off a background refresh so subsequent clicks stay instant.
		void refreshMissingCache();
	}

	function handleMove(orig: Key, dest: Key, _metadata: MoveMetadata) {
		if (!rep) return;
		const promo = isPromotionMove(currentFen, orig, dest) ? 'q' : undefined;
		const edge = edgeFromUci(currentFen, orig, dest, promo);
		if (!edge) return;
		void commitMove(edge);
	}

	async function addFromExplorer(san: string) {
		const edge = edgeFromSan(currentFen, san);
		if (edge) await commitMove(edge);
	}

	async function deleteFromExplorer(san: string, uci: string) {
		if (!rep) return;
		// Drop any pending buffer entry for this edge first so UI state
		// stays in sync.
		pendingEdges = pendingEdges.filter((p) => !(p.fromKey === currentFenKey && p.edge.uci === uci));
		const child = (currentNode?.children ?? []).find((c) => c.uci === uci);
		if (child) {
			await removeEdge(rep.id, currentFenKey, child.toFenKey);
			// If that was the last child at this position and we had a
			// drill card here, remove the card too (it would point at a
			// move that no longer exists). We leave cards at still-populated
			// parents alone — they'll simply accept any remaining child.
			const refreshed = await nodesMap(rep.id);
			const remaining = refreshed.get(currentFenKey);
			if (!remaining || remaining.children.length === 0) {
				await deleteCard(rep.id, currentFenKey);
			}
			nodes = refreshed;
			await touchRepertoire(rep.id);
		}
		void san;
	}

	/**
	 * Reconcile state when walking the line backwards: any pending edge that
	 * led into a step we're dropping is "undone" — it's removed from the
	 * save queue, and if it was the user's own move the session counter
	 * ticks back down. Persisted (already-saved) edges are left alone; we
	 * can't un-save them silently.
	 */
	function untrackDroppedSteps(fromIndex: number) {
		if (!rep) return;
		for (let i = fromIndex; i < history.length; i++) {
			const step = history[i];
			const fromKey = i === 0 ? rep.rootFenKey : history[i - 1].fenKey;
			const pendingIdx = pendingEdges.findIndex(
				(p) => p.fromKey === fromKey && p.edge.toFenKey === step.fenKey
			);
			if (pendingIdx < 0) continue;
			pendingEdges = pendingEdges.filter((_, idx) => idx !== pendingIdx);
			if (colorToMove(fromKey) === rep.color && movesSinceSave > 0) {
				movesSinceSave -= 1;
			}
		}
	}

	function goBack() {
		if (history.length === 0) return;
		cancelJumpAnim();
		untrackDroppedSteps(history.length - 1);
		history = history.slice(0, -1);
		currentFen = history.at(-1)?.fen ?? rep!.rootFen;
	}

	// Cancellation token for the staged "build from branching point" animation.
	// Every call to jumpToFenKey bumps this so an in-flight replay aborts
	// before clobbering a newer navigation. `cancelJumpAnim` also lets direct
	// history mutations (goBack, commitMove, goToPly, jumpToSibling, …) abort
	// a running replay before applying their own update.
	let jumpAnimToken = 0;
	const JUMP_BUILD_STEP_MS = 180;
	function cancelJumpAnim() {
		jumpAnimToken++;
	}

	/**
	 * Walk the tree from the root to `targetKey` using BFS (pathToFenKey),
	 * and rebuild `history` so the board shows the full line. Quietly skips
	 * if the path can't be resolved.
	 *
	 * When the target lies on the current line (one path is a prefix of the
	 * other) the update is applied in one shot — the board just slides along
	 * a line it's already showing. When the target branches off mid-line we
	 * first snap to the branching point (the last shared ancestor) and then
	 * append the divergent moves one ply at a time, so chessground animates
	 * each move individually instead of teleporting every piece at once.
	 */
	async function jumpToFenKey(targetKey: string): Promise<void> {
		if (!rep) return;
		const edges = pathToFenKey(nodes, rep.rootFenKey, targetKey);
		if (!edges) return;
		const token = ++jumpAnimToken;
		if (edges.length === 0) {
			history = [];
			currentFen = rep.rootFen;
			return;
		}
		let fen = rep.rootFen;
		const fullPath: HistoryStep[] = [];
		for (const edge of edges) {
			const newFen = fenAfterMove(fen, edge);
			fullPath.push({
				fen: newFen,
				fenKey: edge.toFenKey,
				san: edge.san,
				lastMove: [edge.uci.slice(0, 2) as Key, edge.uci.slice(2, 4) as Key]
			});
			fen = newFen;
		}

		// Longest common prefix between the current line and the target path.
		// If one is a prefix of the other, we're still on a linear extension
		// of a former point — a single-shot update is fine.
		let shared = 0;
		const limit = Math.min(history.length, fullPath.length);
		while (shared < limit && history[shared].fenKey === fullPath[shared].fenKey) {
			shared++;
		}
		const linear = shared === history.length || shared === fullPath.length;

		if (linear) {
			history = fullPath;
			currentFen = fen;
			return;
		}

		// Branching case: snap to the divergence point, then play the
		// remaining moves forward one at a time so the board animates each
		// move instead of teleporting every piece simultaneously.
		history = fullPath.slice(0, shared);
		currentFen = shared === 0 ? rep.rootFen : fullPath[shared - 1].fen;
		for (let i = shared; i < fullPath.length; i++) {
			await new Promise((r) => setTimeout(r, JUMP_BUILD_STEP_MS));
			if (token !== jumpAnimToken) return;
			history = fullPath.slice(0, i + 1);
			currentFen = fullPath[i].fen;
		}
	}

	const startingIsPinned = $derived(!!rep?.startingFenKey);
	// "Pin start" button state: allowed anywhere the current fenKey is
	// actually in the tree. Branching positions are permitted — auto
	// mode can also land on a branching node (first real choice in the
	// line), so pinning there is symmetric with letting auto do so.
	// When the current position is already the pinned gate the button
	// flips to an unpin affordance.
	const currentIsPinnable = $derived(!!currentNode);
	const currentIsPinnedGate = $derived(
		startingIsPinned && !!rep?.startingFenKey && rep.startingFenKey === currentFenKey
	);

	/**
	 * Pin the current board position as the analysis gate, or unpin if
	 * the current position is already the pinned gate.
	 */
	async function togglePinAtCurrent() {
		if (!rep || !currentFenKey) return;
		const nextKey = currentIsPinnedGate ? undefined : currentFenKey;
		if (nextKey && !currentIsPinnable) return;
		await setStartingPosition(rep.id, nextKey);
		rep = { ...rep, startingFenKey: nextKey };
	}

	function jumpTopEmpiricalGap() {
		if (!rep || !topGap) return;
		jumpToFenKey(topGap.fenKey);
		const n = topGap.count;
		jumpStatus = `Jumped to gap faced in ${n} game${n === 1 ? '' : 's'}.`;
		setTimeout(() => (jumpStatus = null), 2500);
	}

	/**
	 * Land on the opponent-turn position where a missing move is needed,
	 * then auto-play the missing opponent move one more ply so the user
	 * arrives at the user-turn position where they'd enter their reply.
	 * The target after the missing move isn't in `nodes` — that's fine,
	 * history only tracks the board state.
	 */
	async function jumpToMissing(missing: MissingMove) {
		await jumpToFenKey(missing.fromFenKey);
		const edge: Edge = {
			san: missing.san,
			uci: missing.uci,
			toFenKey: missing.afterFenKey
		};
		const newFen = fenAfterMove(missing.fromFen, edge);
		history = [
			...history,
			{
				fen: newFen,
				fenKey: missing.afterFenKey,
				san: missing.san,
				lastMove: [missing.uci.slice(0, 2) as Key, missing.uci.slice(2, 4) as Key]
			}
		];
		currentFen = newFen;
		// Queue the opponent's missing move as a pending edge so the save
		// actually fills the hole in the tree. Without this the board would
		// look advanced but only the user's reply would get persisted.
		const alreadyPersisted = nodes
			.get(missing.fromFenKey)
			?.children.some((c) => c.uci === missing.uci);
		const alreadyPending = pendingEdges.some(
			(p) => p.fromKey === missing.fromFenKey && p.edge.uci === missing.uci
		);
		if (!alreadyPersisted && !alreadyPending) {
			pendingEdges = [
				...pendingEdges,
				{ fromKey: missing.fromFenKey, fromFen: missing.fromFen, edge }
			];
			// Don't bump movesSinceSave — this is the opponent's move, the
			// user hasn't actually finished a line yet. The counter only
			// advances when they play their own reply next.
			evictCoveredFromCache(missing.fromFenKey, missing.uci);
		}
	}

	function fenFromKey(key: string): string {
		const parts = key.split(' ');
		return parts.length === 4 ? `${key} 0 1` : key;
	}

	/**
	 * Kick off a background probe of the whole tree and replace the missing-
	 * move cache with the result. Uses a monotonic token so overlapping
	 * refreshes (e.g. rapid saves) don't clobber newer results with older
	 * ones. Silent on failure — the cache just stays as-is.
	 */
	async function refreshMissingCache() {
		if (!rep || !settings) return;
		if (!rep.coverageGoal || rep.coverageGoal <= 0) return;
		const token = effectiveLichessToken(settings);
		if (!token) return;
		const mine = ++missingCacheToken;
		missingCacheLoading = true;
		try {
			const list = await collectMissingMoves(
				nodes,
				rep.rootFenKey,
				rep.rootFen,
				rep.color,
				rep.coverageGoal,
				fenFromKey,
				{
					speeds: settings.explorerSpeeds,
					ratings: settings.explorerRatings,
					token
				}
			);
			if (mine === missingCacheToken) missingCache = list;
		} catch {
			/* silent — cache stays stale */
		} finally {
			if (mine === missingCacheToken) missingCacheLoading = false;
		}
	}

	/**
	 * Drop any cache entries that are no longer missing because an edge now
	 * covers them. Call from `commitMove` / `flushPending` so the cache stays
	 * consistent with the tree even before a background refresh completes.
	 */
	function evictCoveredFromCache(fromFenKey: string, uci: string) {
		if (missingCache.length === 0) return;
		missingCache = missingCache.filter((m) => !(m.fromFenKey === fromFenKey && m.uci === uci));
	}

	/**
	 * "Next missing" — walk the current line from the root down to where the
	 * user is sitting, probe the explorer at each opponent-turn position, and
	 * jump to the first uncovered threshold-popular move. Closest-to-root
	 * wins so the earliest hole on the line gets addressed first.
	 */
	async function jumpNextMissing() {
		if (!rep || !settings || jumpBusy) return;
		if (!rep.coverageGoal || rep.coverageGoal <= 0) {
			jumpStatus = 'Set a coverage goal (1-in-N) on the repertoire to use missing-move jumps.';
			setTimeout(() => (jumpStatus = null), 3500);
			return;
		}
		const token = effectiveLichessToken(settings);
		if (!token) {
			jumpStatus = 'Connect Lichess (or paste a token) in Settings to probe missing moves.';
			setTimeout(() => (jumpStatus = null), 3500);
			return;
		}
		// Path from root → current: start with the root, then each history
		// step's resulting position.
		const path: { fenKey: string; fen: string }[] = [{ fenKey: rep.rootFenKey, fen: rep.rootFen }];
		for (const step of history) {
			path.push({ fenKey: step.fenKey, fen: step.fen });
		}
		jumpBusy = true;
		jumpStatus = 'Probing current line…';
		try {
			const miss = await firstMissingOnLine(nodes, path, rep.color, rep.coverageGoal, {
				speeds: settings.explorerSpeeds,
				ratings: settings.explorerRatings,
				token
			});
			if (!miss) {
				jumpStatus = 'No missing threshold-popular moves on this line.';
				setTimeout(() => (jumpStatus = null), 3000);
				return;
			}
			jumpStatus = `${miss.san} — ${miss.games.toLocaleString()} games`;
			setTimeout(() => (jumpStatus = null), 3000);
			jumpToMissing(miss);
		} finally {
			jumpBusy = false;
		}
	}

	/**
	 * "Biggest missing" — like most-popular missing, but skips any opponent-
	 * turn position that sits on the current line. "Next missing" already
	 * handles current-line gaps, so this button surfaces the biggest hole
	 * *elsewhere* in the tree.
	 */
	async function jumpBiggestMissing() {
		if (!rep || !settings || jumpBusy) return;
		if (!rep.coverageGoal || rep.coverageGoal <= 0) {
			jumpStatus = 'Set a coverage goal (1-in-N) on the repertoire to use missing-move jumps.';
			setTimeout(() => (jumpStatus = null), 3500);
			return;
		}
		const token = effectiveLichessToken(settings);
		if (!token) {
			jumpStatus = 'Connect Lichess (or paste a token) in Settings to probe missing moves.';
			setTimeout(() => (jumpStatus = null), 3500);
			return;
		}
		const excludeFenKeys = new Set<string>([rep.rootFenKey, ...history.map((s) => s.fenKey)]);
		const cached = missingCache.find((m) => !excludeFenKeys.has(m.fromFenKey));
		if (cached) {
			jumpStatus = `${cached.san} — ${cached.games.toLocaleString()} games`;
			setTimeout(() => (jumpStatus = null), 3000);
			jumpToMissing(cached);
			// Line up the next candidate in the background so the next click
			// is instant too.
			void refreshMissingCache();
			return;
		}
		// Cache miss (either never populated or empty after saves). Fall back
		// to a direct probe and populate the cache with the result.
		jumpBusy = true;
		jumpStatus = missingCacheLoading ? 'Still probing…' : 'Probing tree…';
		try {
			await refreshMissingCache();
			const miss = missingCache.find((m) => !excludeFenKeys.has(m.fromFenKey));
			if (!miss) {
				jumpStatus = 'No missing threshold-popular moves outside this line.';
				setTimeout(() => (jumpStatus = null), 3000);
				return;
			}
			jumpStatus = `${miss.san} — ${miss.games.toLocaleString()} games`;
			setTimeout(() => (jumpStatus = null), 3000);
			jumpToMissing(miss);
		} finally {
			jumpBusy = false;
		}
	}

	/**
	 * "Most popular missing" — BFS the whole tree, probe opponent-turn nodes,
	 * and jump to the single most-played uncovered move above the repertoire
	 * threshold.
	 */
	async function jumpMostImportant() {
		if (!rep || !settings || jumpBusy) return;
		if (!rep.coverageGoal || rep.coverageGoal <= 0) {
			jumpStatus = 'Set a coverage goal (1-in-N) on the repertoire to use missing-move jumps.';
			setTimeout(() => (jumpStatus = null), 3500);
			return;
		}
		const token = effectiveLichessToken(settings);
		if (!token) {
			jumpStatus = 'Connect Lichess (or paste a token) in Settings to rank by popularity.';
			setTimeout(() => (jumpStatus = null), 3500);
			return;
		}
		const cached = missingCache[0];
		if (cached) {
			jumpStatus = `${cached.san} — ${cached.games.toLocaleString()} games`;
			setTimeout(() => (jumpStatus = null), 3000);
			jumpToMissing(cached);
			void refreshMissingCache();
			return;
		}
		jumpBusy = true;
		jumpStatus = missingCacheLoading ? 'Still probing…' : 'Probing tree…';
		try {
			await refreshMissingCache();
			const miss = missingCache[0];
			if (!miss) {
				jumpStatus = 'No missing threshold-popular moves found.';
				setTimeout(() => (jumpStatus = null), 3000);
				return;
			}
			jumpStatus = `${miss.san} — ${miss.games.toLocaleString()} games`;
			setTimeout(() => (jumpStatus = null), 3000);
			jumpToMissing(miss);
		} finally {
			jumpBusy = false;
		}
	}

	function goStart() {
		cancelJumpAnim();
		untrackDroppedSteps(0);
		history = [];
		currentFen = rep!.rootFen;
	}

	function goToPly(index: number) {
		if (index < 0) {
			goStart();
			return;
		}
		if (index >= history.length - 1) return;
		cancelJumpAnim();
		untrackDroppedSteps(index + 1);
		history = history.slice(0, index + 1);
		currentFen = history[index].fen;
	}

	/**
	 * Siblings at a given ply — the other edges out of the parent that the
	 * user didn't take on this pass. Combines persisted children with any
	 * pending (unsaved) edges at that parent so the newly-played move's
	 * forerunners stay visible as sidelines instead of looking deleted.
	 */
	function siblingsAt(i: number): Edge[] {
		if (!rep) return [];
		const parentKey = i === 0 ? rep.rootFenKey : history[i - 1].fenKey;
		const takenKey = history[i].fenKey;
		const persisted = nodes.get(parentKey)?.children ?? [];
		const pending = pendingEdges.filter((p) => p.fromKey === parentKey).map((p) => p.edge);
		const seen = new SvelteSet<string>([takenKey]);
		const out: Edge[] = [];
		for (const edge of [...persisted, ...pending]) {
			if (seen.has(edge.toFenKey)) continue;
			seen.add(edge.toFenKey);
			out.push(edge);
		}
		return out;
	}

	/**
	 * Pivot the current line onto a different child at ply `i`. Keeps the
	 * history up to the parent and replaces the chosen step with the
	 * sideline move; anything deeper is dropped (as with `goToPly`).
	 */
	function jumpToSibling(i: number, edge: Edge) {
		if (!rep) return;
		cancelJumpAnim();
		untrackDroppedSteps(i);
		const trimmed = history.slice(0, i);
		const parentFen = i === 0 ? rep.rootFen : trimmed[trimmed.length - 1].fen;
		const newFen = fenAfterMove(parentFen, edge);
		history = [
			...trimmed,
			{
				fen: newFen,
				fenKey: edge.toFenKey,
				san: edge.san,
				lastMove: [edge.uci.slice(0, 2) as Key, edge.uci.slice(2, 4) as Key]
			}
		];
		currentFen = newFen;
	}

	async function saveComment() {
		if (!rep || !commentDirty) return;
		await setNodeComment(rep.id, currentFenKey, comment.trim());
		nodes = await nodesMap(rep.id);
		commentDirty = false;
	}

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && findMissingOpen) {
			e.preventDefault();
			findMissingOpen = false;
			return;
		}
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			goBack();
		} else if (e.key === 'Home') {
			e.preventDefault();
			goStart();
		}
	}

	function moveNumberPrefix(i: number): string | null {
		return i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : null;
	}

	// "Save line" tracks how many moves the user has added since the last
	// explicit save — moves auto-persist as they're played, but the user
	// still wants a commit moment. We increment on every successful
	// commitMove and reset when they click Save.
	let movesSinceSave = $state(0);
	// Transient "Saved" state: the Save-line pill morphs into a green
	// checkmark for ~1.5 s after a save, then quietly disappears (or
	// gets replaced by a fresh "+N" pill on the next move).
	let justSaved = $state(false);
	let justSavedTimer: ReturnType<typeof setTimeout> | null = null;
	// Derived flags for the Save-line pill (shared by the desktop action
	// bar and the mobile board toolbar). The pill stays mounted always
	// and just disables when there's nothing new to save, so it doesn't
	// pop in and out of the toolbar.
	const saveNothingToDo = $derived(movesSinceSave === 0 && !justSaved);
	const saveNudge = $derived(!justSaved && movesSinceSave >= 5);
	const saveToneClass = $derived(
		justSaved
			? 'border-[var(--color-olive-400)] bg-[var(--color-olive-500)]/30 text-[var(--color-olive-300)]'
			: saveNudge
				? 'save-pulse border-[var(--color-brass-400)] bg-[var(--color-brass-500)] text-[var(--color-ink-950)]'
				: 'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] text-[var(--color-parchment-100)]'
	);

	async function saveLine() {
		await flushPending();
		movesSinceSave = 0;
		justSaved = true;
		if (justSavedTimer) clearTimeout(justSavedTimer);
		justSavedTimer = setTimeout(() => {
			justSaved = false;
			justSavedTimer = null;
		}, 1500);
	}
	function clearJustSaved() {
		if (!justSaved) return;
		justSaved = false;
		if (justSavedTimer) {
			clearTimeout(justSavedTimer);
			justSavedTimer = null;
		}
	}

	// Lichess bot-challenge dialog state. Opens when the user clicks
	// "Challenge bot", collects opponent + level + color, then hits the
	// Lichess challenge API with the current FEN and opens the game URL
	// in a new tab.
	let botDialogOpen = $state(false);
	let botOpponent = $state<'stockfish' | 'maia'>('stockfish');
	let botStockfishLevel = $state(5);
	let botMaiaRating = $state<1100 | 1500 | 1900>(1500);
	let botColor = $state<ChallengeColor>('white');
	let botClockLimit = $state(600);
	let botClockIncrement = $state(0);
	let botLaunching = $state(false);
	let botError = $state<string | null>(null);
	let botMissingScope = $state(false);

	function openBotDialog() {
		if (!rep) return;
		botOpponent = 'stockfish';
		botStockfishLevel = 5;
		botMaiaRating = 1500;
		botColor = rep.color;
		botError = null;
		botMissingScope = false;
		botDialogOpen = true;
	}
	function closeBotDialog() {
		if (botLaunching) return;
		botDialogOpen = false;
		botError = null;
		botMissingScope = false;
	}
	async function launchBotChallenge() {
		if (!rep || !settings || botLaunching) return;
		const token = effectiveLichessToken(settings);
		if (!token) {
			botError = 'No Lichess token configured. Paste one in Settings first.';
			return;
		}
		botLaunching = true;
		botError = null;
		botMissingScope = false;
		try {
			const challengeBase = {
				color: botColor,
				fen: currentFen,
				clockLimit: botClockLimit,
				clockIncrement: botClockIncrement,
				token
			};
			const url =
				botOpponent === 'stockfish'
					? await challengeStockfishAi({ ...challengeBase, level: botStockfishLevel })
					: await challengeMaia({ ...challengeBase, rating: botMaiaRating });

			// Ledger entry — so we can reconcile the game (fetch its PGN,
			// detect deviations) later. If Lichess randomised the colour we
			// still land the user on *some* side; reconciliation will flip
			// the recorded colour from the PGN header if needed.
			const gameId = gameIdFromUrl(url);
			if (gameId && rep) {
				const userColorForRecord =
					botColor === 'random' ? rep.color : (botColor as 'white' | 'black');
				const opponentLabel =
					botOpponent === 'stockfish' ? `Stockfish L${botStockfishLevel}` : `Maia ${botMaiaRating}`;
				const strength = botOpponent === 'stockfish' ? botStockfishLevel : botMaiaRating;
				try {
					await upsertSparGame({
						id: gameId,
						repertoireId: rep.id,
						repertoireName: rep.name,
						startFen: currentFen,
						userColor: userColorForRecord,
						opponent: botOpponent,
						opponentLabel,
						opponentStrength: strength,
						gameUrl: url,
						startedAt: Date.now(),
						status: 'pending'
					});
				} catch (e) {
					console.warn('[spar ledger] upsert failed:', e);
				}
			}

			window.open(url, '_blank', 'noopener,noreferrer');
			botDialogOpen = false;
			// Land the user on the per-game spar page: polls Lichess for
			// the PGN, shows the waiting state, then the analysis.
			if (gameId && rep) {
				await goto(resolve(`/repertoire/${rep.id}/spar/${gameId}`));
			}
		} catch (e) {
			if (e instanceof BotChallengeError) {
				botError = e.message;
				botMissingScope = e.missingScope;
			} else {
				botError = e instanceof Error ? e.message : 'Failed to launch challenge.';
			}
		} finally {
			botLaunching = false;
		}
	}

	let lineCopied = $state(false);
	let lineCopyTimer: ReturnType<typeof setTimeout> | null = null;
	async function copyLine() {
		const parts: string[] = [];
		for (const [i, h] of history.entries()) {
			if (!h.san) continue;
			const prefix = moveNumberPrefix(i);
			if (prefix) parts.push(prefix);
			parts.push(h.san);
		}
		const text = parts.join(' ');
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			lineCopied = true;
			if (lineCopyTimer) clearTimeout(lineCopyTimer);
			lineCopyTimer = setTimeout(() => (lineCopied = false), 1500);
		} catch {
			/* clipboard blocked — silently ignore */
		}
	}
</script>

<svelte:window on:keydown={handleKey} />

{#if loading}
	<div class="mx-auto max-w-4xl px-6 pt-16">
		<p class="text-sm text-[var(--color-parchment-400)]">Loading…</p>
	</div>
{:else if !rep}
	<div class="mx-auto max-w-4xl px-6 pt-16">
		<p class="text-[var(--color-oxblood-300)]">Repertoire not found.</p>
	</div>
{:else}
	<div class="mx-auto max-w-[1280px] px-4 py-6 md:px-6">
		<div class="mb-5 flex items-center gap-3">
			<a
				href={resolve(`/repertoire/${rep.id}`)}
				class="eyebrow inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
			>
				<ArrowLeft class="size-3" />
				<span class="max-w-[200px] truncate">{rep.name}</span>
			</a>
			<span class="hidden text-[var(--color-ink-600)] lg:inline">/</span>
			<span class="eyebrow hidden text-[var(--color-parchment-300)] lg:inline">Edit</span>

			<!-- Actions dropdown — mobile only, right-aligned in the header.
				 Replaces the "/ Edit" breadcrumb label on narrow viewports so
				 the primary menu is reachable from the top of the page
				 (desktop keeps the full action bar below the header).
				 Ghost styling: the header is a breadcrumb strip, not an
				 action bar, so a flat text-plus-icon trigger reads as
				 "more" rather than competing with the eventual primary CTA
				 (Save pill) down below. -->
			<div class="relative ml-auto lg:hidden">
				<button
					type="button"
					onclick={() => (findMissingOpen = !findMissingOpen)}
					disabled={jumpBusy}
					aria-haspopup="menu"
					aria-expanded={findMissingOpen}
					title="Jump to a missing move, spar a bot, or toggle arrows"
					class="eyebrow inline-flex items-center gap-1.5 rounded-[3px] px-1.5 py-1 text-[var(--color-parchment-300)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)] disabled:opacity-60"
				>
					<Menu class="size-3.5" />
					<span>{jumpBusy ? 'Probing…' : 'Actions'}</span>
					<ChevronDown class="size-3" />
				</button>
				{#if findMissingOpen}
					<button
						type="button"
						aria-label="Close menu"
						class="fixed inset-0 z-30"
						onclick={() => (findMissingOpen = false)}
					></button>
					<div
						role="menu"
						class="absolute top-full right-0 z-40 mt-1 w-64 overflow-hidden rounded-[4px] border border-[var(--color-ink-700)] shadow-[var(--shadow-lg)]"
						style:background-color="var(--color-ink-900)"
					>
						<button
							type="button"
							role="menuitem"
							disabled={jumpBusy}
							onclick={() => {
								findMissingOpen = false;
								void jumpNextMissing();
							}}
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:opacity-60"
						>
							<Compass class="size-3.5 text-[var(--color-parchment-400)]" />
							<span
								>Next missing <span class="text-[var(--color-parchment-500)]">· on this line</span
								></span
							>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={jumpBusy}
							onclick={() => {
								findMissingOpen = false;
								void jumpBiggestMissing();
							}}
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:opacity-60"
						>
							<Flame class="size-3.5 text-[var(--color-parchment-400)]" />
							<span
								>Biggest missing <span class="text-[var(--color-parchment-500)]">· elsewhere</span
								></span
							>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={jumpBusy}
							onclick={() => {
								findMissingOpen = false;
								void jumpMostImportant();
							}}
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:opacity-60"
						>
							<Star class="size-3.5 text-[var(--color-parchment-400)]" />
							<span>Most popular missing</span>
						</button>
						<div class="border-t border-[var(--color-ink-800)]"></div>
						<button
							type="button"
							role="menuitem"
							onclick={() => {
								findMissingOpen = false;
								openBotDialog();
							}}
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]"
						>
							<Bot class="size-3.5 text-[var(--color-parchment-400)]" />
							<span>Spar <span class="text-[var(--color-parchment-500)]">· Lichess bot</span></span>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={!currentIsPinnedGate && !currentIsPinnable}
							onclick={() => {
								findMissingOpen = false;
								void togglePinAtCurrent();
							}}
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:opacity-60"
						>
							<Bookmark
								class="size-3.5 text-[var(--color-parchment-400)]"
								fill={currentIsPinnedGate ? 'currentColor' : 'none'}
								strokeWidth={1.75}
							/>
							<span>
								{currentIsPinnedGate ? 'Unpin start' : 'Pin start'}
								<span class="text-[var(--color-parchment-500)]">
									· {currentIsPinnedGate
										? 'revert to auto'
										: currentIsPinnable
											? 'analysis gate'
											: 'not in tree'}
								</span>
							</span>
						</button>
						<button
							type="button"
							role="menuitemcheckbox"
							aria-checked={boardHintsEnabled}
							onclick={() => {
								findMissingOpen = false;
								boardHintsEnabled = !boardHintsEnabled;
							}}
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]"
						>
							{#if boardHintsEnabled}
								<EyeOff class="size-3.5 text-[var(--color-parchment-400)]" />
								<span
									>Hide arrows <span class="text-[var(--color-parchment-500)]"
										>· engine & explorer</span
									></span
								>
							{:else}
								<Eye class="size-3.5 text-[var(--color-parchment-400)]" />
								<span
									>Show arrows <span class="text-[var(--color-parchment-500)]"
										>· engine & explorer</span
									></span
								>
							{/if}
						</button>
					</div>
				{/if}
			</div>
		</div>

		{#if walkPayload && walkCurrent}
			<div
				class="mb-4 flex flex-wrap items-center gap-3 rounded-[4px] border border-[var(--color-brass-400)]/30 bg-[var(--color-brass-500)]/10 px-3 py-2"
			>
				<span class="eyebrow text-[var(--color-brass-300)]">Prep vs {walkPayload.opponent}</span>
				<span class="font-mono text-xs text-[var(--color-parchment-400)] tabular-nums">
					{walkIndex + 1} / {walkTotal}
				</span>
				<span
					class="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--color-parchment-300)]"
				>
					{walkCurrent.line || '(start)'} <span class="text-[var(--color-ink-600)]">·</span>
					they played
					<span class="text-[var(--color-oxblood-300)]">{walkCurrent.san}</span>
					<span class="text-[var(--color-parchment-500)]">({walkCurrent.count}×)</span>
				</span>
				<div class="flex items-center gap-1.5">
					<Button
						variant="secondary"
						size="sm"
						onclick={() => advanceWalk(-1)}
						disabled={walkIndex === 0}
					>
						<ChevronLeft class="size-3.5" />
						<span>Prev</span>
					</Button>
					<Button variant="primary" size="sm" onclick={() => advanceWalk(1)}>
						<span>{walkIndex + 1 === walkTotal ? 'Finish' : 'Next gap'}</span>
					</Button>
					<button
						type="button"
						onclick={exitWalk}
						title="Exit walk-through"
						class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-500)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-200)]"
					>
						<XIcon class="size-4" />
					</button>
				</div>
			</div>
		{/if}

		<!--
			Builder layout.

			On mobile (flex-col) the stacking order is Board → Explorer →
			Line history → Engine readout → Action bar → Notes → Idea, so
			the board and its candidate list land at the top of the page
			without the action bar pushing them below the fold. On lg+
			(`lg:grid`) the elements retake their natural toolbar-on-top
			arrangement via `lg:col-start` / `lg:row-start`; `order-N` is
			ignored because we reset each item with `lg:order-none`.
		-->
		<div class="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_420px]">
			<!-- Action bar: mobile order 6 (under the board toolbar + candidates
				 + line + engine); desktop row 1 spanning both columns.
				 On mobile it holds secondary actions only (Spar, Gap, status);
				 the primary "Find missing" dropdown + save pill live in the
				 board toolbar right under the board for tap-reach. -->
			<div
				class="order-6 flex flex-wrap items-center gap-2 lg:order-none lg:col-span-2 lg:row-start-1"
			>
				<!-- Desktop: individual buttons, hidden on mobile. -->
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={jumpNextMissing}
					disabled={jumpBusy}
					title="Probe the current line and jump to the earliest opponent move above the coverage threshold you haven't answered"
				>
					<Compass class="size-3.5" />
					<span>{jumpBusy ? 'Probing…' : 'Next missing'}</span>
				</Button>
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={jumpBiggestMissing}
					disabled={jumpBusy}
					title="Probe the tree, skipping the current line, and jump to the biggest uncovered opponent move elsewhere"
				>
					<Flame class="size-3.5" />
					<span>{jumpBusy ? 'Probing…' : 'Biggest missing'}</span>
				</Button>
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={jumpMostImportant}
					disabled={jumpBusy}
					title="Probe the whole tree and jump to the single most-played opponent move above the coverage threshold that you haven't answered"
				>
					<Star class="size-3.5" />
					<span>{jumpBusy ? 'Ranking…' : 'Most popular missing'}</span>
				</Button>
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={openBotDialog}
					title="Open a real Lichess game from this position vs Stockfish or Maia"
				>
					<Bot class="size-3.5" />
					<span>Spar</span>
				</Button>
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={togglePinAtCurrent}
					disabled={!currentIsPinnedGate && !currentIsPinnable}
					title={currentIsPinnedGate
						? 'Unpin this position — analysis gate reverts to auto'
						: currentIsPinnable
							? 'Pin this position as the analysis starting point'
							: 'Navigate to a tree position to pin'}
				>
					<Bookmark
						class="size-3.5"
						fill={currentIsPinnedGate ? 'currentColor' : 'none'}
						strokeWidth={1.75}
					/>
					<span>{currentIsPinnedGate ? 'Unpin start' : 'Pin start'}</span>
				</Button>
				{#if topGap}
					<Button
						variant="secondary"
						size="sm"
						onclick={jumpTopEmpiricalGap}
						title="Jump to the position where your scanned games most often ran out of prep"
					>
						<Target class="size-3.5" />
						<span>Gap you commonly face</span>
						<span class="ml-1 font-mono text-[10px] text-[var(--color-parchment-500)] tabular-nums">
							×{topGap.count}
						</span>
					</Button>
				{/if}
				<button
					type="button"
					onclick={() => {
						if (justSaved || saveNothingToDo) return;
						void saveLine();
					}}
					title={justSaved ? 'Saved.' : saveNothingToDo ? 'No unsaved moves yet' : 'Save this line'}
					disabled={justSaved || saveNothingToDo}
					class="hidden items-center gap-2 rounded-full border px-3 py-1 font-serif text-[13px] transition-colors duration-200 disabled:opacity-50 lg:flex {saveToneClass}"
				>
					{#if justSaved}
						<Check class="size-3.5" />
						<span>Saved</span>
					{:else}
						<Save class="size-3.5" />
						<span>Save line</span>
						{#if movesSinceSave > 0}
							<span class="font-mono text-[11px] tabular-nums opacity-80">+{movesSinceSave}</span>
						{/if}
					{/if}
				</button>
				{#if jumpStatus}
					<span class="ml-1 font-serif text-[11px] text-[var(--color-parchment-400)] italic">
						{jumpStatus}
					</span>
				{/if}
			</div>

			<!--
				Engine readout. Plain text, not a button. Mobile order 5 so
				it sits just above the action bar; desktop row 2 col 2 (right
				column width). The engine runs automatically on every
				position; the toggle here only decides whether its
				suggestions are painted on the board.
			-->
			<div
				class="order-5 hidden items-center gap-2 text-[13px] lg:order-none lg:col-start-2 lg:row-start-2 lg:flex"
			>
				<Lightbulb class="size-3.5 shrink-0 text-[var(--color-brass-300)]" />
				<span class="font-mono tabular-nums {engineScoreTone}">{engineScore}</span>
				{#if engineTopSan}
					<span class="text-[var(--color-ink-600)]">·</span>
					<span class="font-mono text-[var(--color-parchment-200)]">{engineTopSan}</span>
				{/if}
				{#if engineDepth > 0}
					<span
						class="font-mono text-[11px] text-[var(--color-parchment-500)] tabular-nums"
						title={enginePrimary?.source === 'cloud'
							? 'Lichess cloud eval'
							: 'Local Stockfish — deepens while you stay on this position'}
					>
						d{engineDepth}{#if engineSourceLabel === 'cloud'}·☁{/if}
					</span>
				{/if}
				<button
					type="button"
					onclick={() => (boardHintsEnabled = !boardHintsEnabled)}
					title={boardHintsEnabled
						? 'Hide engine/explorer arrows on the board'
						: 'Show engine/explorer arrows on the board'}
					class="eyebrow ml-auto cursor-pointer text-[var(--color-parchment-500)] hover:text-[var(--color-brass-300)]"
				>
					{boardHintsEnabled ? 'hide arrows' : 'show arrows'}
				</button>
			</div>

			<!-- Board. Mobile order 1 (top of the page); desktop col 1 row 3. -->
			<section class="order-1 lg:order-none lg:col-start-1 lg:row-start-3">
				<div class="mx-auto max-w-[600px]">
					<Board
						fen={currentFen}
						{orientation}
						turnColor={sideToMove}
						movableColor={isOurTurn ? rep.color : rep.color === 'white' ? 'black' : 'white'}
						{dests}
						{lastMove}
						shapes={boardShapes}
						onmove={handleMove}
					/>
				</div>
			</section>

			<!--
				Board toolbar — mobile only (`lg:hidden`), order 2: sits
				directly under the board and before the candidates, so nav +
				`Find missing` + save stay in reach without scrolling past
				the candidate list. On desktop these controls live in the
				top action bar and the line panel.
			-->
			<div class="order-2 flex items-center gap-1 lg:hidden">
				<button
					type="button"
					onclick={goStart}
					disabled={history.length === 0}
					title="Start (Home)"
					class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)] disabled:pointer-events-none disabled:opacity-30"
				>
					<ChevronFirst class="size-4" />
				</button>
				<button
					type="button"
					onclick={goBack}
					disabled={history.length === 0}
					title="Back (←)"
					class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)] disabled:pointer-events-none disabled:opacity-30"
				>
					<ChevronLeft class="size-4" />
				</button>
				<!-- Save pill. `ml-auto` anchors it to the right edge so
					 the toolbar's left-aligned items don't shift when the
					 pill transitions between enabled/disabled states.
					 The Actions dropdown used to sit between the nav arrows
					 and this pill; it moved up to the page header on narrow
					 viewports, so the toolbar now carries just nav + save. -->
				<button
					type="button"
					onclick={() => {
						if (justSaved || saveNothingToDo) return;
						void saveLine();
					}}
					title={justSaved ? 'Saved.' : saveNothingToDo ? 'No unsaved moves yet' : 'Save this line'}
					disabled={justSaved || saveNothingToDo}
					class="ml-auto flex items-center gap-2 rounded-full border px-3 py-1 font-serif text-[13px] transition-colors duration-200 disabled:opacity-50 {saveToneClass}"
				>
					{#if justSaved}
						<Check class="size-3.5" />
						<span>Saved</span>
					{:else}
						<Save class="size-3.5" />
						<span>Save line</span>
						{#if movesSinceSave > 0}
							<span class="font-mono text-[11px] tabular-nums opacity-80">+{movesSinceSave}</span>
						{/if}
					{/if}
				</button>
			</div>

			<!-- Explorer panel — mobile order 3 (under the board toolbar);
				 desktop col 2 row 3. `self-start`: without it the grid row
				 stretches this cell to match the board column, leaving a
				 giant empty bottom. -->
			<div class="ink-panel order-3 p-4 lg:order-none lg:col-start-2 lg:row-start-3 lg:self-start">
				{#snippet engineInline()}
					<!-- Mobile-only Stockfish readout inlined into the Candidates
						 header; the standalone engine row is hidden on mobile
						 (`hidden lg:flex`) so the page doesn't double-print it. -->
					<span class="flex items-center gap-1.5 text-[12px] lg:hidden">
						<Lightbulb class="size-3 shrink-0 text-[var(--color-brass-300)]" />
						<span class="font-mono tabular-nums {engineScoreTone}">{engineScore}</span>
						{#if engineTopSan}
							<span class="text-[var(--color-ink-600)]">·</span>
							<span class="font-mono text-[var(--color-parchment-200)]">{engineTopSan}</span>
						{/if}
						{#if engineDepth > 0}
							<span class="font-mono text-[10px] text-[var(--color-parchment-500)] tabular-nums">
								d{engineDepth}{#if engineSourceLabel === 'cloud'}·☁{/if}
							</span>
						{/if}
					</span>
				{/snippet}
				<Explorer
					fen={currentFen}
					onselect={addFromExplorer}
					ondelete={deleteFromExplorer}
					knownSans={knownChildSans}
					{engineEvalByUci}
					{engineRows}
					{transposesSans}
					buildingColor={rep.color}
					fingerprint={settings?.styleAdviceEnabled ? styleFingerprint : null}
					openingFit={settings?.styleAdviceEnabled ? styleOpeningFit : null}
					userWdlBySan={userWdlAtCurrent}
					headerRight={engineInline}
				/>
			</div>

			<!-- Move history (line). Mobile order 4 (below the candidates);
				 desktop col 1 row 4 (directly below the board, as before).
				 Nav buttons (⏮ / ◀) are hidden on mobile because the board
				 toolbar carries them; on desktop they stay here next to the
				 line, where they've always lived. -->
			<section class="order-4 lg:order-none lg:col-start-1 lg:row-start-4">
				<div class="mx-auto max-w-[600px]">
					<div class="mb-2 flex items-center gap-1">
						<button
							type="button"
							onclick={goStart}
							disabled={history.length === 0}
							title="Start (Home)"
							class="hidden size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)] disabled:pointer-events-none disabled:opacity-30 lg:flex"
						>
							<ChevronFirst class="size-4" />
						</button>
						<button
							type="button"
							onclick={goBack}
							disabled={history.length === 0}
							title="Back (←)"
							class="hidden size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)] disabled:pointer-events-none disabled:opacity-30 lg:flex"
						>
							<ChevronLeft class="size-4" />
						</button>
						<div class="eyebrow ml-2">Line</div>
					</div>

					{#if history.length === 0}
						<p
							class="rounded-[3px] border border-dashed border-[var(--color-ink-700)] px-3 py-2 font-serif text-sm text-[var(--color-parchment-500)] italic"
						>
							The starting position. Play a move to begin.
						</p>
					{:else}
						<div
							class="relative flex flex-wrap gap-x-1.5 gap-y-0.5 rounded-[3px] border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2 pr-9 font-mono text-[13px] leading-6"
						>
							{#each history as step, i (i)}
								{@const prefix = moveNumberPrefix(i)}
								{@const sibs = siblingsAt(i)}
								{#if prefix}
									<span class="text-[var(--color-parchment-500)]">{prefix}</span>
								{/if}
								<span class="inline-flex items-center gap-1">
									<button
										type="button"
										onclick={() => goToPly(i)}
										class="text-[var(--color-parchment-100)] transition-colors hover:text-[var(--color-brass-300)]"
										class:!text-[var(--color-brass-300)]={i === history.length - 1}
									>
										{step.san}
									</button>
								</span>
								{#if sibs.length > 0}
									<span class="text-[var(--color-parchment-600)]">(</span>
									{#each sibs as sib, j (sib.toFenKey)}
										{#if j > 0}<span class="text-[var(--color-parchment-600)]">, </span>{/if}
										<button
											type="button"
											onclick={() => jumpToSibling(i, sib)}
											title="Switch to sideline {sib.san}"
											class="text-[var(--color-parchment-500)] italic transition-colors hover:text-[var(--color-brass-300)]"
										>
											{sib.san}
										</button>
									{/each}
									<span class="text-[var(--color-parchment-600)]">)</span>
								{/if}
							{/each}
							<button
								type="button"
								onclick={copyLine}
								title={lineCopied ? 'Copied' : 'Copy line as PGN'}
								class="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-[3px] text-[var(--color-parchment-500)]/60 transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-200)]"
							>
								{#if lineCopied}
									<Check class="size-3.5 text-[var(--color-olive-300)]" />
								{:else}
									<Copy class="size-3.5" />
								{/if}
							</button>
						</div>
					{/if}
				</div>
			</section>

			<!--
				Notes — mobile order 7 (below the action bar); desktop col 1
				row 5 (below the line). Engine lives inline with the action
				row now; the old big Engine panel in the right rail is gone.
			-->
			<div class="ink-panel order-7 p-4 lg:order-none lg:col-start-1 lg:row-start-5">
				<label for="note" class="eyebrow mb-2 block">Notes on this position</label>
				<Textarea
					id="note"
					bind:value={comment}
					oninput={() => (commentDirty = true)}
					onblur={saveComment}
					rows={3}
					placeholder="Plans, key ideas, typical motifs…"
					class="font-serif text-[15px] italic"
				/>
				<p class="mt-2 text-[11px] text-[var(--color-parchment-500)]">
					Saves on blur. Tied to the current FEN.
				</p>
			</div>

			<div class="ink-panel order-8 p-4 lg:order-none lg:col-start-1 lg:row-start-6">
				<div class="mb-2 flex items-baseline justify-between">
					<label for="idea-prompt" class="eyebrow block">
						Idea card {ideaCard ? '· scheduled' : ''}
					</label>
					{#if ideaCard}
						<button
							type="button"
							onclick={removeIdeaCard}
							class="eyebrow text-[var(--color-oxblood-300)] transition-colors hover:text-[var(--color-oxblood-200)]"
							title="Delete this idea card"
						>
							Delete
						</button>
					{/if}
				</div>
				<Textarea
					id="idea-prompt"
					bind:value={ideaPrompt}
					oninput={() => (ideaDirty = true)}
					rows={2}
					placeholder="Question for yourself — e.g. Which side has the bad bishop?"
					class="font-serif text-[15px]"
				/>
				<Textarea
					bind:value={ideaAnswer}
					oninput={() => (ideaDirty = true)}
					rows={2}
					placeholder="Optional — the answer you want to recall."
					class="mt-2 font-serif text-[14px] text-[var(--color-parchment-300)] italic"
				/>
				<div class="mt-2 flex items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						onclick={saveIdeaCard}
						disabled={!ideaPrompt.trim() || !ideaDirty}
					>
						{ideaCard ? 'Update' : 'Add idea card'}
					</Button>
					<p class="text-[11px] text-[var(--color-parchment-500)]">
						Drilled in the same session as move cards — prompt shown, reveal the answer, self-rate.
					</p>
				</div>
			</div>
		</div>
	</div>
{/if}

{#if botDialogOpen && rep}
	<!-- Backdrop + modal. Picks opponent (Stockfish level vs Maia rating),
	     color, and clock, then hits Lichess's challenge API with the current
	     FEN and opens the game in a new tab. -->
	<div
		role="presentation"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeBotDialog();
		}}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="bot-dialog-title"
			class="ink-panel w-full max-w-md rounded-[6px] border border-[var(--color-ink-700)] p-5 shadow-lg"
		>
			<div class="mb-3 flex items-center gap-2">
				<Bot class="size-4 text-[var(--color-brass-300)]" />
				<h2 id="bot-dialog-title" class="font-serif text-lg">Challenge a Lichess bot</h2>
			</div>
			<p class="mb-4 font-serif text-xs text-[var(--color-parchment-400)] italic">
				Opens a real game on Lichess from the current position. Your token needs the
				<span class="font-mono not-italic">challenge:write</span> scope.
			</p>

			<div class="mb-3 grid grid-cols-2 gap-2">
				<button
					type="button"
					onclick={() => (botOpponent = 'stockfish')}
					class="rounded-[4px] border p-3 text-left text-sm transition-colors {botOpponent ===
					'stockfish'
						? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/8 text-[var(--color-parchment-100)]'
						: 'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] text-[var(--color-parchment-300)] hover:border-[var(--color-ink-600)]'}"
				>
					<div class="eyebrow">Stockfish</div>
					<div class="mt-1 font-serif text-xs text-[var(--color-parchment-500)] italic">
						Levels 1–8.
					</div>
				</button>
				<button
					type="button"
					onclick={() => (botOpponent = 'maia')}
					class="rounded-[4px] border p-3 text-left text-sm transition-colors {botOpponent ===
					'maia'
						? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/8 text-[var(--color-parchment-100)]'
						: 'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] text-[var(--color-parchment-300)] hover:border-[var(--color-ink-600)]'}"
				>
					<div class="eyebrow">Maia</div>
					<div class="mt-1 font-serif text-xs text-[var(--color-parchment-500)] italic">
						Human-like at 1100 / 1500 / 1900.
					</div>
				</button>
			</div>

			{#if botOpponent === 'stockfish'}
				<div class="mb-3">
					<label for="bot-sf-level" class="eyebrow mb-1 block">Level {botStockfishLevel}</label>
					<input
						id="bot-sf-level"
						type="range"
						min="1"
						max="8"
						step="1"
						bind:value={botStockfishLevel}
						class="w-full accent-[var(--color-brass-300)]"
					/>
					<div
						class="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-parchment-500)]"
					>
						<span>1 easy</span>
						<span>8 hard</span>
					</div>
				</div>
			{:else}
				<div class="mb-3 grid grid-cols-3 gap-2">
					{#each [1100, 1500, 1900] as r (r)}
						<button
							type="button"
							onclick={() => (botMaiaRating = r as 1100 | 1500 | 1900)}
							class="rounded-[4px] border px-2 py-2 text-sm transition-colors {botMaiaRating === r
								? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/8 text-[var(--color-parchment-100)]'
								: 'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] text-[var(--color-parchment-300)] hover:border-[var(--color-ink-600)]'}"
						>
							<span class="font-mono tabular-nums">{r}</span>
						</button>
					{/each}
				</div>
			{/if}

			<div class="mb-3">
				<div class="eyebrow mb-1">Your colour</div>
				<div class="grid grid-cols-3 gap-2">
					{#each ['white', 'black', 'random'] as c (c)}
						<button
							type="button"
							onclick={() => (botColor = c as ChallengeColor)}
							class="rounded-[4px] border px-2 py-1.5 text-sm capitalize transition-colors {botColor ===
							c
								? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/8 text-[var(--color-parchment-100)]'
								: 'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] text-[var(--color-parchment-300)] hover:border-[var(--color-ink-600)]'}"
						>
							{c}
						</button>
					{/each}
				</div>
			</div>

			<div class="mb-4 grid grid-cols-2 gap-3">
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-[var(--color-parchment-400)]">Minutes</span>
					<input
						type="number"
						min="1"
						max="60"
						value={Math.round(botClockLimit / 60)}
						oninput={(e) => {
							const v = parseInt(e.currentTarget.value, 10);
							if (!Number.isNaN(v)) botClockLimit = Math.max(60, Math.min(3600, v * 60));
						}}
						class="h-10 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-3 font-sans text-sm text-[var(--color-parchment-100)] transition-colors hover:border-[var(--color-ink-600)] focus:border-[var(--color-brass-300)] focus:ring-[3px] focus:ring-[var(--color-brass-300)]/15 focus:outline-none"
					/>
				</label>
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-[var(--color-parchment-400)]">Increment (s)</span>
					<input
						type="number"
						min="0"
						max="60"
						bind:value={botClockIncrement}
						class="h-10 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-3 font-sans text-sm text-[var(--color-parchment-100)] transition-colors hover:border-[var(--color-ink-600)] focus:border-[var(--color-brass-300)] focus:ring-[3px] focus:ring-[var(--color-brass-300)]/15 focus:outline-none"
					/>
				</label>
			</div>

			{#if botError}
				<p class="mb-2 text-xs text-[var(--color-oxblood-300)]">{botError}</p>
				{#if botMissingScope}
					<p class="mb-3 text-xs text-[var(--color-parchment-400)]">
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							href={TOKEN_WITH_SCOPES_URL}
							target="_blank"
							rel="noopener noreferrer"
							class="text-[var(--color-brass-300)] underline underline-offset-2"
						>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							Create a Lichess token with the right scopes →
						</a>
						then paste it in
						<a
							href={resolve('/settings')}
							class="text-[var(--color-brass-300)] underline underline-offset-2">Settings</a
						>.
					</p>
				{/if}
			{/if}

			<div class="flex items-center justify-end gap-2">
				<Button variant="ghost" size="sm" onclick={closeBotDialog} disabled={botLaunching}>
					Cancel
				</Button>
				<Button size="sm" onclick={launchBotChallenge} disabled={botLaunching}>
					{botLaunching ? 'Launching…' : 'Challenge'}
				</Button>
			</div>
		</div>
	</div>
{/if}

<style>
	@keyframes save-pulse-kf {
		0%,
		100% {
			box-shadow:
				0 8px 24px -8px rgba(198, 159, 91, 0.45),
				0 0 0 0 rgba(198, 159, 91, 0.55);
		}
		50% {
			box-shadow:
				0 10px 28px -6px rgba(198, 159, 91, 0.55),
				0 0 0 10px rgba(198, 159, 91, 0);
		}
	}
	.save-pulse {
		animation: save-pulse-kf 2.4s ease-in-out infinite;
	}
</style>
