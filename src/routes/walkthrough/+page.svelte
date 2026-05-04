<script module lang="ts">
	import { parsePgn as _parsePgn, startingPosition as _start } from 'chessops/pgn';
	import { parseSan as _parseSan, makeSanAndPlay as _makeSanAndPlay } from 'chessops/san';
	import { makeFen as _makeFen } from 'chessops/fen';
	import { makeUci as _makeUci } from 'chessops/util';

	// These helpers are defined in the module block so Svelte doesn't mistake
	// them for runtime reactive state.
	export function parseGameToPlies(pgn: string): {
		plies: Array<{
			san: string;
			uci: string;
			fenBefore: string;
			fenAfter: string;
			fenKeyBefore: string;
			fenKeyAfter: string;
			annotation: 'match' | 'deviation' | 'past-tree' | 'opponent';
			expectedSan?: string;
		}>;
		headers: Map<string, string>;
	} {
		const games = _parsePgn(pgn);
		if (games.length === 0) return { plies: [], headers: new Map() };
		const game = games[0];
		const startR = _start(game.headers);
		if (startR.isErr) return { plies: [], headers: game.headers };
		const pos = startR.value;
		const plies: Array<{
			san: string;
			uci: string;
			fenBefore: string;
			fenAfter: string;
			fenKeyBefore: string;
			fenKeyAfter: string;
			annotation: 'match' | 'deviation' | 'past-tree' | 'opponent';
			expectedSan?: string;
		}> = [];
		for (const node of game.moves.mainline()) {
			const move = _parseSan(pos, node.san);
			if (!move) break;
			const fenBefore = _makeFen(pos.toSetup());
			const fenKeyBefore = _makeFen(pos.toSetup(), { epd: true });
			const uci = _makeUci(move);
			const san = _makeSanAndPlay(pos, move);
			const fenAfter = _makeFen(pos.toSetup());
			const fenKeyAfter = _makeFen(pos.toSetup(), { epd: true });
			plies.push({
				san,
				uci,
				fenBefore,
				fenAfter,
				fenKeyBefore,
				fenKeyAfter,
				annotation: 'opponent'
			});
		}
		return { plies, headers: game.headers };
	}

	export function pickBestRepertoire(
		plies: Array<{ san: string; fenKeyBefore: string }>,
		reps: Array<{
			id: string;
			color: 'white' | 'black';
			rootFenKey: string;
			nodes: Map<string, import('$lib/types').RepertoireNode>;
		}>
	) {
		let best: (typeof reps)[number] | null = null;
		let bestDepth = -1;
		for (const rep of reps) {
			let depth = 0;
			for (const p of plies) {
				const stm = p.fenKeyBefore.split(' ')[1] === 'w' ? 'white' : 'black';
				if (stm !== rep.color) {
					depth++;
					continue;
				}
				const node = rep.nodes.get(p.fenKeyBefore);
				if (!node || node.children.length === 0) break;
				if (!node.children.find((e) => e.san === p.san)) break;
				depth++;
			}
			if (depth > bestDepth) {
				bestDepth = depth;
				best = rep;
			}
		}
		return best;
	}
</script>

