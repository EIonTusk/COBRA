<script lang="ts">
	import {
		ArrowRight,
		Bookmark,
		Crown,
		Gem,
		Flame,
		Sparkles,
		Swords,
		Shuffle,
		AlertTriangle,
		UserCheck,
		HelpCircle
	} from 'lucide-svelte';
	import type { ComponentType, Snippet } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import {
		fetchExplorer,
		ExplorerRateLimited,
		ExplorerAuthRequired,
		type ExplorerMove,
		type ExplorerResponse
	} from './client';
	import { probeNarrowness, type NarrownessResult } from './narrowness';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import { colorToMove } from '$lib/chess/fen';
	import type { AppSettings } from '$lib/types';
	import { adviseMoves, type StyleAdvice } from '$lib/dossier/styleAdvisor';
	import type { DossierFingerprint } from '$lib/dossier/fingerprint';
	import type { OpeningFitSummary } from '$lib/dossier/openingFit';
	import { Button } from '$lib/ui';
	import { startOAuth, ALL_SCOPES } from '$lib/lichess/oauth';

	let oauthBusy = $state(false);
	// `?return=<path>` carrier for the "Open Settings" and inline-Settings
	// links so a user who routes through Settings to connect (or to paste a
	// token) still ends up back where they started instead of stranded on
	// /settings. The primary "Sign in with Lichess" button goes direct via
	// startOAuth, which handles the same handoff in-script.
	const settingsReturnHref = $derived(
		`${resolve('/settings')}?return=${encodeURIComponent(page.url.pathname + page.url.search + page.url.hash)}#lichess`
	);
	async function connectLichess() {
		if (oauthBusy) return;
		oauthBusy = true;
		try {
			// startOAuth navigates the current tab away (web) or hands the
			// URL to the OS browser (Tauri). Either way, we don't return.
			// Stash the current path so the callback brings the user back to
			// wherever they kicked off (e.g. /repertoire/.../edit) instead of
			// dropping them on /settings.
			const returnTo = page.url.pathname + page.url.search + page.url.hash;
			await startOAuth([...ALL_SCOPES], returnTo);
		} catch (e) {
			oauthBusy = false;
			error = e instanceof Error ? e.message : 'Could not start Lichess sign-in.';
		}
	}

	interface Props {
		fen: string;
		onselect?: (san: string) => void;
		/**
		 * SANs that are already part of the user's tree at this position.
		 * When a move in the explorer list matches, we stamp a small
		 * bookmark next to it so the user sees "I've already got this".
		 */
		knownSans?: Set<string>;
		/**
		 * Optional engine eval per move, keyed by UCI. Parent computes this
		 * from the running MultiPV search; moves outside the engine's top-N
		 * simply have no entry and render without an eval.
		 */
		engineEvalByUci?: Map<string, { text: string; tone: string }>;
		/**
		 * The user's side for this repertoire. When the explorer is on our
		 * turn we show the full tag set; on the opponent's turn we only
		 * show MAIN and a "dangerous" flag (rare but scores well for the
		 * opponent), since the other tags are about "which of my lines to
		 * pick" and don't apply to moves the opponent plays at us.
		 */
		buildingColor?: 'white' | 'black';
		/**
		 * SANs whose target position already exists somewhere else in the
		 * tree — playing this move would transpose into existing prep
		 * instead of creating a parallel line. We show a small icon next
		 * to these rows.
		 */
		transposesSans?: Set<string>;
		/**
		 * Engine-derived candidate moves. When Lichess has no games in its
		 * database for this position, we render these as fallback rows so
		 * the user still has something to click on.
		 */
		engineRows?: Array<{ uci: string; san: string; text: string; tone: string }>;
		/**
		 * Called when the user right-clicks a move that's already in their
		 * tree and picks "Delete from tree". Parent is responsible for
		 * removing the edge + any associated card and refreshing state.
		 */
		ondelete?: (san: string, uci: string) => void;
		/**
		 * User's dossier fingerprint, if available. Enables advisory
		 * style-fit scoring on each candidate row. Purely informational —
		 * doesn't change move ordering or selection.
		 */
		fingerprint?: DossierFingerprint | null;
		/**
		 * Opening-fit summary derived from the same dossier scan. Used to
		 * bias style advice toward families the user actually scores in.
		 */
		openingFit?: OpeningFitSummary | null;
		/**
		 * Optional slot rendered to the right of the Candidates heading.
		 * Used by the editor to inline the Stockfish readout on mobile
		 * where the standalone engine row is hidden to save vertical space.
		 */
		headerRight?: Snippet;
		/**
		 * Per-SAN aggregate of the user's own games at this exact fenKey,
		 * populated from the `position_wdl` IDB store. When present, we
		 * compare the user's score to the Lichess DB score and mark
		 * substantially-underperforming rows (sample-size gated) with a
		 * `?` next to the saved-bookmark glyph.
		 */
		userWdlBySan?: Map<string, { white: number; draws: number; black: number; games: number }>;
		/**
		 * Per-SAN count of how many edges sit beneath the user's saved move
		 * at this position. Surfaced in the delete-confirm dialog and in the
		 * right-click menu so the user sees the blast radius before pruning.
		 * Missing entries are treated as zero.
		 */
		subtreeSizeBySan?: Map<string, number>;
		/**
		 * The user's saved continuations at this position, in tree order.
		 * Only consumed when we can't reach Lichess (no token configured) —
		 * we still want the user to see and click their own prep, just with
		 * the Lichess-derived stats columns rendered as skeletons. Includes
		 * `uci` so deletion still works without a successful explorer fetch.
		 */
		savedMoves?: Array<{ san: string; uci: string }>;
	}
	let {
		fen,
		onselect,
		knownSans,
		engineEvalByUci,
		buildingColor,
		transposesSans,
		engineRows,
		ondelete,
		fingerprint = null,
		openingFit = null,
		headerRight,
		userWdlBySan,
		subtreeSizeBySan,
		savedMoves
	}: Props = $props();

	// Right-click context menu for moves already in the tree. Kept as a
	// power-user shortcut alongside the primary bookmark-click flow.
	let menuSan = $state<string | null>(null);
	let menuUci = $state<string | null>(null);
	let menuX = $state(0);
	let menuY = $state(0);
	function openContextMenu(e: MouseEvent, m: { san: string; uci: string }) {
		if (!knownSans?.has(m.san) || !ondelete) return;
		e.preventDefault();
		menuSan = m.san;
		menuUci = m.uci;
		menuX = e.clientX;
		menuY = e.clientY;
	}
	function closeContextMenu() {
		menuSan = null;
		menuUci = null;
	}

	// Confirm dialog driven by clicking the bookmark glyph (or the Del/
	// Backspace keyboard shortcut on a focused row). Shows the blast
	// radius — the count of moves saved beneath the move being pruned —
	// so a single tap on a small target can't silently nuke a deep
	// subline.
	let confirmSan = $state<string | null>(null);
	let confirmUci = $state<string | null>(null);
	let confirmCount = $state(0);
	function openConfirm(m: { san: string; uci: string }) {
		if (!knownSans?.has(m.san) || !ondelete) return;
		closeContextMenu();
		confirmSan = m.san;
		confirmUci = m.uci;
		confirmCount = subtreeSizeBySan?.get(m.san) ?? 0;
	}
	function closeConfirm() {
		confirmSan = null;
		confirmUci = null;
		confirmCount = 0;
	}
	function commitConfirm() {
		if (confirmSan && confirmUci) ondelete?.(confirmSan, confirmUci);
		closeConfirm();
	}
	// Right-click menu's Delete also goes through the confirm dialog so
	// both entry points show the same blast-radius preview.
	function confirmFromMenu() {
		if (!menuSan || !menuUci) return;
		const san = menuSan;
		const uci = menuUci;
		closeContextMenu();
		openConfirm({ san, uci });
	}

	function handleRowKey(e: KeyboardEvent, m: { san: string; uci: string }) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onselect?.(m.san);
			return;
		}
		if ((e.key === 'Delete' || e.key === 'Backspace') && knownSans?.has(m.san) && ondelete) {
			e.preventDefault();
			openConfirm(m);
		}
	}

	let result = $state<ExplorerResponse | null>(null);
	let error = $state<string | null>(null);
	let needsToken = $state(false);
	let loading = $state(false);
	let settings = $state<AppSettings | null>(null);
	let narrowness = $state<Map<string, NarrownessResult>>(new Map());

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let probeToken = 0;

	$effect(() => {
		(async () => {
			if (!settings) settings = await getSettings();
		})();
	});

	$effect(() => {
		const currentFen = fen;
		if (!currentFen) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			void load(currentFen);
		}, 300);
	});

	async function load(fen: string) {
		if (!settings) settings = await getSettings();
		const lichessToken = effectiveLichessToken(settings);
		if (!lichessToken) {
			needsToken = true;
			result = null;
			error = null;
			return;
		}
		needsToken = false;
		loading = true;
		error = null;
		// Reset probes; they were for the previous position.
		narrowness = new Map();
		const myToken = ++probeToken;
		try {
			const res = await fetchExplorer({
				fen,
				speeds: settings.explorerSpeeds,
				ratings: settings.explorerRatings,
				moves: 10,
				token: lichessToken
			});
			if (myToken !== probeToken) return;
			result = res;
			void scheduleNarrownessProbes(fen, res, myToken);
		} catch (e) {
			result = null;
			if (e instanceof ExplorerAuthRequired) {
				needsToken = true;
			} else if (e instanceof ExplorerRateLimited) {
				error = `Rate limited — retry in ${Math.ceil(e.cooldownMs / 1000)}s`;
			} else {
				error = e instanceof Error ? e.message : 'Failed to load';
			}
		} finally {
			loading = false;
		}
	}

	async function scheduleNarrownessProbes(atFen: string, res: ExplorerResponse, myToken: number) {
		if (!settings) return;
		// Only probe moves plausibly sharp: enough games AND draw rate below the
		// position's own baseline. Cap at 4 probes per position to respect
		// Lichess rate limits.
		const positionTotal = res.moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
		const positionDraws = res.moves.reduce((s, m) => s + m.draws, 0);
		const baseline = positionTotal > 0 ? positionDraws / positionTotal : 0;
		const candidates = res.moves
			.map((m) => ({
				m,
				games: m.white + m.draws + m.black,
				drawRate: m.draws + m.white + m.black === 0 ? 0 : m.draws / (m.white + m.draws + m.black)
			}))
			.filter((c) => c.games >= 30 && c.drawRate <= Math.max(baseline, 0.2))
			.sort((a, b) => a.drawRate - b.drawRate || b.games - a.games)
			.slice(0, 4);

		const lichessToken = effectiveLichessToken(settings);
		for (const { m } of candidates) {
			if (myToken !== probeToken) return;
			const r = await probeNarrowness(atFen, m.uci, {
				speeds: settings.explorerSpeeds,
				ratings: settings.explorerRatings,
				token: lichessToken
			});
			if (myToken !== probeToken) return;
			const next = new SvelteMap(narrowness);
			next.set(m.uci, r);
			narrowness = next;
		}
	}

	const sideToMove = $derived<'white' | 'black'>(fen ? colorToMove(fen) : 'white');

	const totalAll = $derived(
		result ? (result.moves ?? []).reduce((s, m) => s + m.white + m.draws + m.black, 0) : 0
	);

	const topGames = $derived(
		result ? (result.moves ?? []).reduce((m, x) => Math.max(m, totalGames(x)), 0) : 0
	);

	// Weighted average rating across all listed moves, used as the ELITE
	// baseline. Ignores moves without an averageRating.
	const positionAvgRating = $derived.by<number>(() => {
		if (!result) return 0;
		let weightedSum = 0;
		let weight = 0;
		for (const m of result.moves) {
			if (m.averageRating === undefined) continue;
			const g = totalGames(m);
			weightedSum += m.averageRating * g;
			weight += g;
		}
		return weight === 0 ? 0 : weightedSum / weight;
	});

	function totalGames(m: ExplorerMove): number {
		return m.white + m.draws + m.black;
	}

	function sharePct(m: ExplorerMove, side: 'white' | 'draws' | 'black'): number {
		const total = totalGames(m);
		return total === 0 ? 0 : Math.round((m[side] / total) * 100);
	}

	// Score for the side to move: wins + draws/2, as percent.
	function scorePct(m: ExplorerMove): number {
		const total = totalGames(m);
		if (total === 0) return 0;
		const wins = sideToMove === 'white' ? m.white : m.black;
		return Math.round(((wins + m.draws / 2) / total) * 100);
	}

	function scoreTone(pct: number): string {
		if (pct >= 55) return 'text-[var(--color-olive-300)]';
		if (pct <= 45) return 'text-[var(--color-oxblood-300)]';
		return 'text-[var(--color-parchment-100)]';
	}

	type TagKind = 'MAIN' | 'DUBIOUS' | 'ELITE' | 'SHARP' | 'SURPRISE' | 'DANGEROUS';

	const isOurTurn = $derived(buildingColor ? sideToMove === buildingColor : true);

	/**
	 * Advisory style-fit score per candidate UCI. Only computed when
	 * (a) a dossier fingerprint is available and (b) we're on our turn —
	 * style advice doesn't apply to moves the opponent is choosing. Empty
	 * map when unavailable so downstream `.get()` calls are safe.
	 */
	const adviceByUci = $derived.by<Map<string, StyleAdvice>>(() => {
		if (!fingerprint || !isOurTurn || !result || !fen) return new Map();
		const color: 'white' | 'black' = sideToMove;
		const advice = adviseMoves(fen, color, result.moves, fingerprint, openingFit);
		const out = new SvelteMap<string, StyleAdvice>();
		for (const a of advice) out.set(a.uci, a);
		return out;
	});

	/**
	 * Best fit score across candidates at this position. Used to tag the
	 * single top-style-fit move with a filled indicator so the user's
	 * eye lands on it, without implying the other moves are bad.
	 */
	const topFitUci = $derived.by<string | null>(() => {
		let best: { uci: string; fit: number } | null = null;
		for (const [uci, a] of adviceByUci) {
			if (a.fit <= 0) continue;
			if (!best || a.fit > best.fit) best = { uci, fit: a.fit };
		}
		return best && best.fit >= 0.55 ? best.uci : null;
	});

	function fitTone(fit: number): string {
		if (fit >= 0.7) return 'text-[var(--color-olive-300)]';
		if (fit >= 0.55) return 'text-[var(--color-brass-300)]';
		return 'text-[var(--color-parchment-500)]';
	}

	function adviceTitle(a: StyleAdvice): string {
		const parts: string[] = [`Style fit ${Math.round(a.fit * 100)}%.`];
		for (const r of a.reasons) parts.push(r);
		for (const c of a.caveats) parts.push(`⚠ ${c}`);
		return parts.join('\n');
	}

	/**
	 * Decide the tags for a move. Tags stack — a single move can be MAIN +
	 * SHARP + ELITE, because they measure different signals (canonical
	 * classification, forcing character, who plays it). DUBIOUS and
	 * SURPRISE are exclusive: if a move scores poorly it isn't also
	 * "elite", and a rare move that happens to win is already "surprise"
	 * (MAIN / ELITE wouldn't add information).
	 *
	 * Evaluation order matters only for the exclusivity rules: DUBIOUS
	 * short-circuits everything, and SURPRISE only applies to an
	 * otherwise-untagged rare move.
	 */
	function tagsFor(m: ExplorerMove): TagKind[] {
		const games = totalGames(m);
		if (games === 0) return [];
		if (totalAll < 50) return [];

		const freq = games / totalAll;
		const score = scorePct(m);
		const isTop = games === topGames;

		// On the opponent's turn we deliberately show a pared-down tag set.
		// MAIN still matters (this is theory), and a rare-but-effective
		// reply is worth flagging as DANGEROUS so the user remembers to
		// prepare for it. ELITE / SHARP / DUBIOUS / SURPRISE are useful
		// when you're picking your own move, not when you're cataloguing
		// what they might throw at you.
		if (!isOurTurn) {
			const out: TagKind[] = [];
			if (m.opening && ((isTop && freq >= 0.2) || freq >= 0.35)) out.push('MAIN');
			// DANGEROUS mirrors SURPRISE but scored from the side-to-move
			// (which IS the opponent here) — rare reply that nonetheless
			// scores well.
			if (freq < 0.05 && score >= 52 && games >= 20) out.push('DANGEROUS');
			return out;
		}

		if (score <= 40 && games >= 50) return ['DUBIOUS'];

		const out: TagKind[] = [];
		if (m.opening && ((isTop && freq >= 0.2) || freq >= 0.35)) out.push('MAIN');

		const probe = narrowness.get(m.uci);
		if (probe && probe.plies >= 1 && probe.concentration >= 0.55 && games >= 30) {
			out.push('SHARP');
		}

		if (
			positionAvgRating > 0 &&
			m.averageRating !== undefined &&
			m.averageRating - positionAvgRating >= 100 &&
			games >= 30
		) {
			out.push('ELITE');
		}

		if (out.length === 0 && freq < 0.05 && score >= 52 && games >= 20) {
			out.push('SURPRISE');
		}

		return out;
	}

	function tagIcon(tag: TagKind): ComponentType {
		switch (tag) {
			case 'MAIN':
				return Crown;
			case 'ELITE':
				return Gem;
			case 'SURPRISE':
				return Sparkles;
			case 'SHARP':
				return Flame;
			case 'DUBIOUS':
				return AlertTriangle;
			case 'DANGEROUS':
				return Swords;
		}
	}

	function tagIconClass(tag: TagKind): string {
		switch (tag) {
			case 'MAIN':
				return 'text-[var(--color-brass-300)]';
			case 'ELITE':
				return 'text-[var(--color-olive-300)]';
			case 'SURPRISE':
				return 'text-[var(--color-olive-300)]';
			case 'SHARP':
				return 'text-[var(--color-copper-300)]';
			case 'DUBIOUS':
				return 'text-[var(--color-oxblood-300)]';
			case 'DANGEROUS':
				return 'text-[var(--color-oxblood-300)]';
		}
	}

	function tagTitle(tag: TagKind, m?: ExplorerMove): string {
		switch (tag) {
			case 'MAIN':
				return 'Transitions into a named ECO opening.';
			case 'ELITE':
				return m?.averageRating
					? `Higher-rated players choose this (avg ${m.averageRating}).`
					: 'Higher-rated players choose this.';
			case 'SURPRISE':
				return 'Rare but scores well — an off-beat weapon.';
			case 'SHARP': {
				const probe = m ? narrowness.get(m.uci) : undefined;
				if (probe) {
					return `Leads to a narrow forced sequence (top reply ≈ ${Math.round(probe.concentration * 100)}%).`;
				}
				return 'Leads to a narrow forced sequence.';
			}
			case 'DUBIOUS':
				return 'Scores poorly with enough games to be reliable.';
			case 'DANGEROUS':
				return 'Rare reply, but scores well for your opponent — prepare for it.';
		}
	}

	/**
	 * Required gap between DB and user score scales down with sample size.
	 * At the minimum sample size we demand a large gap to overcome noise;
	 * with many games a small gap is enough. Concretely:
	 *
	 *   needed = max(FLOOR, BASE × sqrt(MIN_GAMES / games))
	 *
	 *   games=5  → 0.10   games=20 → 0.05   games=50 → 0.04 (floor)
	 *
	 * The sqrt-scaling approximates the standard error of a proportion,
	 * which shrinks as 1/sqrt(N). Floor prevents the indicator from
	 * firing on trivially-small deltas at very large samples.
	 */
	const UNDERPERFORM_MIN_GAMES = 5;
	const UNDERPERFORM_BASE_DELTA = 0.1;
	const UNDERPERFORM_FLOOR_DELTA = 0.04;

	interface UnderperformInfo {
		userScore: number;
		dbScore: number;
		games: number;
	}

	function requiredDelta(games: number): number {
		const scaled = UNDERPERFORM_BASE_DELTA * Math.sqrt(UNDERPERFORM_MIN_GAMES / games);
		return Math.max(UNDERPERFORM_FLOOR_DELTA, scaled);
	}

	function underperformInfo(m: ExplorerMove): UnderperformInfo | null {
		if (!userWdlBySan) return null;
		// Only meaningful on our turn — "you underperform here" is advice
		// about a move *we* pick, not a reply the opponent plays at us.
		if (!isOurTurn) return null;
		const row = userWdlBySan.get(m.san);
		if (!row || row.games < UNDERPERFORM_MIN_GAMES) return null;
		const wins = sideToMove === 'white' ? row.white : row.black;
		const userScore = (wins + row.draws / 2) / row.games;
		const dbTotal = totalGames(m);
		if (dbTotal === 0) return null;
		const dbWins = sideToMove === 'white' ? m.white : m.black;
		const dbScore = (dbWins + m.draws / 2) / dbTotal;
		if (dbScore - userScore < requiredDelta(row.games)) return null;
		return { userScore, dbScore, games: row.games };
	}

	function underperformTitle(info: UnderperformInfo): string {
		const user = Math.round(info.userScore * 100);
		const db = Math.round(info.dbScore * 100);
		return `You score ${user}% here vs ${db}% expected (${info.games} game${info.games === 1 ? '' : 's'}).`;
	}

	function probePending(m: ExplorerMove): boolean {
		// Show a subtle placeholder while we're still probing candidates.
		const candidates = result?.moves ?? [];
		if (candidates.length === 0) return false;
		const games = totalGames(m);
		if (games < 30) return false;
		const drawRate = games > 0 ? m.draws / games : 0;
		const base = totalAll > 0 ? candidates.reduce((s, x) => s + x.draws, 0) / totalAll : 0;
		const isCandidate = drawRate <= Math.max(base, 0.2);
		return isCandidate && !narrowness.has(m.uci);
	}
