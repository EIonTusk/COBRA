<script lang="ts">
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { goto, beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { sync } from '$lib/sync/syncStore.svelte';
	import { createEmptyCard } from 'ts-fsrs';
	import {
		ArrowLeft,
		BookOpen,
		Bookmark,
		Bot,
		ChevronDown,
		ChevronFirst,
		ChevronLast,
		ChevronLeft,
		ChevronRight,
		Check,
		Compass,
		Copy,
		Flame,
		GraduationCap,
		MoveUpRight,
		Lightbulb,
		Save,
		Star,
		Target,
		Trash2,
		Upload,
		WifiOff,
		X as XIcon
	} from 'lucide-svelte';
	import type { Key, MoveMetadata } from '@lichess-org/chessground/types';
	import type { DrawShape } from '@lichess-org/chessground/draw';

	import Board from '$lib/chess/Board.svelte';
	import Explorer from '$lib/explorer/Explorer.svelte';
	import { listGapsForRepertoire } from '$lib/storage/empiricalGaps';
	import { listPositionWdlAtFenKey, type PositionWdlRow } from '$lib/storage/positionWdl';
	import { getRepertoire, touchRepertoire, setStartingPosition } from '$lib/storage/repertoires';
	import { nodesMap, addEdge, removeEdgeAndPrune, setNodeComment } from '$lib/storage/nodes';
	import { parseRepertoirePgn } from '$lib/chess/pgn';
	import { mergeLinesIntoRepertoire, type MergeLinesResult } from '$lib/storage/importPgn';
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
		sanAtFen
	} from '$lib/chess/position';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import {
		pathToFenKey,
		furthestNonBranchingFenKey,
		countDescendantEdges
	} from '$lib/tree/traversal';
	import {
		collectMissingMoves,
		collectSaveableLeaves,
		firstMissingOnLine,
		type MissingMove
	} from '$lib/tree/missing';
	import { fetchExplorer } from '$lib/explorer/client';
	import { generateMiddlegameGuide, type GenerateProgress } from '$lib/middlegame/generate';
	import {
		aggregateToArrows,
		savedArrowsToShapes,
		shapesToSavedArrows
	} from '$lib/middlegame/arrows';
	import {
		deleteMiddlegameGuide,
		getMiddlegameGuide,
		upsertMiddlegameGuide
	} from '$lib/storage/middlegameGuides';
	import {
		deletePlanCard,
		freshPlanCard,
		getPlanCard,
		upsertPlanCard
	} from '$lib/storage/planCards';
	import { generatePlanCardContent } from '$lib/plan/generate';
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
		SavedAttackSquare,
		SavedMiddlegameGuide,
		SerializedMiddlegameAggregate,
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
	// Reactive gate for any UI affordance that needs to call Lichess.
	// Mirrors the convention used by /mistakes, /autobuild, /opponent-prep
	// so toolbar buttons and inline notices flip in lock-step the moment a
	// token is added or cleared in Settings.
	const tokenConfigured = $derived(!!settings && !!effectiveLichessToken(settings));
	// Path-only "come back here" URL we hand off to /settings via `?return=`
	// so post-OAuth navigation lands the user back on this edit page rather
	// than stranding them on /settings. Path/search/hash only — never the
	// origin (the consumer rejects absolute URLs).
	const lichessReturnHref = $derived(
		`${resolve('/settings')}?return=${encodeURIComponent(page.url.pathname + page.url.search + page.url.hash)}#lichess`
	);
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
	// Explorer total games at the current position. Reset on every position
	// change, populated when the explorer fetch resolves. Drives the
	// "line reached the coverage threshold" glow on the Save-line pill: if
	// the position is rare enough that no opponent move at it can be
	// above-threshold, the line is naturally complete and worth saving.
	let currentExplorerGames = $state<number | null>(null);
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
	// Saved continuations at this position with both SAN and UCI. Passed
	// to the Explorer so the no-Lichess-token state can still render the
	// user's own prep (with skeleton placeholders for Lichess stats).
	const savedMovesAtCurrent = $derived<Array<{ san: string; uci: string }>>(
		(currentNode?.children ?? []).map((e) => ({ san: e.san, uci: e.uci }))
	);
	// Subtree size per saved continuation at this position. The Explorer
	// surfaces the count in its delete-confirm dialog so the user sees how
	// much they're about to drop in addition to the move itself.
	const subtreeSizeBySan = $derived.by<Map<string, number>>(() => {
		const out = new SvelteMap<string, number>();
		if (!currentNode) return out;
		for (const e of currentNode.children) {
			out.set(e.san, countDescendantEdges(nodes, e.toFenKey));
		}
		return out;
	});

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
		// Middle-game guide arrows are an explicit user action, so they paint
		// regardless of the always-on hints toggle. Stack with the engine /
		// explorer hints when both are showing.
		if (mgActive) shapes.push(...mgArrows);
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
		currentExplorerGames = null;

		const fen = currentFen;
		// lila-stockfish-web emits cp/mate from the side-to-move POV (UCI
		// convention); Lichess cloud-eval already returns white's POV. Flip
		// local engine output to white's POV so both sources agree before
		// they hit `combinedByUci`. Without this, "+0.22" at the start
		// position became "-0.20" after e4 — the eval looked sign-flipped
		// when really it was just being re-rendered in black's POV because
		// Black was now on move.
		const localFlip = fen.split(' ')[1] === 'b' ? -1 : 1;
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
					const flipped: EngineInfo = {
						...info,
						scoreCp: info.scoreCp !== undefined ? info.scoreCp * localFlip : undefined,
						scoreMate: info.scoreMate !== undefined ? info.scoreMate * localFlip : undefined
					};
					const map = new SvelteMap(engineByMultipv);
					map.set(info.multipv, flipped);
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
					currentExplorerGames = totalGames;
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

	// Auto-push this rep on edit-mode exit. Edit is the bulk-write phase, so
	// "leaving the editor" is the natural save moment. Fire-and-forget — we
	// don't block navigation, and the dirty mark sticks around if the push
	// fails so the next debounced retry catches it. No-op when sync is off
	// or the rep wasn't actually touched.
	beforeNavigate(() => {
		const id = rep?.id;
		if (id) sync.flushOnExit(`rep:${id}`);
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
		// Keep the forward stack consistent with the move just played: pop
		// the matching top so a back-then-forward round-trip leaves the
		// stack empty, or wipe the stack if the user has forked off the
		// retraced line.
		reconcileForwardWithMove(fromKey, edge);
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

	function handleMove(
		orig: Key,
		dest: Key,
		_metadata: MoveMetadata,
		promotion?: 'q' | 'r' | 'b' | 'n'
	) {
		if (!rep) return;
		const edge = edgeFromUci(currentFen, orig, dest, promotion);
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
			// Cut the edge AND sweep any positions it orphaned — descendant
			// nodes, their FSRS move cards, and idea cards that are no longer
			// reachable from the root. Without the sweep the drill queue keeps
			// serving the deleted variation (it reads cards by index, not by
			// walking the tree). Reachability-based so transpositions survive.
			await removeEdgeAndPrune(rep.id, rep.rootFenKey, currentFenKey, child.toFenKey);
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

	// Browser-style forward stack. `goBack` pushes the dropped step here so
	// the right-arrow can retrace the last viewed line; any new move played
	// off the path clears the stack (you can't both fork and "go forward").
	type ForwardStep = { fromKey: string; edge: Edge };
	let forwardHistory = $state<ForwardStep[]>([]);

	function reconcileForwardWithMove(fromKey: string, edge: Edge) {
		if (forwardHistory.length === 0) return;
		const top = forwardHistory[forwardHistory.length - 1];
		if (top.fromKey === fromKey && top.edge.toFenKey === edge.toFenKey) {
			forwardHistory = forwardHistory.slice(0, -1);
		} else {
			forwardHistory = [];
		}
	}

	function goBack() {
		if (history.length === 0) return;
		cancelJumpAnim();
		const dropped = history[history.length - 1];
		const parentKey = history.length === 1 ? rep!.rootFenKey : history[history.length - 2].fenKey;
		const parentFen = history.length === 1 ? rep!.rootFen : history[history.length - 2].fen;
		// Reconstruct the Edge that took us into the dropped step. Prefer the
		// canonical persisted Edge (carries promotion + UCI exactly); fall
		// back to re-deriving it from the parent fen + stored SAN for pending
		// steps that aren't yet in `nodes`. Deriving from the SAN (rather than
		// the bare lastMove squares) preserves the promotion piece, so an
		// unsaved under-promotion retraces forward with the same UCI
		// `commitMove` originally produced instead of defaulting to a queen.
		let edge: Edge | null =
			nodes.get(parentKey)?.children.find((c) => c.toFenKey === dropped.fenKey) ?? null;
		if (!edge && dropped.san) {
			edge = edgeFromSan(parentFen, dropped.san);
		}
		untrackDroppedSteps(history.length - 1);
		history = history.slice(0, -1);
		currentFen = history.at(-1)?.fen ?? rep!.rootFen;
		if (edge) forwardHistory = [...forwardHistory, { fromKey: parentKey, edge }];
	}

	/**
	 * Step forward by one ply: replay the next entry from `forwardHistory`
	 * if the user just retreated, otherwise descend the only-prepared move
	 * at the current position. Goes nowhere if the position branches and
	 * there's nothing to retrace.
	 */
	function goForward() {
		if (!rep) return;
		if (forwardHistory.length > 0) {
			const top = forwardHistory[forwardHistory.length - 1];
			if (top.fromKey === currentFenKey) {
				void commitMove(top.edge);
				return;
			}
			// Stale stack (we forked into a different branch). Drop it and
			// fall through to the only-child rule below.
			forwardHistory = [];
		}
		const node = nodes.get(currentFenKey);
		if (!node || node.children.length !== 1) return;
		void commitMove(node.children[0]);
	}

	/**
	 * Jump to the leaf of the previously viewed line — replays the whole
	 * `forwardHistory` stack — then keeps walking forward through any
	 * single-prepared-child positions until the line branches or ends. With
	 * no prior viewed line this collapses to "advance to the first
	 * branching".
	 */
	function goEnd() {
		if (!rep) return;
		// Hard cap: pathological tree shouldn't be able to spin forever.
		let safety = 256;
		while (safety-- > 0) {
			if (forwardHistory.length > 0) {
				const top = forwardHistory[forwardHistory.length - 1];
				if (top.fromKey === currentFenKey) {
					void commitMove(top.edge);
					continue;
				}
				forwardHistory = [];
			}
			const node = nodes.get(currentFenKey);
			if (!node || node.children.length !== 1) break;
			void commitMove(node.children[0]);
		}
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
		// Arbitrary jump invalidates the back/forward retrace stack.
		forwardHistory = [];
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

	/**
	 * Open the drill scoped to the current board position — drills every
	 * prepared move in the subtree rooted here instead of replaying the whole
	 * line from move one. Only meaningful when the position is a tree node.
	 */
	function trainFromCurrent() {
		if (!rep || !currentIsPinnable) return;
		void goto(resolve(`/repertoire/${rep.id}/drill?from=${encodeURIComponent(currentFenKey)}`));
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
		// Jumping to root is an arbitrary navigation, not a single back
		// step — the right-arrow shouldn't try to retrace from an unknown
		// midpoint.
		forwardHistory = [];
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
		forwardHistory = [];
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
		forwardHistory = [];
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
		if (e.key === 'Escape' && importPgnOpen) {
			e.preventDefault();
			closeImportPgn();
			return;
		}
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			goBack();
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			goForward();
		} else if (e.key === 'Home') {
			e.preventDefault();
			goStart();
		} else if (e.key === 'End') {
			e.preventDefault();
			goEnd();
		}
	}

	function moveNumberPrefix(i: number): string | null {
		return i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : null;
	}

	// Forward/end nav enable state. The right-arrow lights up when the user
	// has just stepped back (forwardHistory has a matching top), or when the
	// current position has exactly one prepared continuation. The end arrow
	// is enabled whenever there's at least one ply to advance through —
	// either the retrace stack or a single-child node ahead.
	const canGoForward = $derived.by(() => {
		if (forwardHistory.length > 0) {
			return forwardHistory[forwardHistory.length - 1].fromKey === currentFenKey;
		}
		const node = nodes.get(currentFenKey);
		return !!node && node.children.length === 1;
	});
	const canGoEnd = $derived(canGoForward);

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
	// Transposed-into-prep: the user added new moves that landed back on a
	// position already in the tree (reachable via some other edge). That's
	// a natural save moment — the new line is closing a circuit, not just
	// stretching further into uncharted territory.
	const transposedIntoSaved = $derived(
		movesSinceSave > 0 &&
			!!rep &&
			currentFenKey !== rep.rootFenKey &&
			currentFenKey !== '' &&
			reachableFenKeys.has(currentFenKey)
	);
	// "Reached threshold": the current position is rare enough that no
	// further opponent move at it can be above the coverage threshold
	// (totalGames < rootGames / goal). The line is naturally complete to
	// the user's chosen depth — no reason to keep building before saving.
	const reachedCoverageThreshold = $derived.by(() => {
		if (movesSinceSave === 0) return false;
		if (!rep?.coverageGoal) return false;
		const cur = currentExplorerGames;
		const thresholdGames = rep.coverageSnapshot?.thresholdGames;
		if (cur === null || !thresholdGames || thresholdGames <= 0) return false;
		return cur < thresholdGames;
	});
	const saveNudge = $derived(
		!justSaved &&
			movesSinceSave > 0 &&
			(movesSinceSave >= 5 || transposedIntoSaved || reachedCoverageThreshold)
	);
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
		// Default to whichever side is on move at the launch FEN. Lichess
		// starts the game from `currentFen`, so picking `rep.color` while
		// the position has the opposite side to move means the bot plays
		// first — and for some custom-FEN paths the user reports being
		// silently assigned the other colour, which presents as "I'm white
		// but it's black to play and my clock is ticking and I can't move".
		botColor = sideToMove;
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

	// Bulk "add lines via PGN" from inside the builder (issue #70). Parses
	// pasted/uploaded PGN and merges it additively into THIS repertoire via
	// the shared `mergeLinesIntoRepertoire` helper — existing moves dedupe by
	// FEN and drill progress is preserved. Lines must start from the rep's
	// opening position, mirroring the standalone import page; off-root lines
	// are skipped and reported. After a successful merge the node map is
	// refreshed so the new branches show up in the tree immediately.
	let importPgnOpen = $state(false);
	let importPgnText = $state('');
	let importPgnFileName = $state<string | null>(null);
	let importPgnBusy = $state(false);
	let importPgnError = $state<string | null>(null);
	let importPgnResult = $state<MergeLinesResult | null>(null);

	function openImportPgn() {
		if (!rep) return;
		importPgnText = '';
		importPgnFileName = null;
		importPgnError = null;
		importPgnResult = null;
		importPgnOpen = true;
	}
	function closeImportPgn() {
		if (importPgnBusy) return;
		importPgnOpen = false;
	}
	async function onImportPgnFile(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		importPgnText = await file.text();
		importPgnFileName = file.name;
	}
	async function runImportPgn() {
		if (!rep || importPgnBusy || !importPgnText.trim()) return;
		importPgnBusy = true;
		importPgnError = null;
		importPgnResult = null;
		try {
			const lines = parseRepertoirePgn(importPgnText);
			if (lines.length === 0) throw new Error('No valid games found in the PGN.');
			const merged = await mergeLinesIntoRepertoire(rep.id, rep.color, rep.rootFenKey, lines);
			if (merged.importedLines === 0) {
				throw new Error(
					`None of the ${merged.skippedLines} line(s) start from this repertoire's opening position, so nothing was imported.`
				);
			}
			// Refresh the tree + missing-move cache so the merged branches are
			// visible and the probes account for them. Mark the rep touched so
			// the auto-push on exit picks the change up.
			nodes = await nodesMap(rep.id);
			await touchRepertoire(rep.id);
			void refreshMissingCache();
			importPgnResult = merged;
		} catch (err) {
			importPgnError = err instanceof Error ? err.message : 'Import failed';
		} finally {
			importPgnBusy = false;
		}
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
				// Reconciliation overwrites this from the PGN headers once the
				// game finishes, so the worst case for a random-colour pick is
				// a wrong label in the spar list until then. Use side-to-move
				// rather than `rep.color` so the placeholder lines up with
				// what Lichess most often serves for a custom FEN.
				const userColorForRecord =
					botColor === 'random' ? sideToMove : (botColor as 'white' | 'black');
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

	// Middle-game guide arrows. Two flows feed this state:
	//   1. Generate-fresh — fetch top master games, walk them forward ~12
	//      plies, aggregate into common continuations / pawn moves / piece
	//      reroutings, paint as arrows.
	//   2. Load-saved — if the user previously pinned a guide at this
	//      position via the Save button, click loads instantly from IDB.
	// In either case the result is the same `mgArrows` painted on the
	// board. The drill renders the saved guide independently when its own
	// flag is on.
	const MG_PLIES = 12;
	let mgBusy = $state(false);
	let mgArrows = $state<DrawShape[]>([]);
	let mgFenKey = $state<string | null>(null); // fenKey the arrows belong to
	let mgGamesUsable = $state(0);
	let mgGamesQueried = $state(0);
	let mgOpeningName = $state<string | null>(null);
	// Raw heatmap inputs from the most recent generate. Captured here only
	// for the save-flow → IDB hand-off; the editor itself doesn't render
	// the heatmap. The subpage at `/heatmap` reads these from IDB.
	let mgAttackSquares = $state<SavedAttackSquare[]>([]);
	let mgTotalLines = $state(0);
	// Full serialised aggregate captured from the last generate or
	// reloaded from a saved guide. Persisted on save so the plan-card
	// generator (and any future masters-derived feature) can pull
	// structured data without re-querying Lichess.
	let mgAggregate = $state<SerializedMiddlegameAggregate | null>(null);
	let mgError = $state<string | null>(null);
	let mgProgress = $state<string | null>(null);
	let mgErrorTimer: ReturnType<typeof setTimeout> | null = null;
	// Tracks whether the *current* position has a guide pinned in IDB.
	// Drives the button label ("Show saved" vs "Middle-game guide") and
	// the conditional Save / Delete affordances under the action bar.
	let mgSavedExists = $state(false);
	let mgSavedCreatedAt = $state<number | null>(null);
	// Cached ratio from the saved guide so the transposition-health tag can
	// render even when the arrows aren't actively painted. Mirrors the
	// `gamesUsable / gamesQueried` returned by `generateMiddlegameGuide`.
	let mgSavedGamesUsable = $state(0);
	let mgSavedGamesQueried = $state(0);
	let mgSaveBusy = $state(false);
	// True when the arrows currently rendered came from IDB (load-saved
	// flow). Drives whether the Save button is offered: there's no point
	// re-saving an unmodified saved set.
	let mgFromSaved = $state(false);

	const mgActive = $derived(mgArrows.length > 0 && mgFenKey === currentFenKey);

	// Transposition health: how often the top-N master games at this
	// position actually reach it via the same move order the repertoire
	// uses. Low ratios mean most masters transpose elsewhere, so the
	// pinned patterns are drawn from a thinner sample than the headline
	// count suggests. Rendered as a small tag next to the saved-guide
	// indicator. Always reads from the live or saved guide that's
	// current — never from a stale state of a different position.
	const mgHealth = $derived.by(() => {
		const usable = mgActive ? mgGamesUsable : mgSavedExists ? mgSavedGamesUsable : 0;
		const queried = mgActive ? mgGamesQueried : mgSavedExists ? mgSavedGamesQueried : 0;
		if (queried <= 0) return null;
		const ratio = usable / queried;
		let tier: 'high' | 'mid' | 'low' = 'high';
		if (ratio < 0.5) tier = 'low';
		else if (ratio < 0.8) tier = 'mid';
		return { usable, queried, ratio, tier };
	});

	// Auto-clear stale arrows when the user navigates to a different position:
	// they applied to the position they were generated for, not this one.
	$effect(() => {
		if (mgFenKey && mgFenKey !== currentFenKey) {
			mgArrows = [];
			mgFenKey = null;
			mgGamesUsable = 0;
			mgGamesQueried = 0;
			mgAttackSquares = [];
			mgTotalLines = 0;
			mgAggregate = null;
			mgFromSaved = false;
		}
	});

	// Probe IDB on every position change so the button + save controls
	// reflect what's pinned at the current fenKey. Don't auto-paint —
	// loading is still gated on a deliberate click.
	$effect(() => {
		const repId = rep?.id;
		const key = currentFenKey;
		if (!repId || !key) {
			mgSavedExists = false;
			mgSavedCreatedAt = null;
			mgSavedGamesUsable = 0;
			mgSavedGamesQueried = 0;
			return;
		}
		let cancelled = false;
		void getMiddlegameGuide(repId, key).then((g) => {
			if (cancelled) return;
			mgSavedExists = !!g;
			mgSavedCreatedAt = g?.createdAt ?? null;
			mgSavedGamesUsable = g?.gamesUsable ?? 0;
			mgSavedGamesQueried = g?.gamesQueried ?? 0;
		});
		return () => {
			cancelled = true;
		};
	});

	async function toggleMiddlegameGuide() {
		if (mgBusy) return;
		// Toggle off if currently showing for this position.
		if (mgActive) {
			mgArrows = [];
			mgFenKey = null;
			mgGamesUsable = 0;
			mgGamesQueried = 0;
			mgAttackSquares = [];
			mgTotalLines = 0;
			mgAggregate = null;
			mgFromSaved = false;
			return;
		}
		if (!rep) return;
		// Prefer the pinned guide if one exists — saved arrows are an
		// explicit user choice that shouldn't be silently regenerated
		// (and the save flow may have customised them down the line).
		if (mgSavedExists) {
			const saved = await getMiddlegameGuide(rep.id, currentFenKey);
			if (saved) {
				mgArrows = savedArrowsToShapes(saved.arrows);
				mgFenKey = currentFenKey;
				mgGamesUsable = saved.gamesUsable ?? 0;
				mgGamesQueried = saved.gamesQueried ?? 0;
				mgOpeningName = saved.openingName ?? null;
				mgAttackSquares = saved.attackSquares ?? [];
				mgTotalLines = saved.totalLines ?? 0;
				mgAggregate = saved.aggregate ?? null;
				mgFromSaved = true;
				return;
			}
		}
		if (!settings) return;
		const token = effectiveLichessToken(settings);
		if (!token) {
			mgError = 'No Lichess token configured. Paste one in Settings first.';
			scheduleMgErrorClear();
			return;
		}
		mgBusy = true;
		mgError = null;
		mgProgress = 'Fetching master games…';
		const startedFenKey = currentFenKey;
		try {
			const result = await generateMiddlegameGuide({
				fen: currentFen,
				fenKey: currentFenKey,
				token,
				topGames: 15,
				maxPlies: MG_PLIES,
				onProgress: (p: GenerateProgress) => {
					if (p.phase === 'explorer') mgProgress = 'Querying masters explorer…';
					else if (p.phase === 'pgn') mgProgress = `Reading game ${p.current}/${p.total}…`;
					else if (p.phase === 'aggregate') mgProgress = 'Aggregating patterns…';
					else mgProgress = null;
				}
			});
			// Drop the result if the user navigated away while we were fetching.
			if (startedFenKey !== currentFenKey) return;
			const arrows = aggregateToArrows(result.aggregate, { userColor: rep.color });
			if (arrows.length === 0) {
				mgError =
					result.gamesUsable === 0
						? 'No master games found from this position.'
						: 'Patterns are too sparse to draw — try a more common position.';
				scheduleMgErrorClear();
				return;
			}
			mgArrows = arrows;
			mgFenKey = currentFenKey;
			mgGamesUsable = result.gamesUsable;
			mgGamesQueried = result.gamesQueried;
			mgOpeningName = result.openingName;
			mgAttackSquares = result.aggregate.attackSquares.map((a) => ({
				square: a.square,
				attacker: a.attacker,
				count: a.count,
				captureCount: a.captureCount
			}));
			mgTotalLines = result.aggregate.totalLines;
			// The runtime aggregate is plain JSON-safe data; capture it
			// verbatim for save-time persistence + plan-card generation.
			mgAggregate = {
				totalLines: result.aggregate.totalLines,
				pliesWindow: result.aggregate.pliesWindow,
				topNextMoves: result.aggregate.topNextMoves.map((m) => ({
					san: m.san,
					uci: m.uci,
					count: m.count
				})),
				pawnMoves: result.aggregate.pawnMoves.map((p) => ({
					color: p.color,
					san: p.san,
					from: p.from,
					to: p.to,
					isCapture: p.isCapture,
					count: p.count
				})),
				pieceJourneys: result.aggregate.pieceJourneys.map((j) => ({
					color: j.color,
					role: j.role,
					from: j.from,
					to: j.to,
					count: j.count
				})),
				castling: {
					white: {
						short: result.aggregate.castling.white.short,
						long: result.aggregate.castling.white.long
					},
					black: {
						short: result.aggregate.castling.black.short,
						long: result.aggregate.castling.black.long
					}
				},
				attackSquares: result.aggregate.attackSquares.map((a) => ({
					square: a.square,
					attacker: a.attacker,
					count: a.count,
					captureCount: a.captureCount
				}))
			};
			mgFromSaved = false;
		} catch (e) {
			mgError = e instanceof Error ? e.message : 'Failed to generate guide.';
			scheduleMgErrorClear();
		} finally {
			mgBusy = false;
			mgProgress = null;
		}
	}

	async function saveMiddlegameGuideToIDB() {
		if (!rep || mgSaveBusy) return;
		if (mgArrows.length === 0 || mgFenKey !== currentFenKey) return;
		mgSaveBusy = true;
		try {
			const guide: SavedMiddlegameGuide = {
				repertoireId: rep.id,
				fenKey: currentFenKey,
				arrows: shapesToSavedArrows(mgArrows),
				source: 'guide',
				gamesUsable: mgGamesUsable,
				gamesQueried: mgGamesQueried || undefined,
				openingName: mgOpeningName,
				attackSquares: mgAttackSquares.length > 0 ? mgAttackSquares : undefined,
				totalLines: mgTotalLines || undefined,
				aggregate: mgAggregate ?? undefined,
				createdAt: mgSavedCreatedAt ?? Date.now(),
				updatedAt: Date.now()
			};
			await upsertMiddlegameGuide(guide);
			mgSavedExists = true;
			mgSavedCreatedAt = guide.createdAt;
			mgSavedGamesUsable = guide.gamesUsable ?? 0;
			mgSavedGamesQueried = guide.gamesQueried ?? 0;
			mgFromSaved = true;
			// Auto-create or refresh the position's plan card. Content is
			// regenerated from the current aggregate so the answer reflects
			// the latest guide; FSRS scheduling is preserved from any
			// existing card at this position.
			if (mgAggregate && rep) {
				try {
					const content = generatePlanCardContent({
						aggregate: mgAggregate,
						planForColor: rep.color,
						openingName: mgOpeningName
					});
					const existing = await getPlanCard(rep.id, currentFenKey);
					const fresh = freshPlanCard(
						rep.id,
						currentFenKey,
						rep.color,
						content.prompt,
						content.answer,
						mgOpeningName ?? null
					);
					const merged = existing
						? {
								...existing,
								prompt: fresh.prompt,
								answer: fresh.answer,
								planForColor: rep.color,
								openingName: mgOpeningName ?? null
							}
						: fresh;
					await upsertPlanCard(merged);
				} catch {
					/* plan-card creation is best-effort; guide save is the
					   primary action and shouldn't fail if the auxiliary
					   card flow hiccups. */
				}
			}
		} catch (e) {
			mgError = e instanceof Error ? e.message : 'Failed to save guide.';
			scheduleMgErrorClear();
		} finally {
			mgSaveBusy = false;
		}
	}

	async function deleteSavedMiddlegameGuide() {
		if (!rep || mgSaveBusy || !mgSavedExists) return;
		mgSaveBusy = true;
		try {
			await deleteMiddlegameGuide(rep.id, currentFenKey);
			// The plan card was auto-created from this guide; remove it too
			// so the user doesn't end up drilling a plan answer they
			// explicitly threw away.
			try {
				await deletePlanCard(rep.id, currentFenKey);
			} catch {
				/* plan-card cleanup is best-effort. */
			}
			mgSavedExists = false;
			mgSavedCreatedAt = null;
			mgSavedGamesUsable = 0;
			mgSavedGamesQueried = 0;
			// If the rendered arrows came from this saved guide, also clear
			// them from the board so the editor doesn't keep painting a
			// guide that no longer exists.
			if (mgFromSaved) {
				mgArrows = [];
				mgFenKey = null;
				mgGamesUsable = 0;
				mgGamesQueried = 0;
				mgAttackSquares = [];
				mgTotalLines = 0;
				mgAggregate = null;
				mgFromSaved = false;
			}
		} catch (e) {
			mgError = e instanceof Error ? e.message : 'Failed to delete guide.';
			scheduleMgErrorClear();
		} finally {
			mgSaveBusy = false;
		}
	}

	function scheduleMgErrorClear() {
		if (mgErrorTimer) clearTimeout(mgErrorTimer);
		mgErrorTimer = setTimeout(() => {
			mgError = null;
			mgErrorTimer = null;
		}, 4000);
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
					class="eyebrow inline-flex items-center gap-1.5 rounded-[3px] px-1.5 py-1 transition-all duration-150 ease-out disabled:opacity-60 {findMissingOpen
						? 'bg-[var(--color-ink-800)] text-[var(--color-parchment-100)]'
						: 'text-[var(--color-parchment-300)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]'}"
				>
					<span>{jumpBusy ? 'Probing…' : 'Actions'}</span>
					<ChevronDown
						class="size-3 transition-transform duration-200 ease-out {findMissingOpen
							? 'rotate-180'
							: ''}"
					/>
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
						class="ot-menu-pop stagger-menu absolute top-full right-0 z-40 mt-1 w-64 overflow-hidden rounded-[4px] border border-[var(--color-ink-700)] shadow-[var(--shadow-lg)]"
						style:background-color="var(--color-ink-900)"
					>
						{#if !tokenConfigured}
							<!-- Header banner: visible only when no Lichess token,
								 explains why several entries below are disabled
								 and links straight to the connection section in
								 Settings. Replaces the desktop inline pill on
								 mobile, where the action bar has no room. -->
							<!-- href is built from `resolve('/settings')` plus a `?return=`
								 query carrying the current path so the OAuth callback
								 lands the user back here instead of /settings. The lint
								 rule only spots literal `resolve()` calls in the
								 attribute, so disable it for this anchor. -->
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={lichessReturnHref}
								onclick={() => (findMissingOpen = false)}
								style:--i="0"
								class="flex items-center gap-2 border-b border-[var(--color-ink-800)] bg-[var(--color-ink-800)]/40 px-3 py-2 font-mono text-[10px] tracking-wider text-[var(--color-parchment-300)] uppercase transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<WifiOff class="size-3 text-[var(--color-brass-300)]" />
								<span>Lichess offline — sign in to enable</span>
							</a>
						{/if}
						<button
							type="button"
							role="menuitem"
							disabled={jumpBusy || !tokenConfigured}
							title={tokenConfigured
								? undefined
								: 'Requires a Lichess connection — paste a token in Settings to enable.'}
							onclick={() => {
								findMissingOpen = false;
								void jumpNextMissing();
							}}
							style:--i="1"
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:opacity-60"
						>
							<Compass class="size-3.5 text-[var(--color-parchment-400)]" />
							<span
								>Next missing <span class="text-[var(--color-parchment-500)]"
									>· {tokenConfigured ? 'on this line' : 'needs Lichess'}</span
								></span
							>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={jumpBusy || !tokenConfigured}
							title={tokenConfigured
								? undefined
								: 'Requires a Lichess connection — paste a token in Settings to enable.'}
							onclick={() => {
								findMissingOpen = false;
								void jumpBiggestMissing();
							}}
							style:--i="2"
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:opacity-60"
						>
							<Flame class="size-3.5 text-[var(--color-parchment-400)]" />
							<span
								>Biggest missing <span class="text-[var(--color-parchment-500)]"
									>· {tokenConfigured ? 'elsewhere' : 'needs Lichess'}</span
								></span
							>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={jumpBusy || !tokenConfigured}
							title={tokenConfigured
								? undefined
								: 'Requires a Lichess connection — paste a token in Settings to enable.'}
							onclick={() => {
								findMissingOpen = false;
								void jumpMostImportant();
							}}
							style:--i="3"
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:opacity-60"
						>
							<Star class="size-3.5 text-[var(--color-parchment-400)]" />
							<span
								>Most popular missing{#if !tokenConfigured}<span
										class="ml-1 text-[var(--color-parchment-500)]">· needs Lichess</span
									>{/if}</span
							>
						</button>
						{#if topGap}
							<!-- Doesn't need Lichess (driven by the local
								 empirical-gaps store), so this stays
								 enabled even when offline. Sits with the
								 other "find a place to work on" entries. -->
							<!-- Import PGN — no Lichess needed; merges pasted/uploaded
								 lines into this rep. Mobile twin of the toolbar button. -->
							<button
								type="button"
								role="menuitem"
								onclick={() => {
									findMissingOpen = false;
									openImportPgn();
								}}
								style:--i="7"
								class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]"
							>
								<Upload class="size-3.5 text-[var(--color-parchment-400)]" />
								<span
									>Import PGN <span class="text-[var(--color-parchment-500)]"
										>· paste or upload</span
									></span
								>
							</button>
							<button
								type="button"
								role="menuitem"
								onclick={() => {
									findMissingOpen = false;
									jumpTopEmpiricalGap();
								}}
								style:--i="4"
								class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]"
							>
								<Target class="size-3.5 text-[var(--color-parchment-400)]" />
								<span class="flex-1"
									>Gap you commonly face <span class="text-[var(--color-parchment-500)]"
										>· from your games</span
									></span
								>
								<span class="font-mono text-[10px] text-[var(--color-parchment-500)] tabular-nums">
									×{topGap.count}
								</span>
							</button>
						{/if}
						<div class="border-t border-[var(--color-ink-800)]" style:--i="5"></div>
						<button
							type="button"
							role="menuitem"
							disabled={!tokenConfigured}
							title={tokenConfigured
								? undefined
								: 'Requires a Lichess connection — paste a token in Settings to enable.'}
							onclick={() => {
								findMissingOpen = false;
								openBotDialog();
							}}
							style:--i="6"
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:opacity-60"
						>
							<Bot class="size-3.5 text-[var(--color-parchment-400)]" />
							<span
								>Spar <span class="text-[var(--color-parchment-500)]"
									>· {tokenConfigured ? 'Lichess bot' : 'needs Lichess'}</span
								></span
							>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={!currentIsPinnable}
							onclick={() => {
								findMissingOpen = false;
								trainFromCurrent();
							}}
							style:--i="7"
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:opacity-60"
						>
							<GraduationCap
								class="size-3.5 text-[var(--color-parchment-400)]"
								strokeWidth={1.75}
							/>
							<span>
								Train from here
								<span class="text-[var(--color-parchment-500)]">
									· {currentIsPinnable ? 'drill this branch' : 'not in tree'}
								</span>
							</span>
						</button>
						<button
							type="button"
							role="menuitem"
							disabled={!currentIsPinnedGate && !currentIsPinnable}
							onclick={() => {
								findMissingOpen = false;
								void togglePinAtCurrent();
							}}
							style:--i="8"
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
							style:--i="9"
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]"
						>
							<!-- MoveUpRight matches the visual shape of board arrows
								 (a diagonal pointer); the on/off state is carried
								 by the icon's tone — full parchment when arrows are
								 visible, dimmed when they're hidden — and by the
								 menu label that follows. -->
							<MoveUpRight
								class="size-3.5 transition-colors {boardHintsEnabled
									? 'text-[var(--color-brass-300)]'
									: 'text-[var(--color-parchment-500)]'}"
							/>
							{#if boardHintsEnabled}
								<span
									>Hide arrows <span class="text-[var(--color-parchment-500)]"
										>· engine & explorer</span
									></span
								>
							{:else}
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
				{#if !tokenConfigured}
					<!-- Inline notice: sits next to the disabled toolbar
						 buttons so the cause is unambiguous, and links
						 straight to the place that fixes it. Desktop-only —
						 mobile shows it as a header at the top of the
						 Actions popup since the action bar there only
						 carries the save pill. -->
					<!-- See companion banner above for why this href can't pass
						 the lint rule's literal-resolve check. -->
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						href={lichessReturnHref}
						title="Sign in to Lichess to enable these actions"
						class="hidden items-center gap-1.5 rounded-[3px] border border-[var(--color-ink-700)] bg-[var(--color-ink-800)]/40 px-2 py-1 font-mono text-[10px] tracking-wider text-[var(--color-parchment-400)] uppercase transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-200)] lg:inline-flex"
					>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						<WifiOff class="size-3 text-[var(--color-brass-300)]" />
						<span>Lichess offline — sign in to enable</span>
					</a>
				{/if}
				<!-- Desktop: individual buttons, hidden on mobile. The three
					 "missing" probes and Spar all hit Lichess; we disable
					 them when no token is configured and explain why in the
					 tooltip so the user can fix it from Settings rather than
					 hunt for the cause. -->
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={jumpNextMissing}
					disabled={jumpBusy || !tokenConfigured}
					title={tokenConfigured
						? "Probe the current line and jump to the earliest opponent move above the coverage threshold you haven't answered"
						: 'Requires a Lichess connection — paste a token in Settings to enable.'}
				>
					<Compass class="size-3.5" />
					<span>{jumpBusy ? 'Probing…' : 'Next missing'}</span>
				</Button>
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={jumpBiggestMissing}
					disabled={jumpBusy || !tokenConfigured}
					title={tokenConfigured
						? 'Probe the tree, skipping the current line, and jump to the biggest uncovered opponent move elsewhere'
						: 'Requires a Lichess connection — paste a token in Settings to enable.'}
				>
					<Flame class="size-3.5" />
					<span>{jumpBusy ? 'Probing…' : 'Biggest missing'}</span>
				</Button>
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={jumpMostImportant}
					disabled={jumpBusy || !tokenConfigured}
					title={tokenConfigured
						? "Probe the whole tree and jump to the single most-played opponent move above the coverage threshold that you haven't answered"
						: 'Requires a Lichess connection — paste a token in Settings to enable.'}
				>
					<Star class="size-3.5" />
					<span>{jumpBusy ? 'Ranking…' : 'Most popular missing'}</span>
				</Button>
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={openBotDialog}
					disabled={!tokenConfigured}
					title={tokenConfigured
						? 'Open a real Lichess game from this position vs Stockfish or Maia'
						: 'Requires a Lichess connection — paste a token in Settings to enable.'}
				>
					<Bot class="size-3.5" />
					<span>Spar</span>
				</Button>
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={toggleMiddlegameGuide}
					disabled={mgBusy || (!mgSavedExists && !tokenConfigured)}
					title={mgActive
						? mgHealth
							? `Clear middle-game arrows · ${mgHealth.usable}/${mgHealth.queried} top masters reach this position via your move order`
							: 'Clear middle-game arrows'
						: mgSavedExists
							? mgHealth
								? `Show the saved middle-game guide pinned at this position. ${mgHealth.usable}/${mgHealth.queried} top masters reach this position via your move order; the rest transpose elsewhere.`
								: 'Show the saved middle-game guide pinned at this position. The drill paints these too when "Show saved guides" is on.'
							: tokenConfigured
								? 'Aggregate ~12 plies of master games from this position and paint common continuations (green), pawn moves (yellow), and piece reroutings (blue) on the board.'
								: 'Requires a Lichess connection — paste a token in Settings to enable.'}
				>
					<BookOpen class="size-3.5" />
					<span>
						{mgBusy
							? (mgProgress ?? 'Building…')
							: mgActive
								? 'Clear guide'
								: mgSavedExists
									? 'Show saved guide'
									: 'Middle-game guide'}
					</span>
					{#if mgHealth && (mgActive || mgSavedExists)}
						<span
							class="ml-1 font-mono text-[10px] tabular-nums {mgHealth.tier === 'low'
								? 'text-[var(--color-oxblood-300)]'
								: mgHealth.tier === 'mid'
									? 'text-[var(--color-brass-300)]'
									: 'text-[var(--color-parchment-500)]'}"
						>
							·{mgHealth.usable}/{mgHealth.queried}
						</span>
					{:else if mgActive && mgGamesUsable > 0}
						<span class="ml-1 font-mono text-[10px] text-[var(--color-parchment-500)] tabular-nums">
							·{mgGamesUsable}
						</span>
					{:else if !mgActive && mgSavedExists}
						<Star class="ml-1 size-3 text-[var(--color-brass-300)]" fill="currentColor" />
					{/if}
				</Button>
				<!-- Bulk import: paste/upload PGN lines straight into this rep.
					 No Lichess token required, so it stays enabled regardless of
					 connection state. -->
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={openImportPgn}
					title="Add lines to this repertoire by pasting or uploading PGN"
				>
					<Upload class="size-3.5" />
					<span>Import PGN</span>
				</Button>
				{#if mgActive && !mgFromSaved}
					<Button
						class="hidden lg:inline-flex"
						variant="secondary"
						size="sm"
						onclick={() => {
							if (mgSaveBusy) return;
							void saveMiddlegameGuideToIDB();
						}}
						disabled={mgSaveBusy}
						title={mgSavedExists
							? 'Update the saved guide at this position so the drill picks up these arrows.'
							: 'Pin these arrows so the drill can paint them at this position when its setting is on.'}
					>
						<BookOpen class="size-3.5 text-[var(--color-brass-300)]" />
						<span>{mgSaveBusy ? 'Saving…' : mgSavedExists ? 'Update guide' : 'Save guide'}</span>
					</Button>
				{/if}
				{#if mgSavedExists}
					<Button
						class="hidden lg:inline-flex"
						variant="ghost"
						size="sm"
						href={rep ? resolve(`/repertoire/${rep.id}/heatmap`) : undefined}
						title="Open the per-position attack-square heatmap for this repertoire"
					>
						<Flame class="size-3.5" />
					</Button>
					<Button
						class="hidden lg:inline-flex"
						variant="ghost"
						size="sm"
						onclick={deleteSavedMiddlegameGuide}
						disabled={mgSaveBusy}
						title="Delete the saved guide at this position"
					>
						<Trash2 class="size-3.5" />
					</Button>
				{/if}
				<Button
					class="hidden lg:inline-flex"
					variant="secondary"
					size="sm"
					onclick={trainFromCurrent}
					disabled={!currentIsPinnable}
					title={currentIsPinnable
						? 'Drill from this position — practises every prepared move below it, no due-date gating'
						: 'Navigate to a tree position to train from it'}
				>
					<GraduationCap class="size-3.5" strokeWidth={1.75} />
					<span>Train from here</span>
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
					<!-- Desktop-only: mobile users reach the same action via
						 the Actions popup menu, where it sits next to the
						 missing-move probes. -->
					<Button
						class="hidden lg:inline-flex"
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
				{#if jumpStatus}
					<span class="ml-1 font-serif text-[11px] text-[var(--color-parchment-400)] italic">
						{jumpStatus}
					</span>
				{/if}
				{#if mgError}
					<span class="ml-1 font-serif text-[11px] text-[var(--color-oxblood-300)] italic">
						{mgError}
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
				class="order-5 hidden items-baseline gap-2 text-[13px] lg:order-none lg:col-start-2 lg:row-start-2 lg:flex"
			>
				<Lightbulb class="size-3.5 shrink-0 self-center text-[var(--color-brass-300)]" />
				<span class="font-mono tabular-nums {engineScoreTone}">{engineScore}</span>
				{#if engineTopSan}
					<span class="text-[var(--color-ink-600)]">·</span>
					<span class="font-mono text-[var(--color-parchment-200)]">{engineTopSan}</span>
				{/if}
				{#if engineDepth > 0}
					<span class="text-[var(--color-ink-600)]">·</span>
					<span
						class="font-mono text-[var(--color-parchment-500)] tabular-nums"
						title={enginePrimary?.source === 'cloud'
							? 'Lichess cloud eval'
							: 'Local Stockfish — deepens while you stay on this position'}
					>
						depth {engineDepth}{#if engineSourceLabel === 'cloud'}
							· cloud{/if}
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
				<button
					type="button"
					onclick={goForward}
					disabled={!canGoForward}
					title="Forward (→)"
					class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)] disabled:pointer-events-none disabled:opacity-30"
				>
					<ChevronRight class="size-4" />
				</button>
				<button
					type="button"
					onclick={goEnd}
					disabled={!canGoEnd}
					title="End (End)"
					class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)] disabled:pointer-events-none disabled:opacity-30"
				>
					<ChevronLast class="size-4" />
				</button>
				<!-- Right-anchored pill cluster. `ml-auto` is on whichever
					 button is the leftmost of the cluster so the rest follow
					 with normal flex gaps. When arrows are visible and either
					 unsaved or modified-since-save, the Save-guide pill leads
					 the cluster; otherwise Save line carries the ml-auto
					 itself and sits alone on the right (its historical
					 layout). -->
				{#if mgActive && !mgFromSaved}
					<button
						type="button"
						onclick={() => {
							if (mgSaveBusy) return;
							void saveMiddlegameGuideToIDB();
						}}
						title={mgSavedExists
							? 'Update the saved guide at this position so the drill picks up these arrows.'
							: 'Pin these arrows so the drill can paint them at this position when its setting is on.'}
						disabled={mgSaveBusy}
						class="ml-auto flex items-center gap-2 rounded-full border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-3 py-1 font-serif text-[13px] text-[var(--color-parchment-200)] transition-colors duration-200 hover:border-[var(--color-ink-600)] hover:bg-[var(--color-ink-800)] disabled:opacity-50"
					>
						<BookOpen class="size-3.5 text-[var(--color-brass-300)]" />
						<span>{mgSaveBusy ? 'Saving…' : mgSavedExists ? 'Update guide' : 'Save guide'}</span>
					</button>
				{/if}
				<button
					type="button"
					onclick={() => {
						if (justSaved || saveNothingToDo) return;
						void saveLine();
					}}
					title={justSaved ? 'Saved.' : saveNothingToDo ? 'No unsaved moves yet' : 'Save this line'}
					disabled={justSaved || saveNothingToDo}
					class="flex items-center gap-2 rounded-full border px-3 py-1 font-serif text-[13px] transition-colors duration-200 disabled:opacity-50 {mgActive &&
					!mgFromSaved
						? ''
						: 'ml-auto'} {saveToneClass}"
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
					<span class="flex items-baseline gap-1.5 text-[12px] lg:hidden">
						<Lightbulb class="size-3 shrink-0 self-center text-[var(--color-brass-300)]" />
						<span class="font-mono tabular-nums {engineScoreTone}">{engineScore}</span>
						{#if engineTopSan}
							<span class="text-[var(--color-ink-600)]">·</span>
							<span class="font-mono text-[var(--color-parchment-200)]">{engineTopSan}</span>
						{/if}
						{#if engineDepth > 0}
							<span class="text-[var(--color-ink-600)]">·</span>
							<span class="font-mono text-[var(--color-parchment-500)] tabular-nums">
								depth {engineDepth}{#if engineSourceLabel === 'cloud'}
									· cloud{/if}
							</span>
						{/if}
					</span>
				{/snippet}
				<Explorer
					fen={currentFen}
					onselect={addFromExplorer}
					ondelete={deleteFromExplorer}
					knownSans={knownChildSans}
					{subtreeSizeBySan}
					{engineEvalByUci}
					{engineRows}
					{transposesSans}
					buildingColor={rep.color}
					fingerprint={settings?.styleAdviceEnabled ? styleFingerprint : null}
					openingFit={settings?.styleAdviceEnabled ? styleOpeningFit : null}
					userWdlBySan={userWdlAtCurrent}
					savedMoves={savedMovesAtCurrent}
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
						<button
							type="button"
							onclick={goForward}
							disabled={!canGoForward}
							title="Forward (→)"
							class="hidden size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)] disabled:pointer-events-none disabled:opacity-30 lg:flex"
						>
							<ChevronRight class="size-4" />
						</button>
						<button
							type="button"
							onclick={goEnd}
							disabled={!canGoEnd}
							title="End (End)"
							class="hidden size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)] disabled:pointer-events-none disabled:opacity-30 lg:flex"
						>
							<ChevronLast class="size-4" />
						</button>
						<div class="eyebrow ml-2">Line</div>
						<!-- Desktop save pills: sit at the right of the Line
								 header so the primary commit actions live next
								 to the line they're saving, in line with the
								 move arrows. Mobile uses the board-toolbar
								 pills. When the guide pill is present it leads
								 the cluster (carries `ml-auto`); otherwise
								 Save line carries `ml-auto` itself. -->
						{#if mgActive && !mgFromSaved}
							<button
								type="button"
								onclick={() => {
									if (mgSaveBusy) return;
									void saveMiddlegameGuideToIDB();
								}}
								title={mgSavedExists
									? 'Update the saved guide at this position so the drill picks up these arrows.'
									: 'Pin these arrows so the drill can paint them at this position when its setting is on.'}
								disabled={mgSaveBusy}
								class="ml-auto hidden items-center gap-2 rounded-full border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-3 py-1 font-serif text-[13px] text-[var(--color-parchment-200)] transition-colors duration-200 hover:border-[var(--color-ink-600)] hover:bg-[var(--color-ink-800)] disabled:opacity-50 lg:flex"
							>
								<BookOpen class="size-3.5 text-[var(--color-brass-300)]" />
								<span>{mgSaveBusy ? 'Saving…' : mgSavedExists ? 'Update guide' : 'Save guide'}</span
								>
							</button>
						{/if}
						<button
							type="button"
							onclick={() => {
								if (justSaved || saveNothingToDo) return;
								void saveLine();
							}}
							title={justSaved
								? 'Saved.'
								: saveNothingToDo
									? 'No unsaved moves yet'
									: 'Save this line'}
							disabled={justSaved || saveNothingToDo}
							class="hidden items-center gap-2 rounded-full border px-3 py-1 font-serif text-[13px] transition-colors duration-200 disabled:opacity-50 lg:flex {mgActive &&
							!mgFromSaved
								? ''
								: 'ml-auto'} {saveToneClass}"
						>
							{#if justSaved}
								<Check class="size-3.5" />
								<span>Saved</span>
							{:else}
								<Save class="size-3.5" />
								<span>Save line</span>
								{#if movesSinceSave > 0}
									<span class="font-mono text-[11px] tabular-nums opacity-80"
										>+{movesSinceSave}</span
									>
								{/if}
							{/if}
						</button>
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

{#if importPgnOpen && rep}
	<!-- Backdrop + modal for bulk PGN import into the open repertoire. Paste
	     or upload PGN, merge additively into the tree (existing moves dedupe
	     by FEN, drill progress kept), then report what changed. -->
	<div
		role="presentation"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeImportPgn();
		}}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="import-pgn-title"
			class="ink-panel w-full max-w-lg rounded-[6px] border border-[var(--color-ink-700)] p-5 shadow-lg"
		>
			<div class="mb-3 flex items-center gap-2">
				<Upload class="size-4 text-[var(--color-brass-300)]" />
				<h2 id="import-pgn-title" class="font-serif text-lg">Import PGN into this repertoire</h2>
			</div>

			{#if importPgnResult}
				<!-- Post-import summary. Mirrors the standalone import page so the
				     two flows report the same numbers. -->
				<dl class="grid grid-cols-3 gap-3">
					<div>
						<dt class="eyebrow text-[var(--color-parchment-500)]">New moves</dt>
						<dd class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{importPgnResult.addedEdges}
						</dd>
					</div>
					<div>
						<dt class="eyebrow text-[var(--color-parchment-500)]">New cards</dt>
						<dd class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{importPgnResult.addedCards}
						</dd>
					</div>
					<div>
						<dt class="eyebrow text-[var(--color-parchment-500)]">Lines merged</dt>
						<dd class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{importPgnResult.importedLines}
						</dd>
					</div>
				</dl>
				{#if importPgnResult.skippedLines > 0}
					<p class="mt-3 font-serif text-sm text-[var(--color-brass-200)] italic">
						{importPgnResult.skippedLines} line(s) skipped — they start from a different position than
						this repertoire's opening.
					</p>
				{/if}
				<div class="mt-5 flex items-center justify-end gap-2">
					<Button
						variant="ghost"
						size="sm"
						onclick={() => {
							importPgnResult = null;
							importPgnText = '';
							importPgnFileName = null;
						}}>Import more</Button
					>
					<Button size="sm" onclick={closeImportPgn}>Done</Button>
				</div>
			{:else}
				<p class="mb-4 font-serif text-xs text-[var(--color-parchment-400)] italic">
					Merge variations from a study, book, or <span class="font-mono not-italic">.pgn</span>
					file. Existing moves and your drill progress are kept — only new lines are added. Lines must
					start from this repertoire's opening position.
				</p>

				<label
					for="import-pgn-file"
					class="mb-3 flex cursor-pointer items-center gap-3 rounded-[6px] border border-dashed border-[var(--color-ink-700)] p-3 transition-colors hover:border-[var(--color-brass-300)]/60 hover:bg-[var(--color-ink-900)]/50"
				>
					<Upload
						class="size-4 {importPgnFileName
							? 'text-[var(--color-brass-300)]'
							: 'text-[var(--color-parchment-400)]'}"
					/>
					<div class="min-w-0 flex-1 truncate text-sm text-[var(--color-parchment-100)]">
						{importPgnFileName ?? 'Choose a .pgn file — or paste below'}
					</div>
					<input
						id="import-pgn-file"
						type="file"
						accept=".pgn,text/plain"
						onchange={onImportPgnFile}
						class="sr-only"
					/>
				</label>

				<Textarea
					bind:value={importPgnText}
					rows={9}
					placeholder="1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 Bc5 ..."
					class="font-mono text-[13px] leading-6"
				/>

				{#if importPgnError}
					<p class="mt-2 text-xs text-[var(--color-oxblood-300)]">{importPgnError}</p>
				{/if}

				<div class="mt-4 flex items-center justify-end gap-2">
					<Button variant="ghost" size="sm" onclick={closeImportPgn} disabled={importPgnBusy}>
						Cancel
					</Button>
					<Button
						size="sm"
						onclick={runImportPgn}
						disabled={importPgnBusy || !importPgnText.trim()}
					>
						{importPgnBusy ? 'Importing…' : 'Import'}
					</Button>
				</div>
			{/if}
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