<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { slide } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { page } from '$app/state';
	import {
		ArrowLeft,
		ChevronFirst,
		ChevronLast,
		ChevronLeft,
		ChevronRight,
		Check,
		X as XIcon,
		Circle,
		ExternalLink,
		Keyboard
	} from 'lucide-svelte';
	import type { Key, MoveMetadata, Dests } from '@lichess-org/chessground/types';
	import type { DrawShape } from '@lichess-org/chessground/draw';

	import Board from '$lib/chess/Board.svelte';
	import { Button, DashboardBacklink, Input, Label, Select, Textarea, cn } from '$lib/ui';
	import { playCorrect, playIncorrect } from '$lib/ui/sounds';
	import { fetchLichessGamePgn, fetchMastersGamePgn, extractGameId } from '$lib/lichess/singleGame';
	import { fetchExplorer, type TopGameEntry } from '$lib/explorer/client';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import { listRepertoires } from '$lib/storage/repertoires';
	import { nodesMap } from '$lib/storage/nodes';
	import { colorToMove, STARTPOS_FEN } from '$lib/chess/fen';
	import { edgeFromUci, fenAfterMove, isPromotionMove, legalDests } from '$lib/chess/position';
	import { findBranchPoint, fenForKeyInRep } from '$lib/walkthrough/repBranches';
	import { describeGameEnd } from '$lib/walkthrough/endState';
	import type { RecommendedGame } from '$lib/walkthrough/recommend';
	import {
		getPositionOpenings,
		setPositionOpening,
		openingFamily
	} from '$lib/openings/positionOpenings';
	import { autoHeight } from '$lib/ui/autoHeight';
	import { getEngine } from '$lib/stockfish/engine';
	import {
		gradeMove,
		shouldRefute,
		nagGlyph,
		nagColor,
		moveQualityLabel,
		moveQualityHeadline,
		type MoveQuality
	} from '$lib/drill/grade';
	import { probeMoveEvals } from '$lib/drill/probe';
	import type { AppSettings, Color, Repertoire, RepertoireNode } from '$lib/types';

	type Annotation = 'match' | 'deviation' | 'past-tree' | 'opponent';

	interface PlyEntry {
		san: string;
		uci: string;
		fenBefore: string;
		fenAfter: string;
		fenKeyBefore: string;
		fenKeyAfter: string;
		annotation: Annotation;
		expectedSan?: string;
	}

	interface RepChoice {
		id: string;
		name: string;
		color: Color;
		rootFenKey: string;
		nodes: Map<string, RepertoireNode>;
	}

	let pgnText = $state('');
	let urlOrId = $state('');
	let plies = $state<PlyEntry[]>([]);
	let wasLoaded = $state(false);
	$effect(() => {
		const loaded = plies.length > 0;
		if (loaded && !wasLoaded) {
			// Scroll to top when a game loads so the board is immediately
			// visible instead of the previous browse-list scroll position.
			if (typeof window !== 'undefined') {
				window.scrollTo({ top: 0, behavior: 'smooth' });
			}
		}
		wasLoaded = loaded;
	});
	let ply = $state(0);
	let gameHeaders = $state<Map<string, string> | null>(null);
	let loadError = $state<string | null>(null);
	let loading = $state(false);
	let orientation = $state<Color>('white');

	let settings = $state<AppSettings | null>(null);
	let reps = $state<RepChoice[]>([]);
	let selectedRepId = $state<string | null>(null);
	const selectedRep = $derived(reps.find((r) => r.id === selectedRepId) ?? null);

	let browsing = $state(false);
	let browseError = $state<string | null>(null);
	let browseGames = $state<TopGameEntry[]>([]);
	let browseYears = $state<{ since?: number; until?: number }>({});
	// How many of the streamed candidates to show initially. The recommender
	// surfaces up to ~30; rendering them all dilutes the top picks and makes
	// the panel huge. The "Load more" button reveals the rest in batches.
	const BROWSE_PAGE = 10;
	let browseVisibleCount = $state(BROWSE_PAGE);
	// Match depth per browse-list game (in plies) — populated when browsing
	// by deepest user-repertoire coverage.
	let browseDepths = $state<Map<string, { depth: number; repertoire: string; color: Color }>>(
		new Map()
	);
	// Browse-filter state.
	//   - `filterRepId`: narrows to a single rep.
	//   - `filterColor`: narrows by colour, but only takes effect when no
	//     specific rep is chosen (a rep already implies a colour).
	//   - `filterLineKey`: composite "repId|fenKey" identifying one branch
	//     of one rep. Stored as a single composite so the Line dropdown can
	//     span every visible rep without losing track of which tree the
	//     fenKey belongs to. Picking a line implies its rep + colour.
	let filterRepId = $state<string | null>(null);
	let filterColor = $state<'both' | 'white' | 'black'>('both');
	let filterLineKey = $state<string | null>(null);
	// Cached full-rep records (with rootFen) so the filter dropdowns can
	// inspect tree structure without an extra IndexedDB hit each render.
	let fullReps = $state<
		Array<{
			id: string;
			name: string;
			color: Color;
			rootFen: string;
			rootFenKey: string;
			startingFenKey?: string | null;
			nodes: Map<string, RepertoireNode>;
		}>
	>([]);
	const filterRep = $derived(fullReps.find((r) => r.id === filterRepId) ?? null);

	// Pool of reps the filters expose. A specific rep wins; otherwise the
	// colour filter narrows the set; otherwise every rep is in scope. The
	// Line dropdown always lists branches from this pool.
	const filteredReps = $derived.by(() => {
		if (filterRep) return [filterRep];
		if (filterColor !== 'both') return fullReps.filter((r) => r.color === filterColor);
		return fullReps;
	});

	// Cached opening family per branch fenKey (e.g. "Sicilian Defense"). Hydrated
	// from the position_openings IDB store on filter changes, then lazily filled
	// from the Lichess explorer for any branches the user hasn't visited in the
	// rep editor yet. Display labels in the Line dropdown fall back to the bare
	// SAN move when the cache is cold.
	const lineOpeningNames = new SvelteMap<string, string>();
	let lineOpeningFetchToken = 0;

	// Top-level branches across every rep in `filteredReps`, each labelled
	// with its opening family if the cache has a hit (e.g. "Sicilian Defense"
	// / "French Defense"). Anchored at the rep's `startingFenKey` if set,
	// otherwise the nearest branching node — same auto-detection used
	// elsewhere. Each option's value is a composite "repId|fenKey" so the
	// dropdown can mix branches from different reps without collisions.
	const filterLineOptions = $derived.by(() => {
		const opts: Array<{ value: string | null; label: string }> = [
			{ value: null, label: 'Any line' }
		];
		const reps = filteredReps;
		const includeRepName = reps.length > 1;
		for (const rep of reps) {
			const branchKey = findBranchPoint(rep);
			if (!branchKey) continue;
			const node = rep.nodes.get(branchKey);
			if (!node || node.children.length < 2) continue;
			for (const edge of node.children) {
				const named = lineOpeningNames.get(edge.toFenKey);
				const base = named ?? edge.san;
				const label = includeRepName ? `${base} · ${rep.name}` : base;
				opts.push({ value: `${rep.id}|${edge.toFenKey}`, label });
			}
		}
		return opts;
	});

	// Hydrate opening-name labels for whichever reps are in the current pool:
	// cheap IDB read first, then lazy explorer fetches for misses. Captured
	// names are persisted so the next visit is cache-only.
	$effect(() => {
		const reps = filteredReps;
		untrack(() => {
			lineOpeningNames.clear();
			if (reps.length === 0) return;
			void hydrateLineOpenings(reps);
		});
	});

	async function hydrateLineOpenings(reps: typeof fullReps) {
		const myToken = ++lineOpeningFetchToken;
		// Collect every branch fenKey we'll need to label, paired with the
		// rep that owns it (so the lazy fetch can compute the right FEN).
		const branches: Array<{ rep: (typeof fullReps)[number]; toFenKey: string }> = [];
		for (const rep of reps) {
			const branchKey = findBranchPoint(rep);
			if (!branchKey) continue;
			const node = rep.nodes.get(branchKey);
			if (!node || node.children.length < 2) continue;
			for (const edge of node.children) branches.push({ rep, toFenKey: edge.toFenKey });
		}
		if (branches.length === 0) return;
		const cached = await getPositionOpenings(branches.map((b) => b.toFenKey));
		if (myToken !== lineOpeningFetchToken) return;
		for (const [k, v] of cached) lineOpeningNames.set(k, openingFamily(v.name));
		// Fetch missing entries from Lichess. The explorer client serializes
		// requests internally and respects rate limits, so a handful of
		// sequential calls is safe. Skip duplicates (same fenKey across reps).
		const token = settings ? effectiveLichessToken(settings) : '';
		if (!token) return;
		const fetched: Record<string, true> = {};
		for (const { rep, toFenKey } of branches) {
			if (cached.has(toFenKey) || fetched[toFenKey]) continue;
			fetched[toFenKey] = true;
			if (myToken !== lineOpeningFetchToken) return;
			const childFen = fenForKeyInRep(rep, toFenKey);
			if (!childFen) continue;
			try {
				const res = await fetchExplorer({
					fen: childFen,
					source: 'masters',
					moves: 0,
					topGames: 0,
					token
				});
				if (myToken !== lineOpeningFetchToken) return;
				if (res.opening) {
					await setPositionOpening(toFenKey, res.opening);
					lineOpeningNames.set(toFenKey, openingFamily(res.opening.name));
				}
			} catch {
				/* skip on failure — SAN fallback handles it */
			}
		}
	}

	// Resolve the line filter to the rep+fenKey it points at, or null when
	// the stored composite no longer matches any current option (happens
	// when the pool shrinks to exclude that branch). Doing this as a
	// derivation rather than an $effect avoids the "writes-to-state-from-
	// effect" anti-pattern; the underlying `filterLineKey` is left alone so
	// the Select control can keep its identity across re-renders.
	const effectiveLine = $derived.by<{ repId: string; fenKey: string } | null>(() => {
		if (!filterLineKey) return null;
		if (!filterLineOptions.some((o) => o.value === filterLineKey)) return null;
		const sep = filterLineKey.indexOf('|');
		if (sep < 0) return null;
		return {
			repId: filterLineKey.slice(0, sep),
			fenKey: filterLineKey.slice(sep + 1)
		};
	});

	// The rep effectively in scope for the browse: a picked line wins
	// (because it pins both rep + branch), then an explicit rep filter, then
	// nothing (pool spans `filteredReps`).
	const effectiveRep = $derived(
		(effectiveLine && fullReps.find((r) => r.id === effectiveLine.repId)) || filterRep
	);

	// What the Color dropdown displays. When a rep (or line) is in scope it
	// shows that rep's colour — the actual filter is bypassed in this case,
	// but the user expects to see the colour they're effectively targeting,
	// not a stale "Both".
	const displayColor = $derived<'both' | 'white' | 'black'>(
		effectiveRep ? effectiveRep.color : filterColor
	);
	const colorLocked = $derived(!!effectiveRep);

	// Self-play mode: the user plays their colour's moves themselves, like a
	// drill. When off, the walkthrough is the old passive-review mode where
	// stepping buttons drive the ply. Defaults to on whenever there's a
	// selected repertoire — that's when self-play makes sense.
	let selfplay = $state(true);
	type WalkPhase = 'idle' | 'wrong' | 'refuted';
	let walkPhase = $state<WalkPhase>('idle');
	let moveQuality = $state<MoveQuality | null>(null);
	let gradedSquare = $state<Key | null>(null);
	let refutationSan = $state<string | null>(null);
	// Temporary FEN shown while a wrong move (or its engine refutation) is on
	// the board. Overlays `currentFen`. Cleared when the piece settles back.
	let overlayFen = $state<string | null>(null);
	let overlayLastMove = $state<[Key, Key] | undefined>(undefined);
	let wrongToken: { cancelled: boolean } = { cancelled: false };
	// Hint reveal level, same progression as drill.
	//   0 → nothing
	//   1 → source square highlighted (paleGreen)
	//   2 → full arrow from source to destination (green)
	let hintLevel = $state(0);

	// Opponent autoplay pacing: how long to pause before making the opponent's
	// match-played reply when it's not the user's turn.
	const OPPONENT_AUTOPLAY_MS = 650;
	const WRONG_FLASH_MS = 420;
	const WRONG_SETTLE_MS = 380;
	// Engine probe budgets: tighter on fenBefore (cp value only), looser
	// on fenAfter (need a usable PV to animate the refutation).
	const REFUTATION_PROBE_BEFORE_MS = 400;
	const REFUTATION_PROBE_AFTER_MS = 800;
	// Refutation animation: how many plies of Stockfish's PV to animate, and
	// how fast. The goal is to show the tactic through until the material
	// loss is realised — usually 3–4 plies is enough.
	const REFUTATION_MAX_PLIES = 6;
	const REFUTATION_PACE_MS = 700;
	const REFUTATION_HOLD_MS = 1100;

	const baseFen = $derived(
		plies.length === 0
			? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
			: ply === 0
				? plies[0].fenBefore
				: plies[Math.min(ply, plies.length) - 1].fenAfter
	);
	const currentFen = $derived(overlayFen ?? baseFen);

	const lastMove = $derived.by<[Key, Key] | undefined>(() => {
		if (overlayLastMove) return overlayLastMove;
		if (ply === 0 || plies.length === 0) return undefined;
		const p = plies[ply - 1];
		return [p.uci.slice(0, 2) as Key, p.uci.slice(2, 4) as Key];
	});

	const boardShapes = $derived.by<DrawShape[]>(() => {
		const shapes: DrawShape[] = [];

		// Glyph on the graded square (same Lichess-corner style as drill).
		if (moveQuality && gradedSquare) {
			shapes.push({
				orig: gradedSquare,
				label: { text: nagGlyph(moveQuality), fill: nagColor(moveQuality) }
			});
		}

		// Red refutation arrow.
		if (walkPhase === 'refuted' && overlayLastMove) {
			shapes.push({
				orig: overlayLastMove[0],
				dest: overlayLastMove[1],
				brush: 'red'
			});
		}

		// Self-play hint: progressive reveal of the match's played move
		// (source square, then full arrow). Only surfaces while it's the
		// user's turn and the phase is idle.
		if (selfplay && walkPhase === 'idle' && userToMove && hintLevel > 0 && ply < plies.length) {
			const p = plies[ply];
			const orig = p.uci.slice(0, 2) as Key;
			const dest = p.uci.slice(2, 4) as Key;
			if (hintLevel === 1) shapes.push({ orig, brush: 'paleGreen' });
			else shapes.push({ orig, dest, brush: 'green' });
		}

		// In passive mode, show the repertoire's expected-move arrow at
		// deviations. In self-play we suppress this — it would spoil the
		// answer the user is meant to find themselves.
		if (!selfplay && ply > 0) {
			const p = plies[ply - 1];
			if (p && p.annotation === 'deviation' && p.expectedSan && selectedRep) {
				const node = selectedRep.nodes.get(p.fenKeyBefore);
				const expected = node?.children.find((e) => e.san === p.expectedSan);
				if (expected) {
					shapes.push({
						orig: expected.uci.slice(0, 2) as Key,
						dest: expected.uci.slice(2, 4) as Key,
						brush: 'green',
						modifiers: { lineWidth: 12 }
					});
				}
			}
		}
		return shapes;
	});

	// Legal destinations: only the user's own colour, only during the idle
	// phase of self-play, only when it's their turn to move according to the
	// game's next ply.
	const dests = $derived.by<Dests>(() => {
		if (!selfplay || walkPhase !== 'idle') return new Map();
		if (plies.length === 0 || ply >= plies.length) return new Map();
		const nextPly = plies[ply];
		const stm = colorToMove(nextPly.fenKeyBefore);
		if (!selectedRep || stm !== selectedRep.color) return new Map();
		try {
			const raw = legalDests(currentFen);
			return new Map(Array.from(raw, ([k, v]) => [k as Key, v as Key[]]));
		} catch {
			return new Map();
		}
	});

	const userToMove = $derived.by(() => {
		if (!selfplay || plies.length === 0 || ply >= plies.length) return false;
		const nextPly = plies[ply];
		const stm = colorToMove(nextPly.fenKeyBefore);
		return !!selectedRep && stm === selectedRep.color;
	});

	// Whose turn it is at the position currently on the board. Without this
	// chessground defaults to "white" and treats any black move as a pre-move
	// (dragging the piece snaps back instead of committing).
	const turnColorAtFen = $derived<Color>(colorToMove(currentFen));

	/**
	 * When it's not the user's turn (in self-play), autoplay the match's
	 * move after a brief pause so the game flows like a replay. This effect
	 * tracks `ply` and `selfplay` only — reads of other state are untracked
	 * so setting them inside doesn't re-fire the timer.
	 */
	$effect(() => {
		if (!selfplay) return;
		const i = ply;
		// Track plies.length explicitly: loading a new game leaves ply at 0,
		// so without this dep the effect wouldn't re-run to autoplay the
		// opponent's first move (breaks black-side games on initial load).
		const total = plies.length;
		untrack(() => {
			if (walkPhase !== 'idle') return;
			if (total === 0 || i >= total) return;
			const nextPly = plies[i];
			const stm = colorToMove(nextPly.fenKeyBefore);
			if (selectedRep && stm === selectedRep.color) return;
			const timer = setTimeout(() => {
				if (walkPhase !== 'idle') return;
				ply = i + 1;
			}, OPPONENT_AUTOPLAY_MS);
			// Store the timer so pressing Back cancels it implicitly via the
			// next effect run.
			cancelTimer = timer;
		});
		return () => {
			if (cancelTimer) clearTimeout(cancelTimer);
			cancelTimer = null;
		};
	});
	let cancelTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Board input: the user plays their colour's move. If it matches the
	 * game's move, advance. Otherwise, grade it with the engine; blunders
	 * trigger a refutation flow and revert, lesser errors just get a glyph
	 * and revert so the user can try again with the actual match move.
	 */
	function handleBoardMove(orig: Key, dest: Key, _m: MoveMetadata) {
		if (!userToMove || walkPhase !== 'idle') return;
		const nextPly = plies[ply];
		const promo = isPromotionMove(currentFen, orig, dest) ? 'q' : undefined;
		const edge = edgeFromUci(currentFen, orig, dest, promo);
		if (!edge) return;
		gradedSquare = dest;
		if (edge.san === nextPly.san) {
			moveQuality = 'correct';
			playCorrect();
			ply += 1;
			// Clear the glyph shortly after so the next human move isn't
			// polluted by stale state.
			setTimeout(() => {
				moveQuality = null;
				gradedSquare = null;
			}, 700);
		} else {
			overlayFen = fenAfterMove(currentFen, edge);
			overlayLastMove = [orig, dest];
			walkPhase = 'wrong';
			void runWrongSequence(edge.uci, orig, dest);
		}
	}

	async function runWrongSequence(_uci: string, _orig: Key, _dest: Key) {
		wrongToken.cancelled = true;
		const token = { cancelled: false };
		wrongToken = token;

		// `currentFen` has already flipped to the overlay (post-wrong-
		// move) position by the time this runs; the actual game
		// position the user was moving from is `baseFen`.
		const fenBefore = baseFen;
		const wrongFen = overlayFen!;
		refutationSan = null;

		await sleep(WRONG_FLASH_MS);
		if (token.cancelled) return;

		const probe = await probeMoveEvals(
			fenBefore,
			wrongFen,
			REFUTATION_PROBE_BEFORE_MS,
			REFUTATION_PROBE_AFTER_MS
		);
		if (token.cancelled) return;

		moveQuality = probe ? gradeMove(probe.bestUserPov, probe.playedUserPov) : 'dubious';
		if (moveQuality === 'playable') playCorrect();
		else playIncorrect();
		const refute = probe !== null && shouldRefute(moveQuality);

		if (refute && probe) {
			// Walk Stockfish's principal variation several plies deep — the
			// material loss from a real blunder often only becomes visible
			// after 2–3 exchanges, so we keep animating until the tactic
			// plays out.
			let showFen = wrongFen;
			const maxPlies = Math.min(REFUTATION_MAX_PLIES, probe.refutationPv.length);
			for (let i = 0; i < maxPlies; i++) {
				const pvUci = probe.refutationPv[i];
				if (!pvUci || pvUci.length < 4) break;
				const orig = pvUci.slice(0, 2) as Key;
				const dest = pvUci.slice(2, 4) as Key;
				const promo = pvUci.length > 4 ? (pvUci[4] as 'q' | 'r' | 'b' | 'n') : undefined;
				const pvEdge = edgeFromUci(showFen, orig, dest, promo);
				if (!pvEdge) break;
				const nextFen = fenAfterMove(showFen, pvEdge);
				if (i > 0) {
					await sleep(REFUTATION_PACE_MS);
					if (token.cancelled) return;
				}
				overlayFen = nextFen;
				overlayLastMove = [orig, dest];
				if (i === 0) {
					refutationSan = pvEdge.san;
					walkPhase = 'refuted';
				}
				showFen = nextFen;
			}
			await sleep(REFUTATION_HOLD_MS);
			if (token.cancelled) return;
		} else {
			await sleep(500);
			if (token.cancelled) return;
		}

		// Revert. User has to play the match's move to advance.
		overlayFen = null;
		overlayLastMove = undefined;
		gradedSquare = null;
		moveQuality = null;
		refutationSan = null;
		walkPhase = 'idle';
		await sleep(WRONG_SETTLE_MS);
		if (token.cancelled) return;
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	onMount(async () => {
		settings = await getSettings();
		// Warm the engine so the first refutation check doesn't wait on a
		// 20 MB NNUE fetch.
		void getEngine()
			.init()
			.catch(() => undefined);
		const all = await listRepertoires();
		const withNodes = await Promise.all(
			all.map(async (r: Repertoire) => {
				const nodes = await nodesMap(r.id);
				return { rep: r, nodes };
			})
		);
		reps = withNodes.map(({ rep: r, nodes }) => ({
			id: r.id,
			name: r.name,
			color: r.color,
			rootFenKey: r.rootFenKey,
			nodes
		}));
		fullReps = withNodes.map(({ rep: r, nodes }) => ({
			id: r.id,
			name: r.name,
			color: r.color,
			rootFen: r.rootFen,
			rootFenKey: r.rootFenKey,
			startingFenKey: r.startingFenKey,
			nodes
		}));
		// Auto-load if the dashboard linked here with ?gameId=... — this is how
		// the "Recommended walkthrough" card hands off to this page.
		const gameId = page.url.searchParams.get('gameId');
		const repId = page.url.searchParams.get('repertoireId');
		if (gameId) {
			if (repId) selectedRepId = repId;
			await loadMastersGame({
				id: gameId,
				uci: '',
				white: { name: '' },
				black: { name: '' }
			});
		}
	});

	async function load(e: Event) {
		e.preventDefault();
		loadError = null;
		if (!pgnText.trim() && !urlOrId.trim()) {
			loadError = 'Paste a PGN or a Lichess game URL/id.';
			return;
		}
		loading = true;
		try {
			let pgn = pgnText.trim();
			if (!pgn && urlOrId.trim()) {
				const token = settings ? effectiveLichessToken(settings) : '';
				pgn = await fetchLichessGamePgn(urlOrId, token || undefined);
				pgnText = pgn;
			}
			const { plies: pl, headers } = parseGameToPlies(pgn);
			if (pl.length === 0) {
				loadError = 'No moves found in the PGN.';
				plies = [];
				return;
			}
			plies = pl;
			ply = 0;
			gameHeaders = headers;
			const best = pickBestRepertoire(pl, reps);
			selectedRepId = best?.id ?? null;
			orientation = best?.color ?? 'white';
			recomputeAnnotations();
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Failed to load game.';
		} finally {
			loading = false;
		}
	}

	/** Re-grade every ply against the currently selected repertoire. */
	function recomputeAnnotations() {
		if (plies.length === 0) return;
		const rep = selectedRep;
		plies = plies.map((p) => {
			const stm = colorToMove(p.fenKeyBefore);
			if (!rep || stm !== rep.color) {
				return { ...p, annotation: 'opponent' as Annotation, expectedSan: undefined };
			}
			const node = rep.nodes.get(p.fenKeyBefore);
			if (!node || node.children.length === 0) {
				return { ...p, annotation: 'past-tree' as Annotation, expectedSan: undefined };
			}
			const matching = node.children.find((e) => e.san === p.san);
			if (matching) {
				return { ...p, annotation: 'match' as Annotation, expectedSan: p.san };
			}
			return {
				...p,
				annotation: 'deviation' as Annotation,
				expectedSan: node.children[0].san
			};
		});
	}

	// Re-grade when the user switches repertoire. Track only `selectedRep` —
	// `recomputeAnnotations` rewrites `plies`, so if we let the effect pick
	// that up as a dependency we'd loop forever.
	$effect(() => {
		const rep = selectedRep;
		untrack(() => {
			if (plies.length === 0) return;
			recomputeAnnotations();
			if (rep) orientation = rep.color;
		});
	});

	async function browseMasters() {
		if (browsing) return;
		browseError = null;
		browsing = true;
		browseVisibleCount = BROWSE_PAGE;
		const token = settings ? effectiveLichessToken(settings) : '';
		try {
			// If the user has repertoires, surface games that go deepest into
			// *their* prep; otherwise fall back to the generic startpos top
			// games. Filters narrow the candidate set:
			//   - Repertoire: probe just one rep instead of all.
			//   - Color: keep only reps of that colour (only meaningful when
			//     no specific rep is chosen).
			//   - Line: when a rep is chosen, restrict probing to the subtree
			//     rooted at the picked branch.
			if (reps.length > 0) {
				const { recommendDeepGames } = await import('$lib/walkthrough/recommend');
				// Picking a line pins the rep too; otherwise honour the
				// rep/colour filters directly.
				const line = effectiveLine;
				let pool = fullReps;
				if (line) {
					pool = pool.filter((r) => r.id === line.repId);
				} else if (filterRepId) {
					pool = pool.filter((r) => r.id === filterRepId);
				} else if (filterColor !== 'both') {
					pool = pool.filter((r) => r.color === filterColor);
				}
				if (pool.length === 0) {
					browseGames = [];
					browseDepths = new Map();
					browseError = 'No repertoires match the chosen filters.';
					return;
				}
				const probeReps = pool.map((r) => {
					if (line && r.id === line.repId) {
						const probeFen = fenForKeyInRep(r, line.fenKey);
						if (probeFen) {
							return { ...r, probeFromFen: probeFen, probeFromFenKey: line.fenKey };
						}
					}
					return r;
				});
				// Lower the bar when the user picked a single line — candidates
				// are already filtered to the line by probing, and demanding
				// 5 plies past the rep root would gut shallow openings.
				const minDepth = line ? 3 : 5;
				// Browse skips PGN verification (each verified candidate is an
				// extra HTTP round-trip with no payoff for browse — the user
				// sees the actual move-order match the moment they open a
				// game). `onProgress` streams probe results in as they land
				// so the first row appears in <1s instead of 10+.
				const applyRecs = (recs: RecommendedGame[]) => {
					browseGames = recs.map((r) => r.game);
					browseDepths = new Map(
						recs.map((r) => [
							r.game.id,
							{ depth: r.depth, repertoire: r.repertoireName, color: r.repertoireColor }
						])
					);
				};
				const recs = await recommendDeepGames({
					reps: probeReps,
					token: token || undefined,
					limit: 30,
					maxProbes: 20,
					minDepth,
					verify: false,
					onProgress: applyRecs
				});
				applyRecs(recs);
			} else {
				const res = await fetchExplorer({
					fen: STARTPOS_FEN,
					source: 'masters',
					topGames: 15,
					moves: 0,
					token: token || undefined
				});
				browseGames = res.topGames ?? [];
				browseDepths = new Map();
			}
			const years = browseGames
				.map((g) => g.year)
				.filter((y): y is number => typeof y === 'number');
			browseYears = years.length ? { since: Math.min(...years), until: Math.max(...years) } : {};
			if (browseGames.length === 0 && !browseError) {
				browseError = 'No masters games surfaced.';
			}
		} catch (e) {
			browseError = e instanceof Error ? e.message : 'Masters browse failed';
		} finally {
			browsing = false;
		}
	}

	async function loadMastersGame(game: TopGameEntry) {
		loadError = null;
		loading = true;
		try {
			const token = settings ? effectiveLichessToken(settings) : '';
			const pgn = await fetchMastersGamePgn(game.id, token || undefined);
			pgnText = pgn;
			urlOrId = game.id;
			const { plies: pl, headers } = parseGameToPlies(pgn);
			if (pl.length === 0) {
				loadError = 'Masters PGN had no playable moves.';
				return;
			}
			plies = pl;
			ply = 0;
			gameHeaders = headers;
			const best = pickBestRepertoire(pl, reps);
			selectedRepId = best?.id ?? null;
			orientation = best?.color ?? 'white';
			recomputeAnnotations();
			// Remember we've opened this one so the dashboard's daily
			// recommendation rotates to a fresh game next session.
			const { markWalkthroughGameViewed } = await import('$lib/walkthrough/viewed');
			await markWalkthroughGameViewed(game.id);
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Failed to load masters game.';
		} finally {
			loading = false;
		}
	}

	function goto(n: number) {
		// Manual navigation cancels any in-flight wrong/refutation animation
		// and clears overlay state; otherwise a stale refutation could sit
		// on top of a freshly-navigated position.
		wrongToken.cancelled = true;
		overlayFen = null;
		overlayLastMove = undefined;
		moveQuality = null;
		gradedSquare = null;
		refutationSan = null;
		hintLevel = 0;
		walkPhase = 'idle';
		ply = Math.max(0, Math.min(n, plies.length));
	}

	function showHint() {
		if (!selfplay || walkPhase !== 'idle' || !userToMove) return;
		hintLevel = Math.min(hintLevel + 1, 2);
	}
	function step(delta: number) {
		goto(ply + delta);
	}

	function handleKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (plies.length === 0) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			step(-1);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			step(1);
		} else if (e.key === 'Home') {
			e.preventDefault();
			goto(0);
		} else if (e.key === 'End') {
			e.preventDefault();
			goto(plies.length);
		} else if (e.key === 'h' || e.key === 'H' || e.key === 'z' || e.key === 'Z' || e.key === '?') {
			e.preventDefault();
			showHint();
		}
	}

	// Fresh ply → drop any lingering hint so each position starts clean.
	$effect(() => {
		void ply;
		untrack(() => {
			hintLevel = 0;
		});
	});

	function moveNumberPrefix(i: number): string | null {
		return i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : null;
	}

	const summary = $derived.by(() => {
		let match = 0,
			dev = 0,
			past = 0;
		for (const p of plies) {
			if (p.annotation === 'match') match++;
			else if (p.annotation === 'deviation') dev++;
			else if (p.annotation === 'past-tree') past++;
		}
		return { match, dev, past };
	});

	const isAtEnd = $derived(plies.length > 0 && ply >= plies.length);

	/**
	 * Describe how the game ended for the "Game complete" card. Combines the
	 * PGN result + Termination header with rules-detection on the final
	 * position (checkmate / stalemate / 50-move / insufficient material) and
	 * a repetition scan across every position. See `describeGameEnd`.
	 */
	const gameResult = $derived.by(() => {
		if (!isAtEnd) return null;
		const finalFen = plies[plies.length - 1]?.fenAfter;
		// Position list = starting position + every fenKeyAfter. Used solely
		// for threefold-repetition detection on the final position.
		const positionKeys: string[] = [];
		if (plies.length > 0) positionKeys.push(plies[0].fenKeyBefore);
		for (const p of plies) positionKeys.push(p.fenKeyAfter);
		return describeGameEnd({
			result: gameHeaders?.get('Result') ?? '',
			termination: gameHeaders?.get('Termination') ?? undefined,
			whiteName: fmtHeader('White') || undefined,
			blackName: fmtHeader('Black') || undefined,
			finalFen,
			positionKeys
		});
	});

	function fmtHeader(name: string): string {
		return gameHeaders?.get(name) ?? '';
	}

	// Build a Lichess URL to open the loaded game in analysis. If the input
	// looks like a Lichess game id (8 alphanumeric), link straight to the
	// game page — Lichess exposes its analysis UI there. Otherwise (masters
	// DB slugs, pasted PGNs), fall back to opening the current board
	// position in Lichess's generic analysis board via ?fen=.
	const lichessUrl = $derived.by<string | null>(() => {
		if (plies.length === 0) return null;
		const id = urlOrId ? extractGameId(urlOrId) : null;
		if (id) return `https://lichess.org/${id}`;
		const fen = currentFen;
		if (!fen) return null;
		return `https://lichess.org/analysis?fen=${encodeURIComponent(fen)}`;
	});