</script>

<!-- `interpolate-size: allow-keywords` lets browsers transition `height: auto`
     so the panel sizes itself exactly to its content while still animating
     between states as new explorer data arrives. -->
<div class="candidates-autoheight">
	<div class="mb-3 flex items-center gap-2">
		<span class="eyebrow flex-1">Candidates</span>
		{#if loading}
			<span class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
				>loading</span
			>
		{/if}
		{#if headerRight}
			{@render headerRight()}
		{/if}
	</div>

	{#if needsToken}
		<!-- Bordered notice: makes the missing-Lichess state read as a
			 deliberate empty-state rather than a transient blank. The setup
			 instructions live inside the card so the user can act on them
			 without leaving the panel. -->
		<div
			class="mb-4 rounded-[3px] border border-[var(--color-ink-700)] bg-[var(--color-ink-800)]/40 p-3"
		>
			<p class="mb-2 font-mono text-[10px] tracking-wider text-[var(--color-brass-300)] uppercase">
				Lichess connection required
			</p>
			<p class="mb-3 font-serif text-xs leading-relaxed text-[var(--color-parchment-300)] italic">
				Sign in with Lichess to load game counts, win-rates and opening tags. The same connection
				powers explorer probes, opponent prep and bot sparring.
			</p>
			<!-- Primary CTA: full OAuth login flow (PKCE). This is the path
				 we want everyone on — it's a normal "sign in with X" round-
				 trip and the resulting token covers explorer, study sync
				 and bot challenges. The pasted-token escape hatch lives
				 below as a small secondary affordance for people who
				 deliberately want a scopeless personal token. -->
			<div class="mb-2 flex flex-wrap items-center gap-2">
				<Button variant="primary" size="sm" onclick={connectLichess} disabled={oauthBusy}>
					{oauthBusy ? 'Opening Lichess…' : 'Sign in with Lichess'}
				</Button>
				<!-- href is built from `resolve('/settings')` plus a `?return=`
					 carrier so the user lands back on the explorer's host page
					 after connecting. The lint rule only spots literal
					 `resolve()` in the attribute. -->
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					href={settingsReturnHref}
					class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase transition-colors hover:text-[var(--color-parchment-300)]"
				>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
					Open Settings
				</a>
			</div>
			<p class="font-serif text-[11px] leading-relaxed text-[var(--color-parchment-500)] italic">
				Prefer not to sign in? You can paste a personal API token in
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					href={settingsReturnHref}
					class="text-[var(--color-parchment-400)] underline underline-offset-2 hover:text-[var(--color-parchment-200)]"
					><!-- eslint-enable svelte/no-navigation-without-resolve -->Settings</a
				> instead.
			</p>
		</div>

		<!-- Without Lichess we can still surface what *we* know: the user's
			 own saved moves. Each row mirrors the regular candidate layout
			 so columns stay aligned across states; everything Lichess would
			 fill in (WDL bar, share/score %, tags) renders as a pulsing
			 skeleton bar to telegraph "this is where the data goes once you
			 connect". Engine eval still shows real values when available. -->
		{#if savedMoves && savedMoves.length > 0}
			<p
				class="mb-2 font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
			>
				In your repertoire
			</p>
			<ul class="space-y-0.5">
				{#each savedMoves as m (m.uci)}
					<li>
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div
							role={onselect ? 'button' : undefined}
							tabindex={onselect ? 0 : undefined}
							aria-disabled={!onselect ? 'true' : undefined}
							onclick={onselect ? () => onselect?.(m.san) : undefined}
							onkeydown={onselect ? (e) => handleRowKey(e, m) : undefined}
							oncontextmenu={(e) => openContextMenu(e, m)}
							class="group grid w-full grid-cols-[5rem_1fr_3rem] items-center gap-1 rounded-[3px] py-1.5 pr-1.5 pl-1.5 text-left transition-colors lg:gap-2 {onselect
								? 'cursor-pointer hover:bg-[var(--color-ink-800)]'
								: 'cursor-default'}"
						>
							<span
								class="grid grid-cols-[2.25rem_1fr] items-center gap-1 font-mono text-sm text-[var(--color-parchment-100)]"
							>
								<span class="flex items-center gap-1">
									<span class="relative inline-block leading-none whitespace-nowrap">
										{#if ondelete}
											<button
												type="button"
												onclick={(e) => {
													e.stopPropagation();
													openConfirm(m);
												}}
												onkeydown={(e) => {
													if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
												}}
												title="Delete {m.san} from your tree"
												aria-label="Delete {m.san} from your tree"
												class="group/bookmark absolute right-full bottom-0 -m-2 mr-0.5 cursor-pointer py-2 pr-1 pl-3 leading-none"
											>
												<Bookmark
													class="size-2.5 fill-[var(--color-brass-300)] text-[var(--color-brass-300)] transition-colors group-hover/bookmark:fill-[var(--color-oxblood-300)] group-hover/bookmark:text-[var(--color-oxblood-300)]"
													strokeWidth={1.5}
												/>
											</button>
										{:else}
											<Bookmark
												class="absolute right-full bottom-0 mr-1.5 size-2.5 fill-[var(--color-brass-300)] text-[var(--color-brass-300)]"
												strokeWidth={1.5}
												aria-label="Already in your tree"
											>
												<title>Already in your tree</title>
											</Bookmark>
										{/if}
										{m.san}
									</span>
								</span>
								{#if engineEvalByUci?.get(m.uci)}
									{@const ev = engineEvalByUci.get(m.uci)!}
									<span
										class="font-mono text-[10px] tabular-nums {ev.tone}"
										title="Stockfish evaluation"
									>
										{ev.text}
									</span>
								{:else}
									<span></span>
								{/if}
							</span>
							<div class="flex min-w-0 flex-col gap-0.5">
								<div
									class="h-[5px] animate-pulse rounded-full bg-[var(--color-ink-800)]"
									title="Win/draw/loss share — connect Lichess to populate"
									aria-hidden="true"
								></div>
								<div class="flex items-center justify-between gap-2">
									<span
										class="h-2 w-16 animate-pulse rounded-full bg-[var(--color-ink-800)]"
										aria-hidden="true"
									></span>
									<span
										class="h-2 w-7 animate-pulse rounded-full bg-[var(--color-ink-800)]"
										aria-hidden="true"
									></span>
								</div>
							</div>
							<div class="flex flex-col items-end gap-0.5">
								{#if transposesSans?.has(m.san)}
									<span
										title="Transposes into existing prep — playing this reaches a position already in your tree."
										class="flex items-center"
									>
										<Shuffle class="size-3.5 text-[var(--color-brass-300)]" strokeWidth={1.75} />
									</span>
								{:else}
									<span
										class="h-2 w-6 animate-pulse rounded-full bg-[var(--color-ink-800)]"
										aria-hidden="true"
									></span>
								{/if}
								<span
									class="h-2 w-5 animate-pulse rounded-full bg-[var(--color-ink-800)]"
									aria-hidden="true"
								></span>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="font-serif text-[11px] text-[var(--color-parchment-500)] italic">
				No saved moves at this position yet. Play one on the board to add it.
			</p>
		{/if}
	{:else if error}
		<p class="text-xs text-[var(--color-oxblood-300)]">{error}</p>
	{/if}

	{#if result}
		{#if result.opening}
			<div
				class="mb-3 border-b border-[var(--color-ink-800)] pb-2 text-xs text-[var(--color-parchment-400)]"
			>
				<span class="font-mono text-[var(--color-brass-300)]">{result.opening.eco}</span>
				<span class="ml-1 font-serif italic">{result.opening.name}</span>
			</div>
		{/if}

		{#if result.moves.length === 0}
			{#if engineRows && engineRows.length > 0}
				<p class="mb-2 font-serif text-[11px] text-[var(--color-parchment-500)] italic">
					No games in the database. Engine candidates below.
				</p>
				<ul class="space-y-0.5">
					{#each engineRows as r (r.uci)}
						<li>
							<!-- role + tabindex are gated by the same `onselect` condition;
								 static analysis can't see that, hence the directive below. -->
							<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
							<div
								role={onselect ? 'button' : undefined}
								tabindex={onselect ? 0 : undefined}
								aria-disabled={!onselect ? 'true' : undefined}
								onclick={onselect ? () => onselect?.(r.san) : undefined}
								onkeydown={onselect ? (e) => handleRowKey(e, r) : undefined}
								oncontextmenu={(e) => openContextMenu(e, r)}
								class="group grid w-full grid-cols-[5rem_1fr_3rem] items-center gap-1 rounded-[3px] py-1.5 pr-1.5 pl-1.5 text-left transition-colors lg:gap-2 {onselect
									? 'cursor-pointer hover:bg-[var(--color-ink-800)]'
									: 'cursor-default'}"
							>
								<span
									class="grid grid-cols-[2.25rem_1fr] items-center gap-1 font-mono text-sm text-[var(--color-parchment-100)]"
								>
									<span class="flex items-center gap-1">
										<span class="relative inline-block leading-none whitespace-nowrap">
											{#if knownSans?.has(r.san)}
												{#if ondelete}
													<button
														type="button"
														onclick={(e) => {
															e.stopPropagation();
															openConfirm(r);
														}}
														onkeydown={(e) => {
															// Don't let Enter/Space on the bookmark also
															// trigger the row's onselect.
															if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
														}}
														title="Delete {r.san} from your tree"
														aria-label="Delete {r.san} from your tree"
														class="group/bookmark absolute right-full bottom-0 -m-2 mr-0.5 cursor-pointer py-2 pr-1 pl-3 leading-none"
													>
														<Bookmark
															class="size-2.5 fill-[var(--color-brass-300)] text-[var(--color-brass-300)] transition-colors group-hover/bookmark:fill-[var(--color-oxblood-300)] group-hover/bookmark:text-[var(--color-oxblood-300)]"
															strokeWidth={1.5}
														/>
													</button>
												{:else}
													<Bookmark
														class="absolute right-full bottom-0 mr-1.5 size-2.5 fill-[var(--color-brass-300)] text-[var(--color-brass-300)]"
														strokeWidth={1.5}
													/>
												{/if}
											{/if}
											{r.san}
										</span>
									</span>
									<span class="font-mono text-[10px] tabular-nums {r.tone}">{r.text}</span>
								</span>
								<span class="text-[10px] text-[var(--color-parchment-500)] italic">engine only</span
								>
								<span></span>
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="font-serif text-xs text-[var(--color-parchment-500)] italic">
					No games in the database for this position.
				</p>
			{/if}
		{:else}
			<ul class="space-y-0.5">
				{#each result.moves as m (m.uci)}
					{@const s = scorePct(m)}
					{@const ts = tagsFor(m)}
					{@const pending = probePending(m)}
					{@const advice = adviceByUci.get(m.uci)}
					{@const underperform = underperformInfo(m)}
					<li>
						<!-- role + tabindex are gated by the same `onselect` condition;
							 static analysis can't see that, hence the directive below. -->
						<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
						<div
							role={onselect ? 'button' : undefined}
							tabindex={onselect ? 0 : undefined}
							aria-disabled={!onselect ? 'true' : undefined}
							onclick={onselect ? () => onselect?.(m.san) : undefined}
							onkeydown={onselect ? (e) => handleRowKey(e, m) : undefined}
							oncontextmenu={(e) => openContextMenu(e, m)}
							class="group grid w-full grid-cols-[5rem_1fr_3rem] items-center gap-1 rounded-[3px] py-1.5 pr-1.5 pl-1.5 text-left transition-colors lg:gap-2 {onselect
								? 'cursor-pointer hover:bg-[var(--color-ink-800)]'
								: 'cursor-default'}"
						>
							<!-- Inner grid: SAN / eval in fixed columns so the move
								 codes and engine evals each line up vertically
								 across rows. The bookmark anchors to the SAN
								 element (not the row), so its vertical position
								 is consistent regardless of row height. -->
							<span
								class="grid grid-cols-[2.25rem_1fr] items-center gap-1 font-mono text-sm text-[var(--color-parchment-100)]"
							>
								<span class="flex items-center gap-1">
									<!-- SAN wrapper is a tight inline-block with
										 line-height:1 so its box = text glyph
										 height. Bookmark is positioned against
										 that wrapper: right:100% puts its right
										 edge flush to the SAN's left edge, and
										 bottom:0 aligns its bottom with the SAN
										 glyph bottom. This stays consistent no
										 matter the overall row height. -->
									<span class="relative inline-block leading-none whitespace-nowrap">
										{#if knownSans?.has(m.san)}
											{#if ondelete}
												<!-- The bookmark is the primary delete entry point.
													 Clicking it opens a confirm dialog that names
													 the blast radius (the move + its descendants).
													 Padded hit area extends well past the 10px
													 visible icon for touch users. -->
												<button
													type="button"
													onclick={(e) => {
														e.stopPropagation();
														openConfirm(m);
													}}
													onkeydown={(e) => {
														if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
													}}
													title="Delete {m.san} from your tree"
													aria-label="Delete {m.san} from your tree"
													class="group/bookmark absolute right-full bottom-0 -m-2 mr-0.5 cursor-pointer py-2 pr-1 pl-3 leading-none"
												>
													<Bookmark
														class="size-2.5 fill-[var(--color-brass-300)] text-[var(--color-brass-300)] transition-colors group-hover/bookmark:fill-[var(--color-oxblood-300)] group-hover/bookmark:text-[var(--color-oxblood-300)]"
														strokeWidth={1.5}
													/>
												</button>
											{:else}
												<Bookmark
													class="absolute right-full bottom-0 mr-1.5 size-2.5 fill-[var(--color-brass-300)] text-[var(--color-brass-300)]"
													strokeWidth={1.5}
													aria-label="Already in your tree"
												>
													<title>Already in your tree</title>
												</Bookmark>
											{/if}
											{#if underperform}
												<!-- Shown only on saved rows per the design: a
													 question mark to the left of the bookmark
													 flagging that this move underperforms the
													 Lichess DB baseline in the user's own
													 games. Absolute-positioned to clear the
													 bookmark's ~10px width + margin. -->
												<HelpCircle
													class="absolute right-full bottom-0 mr-3.5 size-2.5 text-[var(--color-oxblood-300)]"
													strokeWidth={2}
													aria-label={underperformTitle(underperform)}
												>
													<title>{underperformTitle(underperform)}</title>
												</HelpCircle>
											{/if}
										{/if}
										{m.san}
									</span>
									{#if onselect && !knownSans?.has(m.san)}
										<ArrowRight
											class="size-3 text-[var(--color-parchment-500)] opacity-0 transition-opacity group-hover:opacity-100"
										/>
									{/if}
								</span>
								{#if engineEvalByUci?.get(m.uci)}
									{@const ev = engineEvalByUci.get(m.uci)!}
									<span
										class="font-mono text-[10px] tabular-nums {ev.tone}"
										title="Stockfish evaluation"
									>
										{ev.text}
									</span>
								{:else}
									<span></span>
								{/if}
							</span>
							<div class="flex min-w-0 flex-col gap-0.5">
								<div
									class="flex h-[5px] cursor-help overflow-hidden rounded-full bg-[var(--color-ink-800)]"
									title="W {sharePct(m, 'white')}% · D {sharePct(m, 'draws')}% · B {sharePct(
										m,
										'black'
									)}%"
								>
									<span class="bg-[var(--color-winbar-white)]" style:width="{sharePct(m, 'white')}%"
									></span>
									<span class="bg-[var(--color-winbar-draws)]" style:width="{sharePct(m, 'draws')}%"
									></span>
									<span class="bg-[var(--color-winbar-black)]" style:width="{sharePct(m, 'black')}%"
									></span>
								</div>
								<div
									class="flex items-center justify-between font-mono text-[10px] text-[var(--color-parchment-500)] tabular-nums"
								>
									<span
										class="cursor-help underline decoration-[var(--color-parchment-500)]/60 decoration-dotted underline-offset-2"
										title="White wins / draws / Black wins"
									>
										{sharePct(m, 'white')} / {sharePct(m, 'draws')} / {sharePct(m, 'black')}
									</span>
									<span
										class="{scoreTone(
											s
										)} cursor-help underline decoration-[var(--color-parchment-500)]/60 decoration-dotted underline-offset-2"
										title="Score for {sideToMove === 'white' ? 'White' : 'Black'}"
									>
										{s}%
									</span>
								</div>
							</div>
							<div class="flex flex-col items-end gap-0.5">
								{#if ts.length > 0 || transposesSans?.has(m.san) || advice}
									<span class="flex items-center gap-0.5">
										{#each ts as t (t)}
											{@const Icon = tagIcon(t)}
											<span title={tagTitle(t, m)} class="flex items-center">
												<Icon class="size-3.5 {tagIconClass(t)}" strokeWidth={1.75} />
											</span>
										{/each}
										{#if transposesSans?.has(m.san)}
											<span
												title="Transposes into existing prep — playing this reaches a position already in your tree."
												class="flex items-center"
											>
												<Shuffle
													class="size-3.5 text-[var(--color-brass-300)]"
													strokeWidth={1.75}
												/>
											</span>
										{/if}
										{#if advice && advice.fit >= 0.55}
											<span
												title={adviceTitle(advice)}
												class="flex items-center"
												aria-label="Style fit {Math.round(advice.fit * 100)}%"
											>
												<UserCheck
													class="size-3.5 {fitTone(advice.fit)}"
													strokeWidth={m.uci === topFitUci ? 2.25 : 1.75}
												/>
											</span>
										{/if}
									</span>
								{:else if pending}
									<span
										class="font-mono text-[9px] tracking-widest text-[var(--color-parchment-500)]/60 uppercase"
										title="Probing for sharpness…"
									>
										…
									</span>
								{/if}
								<span
									class="font-mono text-[10px] text-[var(--color-parchment-500)] tabular-nums"
									title="Share of games at this position ({totalGames(m).toLocaleString()} games)"
								>
									{totalAll > 0 ? Math.round((totalGames(m) / totalAll) * 100) : 0}%
								</span>
							</div>
						</div>
					</li>
				{/each}
			</ul>
			{#if onselect}
				<p class="mt-3 font-serif text-[11px] text-[var(--color-parchment-500)] italic">
					Click a move to add it to your tree.
				</p>
			{/if}
		{/if}
	{/if}
</div>

{#if menuSan}
	<!-- Context menu for right-click-delete. Backdrop closes on click;
		 menu is fixed-positioned at the cursor. The "Delete" entry now
		 funnels into the same confirm dialog used by bookmark-click so
		 both paths show the blast-radius preview. -->
	<div
		role="presentation"
		class="fixed inset-0 z-40"
		onclick={closeContextMenu}
		oncontextmenu={(e) => {
			e.preventDefault();
			closeContextMenu();
		}}
	></div>
	<div
		class="ink-panel fixed z-50 flex min-w-[11rem] flex-col overflow-hidden rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] shadow-lg"
		style:left="{menuX}px"
		style:top="{menuY}px"
	>
		<div
			class="border-b border-[var(--color-ink-800)] px-3 py-1.5 font-mono text-[11px] text-[var(--color-parchment-500)]"
		>
			{menuSan}
		</div>
		<button
			type="button"
			onclick={confirmFromMenu}
			class="flex items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--color-oxblood-300)] transition-colors hover:bg-[var(--color-ink-800)]"
		>
			Delete from tree…
		</button>
	</div>
{/if}

{#if confirmSan}
	<!-- Delete confirmation. Triggered by clicking the bookmark glyph on a
		 saved row, by Del/Backspace on a focused row, or by the right-click
		 menu's Delete entry. The blast-radius count comes from the parent
		 (subtreeSizeBySan) so the user sees how much they're about to drop
		 in addition to the move itself. -->
	<div
		role="presentation"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeConfirm();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') closeConfirm();
		}}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="explorer-confirm-delete-title"
			class="ink-panel w-full max-w-sm rounded-[6px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-5 shadow-lg"
		>
			<h3 id="explorer-confirm-delete-title" class="eyebrow mb-2 text-[var(--color-parchment-200)]">
				Delete from tree
			</h3>
			<p class="mb-4 font-serif text-sm text-[var(--color-parchment-300)]">
				{#if confirmCount === 0}
					Delete <span class="font-mono text-[var(--color-parchment-100)]">{confirmSan}</span>
					from your tree?
				{:else}
					Delete <span class="font-mono text-[var(--color-parchment-100)]">{confirmSan}</span>
					and the {confirmCount}
					{confirmCount === 1 ? 'move' : 'moves'} you've prepared beneath it?
				{/if}
			</p>
			<div class="flex justify-end gap-2">
				<Button variant="secondary" size="sm" onclick={closeConfirm}>Cancel</Button>
				<Button variant="destructive" size="sm" onclick={commitConfirm}>Delete</Button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* `interpolate-size: allow-keywords` lets the browser animate between
	   content-sized `height: auto` values, so this panel fits its content
	   exactly yet still glides between states when the candidates list swaps. */
	.candidates-autoheight {
		interpolate-size: allow-keywords;
		height: auto;
		transition: height 200ms ease-out;
		/* Clip only vertically during the height tween so content doesn't
		   spill under the panel mid-animation. Horizontal must stay visible:
		   the "already in tree" bookmark icons are absolute-positioned to
		   the left of SAN cells and would otherwise get clipped. */
		overflow-x: visible;
		overflow-y: clip;
	}
</style>
