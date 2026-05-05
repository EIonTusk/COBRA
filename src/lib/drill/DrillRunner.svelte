<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { onMount, untrack } from 'svelte';
	import { base } from '$app/paths';
	import { autoHeight } from '$lib/ui/autoHeight';
	import {
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
	import type { DrawShape } from '@lichess-org/chessground/draw';

	import Board from '$lib/chess/Board.svelte';
	import {
		edgeFromUci,
		edgeFromSan,
		fenAfterMove,
		legalDests,
		isPromotionMove
	} from '$lib/chess/position';
	import { colorToMove, fenKeyFromFen } from '$lib/chess/fen';
	import { pathToFenKey, furthestNonBranchingFenKey } from '$lib/tree/traversal';
	import { upsertCard, getCard } from '$lib/storage/cards';
	import { upsertIdeaCard } from '$lib/storage/ideaCards';
	import { markMistakeByPosition } from '$lib/storage/mistakes';
	import { getEngine } from '$lib/stockfish/engine';
	import { reviewCard, outcomeToRating, type DrillOutcome } from '$lib/fsrs/scheduler';
	import { Button } from '$lib/ui';
	import { playCorrect, playIncorrect } from '$lib/ui/sounds';
	import {
		DRILL_INTRO_MS,
		type AppSettings,
		type Card,
		type Edge,
		type IdeaCard
	} from '$lib/types';
	import { collectLeafCards, sortLeavesByLineOrder } from './buildSegment';
	import type { DrillEntry, DrillPhase, DrillSegment } from './types';
	import {
		gradeMove,
		shouldRefute,
		nagGlyph,
		nagColor,
		moveQualityLabel,
		moveQualityHeadline,
		type MoveQuality
	} from './grade';
	import { probeMoveEvals } from './probe';

	interface Props {
		segments: DrillSegment[];
		settings: AppSettings;
		/** Page-level callback to rebuild segments and continue. */
		onTrainFurther?: () => Promise<void>;
		/** Page-level callback for "Retrain from scratch" (per-rep drill only). */
		onRetrain?: () => Promise<void>;
		/** Optional disabled flag for the retrain button while it's running. */
		retrainBusy?: boolean;
	}

	let { segments, settings, onTrainFurther, onRetrain, retrainBusy = false }: Props = $props();

	// NAG glyph palette + grading thresholds live in `./grade` — same
	// helpers are reused by the walkthrough flow.

	// Composite keys keep cross-segment state collision-free when two reps
	// happen to share a fenKey (transposition across reps).
	function ck(segIdx: number, fenKey: string): string {
		return `${segIdx}::${fenKey}`;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Queue + walk state
	// ─────────────────────────────────────────────────────────────────────────
	let entries = $state<DrillEntry[]>([]);
	let idx = $state(0);
	let phase = $state<DrillPhase>('loading');
	let chainedEntry = $state<DrillEntry | null>(null);

	// Walks flattened across the merged queue. flatWalkSeg[i] tells us which
	// segment owns walk i — needed so cross-cutting state can disambiguate.
	let flatWalkStarts: number[] = [];
	let flatWalkSeg: number[] = [];
	let flatWalkFenKeys: SvelteSet<string>[] = [];

	// Per-segment leaves cycle gate. In due+non-line-walk mode the segment
	// gets one extra lap of its leaf cards before we move on; in line-walk
	// mode (the default) leaves cycling is skipped because the queue already
	// includes them as part of each line walk.
	const leavesCycledForSeg = new SvelteSet<number>();

	// ─────────────────────────────────────────────────────────────────────────
	// Per-card runtime state. Reset each time `currentEntry` changes.
	// ─────────────────────────────────────────────────────────────────────────
	let currentFen = $state('');
	// Bound to Board.svelte: when true, the next fen-watcher tick suppresses
	// its move/capture sound. We set this before any "snap" — going to the
	// next card's question position, fast-forwarding past well-learned
	// prefix moves, jumping into an idea card. The board still updates;
	// only the sound is muted for that one transition.
	let boardSkipSound = $state(false);

	function snapFen(targetFen: string) {
		boardSkipSound = true;
		currentFen = targetFen;
	}

	let userLastMove = $state<[Key, Key] | undefined>(undefined);
	let userPlayedSan = $state<string | null>(null);
	let correctEdge = $state<Edge | null>(null);
	let correctEdges = $state<Edge[]>([]);
	let hintLevel = $state(0);
	let wrongAttempts = $state(0);
	let moveQuality = $state<MoveQuality | null>(null);
	let gradedSquare = $state<Key | null>(null);
	let refutationSan = $state<string | null>(null);
	let refutationCp = $state<number | null>(null);
	let scrubOffset = $state(0);
	let wrongToken: { cancelled: boolean } = { cancelled: false };
	let skipNextIntro = false;

	// ─────────────────────────────────────────────────────────────────────────
	// Cross-cutting bookkeeping. All keyed by composite (segIdx, fenKey)
	// strings to keep two reps that share a fenKey from poisoning each other.
	// ─────────────────────────────────────────────────────────────────────────
	const drilledKeys = new SvelteSet<string>();
	const introducedKeys = new SvelteSet<string>();
	const failedWalkIndices = new SvelteSet<number>();
	const failedKeysByWalk = new SvelteMap<number, SvelteSet<string>>();
	// Composite keys actually drilled BY each walk (Learn pass). Distinct
	// from `flatWalkFenKeys`, which contains every fenKey scheduled into
	// the walk — including keys that were already drilled by an earlier
	// walk (transposition) and got skipped here. The Train-pass setup
	// uses this to clear ONLY the keys this walk drilled, so a shared
	// fenKey doesn't get re-drilled by every walk that schedules it.
	const drilledByWalk = new SvelteMap<number, SvelteSet<string>>();
	let walkPhase = $state<'learn' | 'train'>('learn');

	// Tracks the "tail" we're working through when we cross out of a
	// segment's last walk. While set, the next walk-completion or
	// idea-completion routes to progressSegmentTail rather than the regular
	// next-walk advance — that's what produces the "drill segment A's walks
	// → drain A's failed walks → play A's ideas → start segment B" order.
	let segTailState = $state<{
		segIdx: number;
		resumeWalk: number;
		stage: 'failedDrain' | 'ideas';
	} | null>(null);
	// Marks segments whose tail (failed drain + ideas) has already been
	// fully processed via the per-segment-tail flow. Stops the end-of-session
	// fallback from running the same ideas a second time.
	const tailedSegments = new SvelteSet<number>();

	// ─────────────────────────────────────────────────────────────────────────
	// Progress tracking
	// ─────────────────────────────────────────────────────────────────────────
	let sessionDone = $state(0);
	let sessionPlannedTotal = $state(0);
	let plannedSlotsDone = $state(0);
	const plannedKeys = new SvelteSet<string>();
	const pendingLapses = new SvelteSet<string>();

	// ─────────────────────────────────────────────────────────────────────────
	// Idea-card phase. ideaSegIdx tracks which segment's tail is currently
	// playing; idea cards interleave per-segment-tail so the user finishes
	// each rep with its own ideas before moving on to the next rep.
	// ─────────────────────────────────────────────────────────────────────────
	let ideaSegIdx = $state(-1);
	let ideaIdx = $state(0);
	let currentIdea = $state<IdeaCard | null>(null);

	// ─────────────────────────────────────────────────────────────────────────
	// Derived selectors
	// ─────────────────────────────────────────────────────────────────────────
	const currentEntry = $derived<DrillEntry | undefined>(chainedEntry ?? entries[idx]);
	const currentSegment = $derived<DrillSegment | undefined>(
		currentEntry ? segments[currentEntry.segIdx] : undefined
	);
	const currentCard = $derived<Card | undefined>(currentEntry?.card);
	const currentRep = $derived(currentSegment?.rep);
	const currentMode = $derived(currentSegment?.mode ?? 'due');
	const currentLineLabel = $derived<string | null>(
		currentEntry && currentSegment
			? (currentSegment.lineLabelByKey.get(currentEntry.card.fenKey) ?? null)
			: null
	);
	const orientation = $derived<'white' | 'black'>(currentRep?.color ?? 'white');
	const sideToMove = $derived<'white' | 'black'>(
		currentFen ? colorToMove(currentFen) : (currentRep?.color ?? 'white')
	);

	// Total open idea cards across all segments (for the idea-phase counter).
	const totalIdeaCount = $derived(segments.reduce((sum, s) => sum + s.ideaQueue.length, 0));
	// Idea cards completed across previous segments.
	const ideaDoneBeforeSeg = $derived.by(() => {
		const out: number[] = [];
		let sum = 0;
		for (const s of segments) {
			out.push(sum);
			sum += s.ideaQueue.length;
		}
		return out;
	});
	const ideaProgressIdx = $derived(
		ideaSegIdx >= 0 ? (ideaDoneBeforeSeg[ideaSegIdx] ?? 0) + ideaIdx : 0
	);

	const progress = $derived.by(() => {
		if (phase === 'idea-prompt' || phase === 'idea-reveal') {
			return totalIdeaCount > 0 ? (ideaProgressIdx / totalIdeaCount) * 100 : 0;
		}
		if (sessionPlannedTotal === 0) return 0;
		const done = Math.min(plannedSlotsDone, sessionPlannedTotal);
		return (done / sessionPlannedTotal) * 100;
	});
	const plannedDoneCount = $derived(Math.min(plannedSlotsDone, sessionPlannedTotal));
	const pendingLapsesCount = $derived(pendingLapses.size);

	const dests = $derived.by<Dests>(() => {
		if (!currentFen || phase !== 'pending') return new Map();
		try {
			const raw = legalDests(currentFen);
			return new Map(Array.from(raw, ([k, v]) => [k as Key, v as Key[]]));
		} catch {
			return new Map();
		}
	});

	// Pre-computed lead-in history: every fen from the rep root down to the
	// question position so the user can scrub backwards.
	const scrubHistory = $derived.by<{
		fens: string[];
		lastMoves: ([Key, Key] | undefined)[];
	}>(() => {
		if (!currentSegment || !currentEntry) return { fens: [], lastMoves: [] };
		const rep = currentSegment.rep;
		const path = pathToFenKey(currentSegment.nodes, rep.rootFenKey, currentEntry.card.fenKey);
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

	const firstTryClean = $derived(wrongAttempts === 0 && hintLevel === 0);
	const isFirstEverCard = $derived(
		!!currentEntry &&
			!currentEntry.card.lastReview &&
			!introducedKeys.has(ck(currentEntry.segIdx, currentEntry.card.fenKey))
	);
	const hintSuppressed = $derived(correctEdges.length > 1 && !isFirstEverCard);

	// ─────────────────────────────────────────────────────────────────────────
	// Constants
	// ─────────────────────────────────────────────────────────────────────────
	const AUTO_ADVANCE_QUICK_MS = 120;
	const AUTO_ADVANCE_SLOW_MS = 1400;
	const WRONG_FLASH_MS = 420;
	const WRONG_SETTLE_MS = 380;
	// Engine probe budget split: `BEFORE` only needs a single cp value
	// (best-line eval at the position the user moved from), so it can
	// run shallower and shorter. `AFTER` needs a usable PV to animate
	// the refutation, so it gets the longer slice.
	const REFUTATION_PROBE_BEFORE_MS = 400;
	const REFUTATION_PROBE_AFTER_MS = 800;
	const REFUTATION_HOLD_MS = 1100;
	const REFUTATION_MAX_PLIES = 6;
	const REFUTATION_PACE_MS = 700;
	// Pause after a line/walk/segment finishes, matched to the slow
	// auto-advance used after a wrong→correct retry. The user needs the same
	// "that was the line" beat between lines as they get between cards in a
	// retried sequence — anything shorter feels rushed.
	const DONE_HOLD_MS = AUTO_ADVANCE_SLOW_MS;

	const currentAutoAdvanceMs = $derived(
		currentMode === 'mistakes' || currentMode === 'retrain'
			? AUTO_ADVANCE_SLOW_MS
			: firstTryClean
				? AUTO_ADVANCE_QUICK_MS
				: AUTO_ADVANCE_SLOW_MS
	);

	// ─────────────────────────────────────────────────────────────────────────
	// Initialisation
	// ─────────────────────────────────────────────────────────────────────────
	onMount(async () => {
		buildFlatQueueFromSegments();
		snapshotPlannedSet();
		const hasMoves = entries.length > 0;
		const hasIdeas = totalIdeaCount > 0;
		if (!hasMoves && hasIdeas) {
			// No drillable cards at all — go straight into idea-only mode.
			void runRemainingIdeas();
		} else {
			phase = entries.length === 0 ? 'empty' : 'pending';
		}
		// Warm up Stockfish in the background so the first wrong-move grade
		// doesn't wait for the NNUE blob.
		void getEngine()
			.init()
			.catch(() => undefined);
	});

	function buildFlatQueueFromSegments() {
		const flat: DrillEntry[] = [];
		flatWalkStarts = [];
		flatWalkSeg = [];
		flatWalkFenKeys = [];
		for (let s = 0; s < segments.length; s++) {
			const seg = segments[s];
			const baseIdx = flat.length;
			for (const c of seg.cards) flat.push({ card: c, segIdx: s });
			for (let w = 0; w < seg.walkStarts.length; w++) {
				flatWalkStarts.push(baseIdx + seg.walkStarts[w]);
				flatWalkSeg.push(s);
				flatWalkFenKeys.push(new SvelteSet(seg.walkFenKeys[w]));
			}
		}
		entries = flat;
		idx = 0;
	}

	function isLineWalkSegment(segIdx: number): boolean {
		const seg = segments[segIdx];
		return seg.mode === 'due' && seg.walkStarts.length > 0;
	}

	/**
	 * Lock in the planned-progress denominator. Predictable extras (Train
	 * passes for walks containing new cards, intro re-queues for brand-new
	 * cards in non-walk mode) are pre-counted; unpredictable extras (auto
	 * wrong re-queue, deferred Train of failed walks, leaves cycle) bump
	 * `sessionPlannedTotal` at their commit sites.
	 */
	function snapshotPlannedSet() {
		plannedKeys.clear();
		pendingLapses.clear();
		plannedSlotsDone = 0;
		walkPhase = 'learn';
		for (const e of entries) plannedKeys.add(ck(e.segIdx, e.card.fenKey));

		let total = 0;
		// Walk-based segments.
		for (let w = 0; w < flatWalkStarts.length; w++) {
			const start = flatWalkStarts[w];
			const end = w + 1 < flatWalkStarts.length ? flatWalkStarts[w + 1] : entries.length;
			let walkLen = 0;
			let walkHasNew = false;
			for (let i = start; i < end; i++) {
				walkLen += 1;
				if (!entries[i].card.lastReview) walkHasNew = true;
			}
			total += walkLen * (walkHasNew ? 2 : 1);
		}
		// Non-walk entries: count brand-new dueOriginalKey cards as 2 slots
		// (intro pass + recall pass). Skip entries already covered by a walk.
		const walkCovered = new SvelteSet<number>();
		for (let w = 0; w < flatWalkStarts.length; w++) {
			const start = flatWalkStarts[w];
			const end = w + 1 < flatWalkStarts.length ? flatWalkStarts[w + 1] : entries.length;
			for (let i = start; i < end; i++) walkCovered.add(i);
		}
		for (let i = 0; i < entries.length; i++) {
			if (walkCovered.has(i)) continue;
			const e = entries[i];
			const seg = segments[e.segIdx];
			const newDue =
				!e.card.lastReview && seg.mode === 'due' && seg.dueOriginalKeys.has(e.card.fenKey);
			total += newDue ? 2 : 1;
		}
		sessionPlannedTotal = total;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Card lifecycle: when currentEntry changes, set up the per-card state and
	// animate the lead-in.
	// ─────────────────────────────────────────────────────────────────────────
	$effect(() => {
		const entry = currentEntry;
		if (!entry || !currentSegment) return;
		const token = { cancelled: false };
		untrack(() => {
			const seg = segments[entry.segIdx];
			const isLineWalkStepCard = seg.mode === 'due' && !seg.dueOriginalKeys.has(entry.card.fenKey);
			hintLevel =
				entry.card.lastReview ||
				introducedKeys.has(ck(entry.segIdx, entry.card.fenKey)) ||
				isLineWalkStepCard
					? 0
					: 2;
			wrongAttempts = 0;
			moveQuality = null;
			gradedSquare = null;
			scrubOffset = 0;
			if (skipNextIntro) {
				skipNextIntro = false;
				userPlayedSan = null;
				correctEdges = acceptedEdgesFor(entry, currentFen);
				correctEdge = correctEdges[0] ?? null;
				phase = 'pending';
				return;
			}
			void startCard(entry, token);
		});
		return () => {
			token.cancelled = true;
		};
	});

	const boardShapes = $derived.by<DrawShape[]>(() => {
		const shapes: DrawShape[] = [];
		if (moveQuality && gradedSquare) {
			shapes.push({
				orig: gradedSquare,
				label: { text: nagGlyph(moveQuality), fill: nagColor(moveQuality) }
			});
		}
		if (phase === 'refuted' && userLastMove) {
			shapes.push({ orig: userLastMove[0], dest: userLastMove[1], brush: 'red' });
		}
		if (phase === 'pending' && hintLevel > 0) {
			const hints = correctEdges.length > 0 ? correctEdges : correctEdge ? [correctEdge] : [];
			const firstEver = !!currentCard && !currentCard.lastReview;
			const multiMove = hints.length > 1;
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

	function fenFromKey(key: string): string {
		const parts = key.split(' ');
		return parts.length === 4 ? `${key} 0 1` : key;
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	function acceptedEdgesFor(entry: DrillEntry, fen: string): Edge[] {
		const seg = segments[entry.segIdx];
		const node = seg.nodes.get(entry.card.fenKey);
		const childSans = node?.children.map((e) => e.san) ?? [];
		const sans = childSans.length > 0 ? childSans : [entry.card.expectedSan];
		const out: Edge[] = [];
		for (const san of sans) {
			const edge = edgeFromSan(fen, san);
			if (edge) out.push(edge);
		}
		return out;
	}

	async function startCard(entry: DrillEntry, token: { cancelled: boolean }) {
		const seg = segments[entry.segIdx];
		const rep = seg.rep;
		userPlayedSan = null;

		const targetFen = fenFromKey(entry.card.fenKey);
		const stepMs = DRILL_INTRO_MS[settings.drillIntroSpeed];

		if (stepMs === 0 || rep.rootFenKey === entry.card.fenKey) {
			snapFen(targetFen);
			userLastMove = undefined;
			correctEdges = acceptedEdgesFor(entry, currentFen);
			correctEdge = correctEdges[0] ?? null;
			phase = 'pending';
			return;
		}

		// Re-queued intro-pass cards skip the lead-in: the user already
		// watched the line walk through once on the first pass, so making
		// them sit through it again would be the "all lines visualised"
		// anti-pattern the line walk is meant to avoid.
		if (introducedKeys.has(ck(entry.segIdx, entry.card.fenKey))) {
			snapFen(targetFen);
			userLastMove = undefined;
			correctEdges = acceptedEdgesFor(entry, currentFen);
			correctEdge = correctEdges[0] ?? null;
			phase = 'pending';
			return;
		}

		const pathFromRoot = pathToFenKey(seg.nodes, rep.rootFenKey, entry.card.fenKey);
		if (!pathFromRoot || pathFromRoot.length === 0) {
			snapFen(targetFen);
			userLastMove = undefined;
			correctEdges = acceptedEdgesFor(entry, currentFen);
			correctEdge = correctEdges[0] ?? null;
			phase = 'pending';
			return;
		}

		// Tail-only animation: if the board is already on a position on the
		// path to the target (e.g. we just chained), only animate the
		// remaining plies instead of rewinding to the root.
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

		// Honour the "open at starting position" preference. In line-walk
		// mode the fast-forward is suppressed: the line walk already drops
		// well-learned moves out of the drill pool, so anything that ended
		// up *before* the queue's first card is exactly the well-learned
		// context the user wants to *see* play out as a refresher.
		const lineWalkModeIntro = isLineWalkSegment(entry.segIdx);
		let skippedFen: string | null = null;
		let skippedLastMove: [Key, Key] | undefined;
		if (startIdx === 0 && settings.openAtStartingPosition !== false && !lineWalkModeIntro) {
			const startKey = rep.startingFenKey ?? furthestNonBranchingFenKey(seg.nodes, rep.rootFenKey);
			if (startKey && startKey !== rep.rootFenKey && startKey !== entry.card.fenKey) {
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
			snapFen(fen);
			userLastMove = skippedLastMove;
		} else if (startIdx === 0) {
			fen = rep.rootFen;
			snapFen(fen);
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
		correctEdges = acceptedEdgesFor(entry, currentFen);
		correctEdge = correctEdges[0] ?? null;
		phase = 'pending';
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Move handling
	// ─────────────────────────────────────────────────────────────────────────
	function handleMove(orig: Key, dest: Key, _m: MoveMetadata) {
		if (!currentEntry || !currentSegment || phase !== 'pending') return;
		const promo = isPromotionMove(currentFen, orig, dest) ? 'q' : undefined;
		const edge = edgeFromUci(currentFen, orig, dest, promo);
		if (!edge) return;
		currentFen = fenAfterMove(currentFen, edge);
		userLastMove = [orig, dest];
		userPlayedSan = edge.san;
		gradedSquare = dest;

		const node = currentSegment.nodes.get(currentEntry.card.fenKey);
		const accepted = new Set<string>(
			node?.children.map((e) => e.san) ?? [currentEntry.card.expectedSan]
		);
		if (accepted.has(edge.san)) {
			moveQuality = 'correct';
			phase = 'correct';
			playCorrect();
			const key = ck(currentEntry.segIdx, currentEntry.card.fenKey);
			if (plannedKeys.has(key)) {
				plannedSlotsDone += 1;
			}
		} else {
			wrongAttempts += 1;
			moveQuality = null;
			phase = 'wrong';
			void runWrongSequence(currentEntry);
		}
	}

	async function runWrongSequence(entry: DrillEntry) {
		wrongToken.cancelled = true;
		const token = { cancelled: false };
		wrongToken = token;

		// At this point `currentFen` has already been advanced to the
		// post-move position by `handleMove`. The starting position of
		// the card (= fenBefore) is reconstructed from its fenKey.
		const fenBefore = fenFromKey(entry.card.fenKey);
		const wrongFen = currentFen;
		refutationSan = null;
		refutationCp = null;

		await sleep(WRONG_FLASH_MS);
		if (token.cancelled) return;

		const probe = await probeMoveEvals(
			fenBefore,
			wrongFen,
			REFUTATION_PROBE_BEFORE_MS,
			REFUTATION_PROBE_AFTER_MS
		);
		if (token.cancelled) return;

		// Grade by cpLoss + absolute-eval context when both probes
		// landed. If only the after-position eval is available, fall
		// back to the absolute-magnitude tiers (no "gave_advantage"
		// detection, but at least the loud cases still land).
		moveQuality = probe ? gradeMove(probe.bestUserPov, probe.playedUserPov) : 'dubious';
		if (moveQuality === 'playable') playCorrect();
		else playIncorrect();

		const refute = probe !== null && shouldRefute(moveQuality);

		if (refute && probe) {
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
				currentFen = nextFen;
				userLastMove = [orig, dest];
				if (i === 0) {
					refutationSan = pvEdge.san;
					refutationCp = probe.refutationCp;
					phase = 'refuted';
				}
				showFen = nextFen;
			}
			await sleep(REFUTATION_HOLD_MS);
			if (token.cancelled) return;
		} else {
			await sleep(400);
			if (token.cancelled) return;
		}

		currentFen = fenFromKey(entry.card.fenKey);
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

	function showHint() {
		if (phase !== 'pending') return;
		if (hintSuppressed) return;
		if (hintLevel === 0 && currentCard && !currentCard.lastReview) {
			hintLevel = 2;
			return;
		}
		hintLevel = Math.min(hintLevel + 1, 2);
	}

	function deriveOutcome(): DrillOutcome {
		if (wrongAttempts > 0) return 'wrong';
		if (hintLevel > 0) return 'peeked';
		return 'correct';
	}

	$effect(() => {
		if (phase !== 'correct') return;
		const delay = currentAutoAdvanceMs;
		const timer = setTimeout(() => {
			void rateAndAdvance(deriveOutcome());
		}, delay);
		return () => clearTimeout(timer);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Rate + advance
	// ─────────────────────────────────────────────────────────────────────────
	async function rateAndAdvance(outcome: DrillOutcome) {
		if (!currentEntry || !currentSegment) return;
		const entry = currentEntry;
		const seg = segments[entry.segIdx];
		const ratedCard = entry.card;
		const compositeKey = ck(entry.segIdx, ratedCard.fenKey);

		const isLineWalkStep = seg.mode === 'due' && !seg.dueOriginalKeys.has(ratedCard.fenKey);
		const lineWalkMode = isLineWalkSegment(entry.segIdx);

		const isIntroductionPass =
			!ratedCard.lastReview &&
			!introducedKeys.has(compositeKey) &&
			seg.mode === 'due' &&
			!isLineWalkStep &&
			!lineWalkMode;

		if (!isLineWalkStep) {
			const updated = reviewCard(ratedCard, outcomeToRating(outcome), settings.fsrsParams);
			await upsertCard(updated);
		}
		sessionDone += 1;

		if (plannedKeys.has(compositeKey)) {
			if (outcome === 'wrong' && !isIntroductionPass && !isLineWalkStep) {
				pendingLapses.add(compositeKey);
			} else if (outcome !== 'wrong') {
				pendingLapses.delete(compositeKey);
			}
		}

		// Mark the failed walk for the end-of-session retry pass. Walk-index
		// granularity avoids transposition false positives; per-walk
		// fenKey granularity narrows the retry to actually-failed cards.
		if (outcome === 'wrong' && !isIntroductionPass && walkPhase === 'learn') {
			const failedWalk = walkOfIdx(idx);
			if (failedWalk >= 0) {
				failedWalkIndices.add(failedWalk);
				let keys = failedKeysByWalk.get(failedWalk);
				if (!keys) {
					keys = new SvelteSet<string>();
					failedKeysByWalk.set(failedWalk, keys);
				}
				keys.add(ratedCard.fenKey);
			}
		}

		// Train pass (line-walk mode): track which fenKeys were drilled
		// in the Learn pass so the second pass clears them and re-runs.
		if (
			lineWalkMode &&
			!ratedCard.lastReview &&
			walkPhase === 'learn' &&
			!introducedKeys.has(compositeKey)
		) {
			introducedKeys.add(compositeKey);
		}

		const willReDrill =
			!lineWalkMode && (isIntroductionPass || (outcome === 'wrong' && !isLineWalkStep));
		if (!willReDrill) {
			drilledKeys.add(compositeKey);
			if (lineWalkMode) {
				const w = walkOfIdx(idx);
				if (w >= 0) {
					let s = drilledByWalk.get(w);
					if (!s) {
						s = new SvelteSet<string>();
						drilledByWalk.set(w, s);
					}
					s.add(compositeKey);
				}
			}
		}
		if (isIntroductionPass) {
			introducedKeys.add(compositeKey);
			entries = [...entries, entry];
		}

		if (seg.mode === 'retrain' && (outcome === 'correct' || outcome === 'easy')) {
			await markMistakeByPosition(seg.rep.id, ratedCard.fenKey);
		}

		// Wrong-answer prune: drop later queue entries in the SAME segment
		// that pass through the failed position. Other segments' cards stay
		// — those are independent reps and their lines aren't compromised.
		if (
			outcome === 'wrong' &&
			!isIntroductionPass &&
			!isLineWalkStep &&
			!lineWalkMode &&
			seg.mode !== 'retrain'
		) {
			pruneDeeperInLine(entry.segIdx, ratedCard.fenKey);
		}

		// Re-queue at the tail (auto mode only). Skipped for intro pass
		// (already queued), line-walk, and any line-walk step.
		if (outcome === 'wrong' && !isIntroductionPass && !isLineWalkStep && !lineWalkMode) {
			entries = [...entries, entry];
			if (plannedKeys.has(compositeKey)) sessionPlannedTotal += 1;
		}

		// Chain into next user reply — same segment only.
		if (outcome === 'correct' || outcome === 'easy' || outcome === 'peeked') {
			// Alt-move pruning: when the user picked a prepared reply other
			// than card.expectedSan at a multi-child decision point, drop
			// queued entries that sit exclusively under the unchosen
			// siblings. Without this, the rest of the session would still
			// surface those siblings' continuation cards even though the
			// user never visited them on this run.
			const decisionNode = seg.nodes.get(ratedCard.fenKey);
			const playedSan = userPlayedSan;
			if (
				decisionNode &&
				decisionNode.children.length > 1 &&
				playedSan &&
				playedSan !== ratedCard.expectedSan
			) {
				const chosen = decisionNode.children.find((c) => c.san === playedSan);
				if (chosen) pruneUnchosenSiblings(entry.segIdx, ratedCard.fenKey, chosen.toFenKey);
			}
			const next = await findNextInLine(entry);
			if (next) {
				await playChainTransition(entry, next);
				return;
			}
		}

		advanceQueue(ratedCard.fenKey);
	}

	function pruneDeeperInLine(segIdx: number, failedFenKey: string) {
		const seg = segments[segIdx];
		const filtered: DrillEntry[] = [];
		const oldToNew: (number | null)[] = new Array(entries.length).fill(null);
		const keep = (i: number, e: DrillEntry) => {
			oldToNew[i] = filtered.length;
			filtered.push(e);
		};
		for (let i = 0; i < entries.length; i++) {
			if (i <= idx) {
				keep(i, entries[i]);
				continue;
			}
			const other = entries[i];
			if (other.segIdx !== segIdx) {
				keep(i, other);
				continue;
			}
			const path = pathToFenKey(seg.nodes, seg.rep.rootFenKey, other.card.fenKey);
			if (!path) {
				keep(i, other);
				continue;
			}
			const passes = path.some((e) => e.toFenKey === failedFenKey);
			if (!passes) keep(i, other);
		}
		if (filtered.length === entries.length) return;
		entries = filtered;
		rewriteWalkArraysAfterPrune(oldToNew);
	}

	/**
	 * Drop queued entries that sit exclusively under the user's *un*chosen
	 * siblings at a multi-child decision point. Without this, after the user
	 * picks alt move x at a position with prepared replies {x, y}, the
	 * already-queued y-continuation cards would still get surfaced later in
	 * the session — even though the user never visited those positions on
	 * this run. Entries that share a fenKey with the chosen subtree (a real
	 * transposition) are kept; only fenKeys reachable solely through the
	 * unchosen branch are dropped.
	 */
	function pruneUnchosenSiblings(segIdx: number, decisionFenKey: string, chosenChildKey: string) {
		const seg = segments[segIdx];
		const node = seg.nodes.get(decisionFenKey);
		if (!node || node.children.length <= 1) return;

		const collect = (rootKey: string): SvelteSet<string> => {
			const out = new SvelteSet<string>();
			const stack: string[] = [rootKey];
			while (stack.length > 0) {
				const k = stack.pop()!;
				if (out.has(k)) continue;
				out.add(k);
				const n = seg.nodes.get(k);
				if (!n) continue;
				for (const e of n.children) stack.push(e.toFenKey);
			}
			return out;
		};

		const unchosenSubtree = new SvelteSet<string>();
		for (const child of node.children) {
			if (child.toFenKey === chosenChildKey) continue;
			for (const k of collect(child.toFenKey)) unchosenSubtree.add(k);
		}
		const chosenSubtree = collect(chosenChildKey);

		const filtered: DrillEntry[] = [];
		const oldToNew: (number | null)[] = new Array(entries.length).fill(null);
		const keep = (i: number, e: DrillEntry) => {
			oldToNew[i] = filtered.length;
			filtered.push(e);
		};
		for (let i = 0; i < entries.length; i++) {
			if (i <= idx) {
				keep(i, entries[i]);
				continue;
			}
			const other = entries[i];
			if (other.segIdx !== segIdx) {
				keep(i, other);
				continue;
			}
			if (unchosenSubtree.has(other.card.fenKey) && !chosenSubtree.has(other.card.fenKey)) {
				continue;
			}
			keep(i, other);
		}
		if (filtered.length === entries.length) return;
		entries = filtered;
		rewriteWalkArraysAfterPrune(oldToNew);
	}

	/**
	 * Rebuild `flatWalkStarts` / `flatWalkSeg` / `flatWalkFenKeys` after a
	 * prune mutated `entries`. Without this, walk-end indices computed by
	 * `walkEndOf` reference positions past the new `entries.length` and
	 * `advanceQueue`'s line-walk loop reads `entries[next]` as `undefined`,
	 * crashing `rateAndAdvance` and stranding `phase` at `'correct'` — the
	 * "drill stops and hangs after an alt move" symptom.
	 *
	 * `oldToNew[i]` is the new index of `entries_old[i]`, or `null` if it
	 * was pruned. For each walk we map its original start to the smallest
	 * surviving new index in its original [start, end) range. Walks whose
	 * entries were all pruned are dropped, and any `failedWalkIndices` /
	 * `failedKeysByWalk` references are remapped or dropped accordingly.
	 */
	function rewriteWalkArraysAfterPrune(oldToNew: (number | null)[]) {
		const newStarts: number[] = [];
		const newSegs: number[] = [];
		const newFenKeys: SvelteSet<string>[] = [];
		const oldWalkToNewWalk = new SvelteMap<number, number>();
		for (let w = 0; w < flatWalkStarts.length; w++) {
			const startOld = flatWalkStarts[w];
			const endOld = w + 1 < flatWalkStarts.length ? flatWalkStarts[w + 1] : oldToNew.length;
			let firstSurviving: number | null = null;
			for (let i = startOld; i < endOld; i++) {
				const ni = oldToNew[i];
				if (ni !== null) {
					firstSurviving = ni;
					break;
				}
			}
			if (firstSurviving === null) continue;
			oldWalkToNewWalk.set(w, newStarts.length);
			newStarts.push(firstSurviving);
			newSegs.push(flatWalkSeg[w]);
			newFenKeys.push(flatWalkFenKeys[w]);
		}
		flatWalkStarts = newStarts;
		flatWalkSeg = newSegs;
		flatWalkFenKeys = newFenKeys;

		const remappedFailed: number[] = [];
		for (const w of failedWalkIndices) {
			const nw = oldWalkToNewWalk.get(w);
			if (nw !== undefined) remappedFailed.push(nw);
		}
		failedWalkIndices.clear();
		for (const nw of remappedFailed) failedWalkIndices.add(nw);

		const remappedKeys = new SvelteMap<number, SvelteSet<string>>();
		for (const [w, keys] of failedKeysByWalk) {
			const nw = oldWalkToNewWalk.get(w);
			if (nw !== undefined) remappedKeys.set(nw, keys);
		}
		failedKeysByWalk.clear();
		for (const [nw, keys] of remappedKeys) failedKeysByWalk.set(nw, keys);

		const remappedDrilled = new SvelteMap<number, SvelteSet<string>>();
		for (const [w, keys] of drilledByWalk) {
			const nw = oldWalkToNewWalk.get(w);
			if (nw !== undefined) remappedDrilled.set(nw, keys);
		}
		drilledByWalk.clear();
		for (const [nw, keys] of remappedDrilled) drilledByWalk.set(nw, keys);
	}

	function effectivePlayedSan(entry: DrillEntry): string {
		const seg = segments[entry.segIdx];
		const node = seg.nodes.get(entry.card.fenKey);
		const played = userPlayedSan;
		if (played && node && node.children.some((c) => c.san === played)) {
			return played;
		}
		return entry.card.expectedSan;
	}

	async function findNextInLine(entry: DrillEntry): Promise<DrillEntry | null> {
		const seg = segments[entry.segIdx];
		// Mistake / retrain modes don't chain — each entry is an explicit
		// deviation the user is here to address.
		if (seg.mode === 'mistakes' || seg.mode === 'retrain') return null;
		const cardFen = fenFromKey(entry.card.fenKey);
		const playedSan = effectivePlayedSan(entry);
		const userEdge = edgeFromSan(cardFen, playedSan);
		if (!userEdge) return null;
		const postUserFen = fenAfterMove(cardFen, userEdge);
		const postUserKey = fenKeyFromFen(postUserFen);
		const nodeAfterUser = seg.nodes.get(postUserKey);
		if (!nodeAfterUser || nodeAfterUser.children.length === 0) return null;
		const oppEdge = nodeAfterUser.children[0];
		const nextKey = ck(entry.segIdx, oppEdge.toFenKey);
		if (drilledKeys.has(nextKey)) return null;
		// Walk-boundary gate (line-walk mode only). With shared-prefix
		// extraction (see buildSegment), a single line of play is split
		// across multiple walks: shared trunk + per-line tails. If the
		// chain crossed those boundaries, the next walk's cards would
		// drill during *this* walk's Learn pass, then again during this
		// walk's Train pass, and yet again when the next walk actually
		// starts — inflating plannedSlotsDone and producing duplicate
		// Train passes. Bail when the chain target lives in a different
		// admitted walk in the same segment; alt-divergence (target not
		// in any admitted walk) is allowed to fall through below.
		if (isLineWalkSegment(entry.segIdx)) {
			const currentWalk = walkOfIdx(idx);
			if (currentWalk >= 0) {
				const inCurrent = flatWalkFenKeys[currentWalk]?.has(oppEdge.toFenKey) ?? false;
				if (!inCurrent) {
					let inOtherAdmitted = false;
					for (let w = 0; w < flatWalkFenKeys.length; w++) {
						if (w === currentWalk) continue;
						if (flatWalkSeg[w] !== entry.segIdx) continue;
						if (flatWalkFenKeys[w].has(oppEdge.toFenKey)) {
							inOtherAdmitted = true;
							break;
						}
					}
					if (inOtherAdmitted) return null;
				}
			}
		}
		// Cap respect: never chain past the planned queue, *except* when the
		// user just diverged onto an alt prepared reply at a multi-child card.
		// In that case the alt-line continuation almost certainly wasn't
		// pre-planned (the line walk was built around `card.expectedSan`),
		// and bailing here would surface the unchosen branch's queued card
		// next — exactly the "I played x but it continued with y" bug.
		// Promote the alt-continuation into plannedKeys so progress
		// accounting stays consistent with the new chained card.
		if (seg.mode === 'due' && !plannedKeys.has(nextKey)) {
			const decisionNode = seg.nodes.get(entry.card.fenKey);
			const isAltDivergence =
				!!decisionNode && decisionNode.children.length > 1 && playedSan !== entry.card.expectedSan;
			if (!isAltDivergence) return null;
			plannedKeys.add(nextKey);
			sessionPlannedTotal += 1;
		}
		const nextCard = await getCard(seg.rep.id, oppEdge.toFenKey);
		if (!nextCard) return null;
		return { card: nextCard, segIdx: entry.segIdx };
	}

	async function playChainTransition(prev: DrillEntry, next: DrillEntry) {
		const seg = segments[prev.segIdx];
		const cardFen = fenFromKey(prev.card.fenKey);
		const playedSan = effectivePlayedSan(prev);
		const userEdge = edgeFromSan(cardFen, playedSan);
		if (!userEdge) {
			advanceQueue();
			return;
		}
		const postUserFen = fenAfterMove(cardFen, userEdge);
		const postUserKey = fenKeyFromFen(postUserFen);
		const nodeAfterUser = seg.nodes.get(postUserKey);
		const oppEdge = nodeAfterUser?.children[0];
		if (!oppEdge) {
			advanceQueue();
			return;
		}
		const postOppFen = fenAfterMove(postUserFen, oppEdge);

		const stepMs = DRILL_INTRO_MS[settings.drillIntroSpeed];
		const pace = stepMs > 0 ? stepMs : 250;

		if (fenKeyFromFen(currentFen) !== postUserKey) {
			await sleep(Math.round(pace * 0.6));
			currentFen = postUserFen;
			userLastMove = [userEdge.uci.slice(0, 2) as Key, userEdge.uci.slice(2, 4) as Key];
		}

		await sleep(pace);
		currentFen = postOppFen;
		userLastMove = [oppEdge.uci.slice(0, 2) as Key, oppEdge.uci.slice(2, 4) as Key];

		skipNextIntro = true;
		chainedEntry = next;
	}

	function maybeOpenWalkAt(queueIdx: number) {
		const walk = flatWalkStarts.indexOf(queueIdx);
		if (walk < 0) return;
		const segIdx = flatWalkSeg[walk];
		const keys = flatWalkFenKeys[walk];
		if (!keys) return;
		for (const k of keys) drilledKeys.delete(ck(segIdx, k));
	}

	function walkOfIdx(queueIdx: number): number {
		for (let i = flatWalkStarts.length - 1; i >= 0; i--) {
			if (flatWalkStarts[i] <= queueIdx) return i;
		}
		return -1;
	}

	function walkEndOf(w: number): number {
		return w + 1 < flatWalkStarts.length ? flatWalkStarts[w + 1] : entries.length;
	}

	function walkNeedsTrain(walkIdx: number): boolean {
		const segIdx = flatWalkSeg[walkIdx];
		const keys = flatWalkFenKeys[walkIdx];
		if (!keys) return false;
		for (const k of keys) {
			if (introducedKeys.has(ck(segIdx, k))) return true;
		}
		return false;
	}

	function advanceQueue(justRatedKey?: string) {
		const currentWalk = walkOfIdx(idx);
		const currentSegIdx = currentEntry?.segIdx ?? -1;
		const currentSeg = currentSegIdx >= 0 ? segments[currentSegIdx] : null;
		const lineWalkMode = currentSeg ? isLineWalkSegment(currentSegIdx) : false;

		// Auto-mode (no walks) or a segment with no walks → linear advance.
		if (!lineWalkMode || currentWalk < 0) {
			let next = idx + 1;
			while (next < entries.length) {
				maybeOpenWalkAt(next);
				const nextEntry = entries[next];
				if (!nextEntry) break;
				if (
					drilledKeys.has(ck(nextEntry.segIdx, nextEntry.card.fenKey)) ||
					(nextEntry.segIdx === currentSegIdx && nextEntry.card.fenKey === justRatedKey)
				) {
					next++;
					continue;
				}
				break;
			}
			if (next >= entries.length) {
				setTimeout(async () => {
					// Try ideas for the *current* segment first, then leaves
					// cycle for it (if not yet cycled), then move on.
					if (currentSegIdx >= 0) {
						if (await tryStartIdeasOrLeaves(currentSegIdx)) return;
					}
					phase = 'done';
				}, DONE_HOLD_MS);
			} else {
				chainedEntry = null;
				idx = next;
			}
			return;
		}

		// Line-walk mode: stay inside the current walk.
		const walkEnd = Math.min(walkEndOf(currentWalk), entries.length);
		let next = idx + 1;
		while (next < walkEnd) {
			const nextEntry = entries[next];
			if (!nextEntry) break;
			if (
				drilledKeys.has(ck(nextEntry.segIdx, nextEntry.card.fenKey)) ||
				(nextEntry.segIdx === currentSegIdx && nextEntry.card.fenKey === justRatedKey)
			) {
				next++;
				continue;
			}
			break;
		}
		if (next < walkEnd) {
			chainedEntry = null;
			idx = next;
			return;
		}

		// Walk exhausted: Train pass (if it had new cards) or transition.
		if (walkPhase === 'learn' && walkNeedsTrain(currentWalk)) {
			setTimeout(() => {
				walkPhase = 'train';
				// Only clear drilled-keys this walk actually drilled. Shared
				// trunks now live in their own walk (see buildSegment); for
				// transposed fenKeys that show up in multiple walks, we
				// still avoid unwinding the prior walk's progress.
				const drilledHere = drilledByWalk.get(currentWalk);
				if (drilledHere) {
					for (const ck_ of drilledHere) drilledKeys.delete(ck_);
					drilledByWalk.delete(currentWalk);
				}
				failedWalkIndices.delete(currentWalk);
				failedKeysByWalk.delete(currentWalk);
				chainedEntry = null;
				idx = flatWalkStarts[currentWalk];
				phase = 'pending';
			}, DONE_HOLD_MS);
			return;
		}

		// If we're in a segment-tail drain (currentWalk is a failed-walk
		// retry), continue draining that segment's tail before moving on.
		if (segTailState && flatWalkSeg[currentWalk] === segTailState.segIdx) {
			setTimeout(() => progressSegmentTail(), DONE_HOLD_MS);
			return;
		}

		// Crossing into a new segment? Run the *current* segment's tail
		// (failed-walk drain → ideas) before starting the next segment's
		// walks. Same segment → just move to next walk.
		const nextWalk = currentWalk + 1;
		const currentWalkSeg = flatWalkSeg[currentWalk];
		const nextWalkSeg = nextWalk < flatWalkStarts.length ? flatWalkSeg[nextWalk] : -1;
		if (nextWalkSeg !== currentWalkSeg) {
			setTimeout(() => enterSegmentTail(currentWalkSeg, nextWalk), DONE_HOLD_MS);
			return;
		}

		setTimeout(() => moveToWalk(nextWalk), DONE_HOLD_MS);
	}

	function moveToWalk(target: number) {
		while (target < flatWalkStarts.length) {
			walkPhase = 'learn';
			const walkStart = flatWalkStarts[target];
			const walkEnd = walkEndOf(target);
			maybeOpenWalkAt(walkStart);
			let restart = walkStart;
			while (
				restart < walkEnd &&
				drilledKeys.has(ck(entries[restart].segIdx, entries[restart].card.fenKey))
			) {
				restart++;
			}
			if (restart < walkEnd) {
				chainedEntry = null;
				idx = restart;
				phase = 'pending';
				return;
			}
			target += 1;
		}

		// No more walks of any kind. Flush ideas for any segment whose tail
		// hasn't been processed (covers segments that had only ideas, no
		// walks — e.g. an empty due queue but pending idea cards), then end.
		void runRemainingIdeas();
	}

	function enterSegmentTail(segIdx: number, resumeWalk: number) {
		segTailState = { segIdx, resumeWalk, stage: 'failedDrain' };
		progressSegmentTail();
	}

	function progressSegmentTail() {
		if (!segTailState) return;
		const { segIdx, resumeWalk } = segTailState;

		if (segTailState.stage === 'failedDrain') {
			// Find next failed walk in this segment. Walk-index granularity
			// avoids transposition false positives; per-walk fenKey
			// granularity narrows the retry to actually-failed cards.
			const failedInSeg: number[] = [];
			for (const w of failedWalkIndices) {
				if (flatWalkSeg[w] === segIdx) failedInSeg.push(w);
			}
			if (failedInSeg.length > 0) {
				const next = Math.min(...failedInSeg);
				failedWalkIndices.delete(next);
				const failedKeys = failedKeysByWalk.get(next);
				failedKeysByWalk.delete(next);
				if (!failedKeys || failedKeys.size === 0) {
					// Spurious entry — recurse to try the next failed walk.
					progressSegmentTail();
					return;
				}
				let plannedFails = 0;
				for (const k of failedKeys) {
					drilledKeys.delete(ck(segIdx, k));
					if (plannedKeys.has(ck(segIdx, k))) plannedFails++;
				}
				const walkStart = flatWalkStarts[next];
				const walkEnd = walkEndOf(next);
				let firstFailed = walkStart;
				while (
					firstFailed < walkEnd &&
					drilledKeys.has(ck(entries[firstFailed].segIdx, entries[firstFailed].card.fenKey))
				) {
					firstFailed++;
				}
				if (firstFailed >= walkEnd) {
					progressSegmentTail();
					return;
				}
				walkPhase = 'train';
				sessionPlannedTotal += plannedFails;
				chainedEntry = null;
				idx = firstFailed;
				phase = 'pending';
				return;
			}
			// Failed drain done — move to ideas stage.
			segTailState = { segIdx, resumeWalk, stage: 'ideas' };
		}

		if (segTailState.stage === 'ideas') {
			const seg = segments[segIdx];
			if (seg.ideaQueue.length > 0) {
				startIdeaPhaseAt(segIdx);
				return;
			}
			// No ideas — fall through to exit.
		}

		// Tail complete for this segment.
		exitSegmentTail();
	}

	function exitSegmentTail() {
		if (!segTailState) return;
		const { segIdx, resumeWalk } = segTailState;
		tailedSegments.add(segIdx);
		segTailState = null;
		if (resumeWalk < flatWalkStarts.length) {
			moveToWalk(resumeWalk);
			return;
		}
		// No more walks — but earlier segments without walks may still have
		// idea cards waiting. Surface them.
		void runRemainingIdeas();
	}

	async function runRemainingIdeas() {
		for (let i = 0; i < segments.length; i++) {
			if (tailedSegments.has(i)) continue;
			if (segments[i].ideaQueue.length > 0) {
				// Mark as a non-resuming tail so onIdeasExhausted advances
				// to the next segment's ideas (or done) without coming back
				// here for the same segment.
				segTailState = { segIdx: i, resumeWalk: flatWalkStarts.length, stage: 'ideas' };
				startIdeaPhaseAt(i);
				return;
			}
			tailedSegments.add(i);
		}
		phase = 'done';
	}

	/**
	 * Try to extend a segment's tail with ideas first, then leaves cycle
	 * (only when the segment was non-line-walk). Returns true if something
	 * was queued and the runner should not yet declare the session done.
	 */
	async function tryStartIdeasOrLeaves(segIdx: number): Promise<boolean> {
		const seg = segments[segIdx];
		if (seg.ideaQueue.length > 0 && !tailedSegments.has(segIdx)) {
			startIdeaPhaseAt(segIdx);
			return true;
		}
		// Leaves cycle (mode 'due', non-line-walk only).
		if (seg.mode === 'due' && !isLineWalkSegment(segIdx) && !leavesCycledForSeg.has(segIdx)) {
			const added = await extendSegmentWithLeaves(segIdx);
			if (added > 0) {
				chainedEntry = null;
				phase = 'pending';
				return true;
			}
		}
		tailedSegments.add(segIdx);
		return await tryAdvanceToNextSegment(segIdx);
	}

	async function tryAdvanceToNextSegment(fromSegIdx: number): Promise<boolean> {
		// In line-walk mode the segment transition is handled by moveToWalk;
		// this path only fires for non-walk segments. Look for the next
		// segment that still has work (cards we haven't drilled, or ideas).
		for (let s = fromSegIdx + 1; s < segments.length; s++) {
			const seg = segments[s];
			// Find first undrilled entry in this segment.
			for (let i = 0; i < entries.length; i++) {
				if (entries[i].segIdx !== s) continue;
				if (!drilledKeys.has(ck(s, entries[i].card.fenKey))) {
					chainedEntry = null;
					idx = i;
					phase = 'pending';
					return true;
				}
			}
			if (seg.ideaQueue.length > 0) {
				startIdeaPhaseAt(s);
				return true;
			}
		}
		return false;
	}

	async function extendSegmentWithLeaves(segIdx: number): Promise<number> {
		const seg = segments[segIdx];
		if (leavesCycledForSeg.has(segIdx)) return 0;
		const leaves = await collectLeafCards(seg.rep, seg.nodes);
		if (leaves.length === 0) {
			leavesCycledForSeg.add(segIdx);
			return 0;
		}
		const sorted = sortLeavesByLineOrder(leaves, seg.rep, seg.nodes);
		// Reset drilled state for these leaves so they replay.
		for (const c of sorted.cards) drilledKeys.delete(ck(segIdx, c.fenKey));
		// Merge leaf labels into the segment's labelmap.
		for (const [k, v] of sorted.lineLabelByKey) {
			if (!seg.lineLabelByKey.has(k)) seg.lineLabelByKey.set(k, v);
		}
		let extraSlots = 0;
		for (const c of sorted.cards) if (plannedKeys.has(ck(segIdx, c.fenKey))) extraSlots++;
		sessionPlannedTotal += extraSlots;
		// Replace the segment's portion of the queue with the leaves. Find
		// the [segStart, segEnd) range and splice.
		let segStart = -1;
		let segEnd = entries.length;
		for (let i = 0; i < entries.length; i++) {
			if (entries[i].segIdx === segIdx) {
				if (segStart === -1) segStart = i;
				segEnd = i + 1;
			}
		}
		const newEntries: DrillEntry[] = [];
		for (let i = 0; i < entries.length; i++) {
			if (i < (segStart === -1 ? entries.length : segStart) || i >= segEnd) {
				newEntries.push(entries[i]);
			}
		}
		// Insert leaves at segStart (or end if segment had no entries).
		const insertAt = segStart === -1 ? newEntries.length : segStart;
		const leafEntries: DrillEntry[] = sorted.cards.map((c) => ({ card: c, segIdx }));
		newEntries.splice(insertAt, 0, ...leafEntries);
		entries = newEntries;
		idx = insertAt;
		leavesCycledForSeg.add(segIdx);
		return leafEntries.length;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Idea phase
	// ─────────────────────────────────────────────────────────────────────────
	function startIdeaPhaseAt(segIdx: number) {
		if (segIdx < 0 || segIdx >= segments.length) {
			phase = 'done';
			return;
		}
		const seg = segments[segIdx];
		if (seg.ideaQueue.length === 0) {
			// Skip to the next segment with ideas.
			const next = nextSegmentWithIdeasAfter(segIdx);
			if (next >= 0) startIdeaPhaseAt(next);
			else phase = 'done';
			return;
		}
		ideaSegIdx = segIdx;
		ideaIdx = 0;
		currentIdea = seg.ideaQueue[0];
		snapFen(fenFromKey(currentIdea.fenKey));
		userLastMove = undefined;
		correctEdge = null;
		correctEdges = [];
		moveQuality = null;
		gradedSquare = null;
		phase = 'idea-prompt';
	}

	function nextSegmentWithIdeasAfter(segIdx: number): number {
		for (let i = segIdx + 1; i < segments.length; i++) {
			if (segments[i].ideaQueue.length > 0) return i;
		}
		return -1;
	}

	function revealIdea() {
		if (phase === 'idea-prompt') phase = 'idea-reveal';
	}

	async function rateIdea(outcome: DrillOutcome) {
		if (!currentIdea) return;
		const seg = segments[ideaSegIdx];
		const next = reviewCard(currentIdea, outcomeToRating(outcome), settings.fsrsParams);
		await upsertIdeaCard(next);
		sessionDone += 1;
		const nextIdx = ideaIdx + 1;
		if (nextIdx >= seg.ideaQueue.length) {
			currentIdea = null;
			if (segTailState) {
				// In a segment-tail context: hand control back to the tail
				// flow, which will exit and resume walks (or move on).
				exitSegmentTail();
				return;
			}
			// Non-walk-mode segment tail (e.g. mistakes / retrain). Mark
			// this segment done and try to advance to the next segment's
			// queue; if none, fall through to the global remainder.
			tailedSegments.add(ideaSegIdx);
			if (await tryAdvanceToNextSegment(ideaSegIdx)) return;
			const nextSegIdeas = nextSegmentWithIdeasAfter(ideaSegIdx);
			if (nextSegIdeas >= 0) {
				startIdeaPhaseAt(nextSegIdeas);
				return;
			}
			phase = 'done';
			return;
		}
		ideaIdx = nextIdx;
		currentIdea = seg.ideaQueue[nextIdx];
		snapFen(fenFromKey(currentIdea.fenKey));
		phase = 'idea-prompt';
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Scrubbing (lead-in history)
	// ─────────────────────────────────────────────────────────────────────────
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
			if (
				!scrubActive &&
				(e.key === 'z' || e.key === 'Z' || e.key === '?' || e.key === 'h' || e.key === 'H')
			) {
				e.preventDefault();
				showHint();
			}
		} else if (phase === 'correct') {
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
			No cards are due right now. Add more lines, or come back later.
		</p>
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
			{#if onTrainFurther}
				<Button onclick={() => void onTrainFurther?.()} variant="primary" size="md">
					<RotateCcw class="size-3.5" />
					<span>Continue studying</span>
				</Button>
			{/if}
			{#if onRetrain}
				<Button
					onclick={() => void onRetrain?.()}
					variant="secondary"
					size="md"
					disabled={retrainBusy}
				>
					<span>{retrainBusy ? 'Resetting…' : 'Retrain from scratch'}</span>
				</Button>
			{/if}
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
				bind:skipNextFenSound={boardSkipSound}
			/>
		</div>
		<aside class="space-y-5">
			<div class="ot-fade">
				<div class="eyebrow mb-2 text-[var(--color-brass-300)]">
					Idea · {ideaProgressIdx + 1} / {totalIdeaCount}
					{#if segments.length > 1 && ideaSegIdx >= 0}
						<span class="ml-1 text-[var(--color-parchment-400)]">
							· {segments[ideaSegIdx].rep.name}
						</span>
					{/if}
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
							<kbd class="ml-1 rounded bg-[var(--color-ink-800)] px-1 py-0.5 font-mono text-[10px]"
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
						<Button variant="destructive" size="sm" onclick={() => rateIdea('wrong')}>Again</Button>
						<Button variant="secondary" size="sm" onclick={() => rateIdea('peeked')}>Hard</Button>
						<Button variant="primary" size="sm" onclick={() => rateIdea('correct')}>Good</Button>
						<Button variant="outline" size="sm" onclick={() => rateIdea('easy')}>Easy</Button>
					</div>
				{/if}
			</div>
		</aside>
	</div>
{:else if currentEntry && currentRep}
	<div class="grid gap-6 md:grid-cols-[minmax(0,1fr)_260px]">
		<!-- Board -->
		<div class="relative mx-auto w-full max-w-[600px]">
			<div
				class="rounded-[4px] transition-shadow duration-200"
				class:board-correct-ring={phase === 'correct'}
				class:board-wrong-ring={phase === 'wrong'}
			>
				{#key currentRep.color}
					<Board
						fen={displayFen}
						{orientation}
						turnColor={sideToMove}
						movableColor={phase === 'pending' && !scrubActive ? currentRep.color : undefined}
						{dests}
						lastMove={displayLastMove}
						shapes={scrubActive ? [] : boardShapes}
						onmove={handleMove}
						viewOnly={phase !== 'pending' || scrubActive}
						bind:skipNextFenSound={boardSkipSound}
					/>
				{/key}
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

		<!-- Side: prompt + feedback + rating. autoHeight smooths the height
			 jumps when the panel cycles between intro / prompt / feedback /
			 result variants — they have very different intrinsic heights. -->
		<aside class="space-y-5" use:autoHeight>
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
						Your move as {currentRep.color}
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
								class:!text-[var(--color-brass-300)]={moveQuality === 'dubious' ||
									moveQuality === 'missed_chance'}
								class:!text-[var(--color-copper-300)]={moveQuality === 'mistake' ||
									moveQuality === 'gave_advantage'}
								class:!text-[var(--color-oxblood-300)]={moveQuality === 'blunder'}
							>
								{moveQualityLabel(moveQuality)}
							</span>
						{:else}
							<span class="text-[var(--color-parchment-400)]">Checking</span>
						{/if}
					</div>
					<h2 class="font-serif text-[2rem] leading-tight text-[var(--color-parchment-100)]">
						{#if moveQuality}
							<em>{moveQualityHeadline(moveQuality)}</em>
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
				{#if segments.length > 1 && currentRep}
					<div
						class="mt-2 flex items-center gap-2 font-mono text-xs text-[var(--color-parchment-400)]"
					>
						<span>Rep</span>
						<span class="text-[var(--color-parchment-200)]">{currentRep.name}</span>
					</div>
				{/if}
				{#if currentRep && currentEntry}
					<Button
						href={`${base}/repertoire/${currentRep.id}/edit?jump=${encodeURIComponent(currentEntry.card.fenKey)}`}
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
