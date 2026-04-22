<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { onMount, untrack } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { X, Keyboard, RotateCcw, Trophy, Check } from 'lucide-svelte';
	import type { Key, MoveMetadata, Dests } from '@lichess-org/chessground/types';
	import type { DrawShape } from '@lichess-org/chessground/draw';

	import Board from '$lib/chess/Board.svelte';
	import { listRepertoires } from '$lib/storage/repertoires';
	import { dueCards, upsertCard } from '$lib/storage/cards';
	import { getSettings } from '$lib/storage/settings';
	import { nodesMap } from '$lib/storage/nodes';
	import { reviewCard, outcomeToRating, type DrillOutcome } from '$lib/fsrs/scheduler';
	import {
		edgeFromUci,
		edgeFromSan,
		fenAfterMove,
		legalDests,
		isPromotionMove,
		planRefutationPlies
	} from '$lib/chess/position';
	import { colorToMove } from '$lib/chess/fen';
	import { pathToFenKey } from '$lib/tree/traversal';
	import { getEngine, type EngineInfo } from '$lib/stockfish/engine';
	import { DRILL_INTRO_MS } from '$lib/types';
	import { Button } from '$lib/ui';
	import { playCorrect, playIncorrect } from '$lib/ui/sounds';
	import type { AppSettings, Card, Edge, Repertoire, RepertoireNode } from '$lib/types';

	// NAG glyph palette — same vocabulary as the per-repertoire drill.
	type MoveQuality = 'correct' | 'playable' | 'dubious' | 'mistake' | 'blunder';
	function nagGlyph(q: MoveQuality): string {
		return q === 'correct'
			? '!'
			: q === 'playable'
				? '!?'
				: q === 'dubious'
					? '?!'
					: q === 'mistake'
						? '?'
						: '??';
	}
	function nagColor(q: MoveQuality): string {
		return q === 'correct'
			? '#639b24'
			: q === 'playable'
				? '#749bbf'
				: q === 'dubious'
					? '#e8b730'
					: q === 'mistake'
						? '#e58f2a'
						: '#ac3332';
	}
	function gradeFromCp(stmCp: number): MoveQuality {
		if (stmCp >= 250) return 'blunder';
		if (stmCp >= 100) return 'mistake';
		if (stmCp >= 25) return 'dubious';
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

	type Phase = 'loading' | 'empty' | 'intro' | 'pending' | 'correct' | 'wrong' | 'refuted' | 'done';

	interface QueueEntry {
		card: Card;
		rep: Repertoire;
		nodes: Map<string, RepertoireNode>;
	}

	let settings = $state<AppSettings | null>(null);
	let queue = $state<QueueEntry[]>([]);
	let idx = $state(0);
	let phase = $state<Phase>('loading');

	let currentFen = $state('');
	let userLastMove = $state<[Key, Key] | undefined>(undefined);
	let userPlayedSan = $state<string | null>(null);
	let correctEdge = $state<Edge | null>(null);
	let sessionDone = $state(0);
	let hintLevel = $state(0);
	let wrongAttempts = $state(0);

	// NAG glyph state.
	let moveQuality = $state<MoveQuality | null>(null);
	let gradedSquare = $state<Key | null>(null);
	let refutationSan = $state<string | null>(null);
	let refutationCp = $state<number | null>(null);
	let wrongToken: { cancelled: boolean } = { cancelled: false };

	const currentEntry = $derived<QueueEntry | undefined>(queue[idx]);
	const currentCard = $derived(currentEntry?.card);
	const currentRep = $derived(currentEntry?.rep);
	const orientation = $derived<'white' | 'black'>(currentRep?.color ?? 'white');
	const sideToMove = $derived<'white' | 'black'>(
		currentFen ? colorToMove(currentFen) : (currentRep?.color ?? 'white')
	);

	const firstTryClean = $derived(wrongAttempts === 0 && hintLevel === 0);
	const isFirstEverCard = $derived(!!currentCard && !currentCard.lastReview);
	const AUTO_ADVANCE_QUICK_MS = 120;
	const AUTO_ADVANCE_SLOW_MS = 1400;
	const currentAutoAdvanceMs = $derived(
		firstTryClean ? AUTO_ADVANCE_QUICK_MS : AUTO_ADVANCE_SLOW_MS
	);
	const WRONG_FLASH_MS = 420;
	const WRONG_SETTLE_MS = 380;
	const DONE_HOLD_MS = 600;
	const REFUTATION_PROBE_MS = 800;
	const REFUTATION_HOLD_MS = 1100;
	const REFUTATION_MAX_PLIES = 6;
	const REFUTATION_PACE_MS = 700;

	function fenFromKey(key: string): string {
		const parts = key.split(' ');
		return parts.length === 4 ? `${key} 0 1` : key;
	}

	onMount(async () => {
		settings = await getSettings();
		queue = await loadMixedQueue();
		phase = queue.length === 0 ? 'empty' : 'pending';
		// Warm up Stockfish so the first wrong-move grade doesn't wait on
		// the NNUE download.
		void getEngine()
			.init()
			.catch(() => undefined);
	});

	/**
	 * Build a mixed drill queue. Ordering model:
	 *
	 *   1. Group reps by colour (white → black) so a session doesn't
	 *      ping-pong between sides.
	 *   2. Within each rep, walk the tree in DFS preorder and emit due
	 *      cards in that order. You get a full line root-to-leaf before
	 *      moving on to its sibling branches — the way you'd think
	 *      about "drilling the Italian" rather than surveying every
	 *      opening one ply at a time.
	 *   3. Orphan cards (not reachable from the root — e.g. after a
	 *      weird import) fall to the tail in dueAt order.
	 *
	 * Straight FSRS dueAt sorting made the queue feel inside-out;
	 * BFS-by-depth felt like a survey. DFS preorder is closer to how
	 * a human learns an opening end-to-end.
	 */
	async function loadMixedQueue(): Promise<QueueEntry[]> {
		if (!settings) return [];
		const reps = await listRepertoires();
		const cap = settings.drillSessionCap;
		const colorRank = (c: 'white' | 'black') => (c === 'white' ? 0 : 1);
		const orderedReps = [...reps].sort((a, b) => colorRank(a.color) - colorRank(b.color));
		const entries: QueueEntry[] = [];
		for (const rep of orderedReps) {
			const due = await dueCards(rep.id, Date.now(), cap);
			if (due.length === 0) continue;
			const nodes = await nodesMap(rep.id);
			const byKey = new Map(due.map((c) => [c.fenKey, c]));
			const remaining = new SvelteSet(byKey.keys());
			const visited = new SvelteSet<string>();
			function walk(fenKey: string) {
				if (visited.has(fenKey)) return;
				visited.add(fenKey);
				const card = byKey.get(fenKey);
				if (card) {
					entries.push({ card, rep, nodes });
					remaining.delete(fenKey);
				}
				const node = nodes.get(fenKey);
				if (!node) return;
				for (const edge of node.children) walk(edge.toFenKey);
			}
			walk(rep.rootFenKey);
			if (remaining.size > 0) {
				const orphans = [...remaining].map((k) => byKey.get(k)!).sort((a, b) => a.dueAt - b.dueAt);
				for (const card of orphans) entries.push({ card, rep, nodes });
			}
		}
		return entries.slice(0, cap);
	}

	$effect(() => {
		// Track currentEntry only; everything inside goes through untrack so
		// the in-flight state writes don't re-fire this effect.
		const entry = currentEntry;
		if (!entry) return;
		const token = { cancelled: false };
		untrack(() => {
			// First-ever cards auto-reveal the full-hint arrow: there's nothing
			// to recall yet, so skip straight to the teaching cue the user
			// would otherwise have to click for.
			hintLevel = entry.card.lastReview ? 0 : 2;
			wrongAttempts = 0;
			userLastMove = undefined;
			userPlayedSan = null;
			moveQuality = null;
			gradedSquare = null;
			refutationSan = null;
			refutationCp = null;
			void startCard(entry, token);
		});
		return () => {
			token.cancelled = true;
		};
	});

	/**
	 * Animate the buildup to a card's position before handing the board
	 * over to the user. Same behaviour as the per-rep drill:
	 *   - If intro speed is off, or we're already on the target fen, snap
	 *     to it.
	 *   - Otherwise pick up where we are on the path from the rep root
	 *     (so chain-like sequences only play the tail) and animate each
	 *     remaining ply.
	 * This also forces a clean board reconfiguration between reps — without
	 * the explicit phase='intro' → 'pending' transition, switching from a
	 * white rep to a black rep could leave chessground with stale
	 * turnColor/movableColor config, locking the new side's pieces.
	 */
	async function startCard(entry: QueueEntry, token: { cancelled: boolean }) {
		const { rep, nodes, card } = entry;
		const targetFen = fenFromKey(card.fenKey);
		const stepMs = DRILL_INTRO_MS[settings?.drillIntroSpeed ?? 'normal'];

		// Snap-path: no animation, or the card is the root.
		if (stepMs === 0 || rep.rootFenKey === card.fenKey) {
			currentFen = targetFen;
			userLastMove = undefined;
			correctEdge = edgeFromSan(currentFen, card.expectedSan);
			phase = 'pending';
			return;
		}

		const pathFromRoot = pathToFenKey(nodes, rep.rootFenKey, card.fenKey);
		if (!pathFromRoot || pathFromRoot.length === 0) {
			currentFen = targetFen;
			userLastMove = undefined;
			correctEdge = edgeFromSan(currentFen, card.expectedSan);
			phase = 'pending';
			return;
		}

		// If the board already sits on a position that lies on the path to
		// the target, only animate the tail from there.
		let startIdx = 0;
		try {
			const curKey = currentFen ? (await import('$lib/chess/fen')).fenKeyFromFen(currentFen) : null;
			if (curKey && curKey !== rep.rootFenKey) {
				for (let i = 0; i < pathFromRoot.length; i++) {
					if (pathFromRoot[i].toFenKey === curKey) {
						startIdx = i + 1;
						break;
					}
				}
			}
		} catch {
			/* ignore — we fall through and animate from root */
		}

		phase = 'intro';
		let fen = startIdx === 0 ? rep.rootFen : currentFen;
		if (startIdx === 0) {
			currentFen = fen;
			userLastMove = undefined;
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
		correctEdge = edgeFromSan(currentFen, card.expectedSan);
		phase = 'pending';
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

	const boardShapes = $derived.by<DrawShape[]>(() => {
		const shapes: DrawShape[] = [];

		// NAG glyph pinned to the played square's corner, Lichess-style.
		if (moveQuality && gradedSquare) {
			shapes.push({
				orig: gradedSquare,
				label: { text: nagGlyph(moveQuality), fill: nagColor(moveQuality) }
			});
		}

		// Red refutation arrow when the engine's showing us why the move lost.
		if (phase === 'refuted' && userLastMove) {
			shapes.push({ orig: userLastMove[0], dest: userLastMove[1], brush: 'red' });
		}

		if (phase === 'pending' && correctEdge && hintLevel > 0) {
			const orig = correctEdge.uci.slice(0, 2) as Key;
			const dest = correctEdge.uci.slice(2, 4) as Key;
			if (hintLevel === 1) shapes.push({ orig, brush: 'paleGreen' });
			else shapes.push({ orig, dest, brush: 'green' });
		}
		return shapes;
	});

	function handleMove(orig: Key, dest: Key, _m: MoveMetadata) {
		if (!currentEntry || phase !== 'pending') return;
		const promo = isPromotionMove(currentFen, orig, dest) ? 'q' : undefined;
		const edge = edgeFromUci(currentFen, orig, dest, promo);
		if (!edge) return;
		currentFen = fenAfterMove(currentFen, edge);
		userLastMove = [orig, dest];
		userPlayedSan = edge.san;
		gradedSquare = dest;

		const node = currentEntry.nodes.get(currentEntry.card.fenKey);
		const accepted = new Set<string>(
			node?.children.map((e) => e.san) ?? [currentEntry.card.expectedSan]
		);
		if (accepted.has(edge.san)) {
			moveQuality = 'correct';
			phase = 'correct';
			playCorrect();
		} else {
			wrongAttempts += 1;
			moveQuality = null;
			phase = 'wrong';
			void runWrongSequence();
		}
	}

	async function runWrongSequence() {
		if (!currentEntry) return;
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

		moveQuality = refutation ? gradeFromCp(refutation.stmCp) : 'dubious';
		// Playable = still a reasonable move, just off-prep → positive cue.
		// Dubious/mistake/blunder → error cue.
		if (moveQuality === 'playable') playCorrect();
		else playIncorrect();
		const shouldRefute =
			refutation !== null && (moveQuality === 'mistake' || moveQuality === 'blunder');

		if (shouldRefute && refutation) {
			// Walk Stockfish's PV only as far as needed to make the point — stop
			// once material has been won (or mate delivered) and the line has
			// quiesced. Positional refutations cap at 2 plies.
			let showFen = wrongFen;
			const maxPlies = planRefutationPlies(
				wrongFen,
				refutation.pv,
				refutation.stmCp,
				REFUTATION_MAX_PLIES
			);
			for (let i = 0; i < maxPlies; i++) {
				const pvUci = refutation.pv[i];
				if (!pvUci || pvUci.length < 4) break;
				const pvOrig = pvUci.slice(0, 2) as Key;
				const pvDest = pvUci.slice(2, 4) as Key;
				const promo = pvUci.length > 4 ? (pvUci[4] as 'q' | 'r' | 'b' | 'n') : undefined;
				const pvEdge = edgeFromUci(showFen, pvOrig, pvDest, promo);
				if (!pvEdge) break;
				const nextFen = fenAfterMove(showFen, pvEdge);
				if (i > 0) {
					await sleep(REFUTATION_PACE_MS);
					if (token.cancelled) return;
				}
				currentFen = nextFen;
				userLastMove = [pvOrig, pvDest];
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
			await sleep(500);
			if (token.cancelled) return;
		}

		// Revert the board and clear glyph state for the next attempt.
		currentFen = fenFromKey(currentEntry.card.fenKey);
		gradedSquare = null;
		userLastMove = undefined;
		await sleep(WRONG_SETTLE_MS);
		if (token.cancelled) return;
		refutationSan = null;
		refutationCp = null;
		// Keep moveQuality + userPlayedSan so the pending retry prompt can
		// continue to show the grade message instead of wiping back to a
		// generic "Try again".
		phase = 'pending';
	}

	async function probeRefutation(
		fen: string,
		timeoutMs: number
	): Promise<{ pv: string[]; stmCp: number } | null> {
		const engine = getEngine();
		if (!engine.isReady()) {
			void engine.init().catch(() => undefined);
			return null;
		}
		// engine.ts already normalises info.scoreCp to white-positive absolute.
		// We want "how bad for the user who just moved" — positive = worse. After
		// the user's move the side to move is their opponent, so flipping by the
		// opponent's colour converts absolute → user-negative.
		const stm = colorToMove(fen);
		const sign = stm === 'black' ? -1 : 1;
		return await new Promise((resolve) => {
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

	$effect(() => {
		if (phase !== 'correct') return;
		const delay = currentAutoAdvanceMs;
		const timer = setTimeout(() => {
			void rateAndAdvance(deriveOutcome());
		}, delay);
		return () => clearTimeout(timer);
	});

	function deriveOutcome(): DrillOutcome {
		if (wrongAttempts > 0) return 'wrong';
		if (hintLevel > 0) return 'peeked';
		return 'correct';
	}

	async function rateAndAdvance(outcome: DrillOutcome) {
		if (!currentEntry || !settings) return;
		const entry = currentEntry;
		const updated = reviewCard(entry.card, outcomeToRating(outcome), settings.fsrsParams);
		await upsertCard(updated);
		sessionDone += 1;
		// Wrong answer → drop any later queue entries that sit strictly
		// deeper in the same repertoire line. Otherwise the intro of the
		// next card would replay through the position we just failed at,
		// spoiling the recall the user was meant to rebuild. Same-rep,
		// same-branch only; other reps / sibling lines stay.
		if (outcome === 'wrong') {
			queue = queue.filter((q, i) => {
				if (i <= idx) return true;
				if (q.rep.id !== entry.rep.id) return true;
				const path = pathToFenKey(q.nodes, q.rep.rootFenKey, q.card.fenKey);
				if (!path) return true;
				return !path.some((e) => e.toFenKey === entry.card.fenKey);
			});
			// Re-queue the failed card at the tail so the user sees it again
			// before the session ends. FSRS already dropped it to short-term
			// rescheduling; this ensures another pass *this* session too.
			queue = [...queue, entry];
		}
		if (idx + 1 >= queue.length) {
			setTimeout(() => (phase = 'done'), DONE_HOLD_MS);
		} else {
			idx += 1;
		}
	}

	function showHint() {
		if (phase !== 'pending') return;
		// Brand-new cards (never reviewed) skip the piece-highlight step and
		// jump straight to the full answer arrow — there's nothing to "nudge"
		// recall of yet.
		if (hintLevel === 0 && currentCard && !currentCard.lastReview) {
			hintLevel = 2;
			return;
		}
		hintLevel = Math.min(hintLevel + 1, 2);
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	function handleKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (phase === 'pending') {
			if (e.key === 'h' || e.key === 'H' || e.key === 'z' || e.key === 'Z' || e.key === '?') {
				e.preventDefault();
				showHint();
			}
		} else if (phase === 'correct' && e.key === '4') {
			e.preventDefault();
			void rateAndAdvance('easy');
		}
	}

	async function reloadSession() {
		// Park the queue empty + phase=loading first so the currentEntry
		// $effect doesn't fire twice (once against the stale previous queue,
		// then again against the refreshed one). Double-firing left the
		// first startCard invocation writing phase='intro' on the wrong
		// entry after the second run had already cancelled it, wedging the
		// UI until a full page refresh.
		phase = 'loading';
		queue = [];
		sessionDone = 0;
		idx = 0;
		hintLevel = 0;
		wrongAttempts = 0;
		userLastMove = undefined;
		userPlayedSan = null;
		moveQuality = null;
		gradedSquare = null;
		refutationSan = null;
		refutationCp = null;
		currentFen = '';
		const next = await loadMixedQueue();
		queue = next;
		phase = next.length === 0 ? 'empty' : 'pending';
	}

	const progress = $derived(queue.length > 0 ? (idx / queue.length) * 100 : 0);

	// Screen-reader announcement text. Mirrors the visual feedback (move
	// quality, correct/wrong phase, caught-up state) into a polite
	// aria-live region so non-sighted users learn how their move was
	// graded without relying on the board glyphs.
	const srAnnouncement = $derived.by(() => {
		if (phase === 'empty') return 'Nothing due right now.';
		if (phase === 'done') return `Session complete. You drilled ${sessionDone} cards.`;
		if (phase === 'correct') return 'Correct.';
		if (phase === 'wrong' && moveQuality) return `${moveQualityLabel(moveQuality)}.`;
		if (phase === 'refuted' && moveQuality)
			return `${moveQualityLabel(moveQuality)}. Engine refutation playing.`;
		return '';
	});

	// stmCp stores "bad-for-user" positive; convert to white-positive absolute
	// for display so the eval reads the conventional way (White blunder → "-X",
	// Black blunder → "+X").
	const refutationWhiteCp = $derived<number | null>(
		refutationCp === null ? null : currentRep?.color === 'white' ? -refutationCp : refutationCp
	);
</script>

<svelte:window on:keydown={handleKey} />

<!--
	Visually-hidden live region: screen readers announce move grading
	("Correct", "A blunder", "Session complete") without duplicating the
	on-screen glyph. aria-live="polite" queues behind the user's input
	so it doesn't interrupt keystrokes.
-->
<div role="status" aria-live="polite" aria-atomic="true" class="sr-only">
	{srAnnouncement}
</div>

<div class="mx-auto max-w-[1000px] px-4 py-4 md:px-6">
	<div class="mb-5 flex items-center gap-3">
		<span class="eyebrow text-[var(--color-parchment-300)]">Quick drill</span>
		{#if currentRep && phase !== 'done' && phase !== 'empty'}
			<span class="text-[var(--color-ink-600)]">·</span>
			<a
				href={resolve(`/repertoire/${currentRep.id}`)}
				class="eyebrow max-w-[280px] truncate transition-colors hover:text-[var(--color-parchment-100)]"
			>
				{currentRep.name}
			</a>
		{/if}
		{#if phase === 'intro' || phase === 'pending' || phase === 'correct' || phase === 'wrong' || phase === 'refuted'}
			<span class="eyebrow ml-auto tabular-nums">
				{idx + 1} <span class="text-[var(--color-ink-600)]">/</span>
				{queue.length}
			</span>
		{/if}
		<a
			href={resolve('/')}
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

	{#if phase === 'intro' || phase === 'pending' || phase === 'correct' || phase === 'wrong' || phase === 'refuted'}
		<div class="relative mb-8 h-px overflow-hidden bg-[var(--color-ink-800)]">
			<div
				class="absolute inset-y-0 left-0 bg-[var(--color-brass-300)] transition-[width] duration-500"
				style:width="{progress}%"
			></div>
		</div>
	{/if}

	{#if phase === 'loading'}
		<p class="text-sm text-[var(--color-parchment-400)]">Loading your due cards…</p>
	{:else if phase === 'empty'}
		<div class="ink-panel mt-8 flex flex-col items-center gap-3 px-8 py-16 text-center">
			<div class="ornament font-serif text-4xl">⁂</div>
			<h2 class="font-serif text-3xl">Nothing due right now.</h2>
			<p class="max-w-sm font-serif text-sm text-[var(--color-parchment-400)] italic">
				You're caught up across every repertoire. Come back later, or drill a specific one from the
				library.
			</p>
			<div class="mt-2 flex gap-2">
				<Button href="{base}/library" variant="primary" size="sm">Library</Button>
				<Button href="{base}/" variant="outline" size="sm">Back</Button>
			</div>
		</div>
	{:else if phase === 'done'}
		<div class="ink-panel mt-8 flex flex-col items-center gap-4 px-8 py-16 text-center">
			<Trophy class="size-10 text-[var(--color-brass-300)]" strokeWidth={1.5} />
			<h2 class="font-serif text-4xl">A good mixed session.</h2>
			<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
				You drilled
				<span class="font-sans font-semibold text-[var(--color-parchment-100)] tabular-nums"
					>{sessionDone}</span
				> cards across your library.
			</p>
			<p class="mt-2 font-serif text-sm text-[var(--color-parchment-400)] italic">
				Continue studying, or head back to the library?
			</p>
			<div class="mt-3 flex flex-wrap justify-center gap-2">
				<Button onclick={reloadSession} variant="primary" size="md">
					<RotateCcw class="size-3.5" />
					<span>Continue studying</span>
				</Button>
				<Button href="{base}/library" variant="outline" size="md">Back to library</Button>
			</div>
		</div>
	{:else if currentEntry}
		<div class="grid gap-6 md:grid-cols-[minmax(0,1fr)_260px]">
			<!-- Board -->
			<div class="relative mx-auto w-full max-w-[600px]">
				<div
					class="rounded-[4px] transition-shadow duration-200"
					class:board-correct-ring={phase === 'correct'}
					class:board-wrong-ring={phase === 'wrong'}
				>
					{#key currentRep?.color}
						<Board
							fen={currentFen}
							{orientation}
							turnColor={sideToMove}
							movableColor={currentRep?.color ?? 'white'}
							{dests}
							lastMove={userLastMove}
							shapes={boardShapes}
							onmove={handleMove}
							viewOnly={phase !== 'pending'}
						/>
					{/key}
				</div>
			</div>

			<!-- Side: prompt + feedback + rating -->
			<aside class="space-y-5">
				{#if phase === 'intro'}
					<div class="ot-fade">
						<div class="eyebrow mb-2 text-[var(--color-parchment-400)]">Playing the line</div>
						<h2 class="font-serif text-[1.75rem] leading-tight text-[var(--color-parchment-200)]">
							<em>Setting the stage…</em>
						</h2>
						<p class="mt-3 font-serif text-sm text-[var(--color-parchment-500)] italic">
							The board will arrive at the position in a moment.
						</p>
					</div>
				{:else if moveQuality && (phase === 'wrong' || (phase === 'pending' && wrongAttempts > 0))}
					<!-- Shared graded-retry block. Rendered in both the wrong phase
					     (after the engine grade lands) and the subsequent pending
					     retry phase (after the piece reverts), so the DOM stays
					     mounted across the transition and the ot-fade animation
					     doesn't re-fire. -->
					<div class="ot-fade">
						<div class="eyebrow mb-2">
							<span
								class:!text-[var(--color-olive-300)]={moveQuality === 'playable'}
								class:!text-[var(--color-brass-300)]={moveQuality === 'dubious'}
								class:!text-[var(--color-copper-300)]={moveQuality === 'mistake'}
								class:!text-[var(--color-oxblood-300)]={moveQuality === 'blunder'}
							>
								{moveQualityLabel(moveQuality)}
							</span>
							<span class="ml-1 text-[var(--color-parchment-500)]">
								· try {wrongAttempts + 1}
							</span>
						</div>
						<h2 class="font-serif text-[2rem] leading-tight text-[var(--color-parchment-100)]">
							{#if moveQuality === 'playable'}
								<em>Fair, but not your repertoire. Try again.</em>
							{:else if moveQuality === 'dubious'}
								<em>Not quite. Try again.</em>
							{:else}
								<em>Try again.</em>
							{/if}
						</h2>
						{#if userPlayedSan}
							<p class="mt-3 font-mono text-sm text-[var(--color-parchment-400)]">
								{userPlayedSan}<span>{nagGlyph(moveQuality)}</span>
							</p>
						{/if}
						{#if phase === 'pending'}
							<div class="ot-fade mt-3">
								{#if hintLevel === 0}
									<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
										Play on the board, or ask for a hint.
									</p>
								{:else if hintLevel === 1}
									<p class="font-serif text-sm text-[var(--color-olive-300)] italic">
										Hint: the piece to move is highlighted.
									</p>
								{:else}
									<p class="font-serif text-sm text-[var(--color-olive-300)] italic">
										The answer is drawn on the board. Play it to advance.
									</p>
								{/if}
							</div>
						{/if}
					</div>
					{#if phase === 'pending'}
						<div class="ot-fade flex gap-2">
							<Button variant="ghost" size="sm" onclick={showHint} disabled={hintLevel >= 2}>
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
								<kbd
									class="ml-1 rounded bg-[var(--color-ink-800)] px-1 py-0.5 font-mono text-[10px]"
									>H</kbd
								>
							</Button>
						</div>
					{/if}
				{:else if phase === 'pending'}
					<div class="ot-fade">
						<div class="eyebrow mb-2">
							Your move as {currentRep?.color}
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
					</div>
					<div class="flex gap-2">
						<Button variant="ghost" size="sm" onclick={showHint} disabled={hintLevel >= 2}>
							<Keyboard class="size-3" />
							<span>
								{hintLevel === 0 ? 'Show hint' : hintLevel === 1 ? 'Show answer' : 'Answer shown'}
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
						<div class="eyebrow mb-2 text-[var(--color-parchment-400)]">Evaluating</div>
						<h2 class="font-serif text-[2rem] leading-tight text-[var(--color-parchment-100)]">
							<em>Checking with the engine…</em>
						</h2>
						{#if userPlayedSan}
							<p class="mt-3 font-mono text-sm text-[var(--color-parchment-400)]">
								{userPlayedSan}
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
							{#if refutationWhiteCp !== null}
								<span
									class="ml-1 font-mono text-[1.1rem] text-[var(--color-parchment-400)] not-italic"
								>
									{#if Math.abs(refutationWhiteCp) >= 10000}
										{refutationWhiteCp > 0 ? '+M' : '-M'}
									{:else}
										{refutationWhiteCp >= 0 ? '+' : ''}{(refutationWhiteCp / 100).toFixed(1)}
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
				</div>
			</aside>
		</div>
	{/if}
</div>
