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
	import { getEngine, type EngineInfo } from '$lib/stockfish/engine';
	import type { AppSettings, Color, Repertoire, RepertoireNode } from '$lib/types';

	// Move-quality glyphs, same vocabulary as the drill page. A shared helper
	// module would be nicer but a handful of small functions inline keeps the
	// walkthrough self-contained.
	type MoveQuality = 'correct' | 'playable' | 'dubious' | 'mistake' | 'blunder';
	function nagGlyph(q: MoveQuality): string {
		switch (q) {
			case 'correct':
				return '!';
			case 'playable':
				return '!?';
			case 'dubious':
				return '?!';
			case 'mistake':
				return '?';
			case 'blunder':
				return '??';
		}
	}
	function nagColor(q: MoveQuality): string {
		switch (q) {
			case 'correct':
				return '#639b24';
			case 'playable':
				return '#749bbf';
			case 'dubious':
				return '#e8b730';
			case 'mistake':
				return '#e58f2a';
			case 'blunder':
				return '#ac3332';
		}
	}
	function gradeFromCp(stmCp: number): MoveQuality {
		if (stmCp >= 200) return 'blunder';
		if (stmCp >= 100) return 'mistake';
		if (stmCp >= 50) return 'dubious';
		return 'playable';
	}

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
	// Match depth per browse-list game (in plies) — populated when browsing
	// by deepest user-repertoire coverage.
	let browseDepths = $state<Map<string, { depth: number; repertoire: string; color: Color }>>(
		new Map()
	);

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
	const REFUTATION_PROBE_MS = 800;
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

		const wrongFen = overlayFen!;
		refutationSan = null;

		await sleep(WRONG_FLASH_MS);
		if (token.cancelled) return;

		const refutation = await probeRefutation(wrongFen, REFUTATION_PROBE_MS);
		if (token.cancelled) return;

		moveQuality = refutation ? gradeFromCp(refutation.stmCp) : 'dubious';
		if (moveQuality === 'playable') playCorrect();
		else playIncorrect();
		const shouldRefute =
			refutation !== null && (moveQuality === 'mistake' || moveQuality === 'blunder');

		if (shouldRefute && refutation) {
			// Walk Stockfish's principal variation several plies deep — the
			// material loss from a real blunder often only becomes visible
			// after 2–3 exchanges, so we keep animating until the tactic
			// plays out.
			let showFen = wrongFen;
			const maxPlies = Math.min(REFUTATION_MAX_PLIES, refutation.pv.length);
			for (let i = 0; i < maxPlies; i++) {
				const pvUci = refutation.pv[i];
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

	async function probeRefutation(
		fen: string,
		timeoutMs: number
	): Promise<{ pv: string[]; stmCp: number } | null> {
		const engine = getEngine();
		if (!engine.isReady()) {
			// Try to kick it so future probes work.
			void engine.init().catch(() => undefined);
			return null;
		}
		const stm = colorToMove(fen);
		const sign = stm === 'black' ? -1 : 1;
		return await new Promise<{ pv: string[]; stmCp: number } | null>((resolve) => {
			let best: { pv: string[]; stmCp: number } | null = null;
			let settled = false;
			const unsub = engine.onInfo((info: EngineInfo) => {
				if (!info.pv.length) return;
				if (info.scoreMate !== undefined) {
					const mateCp = info.scoreMate > 0 ? 10000 : -10000;
					best = { pv: info.pv.slice(), stmCp: mateCp * sign };
				} else if (info.scoreCp !== undefined) {
					best = { pv: info.pv.slice(), stmCp: info.scoreCp * sign };
				}
			});
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				unsub();
				try {
					engine.stop();
				} catch {
					/* ignore */
				}
				resolve(best);
			}, timeoutMs);
			engine.go(fen, 16).catch(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsub();
				resolve(null);
			});
		});
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
		reps = await Promise.all(
			all.map(async (r: Repertoire) => ({
				id: r.id,
				name: r.name,
				color: r.color,
				rootFenKey: r.rootFenKey,
				nodes: await nodesMap(r.id)
			}))
		);
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
		const token = settings ? effectiveLichessToken(settings) : '';
		try {
			// If the user has repertoires, surface games that go deepest into
			// *their* prep; otherwise fall back to the generic startpos top
			// games.
			if (reps.length > 0) {
				const { recommendDeepGames } = await import('$lib/walkthrough/recommend');
				const allReps = await loadFullReps();
				const recs = await recommendDeepGames({
					reps: allReps,
					token: token || undefined,
					limit: 30,
					maxProbes: 50,
					minDepth: 5
				});
				browseGames = recs.map((r) => r.game);
				browseDepths = new Map(
					recs.map((r) => [
						r.game.id,
						{ depth: r.depth, repertoire: r.repertoireName, color: r.repertoireColor }
					])
				);
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
			if (browseGames.length === 0) {
				browseError = 'No masters games surfaced.';
			}
		} catch (e) {
			browseError = e instanceof Error ? e.message : 'Masters browse failed';
		} finally {
			browsing = false;
		}
	}

	/**
	 * Load full-FEN variants of the current reps so recommendDeepGames can
	 * play edges from the root. The page's `reps` array only carries fenKey;
	 * the rootFen lives on the full Repertoire record.
	 */
	async function loadFullReps() {
		const { listRepertoires } = await import('$lib/storage/repertoires');
		const full = await listRepertoires();
		return reps.map((r) => {
			const match = full.find((x) => x.id === r.id);
			return {
				id: r.id,
				name: r.name,
				color: r.color,
				rootFen: match?.rootFen ?? STARTPOS_FEN,
				rootFenKey: r.rootFenKey,
				nodes: r.nodes
			};
		});
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
			<div class="flex items-start gap-3">
				<div class="flex-1">
					<div class="eyebrow mb-1">Browse masters DB</div>
					<p class="font-serif text-xs text-[var(--color-parchment-500)] italic">
						Top games from the Lichess masters database at the starting position. Tournament games
						by titled players, historical and modern.
					</p>
				</div>
				<Button variant="secondary" size="sm" onclick={browseMasters} disabled={browsing}>
					<span>{browsing ? 'Loading…' : browseGames.length > 0 ? 'Refresh' : 'Browse'}</span>
				</Button>
			</div>

			{#if browseError}
				<p class="mt-3 text-xs text-[var(--color-oxblood-300)]">{browseError}</p>
			{/if}
			{#if browseGames.length > 0 && (browseYears.since !== undefined || browseYears.until !== undefined)}
				<p
					class="mt-3 font-mono text-[11px] tracking-widest text-[var(--color-parchment-500)] uppercase"
				>
					{browseGames.length} games · {browseYears.since}
					{browseYears.until && browseYears.until !== browseYears.since
						? `– ${browseYears.until}`
						: ''}
				</p>
			{/if}

			{#if browseGames.length > 0}
				<ul class="mt-3 space-y-1">
					{#each browseGames as g (g.id)}
						{@const meta = browseDepths.get(g.id)}
						<li>
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
				<!-- Drill-style prompt card. Priority: your-move → wrong →
					 refuted → current ply annotation. -->
				{#if selfplay && walkPhase === 'idle' && userToMove && ply < plies.length}
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
									{hintLevel === 0 ? 'Show hint' : hintLevel === 1 ? 'Show answer' : 'Answer shown'}
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
							{moveQuality}
						</div>
						<h2 class="font-serif text-[2rem] leading-tight text-[var(--color-parchment-100)]">
							<em>Not the move played.</em>
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
