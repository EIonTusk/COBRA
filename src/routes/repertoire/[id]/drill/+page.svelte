<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { onMount, untrack } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		X,
		Keyboard,
		Pencil,
		RotateCcw,
		Trophy,
		Check,
		ChevronFirst,
		ChevronLast,
		ChevronLeft,
		ChevronRight
	} from 'lucide-svelte';
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
	// True once the leaf re-cycle has run for this session. Caps the
	// auto-cycle at one extra lap — keeps the "drill the deepest lines a
	// second time" practice without the queue length running away.
	let leavesCycled = false;
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
	// Locked at the moment loadQueue returns. The progress bar's denominator
	// uses this so wrong-answer re-queues, intro re-queues, and leaf cycling
	// don't move the goalposts mid-session. Lapses surface as a separate
	// "to retry" counter instead of inflating the bar.
	let sessionPlannedTotal = $state(0);
	// Per-walk Learn → Train state. Each line walk gets a Learn pass
	// (hints shown for never-seen positions) immediately followed by a
	// Train pass (no hints, same line again from move 1) before the queue
	// moves on to the next walk. `walkPhase` flips between 'learn' and
	// 'train' as `advanceQueue` crosses each walk's boundary; reviews-only
	// walks (no introducedKeys overlap) skip the Train pass entirely. Each
	// entry in `walkStarts` is the queue index where a fresh line walk
	// begins; `walkFenKeys[i]` is the set of fenKeys in that walk. Both
	// are reset and repopulated by `pickWithLineWalk` on each session
	// load.
	let walkPhase = $state<'learn' | 'train'>('learn');
	const walkStarts: number[] = [];
	const walkFenKeys: SvelteSet<string>[] = [];
	// Slot-based progress: every rate event against a planned card adds one
	// slot. Brand-new cards are counted as two slots up-front because the
	// drill plays an introduction pass (hint-shown viewing) before the real
	// recall pass — counting both keeps the progress bar moving from the
	// first answer instead of staying at 0% through the entire intro half
	// of the session.
	let plannedSlotsDone = $state(0);
	const plannedKeys = new SvelteSet<string>();
	const pendingLapses = new SvelteSet<string>();
	// Subset of plannedKeys that came from the original FSRS due selection
	// (before line-walk prefix augmentation). Cards outside this set are
	// "line steps": positions the user is walking through to preserve
	// move-sequence memory. A correct answer at a line step is a free pass
	// (no FSRS schedule update); a wrong answer doesn't count as a lapse
	// against scheduling either, so practising the prefix can never punish
	// a card that wasn't due today.
	const dueOriginalKeys = new SvelteSet<string>();
	let nodes: Map<string, RepertoireNode> = new Map();

	// Lead-in scrubbing. Lets the user step back through the moves that led
	// to the question position (and forward to return) — useful when two
	// near-identical positions appear back-to-back, the intro animation
	// played too fast, or the answer depends on a detail the user wants to
	// re-check. Offset 0 = at the question; positive offsets walk backwards
	// one ply at a time. Reset whenever a new card becomes current.
	let scrubOffset = $state(0);

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
		if (sessionPlannedTotal === 0) return 0;
		const done = Math.min(plannedSlotsDone, sessionPlannedTotal);
		return (done / sessionPlannedTotal) * 100;
	});
	const plannedDoneCount = $derived(Math.min(plannedSlotsDone, sessionPlannedTotal));
	const pendingLapsesCount = $derived(pendingLapses.size);

	// Pre-computed lead-in history for the current card: every FEN from the
	// repertoire root down to the question position, plus the move that
	// produced each one. The user scrubs through this with the back/forward
	// controls without the drill state machine having to know about it.
	const scrubHistory = $derived.by<{
		fens: string[];
		lastMoves: ([Key, Key] | undefined)[];
	}>(() => {
		if (!rep || !currentCard) return { fens: [], lastMoves: [] };
		const path = pathToFenKey(nodes, rep.rootFenKey, currentCard.fenKey);
		const fens: string[] = [rep.rootFen];
		const lastMoves: ([Key, Key] | undefined)[] = [undefined];
		if (!path) return { fens, lastMoves };
		let f = rep.rootFen;
		for (const edge of path) {
			f = fenAfterMove(f, edge);
			fens.push(f);
			lastMoves.push([edge.uci.slice(0, 2) as Key, edge.uci.slice(2, 4) as Key]);
		}
		return { fens, lastMoves };
	});
	const scrubMaxOffset = $derived(Math.max(0, scrubHistory.fens.length - 1));
	const scrubActive = $derived(phase === 'pending' && scrubOffset > 0);
	const displayFen = $derived.by(() => {
		if (!scrubActive) return currentFen;
		const i = scrubHistory.fens.length - 1 - scrubOffset;
		return scrubHistory.fens[i] ?? currentFen;
	});
	const displayLastMove = $derived.by<[Key, Key] | undefined>(() => {
		if (!scrubActive) return userLastMove;
		const i = scrubHistory.fens.length - 1 - scrubOffset;
		return scrubHistory.lastMoves[i];
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
			// Brand-new FSRS-tracked cards (never reviewed, not yet
			// introduced this session) auto-show the answer arrow — there's
			// nothing to recall yet, so the teaching cue is offered without
			// requiring a click. Subsequent passes (`lastReview` set or in
			// `introducedKeys`) suppress it. Line-walk *steps* — positions
			// pulled in because a deeper card was due, not because they
			// were due themselves — also never auto-show: those are recall
			// practice, not first introduction.
			const isLineWalkStepCard = mode === 'due' && !dueOriginalKeys.has(card.fenKey);
			hintLevel = card.lastReview || introducedKeys.has(card.fenKey) || isLineWalkStepCard ? 0 : 2;
			wrongAttempts = 0;
			moveQuality = null;
			gradedSquare = null;
			scrubOffset = 0;
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
					else
						shapes.push({
							orig,
							dest,
							brush: 'green',
							modifiers: { lineWidth: 12 }
						});
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

		// Already-introduced cards (e.g. the tail duplicate added for the
		// unaided revision pass) snap straight to the question position
		// instead of replaying the whole lead-in. The user has already seen
		// the line walked through once on the first pass — making them
		// watch it again would be exactly the "all lines are visualised"
		// complaint the line walk is meant to avoid.
		if (introducedKeys.has(card.fenKey)) {
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
		// feel abrupt. In line-walk mode the fast-forward is suppressed
		// entirely: the line walk already drops well-learned moves out of
		// the drill pool, so anything that ended up *before* the queue's
		// first card is exactly the well-learned context the user wants
		// to *see* play out as a refresher — skipping it would be the
		// "ask the last move" anti-pattern again.
		const lineWalkModeIntro =
			(settings?.drillIntermediateMoves ?? 'play') === 'play' && mode === 'due';
		let skippedFen: string | null = null;
		let skippedLastMove: [Key, Key] | undefined;
		if (startIdx === 0 && settings?.openAtStartingPosition !== false && !lineWalkModeIntro) {
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
		snapshotPlannedSet(queue);
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
			// Fill the progress slot the moment the move lands rather than
			// waiting on the auto-advance pause — the user wants to see the
			// bar move with their action, not after the celebratory dwell.
			// Lapse tracking still settles in rateAndAdvance because it has
			// to know whether the final outcome was 'wrong' (intro/line-walk
			// flags decide whether the lapse is real or just retry chatter).
			if (plannedKeys.has(currentCard.fenKey)) {
				plannedSlotsDone += 1;
			}
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
	//   any wrong attempt                   → 'wrong'   (Again)
	//   hint shown but no wrong attempts    → 'peeked'  (Hard) — keeps the
	//                                         chain alive into the next
	//                                         card so a line walk doesn't
	//                                         break every time the user
	//                                         leans on the arrow.
	//   first-try clean, unaided            → 'correct' (Good)
	// 'easy' can still be triggered explicitly from the keyboard.
	function deriveOutcome(): DrillOutcome {
		if (wrongAttempts > 0) return 'wrong';
		if (hintLevel > 0) return 'peeked';
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
		// Line-walk prefix cards aren't FSRS-due today — the user is only
		// drilling them to preserve sequence memory leading into a deeper due
		// card. Skip the schedule update and the lapse tracking so a missed
		// prefix can't poison the parent card's FSRS state. The in-session
		// retry behaviour (replay, re-queue) still applies.
		const isLineWalkStep = mode === 'due' && !dueOriginalKeys.has(ratedCard.fenKey);
		const lineWalkMode = (settings.drillIntermediateMoves ?? 'play') === 'play';

		// Introduction pass only applies to FSRS-tracked due cards in classic
		// (`auto`) mode. In line-walk mode, the whole point is a contiguous
		// front-to-back walk of each line, so we never re-queue cards at the
		// tail — that would scatter intro retries and lapses out of order
		// and turn the session back into the "ask the last move" anti-
		// pattern the line walk was meant to fix. The schedule still
		// catches up on lapses via FSRS Again rescheduling for the next
		// session.
		const isIntroductionPass =
			!ratedCard.lastReview &&
			!introducedKeys.has(ratedCard.fenKey) &&
			mode === 'due' &&
			!isLineWalkStep &&
			!lineWalkMode;
		if (!isLineWalkStep) {
			const updated = reviewCard(ratedCard, outcomeToRating(outcome), settings.fsrsParams);
			await upsertCard(updated);
		}
		sessionDone += 1;
		// Lapse tracking. The slot itself was already filled by `handleMove`
		// the moment the move was accepted — that's what advances the
		// progress bar. Here we only record whether the final outcome
		// counts as a lapse: wrong on a real FSRS card adds it to the
		// "to retry" badge, anything else clears it.
		if (plannedKeys.has(ratedCard.fenKey)) {
			if (outcome === 'wrong' && !isIntroductionPass && !isLineWalkStep) {
				pendingLapses.add(ratedCard.fenKey);
			} else if (outcome !== 'wrong') {
				pendingLapses.delete(ratedCard.fenKey);
			}
		}
		// Track brand-new cards drilled in the first pass of line-walk mode
		// so the second pass (Train) knows which fenKeys to revisit. The
		// transition in `advanceQueue` clears `drilledKeys` for everything
		// in `introducedKeys` and restarts idx=0; reviews stay drilled and
		// drop out of the second pass.
		if (
			lineWalkMode &&
			!ratedCard.lastReview &&
			walkPhase === 'learn' &&
			!introducedKeys.has(ratedCard.fenKey)
		) {
			introducedKeys.add(ratedCard.fenKey);
		}

		// Mark this position as drilled unless we intend to re-drill it. In
		// `auto` mode we keep the legacy behaviour: introduction passes and
		// non-line-walk wrongs both re-queue at the tail for a second pass.
		// In line-walk mode every drill cleanly adds to `drilledKeys` —
		// the second pass is reached by clearing those keys at the queue-
		// end transition, not by leaving the queue in an unfinished state.
		const willReDrill =
			!lineWalkMode && (isIntroductionPass || (outcome === 'wrong' && !isLineWalkStep));
		if (!willReDrill) drilledKeys.add(ratedCard.fenKey);
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
		// don't prune behind them either. Pruning is also suppressed on
		// line-walk prefixes: the deeper card the user is walking towards is
		// the whole point of the line walk, and stripping it would defeat
		// the exercise.
		if (
			outcome === 'wrong' &&
			!isIntroductionPass &&
			!isLineWalkStep &&
			!lineWalkMode &&
			mode !== 'retrain'
		) {
			pruneDeeperInLine(ratedCard.fenKey);
		}
		// Re-queue a failed card at the tail in `auto` mode so the user gets
		// a second pass before the session ends. Skipped for intro pass
		// (already queued above), line-walk steps (their wrong-flow retries
		// in place), and line-walk mode entirely (a tail re-queue would
		// shred the line-by-line ordering).
		if (outcome === 'wrong' && !isIntroductionPass && !isLineWalkStep && !lineWalkMode) {
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

		advanceQueue(ratedCard.fenKey);
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
		// Cap respect: never chain past the planned queue. The session was
		// built with a per-line forward walk that pulls every reachable user
		// move into `plannedKeys`, so anything outside that set is a card we
		// deliberately deferred to a future session — chaining into it would
		// silently bypass `dailyNewCardCap` and `drillSessionCap`.
		if (mode === 'due' && !plannedKeys.has(oppEdge.toFenKey)) return null;
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
		leavesCycled = false;
		queue = sortByLineOrder(await loadQueue());
		snapshotPlannedSet(queue);
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

	/**
	 * Lock the session's planned-progress denominator. Captures the cards the
	 * session opens with so the progress bar measures work against that fixed
	 * goal — not against a queue length that grows every time a card lapses
	 * or a leaf gets cycled in. Brand-new cards count as two slots in `due`
	 * mode because they trigger an introduction pass before the unaided
	 * recall pass; that keeps the bar advancing from the first answer rather
	 * than parking at 0% through the entire intro phase.
	 */
	function snapshotPlannedSet(initial: Card[]) {
		plannedKeys.clear();
		pendingLapses.clear();
		plannedSlotsDone = 0;
		walkPhase = 'learn';
		// Brand-new cards always cost two slots in either drill mode: in
		// `auto` mode the intro pass re-queues a duplicate at runtime, and
		// in line-walk mode the per-walk Train pass drills every introduced
		// card again. Reviews drill once in either mode.
		let total = 0;
		for (const c of initial) {
			plannedKeys.add(c.fenKey);
			const newDue = !c.lastReview && mode === 'due' && dueOriginalKeys.has(c.fenKey);
			total += newDue ? 2 : 1;
		}
		sessionPlannedTotal = total;
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
		// `pickWithLineWalk` already builds the queue as a sequence of
		// independent line walks (one per candidate, full path included),
		// and we deliberately keep duplicate fenKeys across walks so each
		// line is drilled from its own beginning. The dedup-by-fenKey in
		// `buildLineFirstQueue` would collapse those duplicates and shuffle
		// the order, so skip it for line-walk-mode sessions.
		const lineWalkMode = (settings?.drillIntermediateMoves ?? 'play') === 'play';
		if (lineWalkMode && mode === 'due') {
			return cards;
		}
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
		dueOriginalKeys.clear();
		if (mode === 'mistakes') {
			const cards = await mistakeCards(rep.id, settings.drillSessionCap);
			for (const c of cards) dueOriginalKeys.add(c.fenKey);
			return cards;
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
			for (const c of queue) dueOriginalKeys.add(c.fenKey);
			return queue;
		}
		// Fetch a generous pool so the balancer has room to put review cards
		// ahead of new ones. The sessionCap alone isn't enough: on a fresh
		// import, `dueCards` orders by dueAt asc and the first N could be
		// all-new, leaving no reviews to promote.
		const pool = await dueCards(rep.id, Date.now(), settings.drillSessionCap * 5);
		// Line-walk path: pick due cards greedily and pull each one's full
		// line prefix into the session, but stop the moment either the
		// total-session or new-card budget would be exceeded. Prefix moves
		// count against `dailyNewCardCap` because they're additional new
		// positions the user is being asked to play through, even though
		// they don't update FSRS state. Without this, a brand-new repertoire
		// would walk every line in full and steamroll the daily-new setting.
		const lineWalkOn = (settings.drillIntermediateMoves ?? 'play') === 'play';
		if (lineWalkOn) {
			const session = await pickWithLineWalk(
				pool,
				settings.drillSessionCap,
				settings.dailyNewCardCap
			);
			return session;
		}
		const due = pickBalancedDueCards(pool, settings.drillSessionCap, settings.dailyNewCardCap);
		for (const c of due) dueOriginalKeys.add(c.fenKey);
		return due;
	}

	/**
	 * Greedy session builder for line-walk mode. Walks the due-card pool in
	 * priority order and, for each candidate, computes the full path back to
	 * the line head — the deepest due card plus every earlier user-side card
	 * along the way. The whole walk is admitted only if it fits within both
	 * `drillSessionCap` (total queue length) and `dailyNewCardCap` (new
	 * positions: cards with no FSRS history). When a candidate doesn't fit,
	 * it's skipped and the next is tried, so the session ends up with as
	 * many *complete* line walks as the budgets allow rather than a clipped
	 * mix that leaves deep cards stranded.
	 *
	 * Side effect: populates `dueOriginalKeys` with the cards whose full
	 * walks were admitted. Their prefix companions are NOT added — those
	 * are line-walk steps and skip FSRS scheduling on rate.
	 */
	async function pickWithLineWalk(
		pool: Card[],
		sessionCap: number,
		newCap: number
	): Promise<Card[]> {
		if (!rep) return [];
		// Always walk from the absolute root in line-walk mode. The
		// `openAtStartingPosition` setting only affects how the lead-in
		// animation is staged; for queue construction we want every user
		// move in the line included, so brand-new forced-sequence moves
		// (1.e4 e5, 2.Nf3 Nc6, …) get drilled instead of animated past.
		// `isWellLearned` is what gates an already-mastered move into the
		// "animate, don't drill" bucket — not the line head.
		const lineHead = rep.rootFenKey;

		// Deepest-first admission: precompute each candidate's depth from
		// the rep root and iterate the pool in (depth desc, dueAt asc)
		// order. The deepest due candidate's walk subsumes any shallower
		// candidate on the same line, so iterating deep-to-shallow lets
		// us skip subsumed candidates (`A1` and `A2` are skipped once
		// `A3`'s walk `[A1, A2, A3]` is already admitted) without losing
		// the deepest position the schedule actually surfaced. Variant
		// distribution emerges across sessions: well-learned cards drop
		// out of future walks via `isWellLearned`, freeing the daily-new
		// budget for other variants' deeper moves.
		const depthByKey = new SvelteMap<string, number>();
		for (const c of pool) {
			if (depthByKey.has(c.fenKey)) continue;
			const path = pathToFenKey(nodes, lineHead, c.fenKey);
			depthByKey.set(c.fenKey, path ? path.length : -1);
		}
		const sortedPool = pool.slice().sort((a, b) => {
			const dA = depthByKey.get(a.fenKey) ?? -1;
			const dB = depthByKey.get(b.fenKey) ?? -1;
			if (dA !== dB) return dB - dA;
			return a.dueAt - b.dueAt;
		});

		const out: Card[] = [];
		// Tracks which candidate fenKeys we've already led a walk with —
		// otherwise the same candidate could be picked twice (a candidate's
		// own fenKey isn't shared with another candidate's walk, but it
		// could still appear in the pool more than once if the schedule
		// surfaces it via multiple paths).
		const ledBy = new SvelteSet<string>();
		// Quick lookup so cards that were FSRS-due today but got picked up
		// as part of another candidate's walk still get their schedules
		// updated — without this, only the candidate that "led" the walk
		// would FSRS-update and the others would silently graduate as
		// line-walk steps.
		const poolKeys = new SvelteSet<string>();
		for (const c of pool) poolKeys.add(c.fenKey);
		const uniqueNewSeen = new SvelteSet<string>();
		walkStarts.length = 0;
		walkFenKeys.length = 0;
		let totalRemaining = Math.max(0, sessionCap);
		let newRemaining = Math.max(0, newCap);

		// `drillSessionCap` is the ceiling on *drill events* — the moves the
		// user will actually play this session. A walk with brand-new
		// cards costs `walk.length × 2` events because it gets a Learn
		// pass (with hints) followed by a Train pass (no hints); a walk
		// containing only reviews skips Train and costs `walk.length`.
		// Shared prefixes across multiple candidates' walks count
		// separately because each line is drilled from its own beginning.
		// `dailyNewCardCap` counts unique new positions: a brand-new
		// prefix shared by lines A and B costs one against the cap, but
		// it'll appear in both line walks and be drilled in each line's
		// context. `drilledKeys` is cleared at every walk boundary in
		// `advanceQueue` so the duplicates aren't skipped.
		// Set of fenKeys already covered by an admitted walk. Iterating
		// deepest-first means a shallower candidate on the same line will
		// have its fenKey already in here — that's the cue to skip it
		// because its walk would be a strict prefix of the admitted one.
		const admittedFenKeys = new SvelteSet<string>();
		for (const candidate of sortedPool) {
			if (totalRemaining <= 0) break;
			if (newRemaining <= 0) break;
			if (ledBy.has(candidate.fenKey)) continue;
			if (admittedFenKeys.has(candidate.fenKey)) continue;

			const walk = await collectLineWalk(candidate, lineHead);
			if (!walk) continue;
			const newInWalk = walk.reduce(
				(sum, c) => sum + (!c.lastReview && !uniqueNewSeen.has(c.fenKey) ? 1 : 0),
				0
			);
			// Walks with any new card are drilled twice (Learn + Train);
			// review-only walks drill once. Both passes count against
			// `drillSessionCap`.
			const walkHasNew = walk.some((c) => !c.lastReview);
			const eventCost = walk.length * (walkHasNew ? 2 : 1);
			if (eventCost > totalRemaining) continue;
			if (newInWalk > newRemaining) continue;

			ledBy.add(candidate.fenKey);
			const walkStart = out.length;
			const fenSet = new SvelteSet<string>();
			for (const c of walk) {
				out.push(c);
				fenSet.add(c.fenKey);
				admittedFenKeys.add(c.fenKey);
				if (poolKeys.has(c.fenKey)) dueOriginalKeys.add(c.fenKey);
				if (!c.lastReview) uniqueNewSeen.add(c.fenKey);
			}
			walkStarts.push(walkStart);
			walkFenKeys.push(fenSet);
			totalRemaining -= eventCost;
			newRemaining -= newInWalk;
		}
		return out;
	}

	/**
	 * Build the line-walk for one candidate due card: every prior user-side
	 * card on the path from `lineHead` to the candidate, then the candidate
	 * itself, then every later user-side card on the way to a leaf. Walking
	 * forward as well as backward closes the cap loophole where chain-
	 * forward at drill time would happily run past a mid-line candidate
	 * into unplanned suffixes — the entire line gets admitted (or rejected)
	 * as a single budget unit. Already-claimed positions are skipped so a
	 * second candidate from the same line yields a near-empty walk that
	 * gets dropped by the budget check.
	 *
	 * Forward expansion follows the first prepared user move and the first
	 * recorded opponent reply at each step, mirroring the chain logic in
	 * `findNextInLine` / `playChainTransition`. That keeps the queue and
	 * the chain in sync — every position the chain might walk into is
	 * already a queue item with a `drilledKeys` flag.
	 */
	async function collectLineWalk(card: Card, lineHead: string): Promise<Card[] | null> {
		if (!rep) return null;
		const walk: Card[] = [];
		// Walk is `lineHead → candidate` only — no forward expansion past
		// the FSRS-due candidate. Deeper user moves enter future sessions
		// when their own FSRS schedule comes due. This keeps each session
		// focused on the moves the schedule actually surfaced today rather
		// than dragging an entire line's tail into the drill every time
		// any one of its positions is due.
		if (card.fenKey !== lineHead) {
			const path = pathToFenKey(nodes, lineHead, card.fenKey);
			if (path) {
				for (let i = 0; i < path.length; i++) {
					const fenKeyBeforeEdge = i === 0 ? lineHead : path[i - 1].toFenKey;
					if (fenKeyBeforeEdge === card.fenKey) break;
					if (colorToMove(fenKeyBeforeEdge) !== rep.color) continue;
					const stored = await getCard(rep.id, fenKeyBeforeEdge);
					if (!stored) continue;
					// Well-learned prefix moves get animated past during the
					// lead-in instead of pulled into the drill — the user has
					// already proven recall, so re-asking would waste their
					// time. Anything below the threshold stays in the walk
					// so the user has to play it themselves, even when the
					// same prefix appears in a sibling line walk later in
					// the session — every line is drilled independently
					// from the beginning until the prefix is well-learned.
					if (isWellLearned(stored)) continue;
					walk.push(stored);
				}
			}
		}
		walk.push(card);
		return walk;
	}

	/**
	 * "Well-learned" = the user has demonstrated reliable recall and the
	 * spaced-repetition schedule reflects it. Used to decide whether a
	 * prefix or suffix card on a line walk should be drilled (forces the
	 * user to play it again from memory) or animated past (saves their
	 * time on positions they already know). Card must be in FSRS Review
	 * state and meet the user-configured stability threshold (Settings →
	 * Drill, default 7 days).
	 */
	function isWellLearned(card: Card): boolean {
		const state = card.fsrs.state;
		const stability = typeof card.fsrs.stability === 'number' ? card.fsrs.stability : 0;
		const threshold = settings?.drillWellLearnedDays ?? 7;
		return state === 2 && stability >= threshold;
	}

	/**
	 * Cards whose user-move position has no deeper user-move card in the
	 * repertoire — the "tips" of every prepared line. Used to seed the
	 * second-pass leaves cycle so the deepest moves get an extra rep
	 * before the session ends.
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

	async function extendQueueWithLeaves(): Promise<number> {
		if (!rep || mode !== 'due') return 0;
		// Cap the auto-cycle at one lap. Without this the queue would
		// re-extend on every successful pass through the leaves and the
		// counter would visibly grow forever (12/24, 24/48, …) instead of
		// reading as a clean second pass.
		if (leavesCycled) return 0;
		const leaves = await collectLeafCards();
		if (leaves.length === 0) return 0;
		const sorted = sortByLineOrder(leaves);
		for (const c of sorted) drilledKeys.delete(c.fenKey);
		// Replace rather than append so the counter shows "1/N" → "N/N"
		// across the leaf lap; the prior queue is fully drilled by now and
		// keeping it would just inflate the denominator.
		queue = sorted;
		idx = 0;
		leavesCycled = true;
		return sorted.length;
	}

	/**
	 * Clear `drilledKeys` for every fenKey in the walk whose first index is
	 * `queueIdx` — called as the queue crosses walk boundaries so a shared
	 * prefix drilled as part of the previous line becomes eligible for the
	 * new line again. No-op when the given index isn't a walk start.
	 */
	function maybeOpenWalkAt(queueIdx: number) {
		const walk = walkStarts.indexOf(queueIdx);
		if (walk < 0) return;
		const keys = walkFenKeys[walk];
		if (!keys) return;
		for (const k of keys) drilledKeys.delete(k);
	}

	/** Walk index that contains `queueIdx`, or -1 if no walks are tracked. */
	function walkOfIdx(queueIdx: number): number {
		for (let i = walkStarts.length - 1; i >= 0; i--) {
			if (walkStarts[i] <= queueIdx) return i;
		}
		return -1;
	}

	/** End-exclusive boundary of walk `w` in the flat queue. */
	function walkEndOf(w: number): number {
		return w + 1 < walkStarts.length ? walkStarts[w + 1] : queue.length;
	}

	/** True when any fenKey in this walk has been introduced this session — the signal for "needs a Train pass". */
	function walkNeedsTrain(walkIdx: number): boolean {
		const keys = walkFenKeys[walkIdx];
		if (!keys) return false;
		for (const k of keys) {
			if (introducedKeys.has(k)) return true;
		}
		return false;
	}

	function advanceQueue(justRatedKey?: string) {
		const lineWalkMode = (settings?.drillIntermediateMoves ?? 'play') === 'play';
		const currentWalk = walkOfIdx(idx);

		// Auto-mode (no walks tracked) and any session that ran out of
		// walks fall back to the simple linear advance: skip drilled cards
		// + the just-rated fenKey, end the session at queue exhaustion.
		if (!lineWalkMode || currentWalk < 0) {
			let next = idx + 1;
			while (next < queue.length) {
				maybeOpenWalkAt(next);
				if (drilledKeys.has(queue[next].fenKey) || queue[next].fenKey === justRatedKey) {
					next++;
					continue;
				}
				break;
			}
			if (next >= queue.length) {
				// Move queue is done. If idea cards are queued, flip into the
				// self-rated prompt phase. Otherwise (in due mode) run one extra
				// lap over just the leaves so the deepest lines get a second
				// pass, then end. `extendQueueWithLeaves` replaces the queue
				// and resets `idx` itself.
				setTimeout(async () => {
					if (ideaQueue.length > 0) {
						startIdeaPhase();
						return;
					}
					const added = await extendQueueWithLeaves();
					if (added > 0) {
						chainedCard = null;
						phase = 'pending';
						return;
					}
					phase = 'done';
				}, DONE_HOLD_MS);
			} else {
				chainedCard = null;
				idx = next;
			}
			return;
		}

		// Line-walk mode: stay inside the current walk's [start, end) range
		// while looking for an undrilled card. When we'd cross out of it,
		// flip to the Train pass for the same walk (if it had any new
		// cards), or move on to the next walk.
		const walkEnd = walkEndOf(currentWalk);
		let next = idx + 1;
		while (next < walkEnd) {
			if (drilledKeys.has(queue[next].fenKey) || queue[next].fenKey === justRatedKey) {
				next++;
				continue;
			}
			break;
		}
		if (next < walkEnd) {
			chainedCard = null;
			idx = next;
			return;
		}

		// Exhausted current walk. Decide whether to Train it or move on.
		if (walkPhase === 'learn' && walkNeedsTrain(currentWalk)) {
			setTimeout(() => {
				walkPhase = 'train';
				// Clear `drilledKeys` for *every* card in this walk, not just
				// the introduced ones — a review card mixed into the walk
				// would otherwise stay drilled and break the chain partway
				// through the Train pass, leaving only the moves before it
				// playable. Reviews in partly-new walks get a second drill
				// this session as a side effect, which is fine: it's recall
				// practice on a card already past the well-learned threshold
				// might already filter mature reviews out of the walk
				// upstream.
				const keys = walkFenKeys[currentWalk];
				for (const k of keys) drilledKeys.delete(k);
				chainedCard = null;
				idx = walkStarts[currentWalk];
				phase = 'pending';
			}, DONE_HOLD_MS);
			return;
		}

		setTimeout(() => moveToWalk(currentWalk + 1), DONE_HOLD_MS);
	}

	/**
	 * Slide the queue head to walk `target`. Resets `walkPhase` to 'learn',
	 * opens the new walk's drilledKeys, and lands `idx` on the first
	 * undrilled card inside it. Falls through to idea cards or `done` when
	 * no more walks remain.
	 */
	function moveToWalk(target: number) {
		while (target < walkStarts.length) {
			walkPhase = 'learn';
			const walkStart = walkStarts[target];
			const walkEnd = walkEndOf(target);
			maybeOpenWalkAt(walkStart);
			let restart = walkStart;
			while (restart < walkEnd && drilledKeys.has(queue[restart].fenKey)) {
				restart++;
			}
			if (restart < walkEnd) {
				chainedCard = null;
				idx = restart;
				phase = 'pending';
				return;
			}
			// All cards in this walk are still drilled (rare — only
			// happens when every card in the walk is also in a previously
			// fully-drilled walk and isn't in introducedKeys). Skip walk.
			target += 1;
		}
		if (ideaQueue.length > 0) {
			startIdeaPhase();
			return;
		}
		phase = 'done';
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

	function scrubBack() {
		if (phase !== 'pending') return;
		if (scrubOffset < scrubMaxOffset) scrubOffset += 1;
	}
	function scrubForward() {
		if (phase !== 'pending') return;
		if (scrubOffset > 0) scrubOffset -= 1;
	}
	function scrubToStart() {
		if (phase !== 'pending') return;
		scrubOffset = scrubMaxOffset;
	}
	function scrubToEnd() {
		scrubOffset = 0;
	}

	function handleKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

		if (phase === 'pending') {
			if (e.key === 'ArrowLeft') {
				e.preventDefault();
				scrubBack();
				return;
			}
			if (e.key === 'ArrowRight') {
				e.preventDefault();
				scrubForward();
				return;
			}
			if (e.key === 'Home') {
				e.preventDefault();
				scrubToStart();
				return;
			}
			if (e.key === 'End') {
				e.preventDefault();
				scrubToEnd();
				return;
			}
			// Hint shapes are pinned to the question position; suppress the
			// shortcut while scrubbing so the user doesn't trigger arrows
			// they can't see on a historical position.
			if (
				!scrubActive &&
				(e.key === 'z' || e.key === 'Z' || e.key === '?' || e.key === 'h' || e.key === 'H')
			) {
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
				{plannedDoneCount} <span class="text-[var(--color-ink-600)]">/</span>
				{sessionPlannedTotal}
				{#if pendingLapsesCount > 0}
					<span
						class="ml-2 text-[var(--color-oxblood-300)]"
						title="Cards you missed that need a clean retry before the session ends"
					>
						· {pendingLapsesCount} to retry
					</span>
				{/if}
			</span>
		{:else if phase === 'idea-prompt' || phase === 'idea-reveal'}
			<span class="eyebrow ml-auto tabular-nums">
				{ideaIdx + 1} <span class="text-[var(--color-ink-600)]">/</span>
				{ideaQueue.length}
				<span class="ml-1 text-[var(--color-brass-300)]">ideas</span>
			</span>
		{/if}
		<a
			href={rep ? resolve(`/repertoire/${rep.id}`) : resolve('/')}
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
						fen={displayFen}
						{orientation}
						turnColor={sideToMove}
						movableColor={phase === 'pending' && !scrubActive ? rep?.color : undefined}
						{dests}
						lastMove={displayLastMove}
						shapes={scrubActive ? [] : boardShapes}
						onmove={handleMove}
						viewOnly={phase !== 'pending' || scrubActive}
					/>
				</div>
				{#if phase === 'pending' && scrubMaxOffset > 0}
					<div class="mx-auto mt-2 flex max-w-[560px] items-center justify-center gap-1 md:mt-4">
						<button
							type="button"
							onclick={scrubToStart}
							disabled={scrubOffset >= scrubMaxOffset}
							title="Start (Home)"
							class="flex size-9 items-center justify-center rounded-[3px] text-[var(--color-parchment-300)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:pointer-events-none disabled:opacity-30"
						>
							<ChevronFirst class="size-4" />
						</button>
						<button
							type="button"
							onclick={scrubBack}
							disabled={scrubOffset >= scrubMaxOffset}
							title="Back (←)"
							class="flex size-9 items-center justify-center rounded-[3px] text-[var(--color-parchment-300)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:pointer-events-none disabled:opacity-30"
						>
							<ChevronLeft class="size-4" />
						</button>
						<span class="eyebrow px-3 tabular-nums">
							{scrubMaxOffset - scrubOffset} / {scrubMaxOffset}
						</span>
						<button
							type="button"
							onclick={scrubForward}
							disabled={scrubOffset === 0}
							title="Next (→)"
							class="flex size-9 items-center justify-center rounded-[3px] text-[var(--color-parchment-300)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:pointer-events-none disabled:opacity-30"
						>
							<ChevronRight class="size-4" />
						</button>
						<button
							type="button"
							onclick={scrubToEnd}
							disabled={scrubOffset === 0}
							title="End (End)"
							class="flex size-9 items-center justify-center rounded-[3px] text-[var(--color-parchment-300)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:pointer-events-none disabled:opacity-30"
						>
							<ChevronLast class="size-4" />
						</button>
					</div>
				{/if}
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
					<div
						class="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-[var(--color-parchment-400)]"
					>
						<span class="text-[var(--color-parchment-100)] tabular-nums">{plannedDoneCount}</span>
						<span>of</span>
						<span class="tabular-nums">{sessionPlannedTotal}</span>
						<span>done</span>
						{#if pendingLapsesCount > 0}
							<span class="text-[var(--color-ink-600)]">·</span>
							<span class="text-[var(--color-oxblood-300)] tabular-nums">{pendingLapsesCount}</span>
							<span>to retry</span>
						{/if}
					</div>
					<div
						class="mt-1 flex items-center gap-2 font-mono text-[10px] text-[var(--color-parchment-500)]"
					>
						<span class="tabular-nums">{sessionDone}</span>
						<span>total reviews this session</span>
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
