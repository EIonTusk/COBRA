<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { onMount, untrack } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { page } from '$app/state';
	import { X, Keyboard, Pencil, RotateCcw, Trophy, Check } from 'lucide-svelte';
	import type { Key, MoveMetadata, Dests } from '@lichess-org/chessground/types';

	import Board from '$lib/chess/Board.svelte';
	import { getRepertoire } from '$lib/storage/repertoires';
	import {
		dueCards,
		getCard,
		listCards,
		mistakeCards,
		pickBalancedDueCards,
		resetAllFsrs,
		upsertCard
	} from '$lib/storage/cards';
	import { dueIdeaCards, upsertIdeaCard } from '$lib/storage/ideaCards';
	import { filterActiveMistakes, listMistakes, markMistakeByPosition } from '$lib/storage/mistakes';
	import { createFreshCard } from '$lib/fsrs/scheduler';
	import { getSettings } from '$lib/storage/settings';
	import { nodesMap } from '$lib/storage/nodes';
	import { getEngine, type EngineInfo } from '$lib/stockfish/engine';
	import { reviewCard, outcomeToRating, type DrillOutcome } from '$lib/fsrs/scheduler';
	import {
		edgeFromUci,
		edgeFromSan,
		fenAfterMove,
		legalDests,
		isPromotionMove
	} from '$lib/chess/position';
	import { colorToMove, fenKeyFromFen } from '$lib/chess/fen';
	import { pathToFenKey, furthestNonBranchingFenKey } from '$lib/tree/traversal';
	import { buildLineFirstQueue } from '$lib/tree/lineOrder';
	import { Button, confirmDialog } from '$lib/ui';
	import { playCorrect, playIncorrect } from '$lib/ui/sounds';
	import { DRILL_INTRO_MS } from '$lib/types';
	import type { Repertoire, Card, IdeaCard, AppSettings, Edge, RepertoireNode } from '$lib/types';

	type Phase =
		| 'loading'
		| 'empty'
		| 'intro'
		| 'pending'
		| 'correct'
		| 'wrong'
		| 'refuted'
		| 'idea-prompt'
		| 'idea-reveal'
		| 'done';

	let rep = $state<Repertoire | null>(null);
	let settings = $state<AppSettings | null>(null);
	let queue = $state<Card[]>([]);
	let idx = $state(0);
	let phase = $state<Phase>('loading');
	// Line label per card fenKey — built once when the queue loads and
	// consulted whenever we need to know "which line is this card in?".
	// Keyed on fenKey (not queue index) so the mapping survives mutations
	// like pruneDeeperInLine and the wrong-answer re-enqueue.
	let lineLabelByKey = new SvelteMap<string, string | null>();

	// Idea-card tail of the session. Plays after the move queue drains so
	// the user finishes with a few open-ended prompts while the theory is
	// still fresh. Self-rated — no move input.
	let ideaQueue = $state<IdeaCard[]>([]);
	let ideaIdx = $state(0);
	let currentIdea = $state<IdeaCard | null>(null);

	let currentFen = $state('');
	let userLastMove = $state<[Key, Key] | undefined>(undefined);
	let userPlayedSan = $state<string | null>(null);
	let correctEdge = $state<Edge | null>(null);
	// When the position has more than one recorded user move (e.g. both Bb5
	// and Bc4 are prepped), every child is an equally-valid answer. The hint
	// paints all of them so the drill can't accidentally bias recall toward
	// whichever SAN happens to be stored as expectedSan.
	let correctEdges = $state<Edge[]>([]);
	let sessionDone = $state(0);
	let nodes: Map<string, RepertoireNode> = new Map();

	// Chain-through-line state. When the user gets a card right, we play the
	// opponent's response from the tree and — if the position that follows is
	// itself a drill card — continue in the same line instead of rebuilding
	// the next queue card from the root.
	let chainedCard = $state<Card | null>(null);
	const drilledKeys = new SvelteSet<string>();
	// FenKeys of never-reviewed cards that have already had their
	// auto-hinted "introduction" pass this session. On their re-queued second
	// pass the hint is suppressed so the user actually drills the move
	// unaided at least once before FSRS schedules it days out.
	const introducedKeys = new SvelteSet<string>();
	// Plain variable (not $state): a one-shot "don't play the intro animation
	// for this card" signal that the chain handler sets before swapping
	// `chainedCard`. The subsequent $effect reads it to short-circuit.
	let skipNextIntro = false;

	// Per-card try state. Reset whenever a new card becomes current.
	//   hintLevel 0 → nothing shown
	//   hintLevel 1 → source square highlighted (a nudge)
	//   hintLevel 2 → full arrow from source to destination (the answer)
	// wrongAttempts counts misses; any > 0 costs an Again rating.
	let hintLevel = $state(0);
	let wrongAttempts = $state(0);

	// Refutation state: when the engine shows us why a wrong move lost.
	let refutationSan = $state<string | null>(null);
	let refutationCp = $state<number | null>(null);
	// Non-reactive cancellation handle for async wrong sequences.
	let wrongToken: { cancelled: boolean } = { cancelled: false };

	// Move-quality grading for NAG glyphs on the board.
	type MoveQuality = 'correct' | 'playable' | 'dubious' | 'mistake' | 'blunder';
	let moveQuality = $state<MoveQuality | null>(null);
	// The square we stamp the NAG glyph on. Tracked separately from
	// `userLastMove` because the latter gets repurposed for the refutation's
	// own highlight during the 'refuted' phase.
	let gradedSquare = $state<Key | null>(null);

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

	// Lichess palette for NAG badges. chessground renders a label-only shape
	// (no brush) as a small bordered circle pinned to the top-right corner
	// of the square — the exact design Lichess uses on its analysis board.
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

	function moveQualityLabel(q: MoveQuality): string {
		switch (q) {
			case 'correct':
				return 'Correct';
			case 'playable':
				return 'Playable — not your line';
			case 'dubious':
				return 'Dubious — not your line';
			case 'mistake':
				return 'A mistake';
			case 'blunder':
				return 'A blunder';
		}
	}

	const mode = $derived<'due' | 'mistakes' | 'retrain'>(
		page.url.searchParams.get('mode') === 'mistakes'
			? 'mistakes'
			: page.url.searchParams.get('mode') === 'retrain'
				? 'retrain'
				: 'due'
	);

	const currentCard = $derived<Card | undefined>(chainedCard ?? queue[idx]);
	const currentLineLabel = $derived<string | null>(
		currentCard ? (lineLabelByKey.get(currentCard.fenKey) ?? null) : null
	);
	const orientation = $derived<'white' | 'black'>(rep?.color ?? 'white');
	const sideToMove = $derived<'white' | 'black'>(currentFen ? colorToMove(currentFen) : 'white');
	const progress = $derived.by(() => {
		if (phase === 'idea-prompt' || phase === 'idea-reveal') {
			return ideaQueue.length > 0 ? (ideaIdx / ideaQueue.length) * 100 : 0;
		}
		return queue.length > 0 ? (idx / queue.length) * 100 : 0;
	});

	$effect(() => {
		// The only dependency we want is `currentCard`. Everything else —
		// reads of `currentFen`, state assignments, the startCard call —
		// goes through `untrack` so an in-card assignment to `currentFen`
		// (e.g. in handleMove) doesn't re-fire this effect and re-run the
		// intro, which would wipe the 'correct' state the user just earned.
		const card = currentCard;
		if (!card || !rep) return;
		const token = { cancelled: false };
		untrack(() => {
			// First-ever cards auto-reveal the full-hint arrow: there's nothing
			// to recall yet, so skip straight to the teaching cue the user
			// would otherwise have to click for. On the re-queued second pass
			// of an introduced card the hint is suppressed so the user drills
			// it unaided — see the introducedKeys logic in rateAndAdvance.
			hintLevel = card.lastReview || introducedKeys.has(card.fenKey) ? 0 : 2;
			wrongAttempts = 0;
			moveQuality = null;
			gradedSquare = null;
			if (skipNextIntro) {
				skipNextIntro = false;
				userPlayedSan = null;
				correctEdges = acceptedEdgesFor(card, currentFen);
				correctEdge = correctEdges[0] ?? null;
				phase = 'pending';
				return;
			}
			void startCard(card, token);
		});
		return () => {
			token.cancelled = true;
		};
	});

	// Board overlays:
	//   - Hints while pending (progressive green).
	//   - A NAG glyph (!, !?, ?!, ?, ??) on the square the user played to,
	//     coloured by grade. Lives through 'correct', 'wrong' and 'refuted'.
	//   - During 'refuted', an extra red arrow pointing out the engine's
	//     punishment move.
	const boardShapes = $derived.by<import('@lichess-org/chessground/draw').DrawShape[]>(() => {
		const shapes: import('@lichess-org/chessground/draw').DrawShape[] = [];

		if (moveQuality && gradedSquare) {
			// No `brush`: chessground pins the label to the top-right corner
			// of the square, Lichess-style, instead of centering it.
			shapes.push({
				orig: gradedSquare,
				label: { text: nagGlyph(moveQuality), fill: nagColor(moveQuality) }
			});
		}

		if (phase === 'refuted' && userLastMove) {
			shapes.push({
				orig: userLastMove[0],
				dest: userLastMove[1],
				brush: 'red'
			});
		}

		if (phase === 'pending' && hintLevel > 0) {
			const hints = correctEdges.length > 0 ? correctEdges : correctEdge ? [correctEdge] : [];
			const firstEver = !!currentCard && !currentCard.lastReview;
			const multiMove = hints.length > 1;
			// Multi-answer positions are a teaching moment on the first-ever
			// encounter: paint an arrow per accepted edge so the user sees
			// every recorded reply is acceptable. On a subsequent review we
			// withhold all arrows — the user has already been introduced to
			// the options and should pick one from memory.
			const showArrows = !multiMove || firstEver;
			if (showArrows) {
				for (const edge of hints) {
					const orig = edge.uci.slice(0, 2) as Key;
					const dest = edge.uci.slice(2, 4) as Key;
					if (hintLevel === 1) shapes.push({ orig, brush: 'paleGreen' });
					else shapes.push({ orig, dest, brush: 'green' });
				}
			}
		}

		return shapes;
	});

	async function startCard(card: Card, token: { cancelled: boolean }) {
		if (!rep) return;
		userPlayedSan = null;

		const targetFen = fenFromKey(card.fenKey);
		const stepMs = DRILL_INTRO_MS[settings?.drillIntroSpeed ?? 'normal'];

		if (stepMs === 0 || rep.rootFenKey === card.fenKey) {
			currentFen = targetFen;
			userLastMove = undefined;
			correctEdges = acceptedEdgesFor(card, currentFen);
			correctEdge = correctEdges[0] ?? null;
			phase = 'pending';
			return;
		}

		const pathFromRoot = pathToFenKey(nodes, rep.rootFenKey, card.fenKey);
		if (!pathFromRoot || pathFromRoot.length === 0) {
			currentFen = targetFen;
			userLastMove = undefined;
			correctEdges = acceptedEdgesFor(card, currentFen);
			correctEdge = correctEdges[0] ?? null;
			phase = 'pending';
			return;
		}

		// If the board is already on a position that lies on the path to the
		// target card (e.g. we just chained here and are now advancing to a
		// card a few plies deeper along the same line), only animate the tail
		// from here instead of rewinding all the way to the root.
		let startIdx = 0;
		const curKey = currentFen ? fenKeyFromFen(currentFen) : null;
		if (curKey && curKey !== rep.rootFenKey) {
			for (let i = 0; i < pathFromRoot.length; i++) {
				if (pathFromRoot[i].toFenKey === curKey) {
					startIdx = i + 1;
					break;
				}
			}
		}
		// Honour the "open at starting position" preference: when the
		// board isn't already on the path (startIdx === 0), fast-forward
		// past any forced prefix up to the rep's starting fenKey so the
		// animation only covers the meaningful part of the line. Drills
		// for cards *before* the starting position keep the full intro
		// — the user explicitly drills them, so dropping animation would
		// feel abrupt.
		let skippedFen: string | null = null;
		let skippedLastMove: [Key, Key] | undefined;
		if (startIdx === 0 && settings?.openAtStartingPosition !== false) {
			const startKey = rep.startingFenKey ?? furthestNonBranchingFenKey(nodes, rep.rootFenKey);
			if (startKey && startKey !== rep.rootFenKey && startKey !== card.fenKey) {
				let walkFen = rep.rootFen;
				for (let i = 0; i < pathFromRoot.length; i++) {
					const edge = pathFromRoot[i];
					walkFen = fenAfterMove(walkFen, edge);
					if (edge.toFenKey === startKey) {
						startIdx = i + 1;
						skippedFen = walkFen;
						skippedLastMove = [edge.uci.slice(0, 2) as Key, edge.uci.slice(2, 4) as Key];
						break;
					}
				}
			}
		}

		phase = 'intro';
		let fen: string;
		if (skippedFen) {
			fen = skippedFen;
			currentFen = fen;
			userLastMove = skippedLastMove;
		} else if (startIdx === 0) {
			fen = rep.rootFen;
			currentFen = fen;
			userLastMove = undefined;
		} else {
			fen = currentFen;
		}

		for (let i = startIdx; i < pathFromRoot.length; i++) {
			const edge = pathFromRoot[i];
			await sleep(stepMs);
			if (token.cancelled) return;
			fen = fenAfterMove(fen, edge);
			currentFen = fen;
			userLastMove = [edge.uci.slice(0, 2) as Key, edge.uci.slice(2, 4) as Key];
		}

		if (token.cancelled) return;
		correctEdges = acceptedEdgesFor(card, currentFen);
		correctEdge = correctEdges[0] ?? null;
		phase = 'pending';
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	const dests = $derived.by<Dests>(() => {
		if (!currentFen || phase !== 'pending') return new Map();
		try {
			const raw = legalDests(currentFen);
			return new Map(Array.from(raw, ([k, v]) => [k as Key, v as Key[]]));
		} catch {
			return new Map();
		}
	});

	onMount(async () => {
		const id = page.params.id;
		if (!id) {
			phase = 'empty';
			return;
		}
		rep = (await getRepertoire(id)) ?? null;
		if (!rep) {
			phase = 'empty';
			return;
		}
		settings = await getSettings();
		nodes = await nodesMap(rep.id);
		queue = sortByLineOrder(await loadQueue());
		// Idea cards only join the "due" mode session — retrain/mistakes are
		// tightly scoped to move-card deviations and a prompt would dilute
		// the point of those sessions.
		if (mode === 'due') {
			ideaQueue = await dueIdeaCards(rep.id, Date.now(), settings.drillSessionCap);
		}
		if (queue.length === 0 && ideaQueue.length > 0) {
			startIdeaPhase();
		} else {
			phase = queue.length === 0 ? 'empty' : 'pending';
		}
		// Kick Stockfish in the background so the first blunder check has a
		// ready engine. Silent fallback if COOP/COEP aren't satisfied or the
		// WASM blobs aren't installed — blunder refutations just won't show.
		void getEngine()
			.init()
			.catch(() => undefined);
	});

	function fenFromKey(key: string): string {
		const parts = key.split(' ');
		return parts.length === 4 ? `${key} 0 1` : key;
	}

	/**
	 * All recorded user-side replies at the card's position, resolved to
	 * Edge objects valid at `fen`. When the tree has no node for this fenKey
	 * (orphaned card), fall back to the card's stored `expectedSan` so the
	 * hint still draws something. Returns an empty list only when even the
	 * fallback can't be parsed.
	 */
	function acceptedEdgesFor(card: Card, fen: string): Edge[] {
		const node = nodes.get(card.fenKey);
		const childSans = node?.children.map((e) => e.san) ?? [];
		const sans = childSans.length > 0 ? childSans : [card.expectedSan];
		const out: Edge[] = [];
		for (const san of sans) {
			const edge = edgeFromSan(fen, san);
			if (edge) out.push(edge);
		}
		return out;
	}

	function handleMove(orig: Key, dest: Key, _m: MoveMetadata) {
		if (!currentCard || phase !== 'pending') return;
		const promo = isPromotionMove(currentFen, orig, dest) ? 'q' : undefined;
		const edge = edgeFromUci(currentFen, orig, dest, promo);
		if (!edge) return;
		// Sync our fen to the played position. chessground has already moved
		// the piece internally on drop; without this update Svelte's effect
		// won't fire when we revert to the card FEN later, and the piece
		// silently snaps instead of animating back.
		currentFen = fenAfterMove(currentFen, edge);
		userLastMove = [orig, dest];
		userPlayedSan = edge.san;
		gradedSquare = dest;
		// Multi-answer: any child edge recorded in the tree at this position
		// counts as correct, not just the card's primary expectedSan. Lets
		// users maintain several equally-good replies per position.
		const nodeHere = nodes.get(currentCard.fenKey);
		const accepted = new Set<string>(
			nodeHere?.children.map((e) => e.san) ?? [currentCard.expectedSan]
		);
		if (accepted.has(edge.san)) {
			moveQuality = 'correct';
			phase = 'correct';
			playCorrect();
		} else {
			wrongAttempts += 1;
			moveQuality = null;
			phase = 'wrong';
			void runWrongSequence(currentCard);
		}
	}

	// Pause lengths for the 'correct' phase. A clean first-try answer barely
	// pauses — the user knew it. Answers that needed retries or hints linger
	// so the user can absorb the right line before the next card loads.
	const AUTO_ADVANCE_QUICK_MS = 120;
	const AUTO_ADVANCE_SLOW_MS = 1400;

	const firstTryClean = $derived(wrongAttempts === 0 && hintLevel === 0);
	const isFirstEverCard = $derived(
		!!currentCard && !currentCard.lastReview && !introducedKeys.has(currentCard.fenKey)
	);
	// Multi-move review cards withhold hints: drawing arrows for every
	// accepted reply would either overwhelm the board or leak the full
	// "recipe" for positions where the user is supposed to pick one from
	// memory. First-ever encounters still get the teaching arrows — the
	// rest of the session keeps them hidden.
	const hintSuppressed = $derived(correctEdges.length > 1 && !isFirstEverCard);
	const currentAutoAdvanceMs = $derived(
		// Mistake-focused sessions always use the slow pause so the "corrected"
		// feedback actually registers before the next card loads.
		mode === 'mistakes' || mode === 'retrain'
			? AUTO_ADVANCE_SLOW_MS
			: firstTryClean
				? AUTO_ADVANCE_QUICK_MS
				: AUTO_ADVANCE_SLOW_MS
	);

	// Wrong-move timing: red flash while the piece is on the wrong square,
	// then fen reverts so chessground animates the piece back, then phase
	// resets to pending so the user can try again.
	const WRONG_FLASH_MS = 420;
	const WRONG_SETTLE_MS = 380;
	// Blunder-refutation timing: how long to wait for the engine, and how
	// long to leave the refutation on the board before reverting.
	const REFUTATION_PROBE_MS = 800;
	const REFUTATION_HOLD_MS = 1100;
	// Animate the first few plies of Stockfish's principal variation so the
	// material loss plays out, not just the immediate capture. Most tactics
	// need 3–4 plies to resolve.
	const REFUTATION_MAX_PLIES = 6;
	const REFUTATION_PACE_MS = 700;
	// Engine score magnitude (cp, side-to-move perspective) that promotes a
	// wrong move from "just off" to "blunder worth showing".
	const _BLUNDER_THRESHOLD_CP = 100;

	// On a correct move, auto-advance after a brief pause so the user can see
	// the landing square flash green. Pressing 4 during the window upgrades
	// the rating to Easy.
	$effect(() => {
		if (phase !== 'correct') return;
		const delay = currentAutoAdvanceMs;
		const timer = setTimeout(() => {
			void rateAndAdvance(deriveOutcome());
		}, delay);
		return () => clearTimeout(timer);
	});

	// On a wrong move: flash briefly, ask the engine to grade the move, then
	// either (for mistakes / blunders) animate the engine's refutation before
	// reverting, or (for milder slips) just wait briefly and revert. The NAG
	// glyph corresponding to the grade sits on the played square the whole
	// time.
	async function runWrongSequence(card: Card) {
		wrongToken.cancelled = true;
		const token = { cancelled: false };
		wrongToken = token;

		const wrongFen = currentFen;
		refutationSan = null;
		refutationCp = null;

		await sleep(WRONG_FLASH_MS);
		if (token.cancelled) return;

		const refutation = await probeRefutation(wrongFen, REFUTATION_PROBE_MS);
		if (token.cancelled) return;

		// Grade the move. If the engine is cold we fall back to 'dubious' so
		// the user still gets a glyph; blunder-refutation needs the engine.
		moveQuality = refutation ? gradeFromCp(refutation.stmCp) : 'dubious';
		// Playable = off-prep but still a fine move → positive cue. Otherwise
		// (dubious / mistake / blunder) the error cue.
		if (moveQuality === 'playable') playCorrect();
		else playIncorrect();

		const shouldRefute =
			refutation !== null && (moveQuality === 'mistake' || moveQuality === 'blunder');

		if (shouldRefute && refutation) {
			// Walk Stockfish's principal variation through the tactic. Showing
			// only the immediate reply often hides the actual material loss
			// (which resolves 2–3 plies later); animating several plies makes
			// the why of the blunder legible.
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
				currentFen = nextFen;
				userLastMove = [orig, dest];
				if (i === 0) {
					refutationSan = pvEdge.san;
					refutationCp = refutation.stmCp;
					phase = 'refuted';
				}
				showFen = nextFen;
			}
			await sleep(REFUTATION_HOLD_MS);
			if (token.cancelled) return;
		} else {
			// Keep the glyph on the board for a moment before reverting, so
			// the user can actually register the grade.
			await sleep(400);
			if (token.cancelled) return;
		}

		currentFen = fenFromKey(card.fenKey);
		gradedSquare = null;
		userLastMove = undefined;
		await sleep(WRONG_SETTLE_MS);
		if (token.cancelled) return;

		userPlayedSan = null;
		refutationSan = null;
		refutationCp = null;
		moveQuality = null;
		phase = 'pending';
	}

	/**
	 * Ask Stockfish for the best move at `fen` within `timeoutMs`. Returns
	 * `null` if the engine isn't initialized yet (we don't block the drill
	 * waiting for Stockfish's ~20 MB NNUE to load). `stmCp` is centipawns
	 * from the perspective of the side to move — a positive number means
	 * the replier (usually the opponent, post-blunder) is doing well.
	 */
	async function probeRefutation(
		fen: string,
		timeoutMs: number
	): Promise<{ pv: string[]; stmCp: number } | null> {
		const engine = getEngine();
		if (!engine.isReady()) return null;
		const stm = colorToMove(fen);
		// Engine's scoreCp in EngineInfo is white-relative (my wrapper flips
		// the raw side-to-move value); rebuild the stm-relative number so
		// the threshold check doesn't have to know colors.
		const sign = stm === 'black' ? -1 : 1;
		return await new Promise<{ pv: string[]; stmCp: number } | null>((resolve) => {
			let best: { pv: string[]; stmCp: number } | null = null;
			let settled = false;
			const unsub = engine.onInfo((info: EngineInfo) => {
				if (!info.pv.length) return;
				if (info.scoreMate !== undefined) {
					// Mate in N for the side to move = very big advantage.
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

	function showHint() {
		if (phase !== 'pending') return;
		// Multi-move review cards deliberately withhold arrows — bumping
		// hintLevel here would just saddle the user with a 'peeked' grade
		// for a click that drew nothing.
		if (hintSuppressed) return;
		// Brand-new cards (never reviewed) skip the piece-highlight step and
		// jump straight to the full answer arrow — there's nothing to "nudge"
		// recall of yet.
		if (hintLevel === 0 && currentCard && !currentCard.lastReview) {
			hintLevel = 2;
			return;
		}
		hintLevel = Math.min(hintLevel + 1, 2);
	}

	// Map the final state of the card to an FSRS outcome.
	//   any wrong attempt OR any hint used  → 'wrong'   (Again)
	//   first-try clean, unaided            → 'correct' (Good)
	// 'easy' can still be triggered explicitly from the keyboard.
	// A peek is a failed recall: the user didn't produce the move on their
	// own, so FSRS schedules it back to short-term just like an outright
	// miss. The re-queue + prune flow in rateAndAdvance follows the 'wrong'
	// path, with intro-pass de-duplication handled there.
	function deriveOutcome(): DrillOutcome {
		if (wrongAttempts > 0 || hintLevel > 0) return 'wrong';
		return 'correct';
	}

	async function rateAndAdvance(outcome: DrillOutcome) {
		if (!rep || !settings || !currentCard) return;
		const ratedCard = currentCard;
		// "Introduction pass": the first time we ever show a never-reviewed
		// card this session it opens with the hint arrow drawn. The pass is
		// still a viewing rather than a recall — we re-queue the card once
		// so the user drills it unaided before the session ends. The flow
		// triggers regardless of outcome (even 'wrong', which is what a peek
		// now produces) because the point is to guarantee the second pass.
		// Prune and the generic wrong-re-queue are suppressed on intro pass
		// so we don't double-queue or strip deeper cards the user never
		// actually flunked.
		const isIntroductionPass =
			!ratedCard.lastReview && !introducedKeys.has(ratedCard.fenKey) && mode === 'due';
		const updated = reviewCard(ratedCard, outcomeToRating(outcome), settings.fsrsParams);
		await upsertCard(updated);
		sessionDone += 1;
		// Mark this position as drilled only on a clean pass — a wrong
		// answer gets re-queued at the tail and must remain visible to
		// advanceQueue, which uses drilledKeys to skip already-finished
		// cards. Introduction passes also stay visible: the re-queued card
		// needs to come around a second time for the drill-without-hint.
		if (outcome !== 'wrong' && !isIntroductionPass) drilledKeys.add(ratedCard.fenKey);
		if (isIntroductionPass) {
			introducedKeys.add(ratedCard.fenKey);
			queue = [...queue, ratedCard];
		}
		// Mark stored Lichess-game mistakes at this position as corrected
		// when we're in retrain mode and the user answered correctly.
		if (mode === 'retrain' && (outcome === 'correct' || outcome === 'easy') && rep) {
			await markMistakeByPosition(rep.id, ratedCard.fenKey);
		}

		// On a wrong answer, drop any remaining queue cards that sit deeper
		// in the same line as the card the user just failed. Otherwise the
		// next queue pick might animate its intro right through the failed
		// position, showing the "correct" move before the user has actually
		// internalised it. Those deeper cards come back in future sessions
		// via normal FSRS scheduling. Retrain mode is mistake-specific and
		// doesn't use tree ordering, so we skip the prune there. Intro-pass
		// peeks aren't real misses (the user viewed the shown move), so we
		// don't prune behind them either.
		if (outcome === 'wrong' && !isIntroductionPass && mode !== 'retrain') {
			pruneDeeperInLine(ratedCard.fenKey);
		}
		// Always re-queue a failed card at the tail so the user gets a second
		// pass at it before the session ends. FSRS still schedules it for a
		// later day; this is an in-session repeat on top of that. Intro pass
		// already queued this card above — skip the generic re-queue so we
		// don't add the same card twice.
		if (outcome === 'wrong' && !isIntroductionPass) {
			queue = [...queue, ratedCard];
		}

		// On a successful answer, try to continue the line: play the opponent's
		// reply from the tree and, if the resulting position is also a drill
		// card, continue there without rebuilding from the root.
		if (outcome === 'correct' || outcome === 'easy' || outcome === 'peeked') {
			const next = await findNextInLine(ratedCard);
			if (next) {
				await playChainTransition(ratedCard, next);
				return;
			}
		}

		advanceQueue();
	}

	/**
	 * Remove queue entries (beyond the current idx) whose path from the
	 * repertoire root passes through `failedFenKey`. Those are strictly
	 * deeper in the same branch the user just flunked, and letting them
	 * advance would replay the failed position's "correct" move as part
	 * of the intro animation — bypassing the recall practice that's the
	 * whole point of the drill.
	 */
	function pruneDeeperInLine(failedFenKey: string) {
		if (!rep) return;
		const filtered: Card[] = [];
		for (let i = 0; i < queue.length; i++) {
			if (i <= idx) {
				filtered.push(queue[i]);
				continue;
			}
			const other = queue[i];
			const path = pathToFenKey(nodes, rep.rootFenKey, other.fenKey);
			if (!path) {
				filtered.push(other);
				continue;
			}
			const passesThroughFailure = path.some((e) => e.toFenKey === failedFenKey);
			if (!passesThroughFailure) filtered.push(other);
		}
		queue = filtered;
	}

	/**
	 * Which SAN was actually played for this card? Falls back to the card's
	 * primary expectedSan for the peeked / hint-only flow where the user
	 * never made a move.
	 */
	function effectivePlayedSan(card: Card): string {
		const node = nodes.get(card.fenKey);
		const played = userPlayedSan;
		if (played && node && node.children.some((c) => c.san === played)) {
			return played;
		}
		return card.expectedSan;
	}

	async function findNextInLine(ratedCard: Card): Promise<Card | null> {
		if (!rep) return null;
		// In mistake-focused modes, don't chain. Each queue entry is an explicit
		// deviation the user is here to address — chaining into a nearby card
		// makes it look like the mistake wasn't recorded ("same thing again")
		// when really we just jumped to the next position in the tree.
		if (mode === 'mistakes' || mode === 'retrain') return null;
		const cardFen = fenFromKey(ratedCard.fenKey);
		const playedSan = effectivePlayedSan(ratedCard);
		const userEdge = edgeFromSan(cardFen, playedSan);
		if (!userEdge) return null;
		const postUserFen = fenAfterMove(cardFen, userEdge);
		const postUserKey = fenKeyFromFen(postUserFen);
		const nodeAfterUser = nodes.get(postUserKey);
		if (!nodeAfterUser || nodeAfterUser.children.length === 0) return null;
		// First recorded opponent reply. Weighted/random could come later.
		const oppEdge = nodeAfterUser.children[0];
		if (drilledKeys.has(oppEdge.toFenKey)) return null;
		const nextCard = await getCard(rep.id, oppEdge.toFenKey);
		if (!nextCard) return null;
		return nextCard;
	}

	async function playChainTransition(ratedCard: Card, nextCard: Card) {
		if (!rep || !settings) return;
		const cardFen = fenFromKey(ratedCard.fenKey);
		const playedSan = effectivePlayedSan(ratedCard);
		const userEdge = edgeFromSan(cardFen, playedSan);
		if (!userEdge) {
			advanceQueue();
			return;
		}
		const postUserFen = fenAfterMove(cardFen, userEdge);
		const postUserKey = fenKeyFromFen(postUserFen);
		const nodeAfterUser = nodes.get(postUserKey);
		const oppEdge = nodeAfterUser?.children[0];
		if (!oppEdge) {
			advanceQueue();
			return;
		}
		const postOppFen = fenAfterMove(postUserFen, oppEdge);

		const stepMs = DRILL_INTRO_MS[settings.drillIntroSpeed];
		const pace = stepMs > 0 ? stepMs : 250;

		// Peeked flow: user never played the move, so lay it down first.
		if (fenKeyFromFen(currentFen) !== postUserKey) {
			await sleep(Math.round(pace * 0.6));
			currentFen = postUserFen;
			userLastMove = [userEdge.uci.slice(0, 2) as Key, userEdge.uci.slice(2, 4) as Key];
		}

		// Opponent's reply.
		await sleep(pace);
		currentFen = postOppFen;
		userLastMove = [oppEdge.uci.slice(0, 2) as Key, oppEdge.uci.slice(2, 4) as Key];

		// Hand off to the next card without replaying the intro.
		skipNextIntro = true;
		chainedCard = nextCard;
	}

	const DONE_HOLD_MS = 600;

	let retrainBusy = $state(false);

	async function trainFurther() {
		if (!rep) return;
		await reloadSession();
	}

	async function retrain() {
		if (!rep || retrainBusy) return;
		const ok = await confirmDialog({
			title: 'Retrain from scratch',
			message:
				'Reset spaced-repetition state for every card in this repertoire. Positions stay; the schedule restarts from zero and everything becomes due immediately.',
			confirmLabel: 'Reset schedule',
			variant: 'destructive'
		});
		if (!ok) return;
		retrainBusy = true;
		try {
			await resetAllFsrs(rep.id);
			await reloadSession();
		} finally {
			retrainBusy = false;
		}
	}

	async function reloadSession() {
		if (!rep || !settings) return;
		drilledKeys.clear();
		introducedKeys.clear();
		chainedCard = null;
		userLastMove = undefined;
		userPlayedSan = null;
		moveQuality = null;
		gradedSquare = null;
		hintLevel = 0;
		wrongAttempts = 0;
		sessionDone = 0;
		queue = sortByLineOrder(await loadQueue());
		idx = 0;
		ideaQueue =
			mode === 'due' ? await dueIdeaCards(rep.id, Date.now(), settings.drillSessionCap) : [];
		ideaIdx = 0;
		currentIdea = null;
		if (queue.length === 0 && ideaQueue.length > 0) {
			startIdeaPhase();
		} else {
			phase = queue.length === 0 ? 'empty' : 'pending';
		}
	}

	const OVERDUE_CAP_MS = 24 * 60 * 60 * 1000;

	/**
	 * Reorder a drill queue line-first and record each card's line label so
	 * the UI can announce which opening the user is drilling.
	 *
	 * Line-first means: cards sharing the same first branching choice (at or
	 * below the repertoire's starting position) are drilled contiguously, in
	 * plies-from-root order. You walk the Ruy end-to-end before moving to
	 * the Italian — matching how a player thinks about "drilling a line".
	 *
	 * The overdue cap pulls whole line blocks forward when any card in them
	 * is more than a day late, so a user who ends a session early never
	 * defers a badly-overdue card behind fresher ones. Mistake and retrain
	 * modes skip the cap — their `dueAt` isn't FSRS-meaningful.
	 */
	function sortByLineOrder(cards: Card[]): Card[] {
		lineLabelByKey.clear();
		if (!rep) return cards;
		const applyOverdueCap = mode === 'due';
		const ordered = buildLineFirstQueue(cards, nodes, {
			rootFenKey: rep.rootFenKey,
			startingFenKey: rep.startingFenKey ?? null,
			overdueCapMs: applyOverdueCap ? OVERDUE_CAP_MS : undefined
		});
		for (let i = 0; i < ordered.cards.length; i++) {
			lineLabelByKey.set(ordered.cards[i].fenKey, ordered.lineLabels[i]);
		}
		return ordered.cards;
	}

	async function loadQueue(): Promise<Card[]> {
		if (!rep || !settings) return [];
		if (mode === 'mistakes') {
			return mistakeCards(rep.id, settings.drillSessionCap);
		}
		if (mode === 'retrain') {
			// Build a queue from pending Lichess-game mistakes in this repertoire.
			const pending = await filterActiveMistakes(
				await listMistakes({
					status: 'pending',
					repertoireId: rep.id,
					limit: settings.drillSessionCap
				})
			);
			const queue: Card[] = [];
			for (const m of pending) {
				const existing = await getCard(rep.id, m.fenKey);
				queue.push(existing ?? createFreshCard(rep.id, m.fenKey, m.expectedSan, Date.now()));
			}
			return queue;
		}
		// Fetch a generous pool so the balancer has room to put review cards
		// ahead of new ones. The sessionCap alone isn't enough: on a fresh
		// import, `dueCards` orders by dueAt asc and the first N could be
		// all-new, leaving no reviews to promote.
		const pool = await dueCards(rep.id, Date.now(), settings.drillSessionCap * 5);
		return pickBalancedDueCards(pool, settings.drillSessionCap, settings.dailyNewCardCap);
	}

	/**
	 * "Leaf" cards in the tree: user-turn cards whose expected move leads
	 * (via the opponent's first reply) to a position with no further card
	 * — i.e. the deepest rung of each line. A repertoire is never really
	 * "done"; once the due queue drains in `due` mode we cycle the leaves
	 * back in so the user keeps practicing the end of every line. Any
	 * intermediate card that fails along the way still gets re-queued
	 * through the normal wrong-answer path.
	 */
	async function collectLeafCards(): Promise<Card[]> {
		if (!rep) return [];
		const all = await listCards(rep.id);
		const byKey = new Map(all.map((c) => [c.fenKey, c]));
		const leaves: Card[] = [];
		for (const card of all) {
			const node = nodes.get(card.fenKey);
			if (!node || node.children.length === 0) {
				leaves.push(card);
				continue;
			}
			let hasDeeperCard = false;
			outer: for (const userEdge of node.children) {
				const oppNode = nodes.get(userEdge.toFenKey);
				if (!oppNode) continue;
				for (const oppEdge of oppNode.children) {
					if (byKey.has(oppEdge.toFenKey)) {
						hasDeeperCard = true;
						break outer;
					}
				}
			}
			if (!hasDeeperCard) leaves.push(card);
		}
		return leaves;
	}

	/**
	 * Re-queue the leaves at the tail so the session keeps going. Also
	 * clears `drilledKeys` scoped to what we're about to enqueue: a leaf
	 * that was already completed earlier in the session must be drillable
	 * again on this lap, otherwise `advanceQueue` would immediately skip
	 * past it.
	 */
	async function extendQueueWithLeaves(): Promise<number> {
		if (!rep || mode !== 'due') return 0;
		const leaves = await collectLeafCards();
		if (leaves.length === 0) return 0;
		const sorted = sortByLineOrder(leaves);
		for (const c of sorted) drilledKeys.delete(c.fenKey);
		queue = [...queue, ...sorted];
		return sorted.length;
	}

	function advanceQueue() {
		let next = idx + 1;
		while (next < queue.length && drilledKeys.has(queue[next].fenKey)) {
			next++;
		}
		if (next >= queue.length) {
			// Move queue is done. If idea cards are queued, flip into the
			// self-rated prompt phase. Otherwise (in due mode) cycle leaves
			// back in so the drill never declares the rep "fully learned"
			// — the user can keep practicing forever. Hold briefly so the
			// final green glyph registers before anything else moves.
			setTimeout(async () => {
				if (ideaQueue.length > 0) {
					startIdeaPhase();
					return;
				}
				const added = await extendQueueWithLeaves();
				if (added > 0) {
					chainedCard = null;
					idx = next;
					phase = 'pending';
					return;
				}
				phase = 'done';
			}, DONE_HOLD_MS);
		} else {
			chainedCard = null;
			idx = next;
		}
	}

	/**
	 * Show the board at the first due idea card's position and wait for the
	 * user to reveal the answer. The move-card state (currentCard, queue,
	 * refutation, etc.) is left where it was — idea mode doesn't accept
	 * move input and doesn't chain, so there's nothing to clear.
	 */
	function startIdeaPhase() {
		if (ideaQueue.length === 0) {
			phase = 'done';
			return;
		}
		ideaIdx = 0;
		currentIdea = ideaQueue[0];
		currentFen = fenFromKey(currentIdea.fenKey);
		userLastMove = undefined;
		correctEdge = null;
		correctEdges = [];
		moveQuality = null;
		gradedSquare = null;
		phase = 'idea-prompt';
	}

	function revealIdea() {
		if (phase === 'idea-prompt') phase = 'idea-reveal';
	}

	async function rateIdea(outcome: DrillOutcome) {
		if (!settings || !currentIdea) return;
		const nextCard = reviewCard(currentIdea, outcomeToRating(outcome), settings.fsrsParams);
		await upsertIdeaCard(nextCard);
		sessionDone += 1;
		const nextIdx = ideaIdx + 1;
		if (nextIdx >= ideaQueue.length) {
			currentIdea = null;
			phase = 'done';
			return;
		}
		ideaIdx = nextIdx;
		currentIdea = ideaQueue[nextIdx];
		currentFen = fenFromKey(currentIdea.fenKey);
		phase = 'idea-prompt';
	}

	function handleKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

		if (phase === 'pending') {
			if (e.key === 'z' || e.key === 'Z' || e.key === '?' || e.key === 'h' || e.key === 'H') {
				e.preventDefault();
				showHint();
			}
		} else if (phase === 'correct') {
			// Correct auto-advances; only the Easy shortcut matters here.
			if (e.key === '4') {
				e.preventDefault();
				void rateAndAdvance('easy');
			}
		} else if (phase === 'idea-prompt') {
			if (e.key === ' ' || e.key === 'Enter') {
				e.preventDefault();
				revealIdea();
			}
		} else if (phase === 'idea-reveal') {
			if (e.key === '1') {
				e.preventDefault();
				void rateIdea('wrong');
			} else if (e.key === '2') {
				e.preventDefault();
				void rateIdea('peeked');
			} else if (e.key === '3') {
				e.preventDefault();
				void rateIdea('correct');
			} else if (e.key === '4') {
				e.preventDefault();
				void rateIdea('easy');
			}
		}
	}
</script>

<svelte:window on:keydown={handleKey} />

<div class="mx-auto max-w-[1000px] px-4 py-4 md:px-6">
	<div class="mb-5 flex items-center gap-3">
		<span class="eyebrow text-[var(--color-parchment-300)]">Drill</span>
		{#if rep}
			<span class="text-[var(--color-ink-600)]">·</span>
			<a
				href={resolve(`/repertoire/${rep.id}`)}
				class="eyebrow max-w-[280px] truncate transition-colors hover:text-[var(--color-parchment-100)]"
			>
				{rep.name}
			</a>
		{/if}
		{#if phase === 'intro' || phase === 'pending' || phase === 'correct' || phase === 'wrong' || phase === 'refuted'}
			<span class="eyebrow ml-auto tabular-nums">
				{idx + 1} <span class="text-[var(--color-ink-600)]">/</span>
				{queue.length}
			</span>
		{:else if phase === 'idea-prompt' || phase === 'idea-reveal'}
			<span class="eyebrow ml-auto tabular-nums">
				{ideaIdx + 1} <span class="text-[var(--color-ink-600)]">/</span>
				{ideaQueue.length}
				<span class="ml-1 text-[var(--color-brass-300)]">ideas</span>
			</span>
		{/if}
		<!-- eslint-disable svelte/no-navigation-without-resolve -->
		<a
			href={rep ? `/repertoire/${rep.id}` : '/'}
			class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
			class:ml-auto={!(
				phase === 'intro' ||
				phase === 'pending' ||
				phase === 'correct' ||
				phase === 'wrong' ||
				phase === 'refuted'
			)}
			aria-label="Close drill"
		>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
			<X class="size-4" />
		</a>
	</div>

	<!-- Progress bar -->
	{#if phase === 'intro' || phase === 'pending' || phase === 'correct' || phase === 'wrong' || phase === 'refuted' || phase === 'idea-prompt' || phase === 'idea-reveal'}
		<div class="relative mb-8 h-px overflow-hidden bg-[var(--color-ink-800)]">
			<div
				class="absolute inset-y-0 left-0 bg-[var(--color-brass-300)] transition-[width] duration-500"
				style:width="{progress}%"
			></div>
		</div>
	{/if}

	{#if phase === 'loading'}
		<p class="text-sm text-[var(--color-parchment-400)]">Loading due cards…</p>
	{:else if phase === 'empty'}
		<div class="ink-panel mt-8 flex flex-col items-center gap-3 px-8 py-16 text-center">
			<div class="ornament font-serif text-4xl">⁂</div>
			<h2 class="font-serif text-3xl">All caught up.</h2>
			<p class="max-w-sm font-serif text-sm text-[var(--color-parchment-400)] italic">
				No cards are due right now. Add more lines to your tree, or come back later.
			</p>
			{#if rep}
				<div class="mt-2 flex gap-2">
					<Button href={`${base}/repertoire/${rep.id}/edit`} variant="primary" size="sm"
						>Edit tree</Button
					>
					<Button href={`${base}/repertoire/${rep.id}`} variant="outline" size="sm">Back</Button>
				</div>
			{/if}
		</div>
	{:else if phase === 'done'}
		<div class="ink-panel mt-8 flex flex-col items-center gap-4 px-8 py-16 text-center">
			<Trophy class="size-10 text-[var(--color-brass-300)]" strokeWidth={1.5} />
			<h2 class="font-serif text-4xl">A good session.</h2>
			<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
				You drilled
				<span class="font-sans font-semibold text-[var(--color-parchment-100)] tabular-nums"
					>{sessionDone}</span
				> cards.
			</p>
			<p class="mt-2 font-serif text-sm text-[var(--color-parchment-400)] italic">
				Continue studying, or head back to the library?
			</p>
			<div class="mt-3 flex flex-wrap justify-center gap-2">
				<Button onclick={trainFurther} variant="primary" size="md">
					<RotateCcw class="size-3.5" />
					<span>Continue studying</span>
				</Button>
				<Button onclick={retrain} variant="secondary" size="md" disabled={retrainBusy}>
					<span>{retrainBusy ? 'Resetting…' : 'Retrain from scratch'}</span>
				</Button>
				<Button href="{base}/library" variant="outline" size="md">Back to library</Button>
			</div>
		</div>
	{:else if (phase === 'idea-prompt' || phase === 'idea-reveal') && currentIdea}
		<div class="grid gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
			<div class="relative mx-auto w-full max-w-[600px]">
				<Board
					fen={currentFen}
					{orientation}
					turnColor={sideToMove}
					movableColor={undefined}
					{dests}
					viewOnly
				/>
			</div>
			<aside class="space-y-5">
				<div class="ot-fade">
					<div class="eyebrow mb-2 text-[var(--color-brass-300)]">
						Idea · {ideaIdx + 1} / {ideaQueue.length}
					</div>
					<h2 class="font-serif text-[1.75rem] leading-tight text-[var(--color-parchment-50)]">
						{currentIdea.prompt}
					</h2>
					{#if phase === 'idea-prompt'}
						<p class="mt-3 font-serif text-sm text-[var(--color-parchment-400)] italic">
							Think it through, then reveal.
						</p>
						<div class="mt-4">
							<Button variant="primary" size="md" onclick={revealIdea}>
								<span>Reveal</span>
								<kbd
									class="ml-1 rounded bg-[var(--color-ink-800)] px-1 py-0.5 font-mono text-[10px]"
									>Space</kbd
								>
							</Button>
						</div>
					{:else}
						{#if currentIdea.answer}
							<p
								class="mt-3 rounded-[3px] border-l-2 border-[var(--color-brass-300)] bg-[var(--color-ink-900)] p-3 font-serif text-[15px] text-[var(--color-parchment-100)] italic"
							>
								{currentIdea.answer}
							</p>
						{:else}
							<p class="mt-3 font-serif text-sm text-[var(--color-parchment-500)] italic">
								No recorded answer — grade yourself honestly.
							</p>
						{/if}
						<div class="mt-5 grid grid-cols-4 gap-2">
							<Button variant="destructive" size="sm" onclick={() => rateIdea('wrong')}>
								Again
							</Button>
							<Button variant="secondary" size="sm" onclick={() => rateIdea('peeked')}>Hard</Button>
							<Button variant="primary" size="sm" onclick={() => rateIdea('correct')}>Good</Button>
							<Button variant="outline" size="sm" onclick={() => rateIdea('easy')}>Easy</Button>
						</div>
					{/if}
				</div>
			</aside>
		</div>
	{:else if currentCard}
		<div class="grid gap-6 md:grid-cols-[minmax(0,1fr)_260px]">
			<!-- Board -->
			<div class="relative mx-auto w-full max-w-[600px]">
				<div
					class="rounded-[4px] transition-shadow duration-200"
					class:board-correct-ring={phase === 'correct'}
					class:board-wrong-ring={phase === 'wrong'}
				>
					<Board
						fen={currentFen}
						{orientation}
						turnColor={sideToMove}
						movableColor={phase === 'pending' ? rep?.color : undefined}
						{dests}
						lastMove={userLastMove}
						shapes={boardShapes}
						onmove={handleMove}
						viewOnly={phase !== 'pending'}
					/>
				</div>
			</div>

			<!-- Side: prompt + feedback + rating -->
			<aside class="space-y-5">
				<!-- Prompt area (or feedback) -->
				{#if phase === 'intro'}
					{#key currentLineLabel}
						<div class="ot-fade">
							<div class="eyebrow mb-2 text-[var(--color-parchment-400)]">
								Playing the line{#if currentLineLabel}
									<span class="ml-1 text-[var(--color-brass-300)]">· {currentLineLabel}</span>
								{/if}
							</div>
							<h2 class="font-serif text-[1.75rem] leading-tight text-[var(--color-parchment-200)]">
								<em>Setting the stage…</em>
							</h2>
							<p class="mt-3 font-serif text-sm text-[var(--color-parchment-500)] italic">
								The board will arrive at the position in a moment.
							</p>
						</div>
					{/key}
				{:else if phase === 'pending'}
					<div class="ot-fade">
						<div class="eyebrow mb-2">
							Your move as {rep?.color}
							{#if wrongAttempts > 0}
								<span class="ml-1 text-[var(--color-oxblood-300)]">
									· try {wrongAttempts + 1}
								</span>
							{/if}
						</div>
						<h2 class="font-serif text-[2rem] leading-tight text-[var(--color-parchment-50)]">
							{#if wrongAttempts > 0}
								<em>Not that one. Try again.</em>
							{:else}
								What do you play here?
							{/if}
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
					</div>
					<div class="flex gap-2">
						<Button
							variant="ghost"
							size="sm"
							onclick={showHint}
							disabled={hintLevel >= 2 || hintSuppressed}
						>
							<Keyboard class="size-3" />
							<span>
								{hintLevel === 0
									? isFirstEverCard
										? 'Show answer'
										: 'Show hint'
									: hintLevel === 1
										? 'Show answer'
										: 'Answer shown'}
							</span>
							<kbd class="ml-1 rounded bg-[var(--color-ink-800)] px-1 py-0.5 font-mono text-[10px]"
								>H</kbd
							>
						</Button>
					</div>
				{:else if phase === 'correct'}
					<div class="ot-fade">
						<div class="flex items-center gap-2 text-[var(--color-olive-300)]">
							<Check class="size-4" strokeWidth={2.5} />
							<span class="eyebrow !text-[var(--color-olive-300)]">
								{firstTryClean ? 'Correct' : 'Got there'}
							</span>
						</div>
						<p class="mt-2 font-mono text-sm text-[var(--color-parchment-400)]">
							{userPlayedSan}<span class="text-[var(--color-olive-300)]">!</span>
						</p>
						<div class="relative mt-4 h-px overflow-hidden bg-[var(--color-ink-800)]">
							<div
								class="absolute inset-y-0 left-0 bg-[var(--color-olive-400)]"
								style:animation="drill-shrink {currentAutoAdvanceMs}ms linear forwards"
							></div>
						</div>
						{#if firstTryClean}
							<p class="mt-3 font-serif text-[11px] text-[var(--color-parchment-500)] italic">
								Press
								<kbd class="rounded bg-[var(--color-ink-800)] px-1 py-0.5 font-mono text-[10px]"
									>4</kbd
								> if that was easy.
							</p>
						{:else}
							<p class="mt-3 font-serif text-[11px] text-[var(--color-parchment-500)] italic">
								Taking a beat so the line sticks.
							</p>
						{/if}
					</div>
				{:else if phase === 'wrong'}
					<div class="ot-fade">
						<div class="eyebrow mb-2">
							{#if moveQuality}
								<span
									class:!text-[var(--color-olive-300)]={moveQuality === 'playable'}
									class:!text-[var(--color-brass-300)]={moveQuality === 'dubious'}
									class:!text-[var(--color-copper-300)]={moveQuality === 'mistake'}
									class:!text-[var(--color-oxblood-300)]={moveQuality === 'blunder'}
								>
									{moveQualityLabel(moveQuality)}
								</span>
							{:else}
								<span class="text-[var(--color-parchment-400)]">Checking</span>
							{/if}
						</div>
						<h2 class="font-serif text-[2rem] leading-tight text-[var(--color-parchment-100)]">
							{#if moveQuality === 'playable'}
								<em>Fair, but not your repertoire. Try again.</em>
							{:else if moveQuality === 'dubious'}
								<em>Not quite. Try again.</em>
							{:else if moveQuality}
								<em>Try again.</em>
							{:else}
								<em>Evaluating…</em>
							{/if}
						</h2>
						{#if userPlayedSan && moveQuality}
							<p class="mt-3 font-mono text-sm text-[var(--color-parchment-400)]">
								{userPlayedSan}<span>{nagGlyph(moveQuality)}</span>
							</p>
						{/if}
					</div>
				{:else if phase === 'refuted'}
					<div class="ot-fade">
						<div class="eyebrow mb-2 text-[var(--color-oxblood-300)]">
							{moveQuality ? moveQualityLabel(moveQuality) : 'Why that loses'}
						</div>
						<p class="mt-1 font-mono text-sm text-[var(--color-parchment-400)]">
							{userPlayedSan}<span class="text-[var(--color-oxblood-300)]"
								>{moveQuality ? nagGlyph(moveQuality) : '??'}</span
							>
						</p>
						<h2
							class="mt-3 font-serif text-[1.75rem] leading-tight text-[var(--color-parchment-100)]"
						>
							Engine:
							<span class="font-mono text-[var(--color-oxblood-300)] not-italic">
								{refutationSan}
							</span>
							{#if refutationCp !== null}
								<span
									class="ml-1 font-mono text-[1.1rem] text-[var(--color-parchment-400)] not-italic"
								>
									{#if refutationCp >= 10000}
										mate
									{:else}
										+{(refutationCp / 100).toFixed(1)}
									{/if}
								</span>
							{/if}
						</h2>
						<p class="mt-3 font-serif text-sm text-[var(--color-parchment-500)] italic">
							Resetting to let you try again.
						</p>
					</div>
				{/if}

				<div class="border-t border-[var(--color-ink-800)] pt-4">
					<div class="eyebrow mb-2">Session</div>
					<div class="flex items-center gap-2 font-mono text-xs text-[var(--color-parchment-400)]">
						<span class="text-[var(--color-parchment-100)] tabular-nums">{sessionDone}</span>
						<span>reviewed</span>
						<span class="text-[var(--color-ink-600)]">·</span>
						<span class="tabular-nums">{queue.length - idx}</span>
						<span>remaining</span>
					</div>
					{#if currentLineLabel}
						<div
							class="mt-2 flex items-center gap-2 font-mono text-xs text-[var(--color-parchment-400)]"
						>
							<span>Line</span>
							<span class="text-[var(--color-brass-300)]">{currentLineLabel}</span>
						</div>
					{/if}
					{#if rep && currentCard}
						<Button
							href={`${base}/repertoire/${rep.id}/edit?jump=${encodeURIComponent(currentCard.fenKey)}`}
							variant="ghost"
							size="sm"
							class="mt-3"
						>
							<Pencil class="size-3" />
							<span>Open in builder</span>
						</Button>
					{/if}
				</div>
			</aside>
		</div>
	{/if}
</div>