</script>

<svelte:window on:keydown={handleKey} />

<div
	class={plies.length > 0
		? 'mx-auto max-w-5xl px-4 py-6 md:px-6 md:pt-12 md:pb-16'
		: 'relative mx-auto max-w-2xl px-6 pt-14 pb-16'}
>
	{#if plies.length > 0}
		<button
			type="button"
			onclick={() => {
				plies = [];
				ply = 0;
				gameHeaders = null;
				pgnText = '';
				urlOrId = '';
				walkPhase = 'idle';
				overlayFen = null;
				overlayLastMove = undefined;
				moveQuality = null;
				gradedSquare = null;
				refutationSan = null;
			}}
			class="eyebrow mb-3 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)] md:mb-5"
		>
			<ArrowLeft class="size-3" />
			<span>Walkthrough</span>
		</button>
	{:else}
		<DashboardBacklink />
	{/if}

	{#if plies.length === 0}
		<div class="eyebrow mb-3">Walkthrough</div>
		<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
			Step through a <em class="text-[var(--color-brass-300)]">reference game</em>.
		</h1>
		<p class="mt-3 max-w-xl text-[var(--color-parchment-400)]">
			Paste a PGN or a Lichess game URL, pick the repertoire to compare against, and move by move
			the app marks where the game matched your tree, where it diverged, and what your line would
			have played instead.
		</p>
	{/if}

	{#if plies.length === 0}
		<!-- Browse top masters DB games -->
		<div class="ink-panel mt-8 p-4">
			<div class="eyebrow mb-1">Browse masters DB</div>
			<p class="font-serif text-xs text-[var(--color-parchment-500)] italic">
				Top games from the Lichess masters database at the starting position. Tournament games by
				titled players, historical and modern.
			</p>

			{#if reps.length > 0}
				<!-- Filters narrow the candidate set: by repertoire, by colour
					 (only meaningful when no specific rep is chosen), and by
					 line. The Line dropdown lists branches across every rep
					 in scope, so picking a line is enough on its own — it
					 implies the rep + colour. -->
				<div class="relative z-10 mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-3">
					<div>
						<Label for="filter-rep">Repertoire</Label>
						<Select
							id="filter-rep"
							value={filterRepId}
							onchange={(v) => (filterRepId = v as string | null)}
							placeholder="All"
							options={[
								{ value: null, label: 'All repertoires' },
								...fullReps.map((r) => ({ value: r.id, label: `${r.name} (${r.color})` }))
							]}
						/>
					</div>
					<div
						class={colorLocked ? 'pointer-events-none opacity-40' : ''}
						aria-disabled={colorLocked}
					>
						<Label for="filter-color">Color</Label>
						<Select
							id="filter-color"
							value={displayColor}
							onchange={(v) => (filterColor = (v ?? 'both') as 'both' | 'white' | 'black')}
							options={[
								{ value: 'both', label: 'Both colors' },
								{ value: 'white', label: 'White' },
								{ value: 'black', label: 'Black' }
							]}
						/>
					</div>
					<div>
						<Label for="filter-line">Line</Label>
						<Select
							id="filter-line"
							value={filterLineKey}
							onchange={(v) => (filterLineKey = v as string | null)}
							placeholder="Any line"
							options={filterLineOptions}
						/>
					</div>
				</div>
			{/if}

			<div class="mt-5 flex flex-wrap items-center gap-3">
				<Button variant="primary" size="md" onclick={browseMasters} disabled={browsing}>
					<span>{browsing ? 'Loading…' : browseGames.length > 0 ? 'Refresh games' : 'Browse'}</span>
				</Button>
				{#if effectiveRep}
					<span
						class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
					>
						in {effectiveRep.name}
						{#if effectiveLine}
							{@const lineLabel = lineOpeningNames.get(effectiveLine.fenKey)}
							{#if lineLabel}· {lineLabel}{/if}
						{/if}
					</span>
				{/if}
			</div>

			{#if browseError}
				<p class="mt-3 text-xs text-[var(--color-oxblood-300)]">{browseError}</p>
			{/if}
			{#if browseGames.length > 0 && (browseYears.since !== undefined || browseYears.until !== undefined)}
				<p
					class="mt-3 font-mono text-[11px] tracking-widest text-[var(--color-parchment-500)] uppercase"
				>
					{Math.min(browseVisibleCount, browseGames.length)} of {browseGames.length} · {browseYears.since}
					{browseYears.until && browseYears.until !== browseYears.since
						? `– ${browseYears.until}`
						: ''}
				</p>
			{/if}

			{#if browseGames.length > 0}
				<ul class="mt-3 space-y-1">
					{#each browseGames.slice(0, browseVisibleCount) as g (g.id)}
						{@const meta = browseDepths.get(g.id)}
						<li in:slide={{ duration: 220 }} animate:flip={{ duration: 220 }}>
							<button
								type="button"
								onclick={() => loadMastersGame(g)}
								disabled={loading}
								class="grid w-full grid-cols-[auto_1fr_auto_auto] items-baseline gap-3 rounded-[3px] px-2 py-2 text-left transition-colors hover:bg-[var(--color-ink-800)]"
							>
								<span class="eyebrow text-[var(--color-brass-300)] tabular-nums"
									>{g.year ?? '—'}</span
								>
								<span class="truncate font-mono text-sm">
									{g.white.name}
									{g.white.rating ? `(${g.white.rating})` : ''}
									<span class="text-[var(--color-parchment-500)]">vs</span>
									{g.black.name}
									{g.black.rating ? `(${g.black.rating})` : ''}
								</span>
								{#if meta}
									<span
										class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-400)] uppercase"
										title="Match depth in {meta.repertoire}"
									>
										{meta.depth} ply
									</span>
								{:else}
									<span></span>
								{/if}
								<span
									class="font-mono text-[11px] tracking-wider uppercase"
									class:text-[var(--color-parchment-200)]={g.winner === 'white'}
									class:text-[var(--color-parchment-400)]={g.winner === 'black'}
									class:text-[var(--color-parchment-500)]={!g.winner}
								>
									{g.winner === 'white' ? '1–0' : g.winner === 'black' ? '0–1' : '½–½'}
								</span>
							</button>
						</li>
					{/each}
				</ul>
				{#if browseVisibleCount < browseGames.length}
					<div class="mt-3 flex justify-center">
						<Button
							variant="ghost"
							size="sm"
							onclick={() =>
								(browseVisibleCount = Math.min(
									browseGames.length,
									browseVisibleCount + BROWSE_PAGE
								))}
						>
							<span>Load more · {browseGames.length - browseVisibleCount} hidden</span>
						</Button>
					</div>
				{/if}
			{/if}
		</div>

		<div class="paper-divider my-6 font-serif text-lg">
			<span class="ornament">⁂</span>
		</div>

		<form onsubmit={load} class="space-y-4">
			<div class="grid items-end gap-3 md:grid-cols-[1fr_auto]">
				<div>
					<Label for="url">Lichess game URL or id</Label>
					<Input
						id="url"
						bind:value={urlOrId}
						placeholder="https://lichess.org/xxxxxxxx or xxxxxxxx"
						disabled={loading}
						class="font-mono text-[13px]"
					/>
				</div>
				<Button type="submit" variant="primary" size="md" disabled={loading}>
					<span>{loading ? 'Loading…' : 'Load'}</span>
				</Button>
			</div>

			<div class="paper-divider my-2 font-serif text-lg">
				<span class="ornament">⁂</span>
			</div>

			<div>
				<Label for="pgn">Or paste a PGN</Label>
				<Textarea
					id="pgn"
					bind:value={pgnText}
					rows={8}
					placeholder="[Event ...]&#10;&#10;1. e4 e5 2. Nf3 ..."
					class="font-mono text-[13px]"
				/>
			</div>

			{#if loadError}
				<p class="text-sm text-[var(--color-oxblood-300)]">{loadError}</p>
			{/if}
		</form>
	{:else}
		<!-- Game loaded: board on the left, prompt/info rail on the right -->
		<div class="mt-3 grid gap-3 md:mt-6 md:grid-cols-[minmax(0,1fr)_320px] md:gap-6">
			<!-- Board column: board, nav, moves. -->
			<section>
				<div class="mx-auto max-w-[560px]">
					<Board
						fen={currentFen}
						{orientation}
						turnColor={turnColorAtFen}
						{lastMove}
						shapes={boardShapes}
						viewOnly={!selfplay || !userToMove || walkPhase !== 'idle'}
						movableColor={selfplay && selectedRep ? selectedRep.color : 'both'}
						{dests}
						onmove={handleBoardMove}
					/>
				</div>

				<div class="mx-auto mt-2 flex max-w-[560px] items-center justify-center gap-1 md:mt-4">
					<button
						type="button"
						onclick={() => goto(0)}
						disabled={ply === 0}
						title="Start (Home)"
						class="flex size-9 items-center justify-center rounded-[3px] text-[var(--color-parchment-300)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:pointer-events-none disabled:opacity-30"
					>
						<ChevronFirst class="size-4" />
					</button>
					<button
						type="button"
						onclick={() => step(-1)}
						disabled={ply === 0}
						title="Back (←)"
						class="flex size-9 items-center justify-center rounded-[3px] text-[var(--color-parchment-300)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:pointer-events-none disabled:opacity-30"
					>
						<ChevronLeft class="size-4" />
					</button>
					<span class="eyebrow px-3 tabular-nums">
						{ply} / {plies.length}
					</span>
					<button
						type="button"
						onclick={() => step(1)}
						disabled={ply >= plies.length}
						title="Next (→)"
						class="flex size-9 items-center justify-center rounded-[3px] text-[var(--color-parchment-300)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:pointer-events-none disabled:opacity-30"
					>
						<ChevronRight class="size-4" />
					</button>
					<button
						type="button"
						onclick={() => goto(plies.length)}
						disabled={ply >= plies.length}
						title="End (End)"
						class="flex size-9 items-center justify-center rounded-[3px] text-[var(--color-parchment-300)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:pointer-events-none disabled:opacity-30"
					>
						<ChevronLast class="size-4" />
					</button>
				</div>

				<!-- Moves list: under the board. In self-play, future moves are
					 hidden to avoid spoiling what's next. The hide/show toggle
					 doubles as the self-play switch — hiding future moves is the
					 whole point of self-play mode. -->
				<div class="ink-panel mx-auto mt-2 max-w-[560px] p-4 md:mt-4">
					<div class="mb-2 flex items-baseline justify-between gap-2">
						<span class="eyebrow">Moves</span>
						<div class="flex items-center gap-3">
							{#if selfplay}
								<span
									class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
								>
									{ply}/{plies.length} played
								</span>
							{/if}
							{#if reps.length > 0}
								<label
									class="flex cursor-pointer items-center gap-2"
									title="Hide future moves so you can play them yourself"
								>
									<span
										class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-400)] uppercase"
									>
										Hide/show moves
									</span>
									<button
										type="button"
										role="switch"
										aria-checked={selfplay}
										aria-label="Hide or show moves"
										onclick={() => (selfplay = !selfplay)}
										class={cn(
											'relative h-4 w-7 rounded-full transition-colors',
											selfplay ? 'bg-[var(--color-brass-300)]' : 'bg-[var(--color-ink-700)]'
										)}
									>
										<span
											class={cn(
												'absolute top-0.5 size-3 rounded-full bg-[var(--color-parchment-50)] transition-all',
												selfplay ? 'left-[14px]' : 'left-0.5'
											)}
										></span>
									</button>
								</label>
							{/if}
						</div>
					</div>
					<div class="flex flex-wrap gap-x-1.5 gap-y-0 font-mono text-[13px] leading-7">
						{#each plies as p, i (i)}
							{@const prefix = moveNumberPrefix(i)}
							{@const hide = selfplay && i >= ply}
							{#if prefix && !hide}
								<span class="text-[var(--color-parchment-500)]">{prefix}</span>
							{/if}
							{#if !hide}
								<button
									type="button"
									onclick={() => goto(i + 1)}
									class={cn(
										'rounded px-0.5 transition-colors',
										i + 1 === ply
											? 'bg-[var(--color-brass-300)]/20 text-[var(--color-brass-200)]'
											: 'text-[var(--color-parchment-100)] hover:text-[var(--color-brass-300)]',
										p.annotation === 'match' &&
											'underline decoration-[var(--color-olive-400)] decoration-[1.5px] underline-offset-4',
										p.annotation === 'deviation' &&
											'underline decoration-[var(--color-oxblood-300)] decoration-wavy underline-offset-4'
									)}
								>
									{p.san}
								</button>
							{/if}
						{/each}
						{#if selfplay && ply < plies.length}
							<span class="text-[var(--color-parchment-500)] italic">
								· {plies.length - ply} hidden
							</span>
						{/if}
					</div>
				</div>
			</section>

			<!-- Right rail: prompt card (drill-style) + game info + controls -->
			<aside class="space-y-3 md:space-y-5">
				<!-- Drill-style prompt card. Priority: end-of-game →
					 your-move → wrong → refuted → current ply annotation.
					 Wrapped in autoHeight so swapping between branches
					 (which often have different intrinsic heights) animates
					 instead of snapping. -->
				<div use:autoHeight>
					{#if isAtEnd && gameResult}
						<div class="ot-fade">
							<div class="eyebrow mb-2">Game complete</div>
							<div class="flex items-baseline gap-3">
								<span
									class="font-mono text-3xl tabular-nums"
									class:text-[var(--color-parchment-50)]={gameResult.tone === 'white'}
									class:text-[var(--color-parchment-300)]={gameResult.tone === 'black'}
									class:text-[var(--color-parchment-400)]={gameResult.tone === 'draw' ||
										gameResult.tone === 'unknown'}
								>
									{gameResult.score}
								</span>
								<h2 class="font-serif text-[1.5rem] leading-tight text-[var(--color-parchment-50)]">
									{gameResult.headline}
								</h2>
							</div>
							<p class="mt-3 font-serif text-sm text-[var(--color-parchment-400)] italic">
								Stepped through {plies.length} plies. Use ← to revisit any move.
							</p>
						</div>
					{:else if selfplay && walkPhase === 'idle' && userToMove && ply < plies.length}
						<div class="ot-fade">
							<div class="eyebrow mb-2">
								Your move as {selectedRep?.color}
							</div>
							<h2 class="font-serif text-[2rem] leading-tight text-[var(--color-parchment-50)]">
								What do you play here?
							</h2>
							{#if hintLevel === 0}
								<p class="mt-3 font-serif text-sm text-[var(--color-parchment-400)] italic">
									Play on the board, or ask for a hint.
								</p>
							{:else if hintLevel === 1}
								<p class="mt-3 font-serif text-sm text-[var(--color-olive-300)] italic">
									Hint: the piece to move is highlighted.
								</p>
							{:else}
								<p class="mt-3 font-serif text-sm text-[var(--color-olive-300)] italic">
									The answer is drawn on the board. Play it to advance.
								</p>
							{/if}
							<div class="mt-3 flex gap-2">
								<Button variant="ghost" size="sm" onclick={showHint} disabled={hintLevel >= 2}>
									<Keyboard class="size-3" />
									<span>
										{hintLevel === 0
											? 'Show hint'
											: hintLevel === 1
												? 'Show answer'
												: 'Answer shown'}
									</span>
									<kbd
										class="ml-1 rounded bg-[var(--color-ink-800)] px-1 py-0.5 font-mono text-[10px]"
										>H</kbd
									>
								</Button>
							</div>
						</div>
					{:else if selfplay && walkPhase === 'wrong' && moveQuality}
						<div class="ot-fade">
							<div class="eyebrow mb-2" style:color={nagColor(moveQuality)}>
								{nagGlyph(moveQuality)}
								{moveQualityLabel(moveQuality)}
							</div>
							<h2 class="font-serif text-[2rem] leading-tight text-[var(--color-parchment-100)]">
								<em>{moveQualityHeadline(moveQuality)}</em>
							</h2>
							<p class="mt-3 font-serif text-sm text-[var(--color-parchment-400)] italic">
								Try again — play the game move.
							</p>
						</div>
					{:else if selfplay && walkPhase === 'refuted' && refutationSan}
						<div class="ot-fade">
							<div class="eyebrow mb-2 !text-[var(--color-oxblood-300)]">Refuted</div>
							<h2 class="font-serif text-[1.75rem] leading-tight text-[var(--color-parchment-100)]">
								Engine:
								<span class="font-mono text-[var(--color-oxblood-300)] not-italic"
									>{refutationSan}</span
								>
							</h2>
							<p class="mt-3 font-serif text-sm text-[var(--color-parchment-500)] italic">
								Resetting to let you try again.
							</p>
						</div>
					{:else if ply > 0}
						{@const current = plies[ply - 1]}
						<div class="ot-fade">
							<div class="flex items-baseline gap-2">
								<span class="eyebrow">Ply {ply}</span>
								<span class="font-mono text-xl">
									{moveNumberPrefix(ply - 1) ?? ''}
									{current.san}
								</span>
							</div>
							{#if current.annotation === 'match'}
								<p class="mt-2 font-serif text-sm text-[var(--color-olive-300)] italic">
									<Check class="mb-0.5 inline size-3.5" /> In your repertoire.
								</p>
							{:else if current.annotation === 'deviation'}
								<p class="mt-2 font-serif text-sm text-[var(--color-oxblood-300)] italic">
									<XIcon class="mb-0.5 inline size-3.5" /> Off-book.
									{#if !selfplay}
										Your line here:
										<span class="font-mono text-[var(--color-brass-300)] not-italic"
											>{current.expectedSan}</span
										>
									{/if}
								</p>
							{:else if current.annotation === 'past-tree'}
								<p class="mt-2 font-serif text-sm text-[var(--color-parchment-400)] italic">
									<Circle class="mb-0.5 inline size-3.5" /> Past your prep.
								</p>
							{:else}
								<p class="mt-2 font-serif text-sm text-[var(--color-parchment-500)] italic">
									Opponent's move.
								</p>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Game info + repertoire picker. -->
				<div class="ink-panel p-4">
					<div class="mb-2 flex items-center justify-between gap-2">
						<span class="eyebrow">Game</span>
						{#if lichessUrl}
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={lichessUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 font-mono text-[10px] tracking-wider text-[var(--color-parchment-400)] uppercase transition-colors hover:text-[var(--color-brass-300)]"
								title="Open in Lichess analysis"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<span>Lichess analysis</span>
								<ExternalLink class="size-3" />
							</a>
						{/if}
					</div>
					<p class="font-mono text-sm leading-5">
						{fmtHeader('White')} vs {fmtHeader('Black')}
					</p>
					<p class="mt-1 font-serif text-xs text-[var(--color-parchment-500)] italic">
						{fmtHeader('Event') || 'Loaded game'}
						{fmtHeader('Date') ? ` · ${fmtHeader('Date')}` : ''}
					</p>

					{#if reps.length > 0}
						<div class="relative z-20 mt-4">
							<Label>Compare with</Label>
							<Select
								value={selectedRepId ?? null}
								onchange={(v) => (selectedRepId = v as string | null)}
								placeholder="— none —"
								options={[
									{ value: null, label: '— none —' },
									...reps.map((r) => ({ value: r.id, label: `${r.name} (${r.color})` }))
								]}
							/>
						</div>
					{/if}

					<div class="mt-4 grid grid-cols-3 gap-1 text-center">
						<div>
							<div class="eyebrow !text-[var(--color-olive-300)]">Match</div>
							<div class="font-serif text-xl tabular-nums">{summary.match}</div>
						</div>
						<div>
							<div class="eyebrow !text-[var(--color-oxblood-300)]">Deviations</div>
							<div class="font-serif text-xl tabular-nums">{summary.dev}</div>
						</div>
						<div>
							<div class="eyebrow">Past prep</div>
							<div class="font-serif text-xl tabular-nums">{summary.past}</div>
						</div>
					</div>
				</div>

				<Button
					variant="ghost"
					size="sm"
					onclick={() => {
						plies = [];
						ply = 0;
						gameHeaders = null;
						pgnText = '';
						urlOrId = '';
						walkPhase = 'idle';
						overlayFen = null;
						overlayLastMove = undefined;
						moveQuality = null;
						gradedSquare = null;
						refutationSan = null;
					}}
				>
					Load another
				</Button>
			</aside>
		</div>
	{/if}
</div>
