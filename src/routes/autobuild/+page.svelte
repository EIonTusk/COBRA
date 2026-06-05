<script lang="ts">
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { base, resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { ArrowLeft, ArrowRight, RotateCcw, X } from 'lucide-svelte';
	import type { Key, MoveMetadata, Dests } from '@lichess-org/chessground/types';

	import Board from '$lib/chess/Board.svelte';
	import { buildFromMasters, startFenAfterPrefix } from '$lib/lichess/mastersBuild';
	import { buildFromBroadcasts, type BroadcastBuildProgress } from '$lib/lichess/broadcastBuild';
	import { buildFromChesscom, type ChesscomBuildProgress } from '$lib/chesscom/chesscomBuild';
	import { searchFidePlayers, type FidePlayer } from '$lib/lichess/broadcasts';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import { createRepertoire } from '$lib/storage/repertoires';
	import { colorToMove, STARTPOS_FEN } from '$lib/chess/fen';
	import { edgeFromUci, fenAfterMove, legalDests } from '$lib/chess/position';
	import { Button, Input, Label, SourceUsernameInput, type Source, cn } from '$lib/ui';
	import type { AppSettings, Color } from '$lib/types';
	import { loadDossierReport } from '$lib/storage/dossierReport';

	type Mode = 'lichess' | 'masters' | 'broadcasts';
	type PrefixInputMode = 'san' | 'board';

	let mode = $state<Mode>('lichess');
	// Which platform to pull the user's games from in player mode. Lichess
	// goes through the /player explorer (fast, aggregated); chess.com streams
	// the user's own PGNs and aggregates client-side.
	let source = $state<Source>('lichess');

	// FIDE player picker for broadcast mode. `broadcastPlayerQuery` drives the
	// debounced search; `broadcastPlayerResults` populates the select;
	// `broadcastSelectedPlayer` is the one the user committed to.
	let broadcastPlayerQuery = $state('');
	let broadcastPlayerResults = $state<FidePlayer[]>([]);
	let broadcastSelectedPlayer = $state<FidePlayer | null>(null);
	let broadcastSearching = $state(false);
	let broadcastSearchError = $state<string | null>(null);
	let broadcastSearchToken = 0;
	let broadcastMaxTournaments = $state(20);
	// Combobox open/close: opens while typing (query ≥ 2 chars) or when the
	// input is focused and there are cached results; closes on pick or
	// outside click.
	let broadcastComboOpen = $state(false);
	let broadcastComboRoot = $state<HTMLDivElement | null>(null);

	// Shared controls.
	let color: Color = $state('white');
	let depth = $state(16);
	let opponentFanout = $state(2);
	let name = $state('');
	let running = $state(false);
	let done = $state(false);
	let error = $state<string | null>(null);
	let settings = $state<AppSettings | null>(null);
	let controller: AbortController | null = null;
	let createdRepId = $state<string | null>(null);

	// Player-mode: the username whose games we walk. Interpretation depends
	// on `source` — Lichess handle or chess.com handle.
	let username = $state('');
	// Chess.com-only knob: how many recent games to stream for client-side
	// aggregation. Lichess gets unlimited via its explorer.
	let chesscomMaxGames = $state(100);

	// Starting moves (shared by both modes).
	let prefixInput = $state('');
	let prefixMode = $state<PrefixInputMode>('san');

	// Board-builder state (only used when prefixMode === 'board').
	let builderFen = $state(STARTPOS_FEN);
	let builderSans = $state<string[]>([]);
	let builderLastMove = $state<[Key, Key] | undefined>(undefined);

	// Popular Lichess usernames, offered as suggestions in the Lichess-mode
	// username field. Raw usernames — Lichess-mode takes usernames directly.
	const POPULAR_LICHESS_USERNAMES = [
		'DrNykterstein',
		'Hikaru',
		'Firouzja2003',
		'AnishGiri',
		'lachesisQ',
		'LyonBeast',
		'Zhigalko_Sergei',
		'Konevlad'
	];

	const builderDests = $derived.by<Dests>(() => {
		if (prefixMode !== 'board') return new Map();
		try {
			const raw = legalDests(builderFen);
			return new Map(Array.from(raw, ([k, v]) => [k as Key, v as Key[]]));
		} catch {
			return new Map();
		}
	});

	let broadcastSearchTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * Debounced FIDE-player search. Typing in the input fires a 250 ms
	 * timer; whichever run is newest when the response lands wins, so a
	 * quick "d" → "di" → "din" sequence doesn't race older responses over
	 * fresher ones. Selecting a player from the dropdown doesn't re-query.
	 */
	function onBroadcastPlayerQueryInput() {
		// User typed — invalidate any previously-selected player, otherwise
		// they could edit "ding" → "carlsen" and leave the old selection
		// silently driving the build.
		broadcastSelectedPlayer = null;
		broadcastSearchError = null;
		broadcastComboOpen = true;
		if (broadcastSearchTimer) clearTimeout(broadcastSearchTimer);
		const q = broadcastPlayerQuery.trim();
		if (q.length < 2) {
			broadcastPlayerResults = [];
			broadcastSearching = false;
			return;
		}
		broadcastSearchTimer = setTimeout(async () => {
			const mine = ++broadcastSearchToken;
			broadcastSearching = true;
			try {
				const token = settings ? effectiveLichessToken(settings) : '';
				const results = await searchFidePlayers({
					query: q,
					token: token || undefined
				});
				if (mine !== broadcastSearchToken) return;
				broadcastPlayerResults = results.slice(0, 25);
			} catch (e) {
				if (mine !== broadcastSearchToken) return;
				broadcastSearchError = (e as Error).message || 'FIDE search failed.';
				broadcastPlayerResults = [];
			} finally {
				if (mine === broadcastSearchToken) broadcastSearching = false;
			}
		}, 250);
	}

	/**
	 * Commit a FIDE player from the combobox dropdown. Fills the input with
	 * their canonical name so the field no longer reads like an in-progress
	 * search, closes the dropdown, and clears staging state.
	 */
	function pickBroadcastPlayer(p: FidePlayer) {
		broadcastSelectedPlayer = p;
		broadcastPlayerQuery = p.name;
		broadcastComboOpen = false;
	}

	/**
	 * Close the combobox when the user clicks/taps outside of it. Mirrors
	 * the behaviour baked into `Select.svelte`.
	 */
	function onBroadcastComboDocMouseDown(e: MouseEvent) {
		if (!broadcastComboOpen || !broadcastComboRoot) return;
		if (e.target instanceof Node && broadcastComboRoot.contains(e.target)) return;
		broadcastComboOpen = false;
	}

	function onBroadcastComboDocKeydown(e: KeyboardEvent) {
		if (!broadcastComboOpen) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			broadcastComboOpen = false;
		}
	}

	function handleBuilderMove(
		orig: Key,
		dest: Key,
		_m: MoveMetadata,
		promotion?: 'q' | 'r' | 'b' | 'n'
	) {
		const edge = edgeFromUci(builderFen, orig, dest, promotion);
		if (!edge) return;
		builderFen = fenAfterMove(builderFen, edge);
		builderSans = [...builderSans, edge.san];
		builderLastMove = [orig, dest];
		prefixInput = formatSanSequence(builderSans);
	}

	function builderUndo() {
		if (builderSans.length === 0) return;
		const trimmed = builderSans.slice(0, -1);
		builderSans = trimmed;
		prefixInput = formatSanSequence(trimmed);
		const nextFen = startFenAfterPrefix(trimmed);
		builderFen = nextFen ?? STARTPOS_FEN;
		builderLastMove = undefined;
	}

	function builderReset() {
		builderSans = [];
		prefixInput = '';
		builderFen = STARTPOS_FEN;
		builderLastMove = undefined;
	}

	function formatSanSequence(sans: string[]): string {
		const out: string[] = [];
		for (let i = 0; i < sans.length; i++) {
			if (i % 2 === 0) out.push(`${i / 2 + 1}.`);
			out.push(sans[i]);
		}
		return out.join(' ');
	}

	/**
	 * Normalise a pasted SAN sequence:
	 *   "e4 c5 Nf3 d6" → "1. e4 c5 2. Nf3 d6"
	 *   "1.e4  c5 2.Nf3 d6" → "1. e4 c5 2. Nf3 d6"
	 * Drops move numbers, dots, and stray digits; re-inserts every two plies.
	 */
	function normalizeSanPrefix(input: string): string {
		const tokens = input
			.split(/\s+/)
			.map((t) => t.replace(/^\d+\.+/, ''))
			.filter((t) => t.length > 0 && !/^\d+$/.test(t) && !/^\.+$/.test(t));
		return formatSanSequence(tokens);
	}

	function formatPrefix() {
		prefixInput = normalizeSanPrefix(prefixInput);
	}

	// Syncing prefixInput → builder state when the user switches modes: if
	// they typed something in SAN mode and then flip to Board mode, replay
	// those moves onto the builder.
	$effect(() => {
		if (prefixMode !== 'board') return;
		const sans = prefixInput
			.split(/\s+/)
			.map((t) => t.replace(/^\d+\.+/, ''))
			.filter((t) => t.length > 0 && !/^\d+$/.test(t) && !/^\.+$/.test(t));
		if (sans.length === 0) {
			builderSans = [];
			builderFen = STARTPOS_FEN;
			builderLastMove = undefined;
			return;
		}
		if (arraysEqual(sans, builderSans)) return;
		const replayFen = startFenAfterPrefix(sans);
		if (replayFen) {
			builderSans = sans;
			builderFen = replayFen;
			builderLastMove = undefined;
		}
	});

	function arraysEqual(a: string[], b: string[]) {
		return a.length === b.length && a.every((x, i) => x === b[i]);
	}

	const stats = $state({
		edgesAdded: 0,
		cardsAdded: 0,
		probed: 0,
		// Broadcasts-mode only.
		tournamentsScanned: 0,
		tournamentsTotal: 0,
		gamesScanned: 0,
		gamesMatched: 0,
		currentTournament: ''
	});

	// Whether the user has a cached dossier scan we could draw style advice
	// from. Not used to change autobuild's pick logic — the tree shape stays
	// the same — just to inform the user that advice will appear in the
	// editor once the rep is created.
	let hasDossierReport = $state(false);

	onMount(async () => {
		settings = await getSettings();
		if (settings?.lichessOAuth?.username && !username) {
			username = settings.lichessOAuth.username;
		}
		try {
			const saved = await loadDossierReport();
			hasDossierReport = !!saved?.payload;
		} catch {
			hasDossierReport = false;
		}
	});

	const tokenConfigured = $derived(!!settings && !!effectiveLichessToken(settings));
	// Chess.com uses a public, unauthenticated API, so the player mode only
	// needs a Lichess token when the source is set to Lichess. Masters and
	// broadcasts still go through Lichess and require a token.
	const tokenNeeded = $derived(mode !== 'lichess' || source === 'lichess');
	const canRun = $derived.by(() => {
		if (running) return false;
		if (tokenNeeded && !tokenConfigured) return false;
		if (mode === 'lichess') return !!username.trim();
		if (mode === 'broadcasts') return !!broadcastSelectedPlayer;
		return true; // masters
	});

	function resolveStartFen(): string | null {
		const prefixSans = prefixInput
			.split(/\s+/)
			.map((t) => t.replace(/^[0-9]+\.+/g, '').trim())
			.filter((t) => t.length > 0 && !/^\d+$/.test(t));
		if (prefixSans.length === 0) return STARTPOS_FEN;
		return startFenAfterPrefix(prefixSans);
	}

	function prefixSansForName(): string[] {
		return prefixInput
			.split(/\s+/)
			.map((t) => t.replace(/^[0-9]+\.+/g, '').trim())
			.filter((t) => t.length > 0 && !/^\d+$/.test(t));
	}

	async function run(e: Event) {
		e.preventDefault();
		if (!settings || !canRun) return;
		const token = effectiveLichessToken(settings);
		if (tokenNeeded && !token) {
			error = 'Connect Lichess or paste a token in Settings first.';
			return;
		}

		const startFen = resolveStartFen();
		if (!startFen) {
			error = 'Could not parse the starting moves. Check SAN spelling.';
			return;
		}

		error = null;
		done = false;
		running = true;
		controller = new AbortController();
		stats.edgesAdded = 0;
		stats.cardsAdded = 0;
		stats.probed = 0;
		stats.tournamentsScanned = 0;
		stats.tournamentsTotal = 0;
		stats.gamesScanned = 0;
		stats.gamesMatched = 0;
		stats.currentTournament = '';

		const playerHandle = mode === 'lichess' ? username.trim() : '';
		const sans = prefixSansForName();
		const sourceLabel =
			mode === 'lichess'
				? source === 'chesscom'
					? `${playerHandle} (chess.com)`
					: playerHandle
				: mode === 'broadcasts'
					? `OTB / ${broadcastSelectedPlayer?.name ?? 'player'}`
					: 'Masters';
		const repName =
			name.trim() ||
			(sans.length > 0
				? `${sourceLabel}: ${sans.join(' ')} — ${color}`
				: `${sourceLabel} — ${color}`);

		try {
			const rep = await createRepertoire(repName, color, startFen);
			createdRepId = rep.id;

			if (mode === 'broadcasts') {
				if (!broadcastSelectedPlayer) {
					throw new Error('Pick a FIDE player from the search dropdown first.');
				}
				const result = await buildFromBroadcasts({
					repId: rep.id,
					color,
					depth,
					startFen,
					player: {
						id: broadcastSelectedPlayer.id,
						name: broadcastSelectedPlayer.name
					},
					maxTournaments: broadcastMaxTournaments,
					token,
					signal: controller.signal,
					onProgress: (p: BroadcastBuildProgress) => {
						stats.tournamentsScanned = p.tournamentsScanned;
						stats.tournamentsTotal = p.tournamentsTotal;
						stats.gamesScanned = p.gamesScanned;
						stats.gamesMatched = p.gamesMatched;
						stats.edgesAdded = p.edgesAdded;
						stats.cardsAdded = p.cardsAdded;
						stats.currentTournament = p.currentTournament ?? '';
					}
				});
				stats.edgesAdded = result.edgesAdded;
				stats.cardsAdded = result.cardsAdded;
				stats.gamesMatched = result.gamesMatched;
			} else if (mode === 'lichess' && source === 'chesscom') {
				const result = await buildFromChesscom({
					repId: rep.id,
					color,
					startFen,
					depth,
					username: playerHandle,
					maxGames: chesscomMaxGames,
					since: settings.gamesSince,
					opponentFanout,
					signal: controller.signal,
					onProgress: (p: ChesscomBuildProgress) => {
						stats.gamesScanned = p.gamesScanned;
						stats.gamesMatched = p.gamesMatched;
						stats.probed = p.probed;
						stats.edgesAdded = p.edgesAdded;
						stats.cardsAdded = p.cardsAdded;
					}
				});
				stats.edgesAdded = result.edgesAdded;
				stats.cardsAdded = result.cardsAdded;
				stats.probed = result.probed;
				stats.gamesScanned = result.gamesScanned;
				stats.gamesMatched = result.gamesMatched;
			} else {
				const result = await buildFromMasters({
					repId: rep.id,
					color,
					startFen,
					depth,
					token,
					signal: controller.signal,
					opponentFanout,
					imitatePlayer: playerHandle || undefined,
					onProgress: (probed, edges) => {
						stats.probed = probed;
						stats.edgesAdded = edges;
					}
				});
				stats.edgesAdded = result.edgesAdded;
				stats.cardsAdded = result.cardsAdded;
				stats.probed = result.probed;
			}
			done = true;
		} catch (e) {
			if ((e as Error).name === 'AbortError') {
				done = true;
			} else {
				error = e instanceof Error ? e.message : 'Autobuild failed';
			}
		} finally {
			running = false;
			controller = null;
		}
	}

	function cancel() {
		controller?.abort();
	}
</script>

<svelte:window onmousedown={onBroadcastComboDocMouseDown} onkeydown={onBroadcastComboDocKeydown} />

<div class="stagger mx-auto max-w-2xl px-6 pt-14 pb-16">
	<a
		href={resolve('/repertoire/new')}
		class="eyebrow mb-5 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
		style:--i="0"
	>
		<ArrowLeft class="size-3" />
		<span>Back</span>
	</a>

	<div class="eyebrow mb-3" style:--i="1">Autobuild</div>
	<h1 class="font-serif text-5xl leading-[1.05] tracking-tight" style:--i="2">
		Seed a repertoire <em class="text-[var(--color-brass-300)]">automatically</em>.
	</h1>

	<!-- Mode toggle -->
	<div
		class="mt-6 grid grid-cols-3 overflow-hidden rounded-[5px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-0.5"
		style:--i="3"
		role="radiogroup"
	>
		<button
			type="button"
			class={cn(
				'rounded-[4px] px-4 py-3 text-left transition-colors',
				mode === 'lichess'
					? 'bg-[var(--color-brass-300)] text-[var(--color-ink-950)]'
					: 'text-[var(--color-parchment-200)] hover:bg-[var(--color-ink-800)]'
			)}
			onclick={() => (mode = 'lichess')}
			disabled={running}
		>
			<div class="font-serif text-lg leading-none">Player games</div>
			<div
				class={cn(
					'mt-1.5 font-mono text-[11px] tracking-wider uppercase',
					mode === 'lichess'
						? 'text-[var(--color-ink-950)]/70'
						: 'text-[var(--color-parchment-500)]'
				)}
			>
				Lichess or chess.com
			</div>
		</button>
		<button
			type="button"
			class={cn(
				'rounded-[4px] px-4 py-3 text-left transition-colors',
				mode === 'masters'
					? 'bg-[var(--color-brass-300)] text-[var(--color-ink-950)]'
					: 'text-[var(--color-parchment-200)] hover:bg-[var(--color-ink-800)]'
			)}
			onclick={() => (mode = 'masters')}
			disabled={running}
		>
			<div class="font-serif text-lg leading-none">Masters DB</div>
			<div
				class={cn(
					'mt-1.5 font-mono text-[11px] tracking-wider uppercase',
					mode === 'masters'
						? 'text-[var(--color-ink-950)]/70'
						: 'text-[var(--color-parchment-500)]'
				)}
			>
				Aggregate titled games
			</div>
		</button>
		<button
			type="button"
			class={cn(
				'rounded-[4px] px-4 py-3 text-left transition-colors',
				mode === 'broadcasts'
					? 'bg-[var(--color-brass-300)] text-[var(--color-ink-950)]'
					: 'text-[var(--color-parchment-200)] hover:bg-[var(--color-ink-800)]'
			)}
			onclick={() => (mode = 'broadcasts')}
			disabled={running}
		>
			<div class="font-serif text-lg leading-none">OTB broadcasts</div>
			<div
				class={cn(
					'mt-1.5 font-mono text-[11px] tracking-wider uppercase',
					mode === 'broadcasts'
						? 'text-[var(--color-ink-950)]/70'
						: 'text-[var(--color-parchment-500)]'
				)}
			>
				A specific player's OTB games
			</div>
		</button>
	</div>

	<p class="mt-5 max-w-md text-[var(--color-parchment-400)]" style:--i="4">
		{#if mode === 'lichess'}
			{#if source === 'chesscom'}
				Streams the user's recent chess.com games, aggregates them client-side, and walks the tree:
				their top move at your-side positions, common replies fanned out at opponent-side positions.
			{:else}
				Walks the chosen player's Lichess games recursively. Picks their top move at your-side
				positions; fans out to common replies at opponent-side positions.
			{/if}
		{:else if mode === 'masters'}
			Walks the Lichess master-games database recursively. Canonical theory at your-side positions,
			top replies fanned out at opponent-side positions.
		{:else}
			Scans recent Lichess broadcast PGNs (Candidates, Tata Steel, Olympiad, …) for games involving
			a named player and folds their OTB openings into a new repertoire. Works for anyone who plays
			modern top events, Lichess account or not.
		{/if}
	</p>

	{#if tokenNeeded && !tokenConfigured}
		<div
			class="mt-6 rounded border border-[var(--color-brass-400)]/30 bg-[var(--color-brass-500)]/10 p-4 text-sm"
		>
			<p class="text-[var(--color-brass-200)]">
				Needs a Lichess connection.
				<a
					href={resolve('/settings')}
					class="text-[var(--color-brass-300)] underline underline-offset-2"
				>
					Connect in Settings
				</a>{#if mode === 'lichess'}, or switch to chess.com below (public API, no token needed){/if}.
			</p>
		</div>
	{/if}

	<form onsubmit={run} class="mt-10 space-y-6" style:--i="5">
		{#if mode === 'lichess'}
			<div>
				<Label for="user">Username</Label>
				<SourceUsernameInput
					id="user"
					list={source === 'lichess' ? 'popular-lichess-users' : undefined}
					bind:source
					bind:username
					required
					disabled={running}
				/>
				<datalist id="popular-lichess-users">
					{#each POPULAR_LICHESS_USERNAMES as p (p)}
						<option value={p}></option>
					{/each}
				</datalist>
				<p class="mt-1.5 font-serif text-xs text-[var(--color-parchment-500)] italic">
					{#if source === 'chesscom'}
						Any chess.com handle. Public API — no login required.
					{:else}
						Any Lichess handle. Suggestions are popular titled players.
					{/if}
				</p>
				{#if source === 'chesscom'}
					<div class="mt-3">
						<Label for="cc-max">Games to scan</Label>
						<Input
							id="cc-max"
							type="number"
							min={10}
							bind:value={chesscomMaxGames}
							disabled={running}
							class="font-mono"
						/>
						<p class="mt-1.5 font-serif text-xs text-[var(--color-parchment-500)] italic">
							Newest games first. chess.com has no aggregate explorer, so the tree's quality scales
							with this cap.
						</p>
					</div>
				{/if}
			</div>
		{:else if mode === 'masters'}
			<div
				class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)]/60 p-3 text-xs text-[var(--color-parchment-400)]"
			>
				Walks the aggregate masters DB — canonical theory from top titled games. The DB itself has
				no player filter; for a specific player's OTB games, use <strong>OTB broadcasts</strong>.
			</div>
		{:else}
			<div class="space-y-3">
				<div>
					<Label for="bcast-player">FIDE player</Label>
					<div class="relative" bind:this={broadcastComboRoot}>
						<Input
							id="bcast-player"
							bind:value={broadcastPlayerQuery}
							oninput={onBroadcastPlayerQueryInput}
							onfocus={() => (broadcastComboOpen = broadcastPlayerResults.length > 0)}
							disabled={running}
							placeholder="Type a surname — e.g. ding, carlsen, nepomniachtchi"
							class="font-mono"
							autocomplete="off"
							role="combobox"
							aria-expanded={broadcastComboOpen}
							aria-autocomplete="list"
						/>
						{#if broadcastComboOpen && (broadcastSearching || broadcastSearchError || broadcastPlayerResults.length > 0)}
							<div
								role="listbox"
								class="absolute z-40 mt-1 w-full overflow-hidden rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] shadow-[0_16px_32px_-8px_rgba(0,0,0,0.8)]"
							>
								{#if broadcastSearching}
									<div class="px-3 py-2 font-mono text-[12px] text-[var(--color-parchment-500)]">
										Searching…
									</div>
								{:else if broadcastSearchError}
									<div class="px-3 py-2 font-mono text-[12px] text-[var(--color-oxblood-300)]">
										{broadcastSearchError}
									</div>
								{:else}
									<ul class="max-h-64 overflow-y-auto py-1">
										{#each broadcastPlayerResults as p (p.id)}
											{@const active = broadcastSelectedPlayer?.id === p.id}
											<li in:slide={{ duration: 200 }} animate:flip={{ duration: 200 }}>
												<button
													type="button"
													role="option"
													aria-selected={active}
													onclick={() => pickBroadcastPlayer(p)}
													class={cn(
														'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-[12px] transition-colors',
														active
															? 'text-[var(--color-brass-300)]'
															: 'text-[var(--color-parchment-200)]',
														'hover:bg-[var(--color-ink-800)]'
													)}
												>
													<span class="truncate">
														{p.title ? `${p.title} ` : ''}{p.name}
													</span>
													<span class="shrink-0 text-[11px] text-[var(--color-parchment-500)]">
														{p.federation ?? ''}{p.standard ? ` · ${p.standard}` : ''}
													</span>
												</button>
											</li>
										{/each}
									</ul>
								{/if}
							</div>
						{/if}
					</div>
					<p class="mt-1.5 font-serif text-xs text-[var(--color-parchment-500)] italic">
						Searches Lichess's FIDE index. Picking a player locks in the canonical name variants
						used to match PGN headers in each scanned broadcast.
					</p>
					{#if broadcastSelectedPlayer}
						<p class="mt-1.5 font-mono text-[11px] text-[var(--color-brass-300)]">
							Selected: {broadcastSelectedPlayer.name} (FIDE {broadcastSelectedPlayer.id})
						</p>
					{/if}
				</div>
				<div>
					<Label for="bcast-count">Tournaments to scan</Label>
					<Input
						id="bcast-count"
						type="number"
						min={1}
						bind:value={broadcastMaxTournaments}
						disabled={running}
						class="font-mono"
					/>
					<p class="mt-1.5 font-serif text-xs text-[var(--color-parchment-500)] italic">
						Newest major events first (tier-sorted). Each tournament's full PGN is downloaded once
						and skipped fast if the player's name doesn't appear.
					</p>
				</div>
			</div>
		{/if}

		<div>
			<div class="mb-1.5 flex items-end justify-between gap-3">
				<Label for="prefix">Starting moves (optional)</Label>
				<div
					class="inline-flex overflow-hidden rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] font-mono text-[10px] tracking-wider uppercase"
					role="radiogroup"
				>
					<button
						type="button"
						role="radio"
						aria-checked={prefixMode === 'san'}
						disabled={running}
						class={cn(
							'px-2 py-1 transition-colors',
							prefixMode === 'san'
								? 'bg-[var(--color-brass-300)] text-[var(--color-ink-950)]'
								: 'text-[var(--color-parchment-300)] hover:bg-[var(--color-ink-800)]'
						)}
						onclick={() => (prefixMode = 'san')}
					>
						Type SAN
					</button>
					<button
						type="button"
						role="radio"
						aria-checked={prefixMode === 'board'}
						disabled={running}
						class={cn(
							'px-2 py-1 transition-colors',
							prefixMode === 'board'
								? 'bg-[var(--color-brass-300)] text-[var(--color-ink-950)]'
								: 'text-[var(--color-parchment-300)] hover:bg-[var(--color-ink-800)]'
						)}
						onclick={() => (prefixMode = 'board')}
					>
						Build on board
					</button>
				</div>
			</div>

			{#if prefixMode === 'san'}
				<div class="flex gap-2">
					<Input
						id="prefix"
						bind:value={prefixInput}
						onblur={formatPrefix}
						disabled={running}
						placeholder="1. e4 c5 2. Nf3"
						class="flex-1 font-mono"
					/>
					<Button
						type="button"
						variant="ghost"
						size="md"
						onclick={formatPrefix}
						disabled={running || !prefixInput.trim()}
					>
						Format
					</Button>
				</div>
				<p class="mt-1.5 font-serif text-xs text-[var(--color-parchment-500)] italic">
					Paste free-form; Format (or blur) normalises move numbers and spacing.
				</p>
			{:else}
				<div class="grid items-start gap-3 sm:grid-cols-[220px_1fr]">
					<div class="max-w-[220px]">
						<Board
							fen={builderFen}
							orientation="white"
							turnColor={colorToMove(builderFen.split(' ')[1] === 'w' ? builderFen : builderFen) as
								| 'white'
								| 'black'}
							movableColor="both"
							dests={builderDests}
							lastMove={builderLastMove}
							onmove={handleBuilderMove}
						/>
					</div>
					<div class="min-w-0 space-y-2">
						<div
							class="min-h-10 rounded-[3px] border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2 font-mono text-[13px] leading-6 break-all"
						>
							{prefixInput || ''}
							{#if !prefixInput}
								<span class="font-serif text-[var(--color-parchment-500)] italic"
									>Play moves on the board to build the starting line…</span
								>
							{/if}
						</div>
						<div class="flex gap-2">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onclick={builderUndo}
								disabled={running || builderSans.length === 0}
							>
								<span>Undo</span>
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onclick={builderReset}
								disabled={running || builderSans.length === 0}
							>
								<RotateCcw class="size-3" />
								<span>Reset</span>
							</Button>
						</div>
						<p class="font-serif text-[11px] text-[var(--color-parchment-500)] italic">
							Plays to whichever side is to move.
						</p>
					</div>
				</div>
			{/if}
		</div>

		<div class="grid grid-cols-2 gap-5">
			<div>
				<Label>Colour to drill</Label>
				<div class="mt-1 grid grid-cols-2 gap-2">
					{#each ['white', 'black'] as c (c)}
						<button
							type="button"
							disabled={running}
							class={cn(
								'rounded-[5px] border p-3 text-left transition-colors',
								color === c
									? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/8'
									: 'border-[var(--color-ink-700)] hover:border-[var(--color-ink-600)]'
							)}
							onclick={() => (color = c as Color)}
						>
							<span
								class={cn(
									'font-serif text-2xl leading-none',
									c === 'white'
										? 'chess-king-white text-[var(--color-brass-300)]'
										: 'chess-king-black'
								)}
							></span>
							<span class="eyebrow mt-2 block capitalize">{c}</span>
						</button>
					{/each}
				</div>
			</div>

			<div class="space-y-3">
				{#if mode !== 'broadcasts'}
					<div>
						<Label for="fanout">Opponent fan-out</Label>
						<Input
							id="fanout"
							type="number"
							min={1}
							bind:value={opponentFanout}
							disabled={running}
							class="font-mono"
						/>
						<p class="mt-1 font-serif text-[10px] text-[var(--color-parchment-500)] italic">
							Deviations to cover at opponent-side positions.
						</p>
					</div>
				{/if}
				<div>
					<Label for="depth">Opening depth (plies)</Label>
					<Input
						id="depth"
						type="number"
						min={4}
						bind:value={depth}
						disabled={running}
						class="font-mono"
					/>
				</div>
			</div>
		</div>

		<div>
			<Label for="name">Repertoire name (optional)</Label>
			<Input
				id="name"
				bind:value={name}
				disabled={running}
				placeholder={mode === 'masters'
					? `Masters — ${color}`
					: mode === 'broadcasts'
						? `OTB / ${broadcastSelectedPlayer?.name || 'player'} — ${color}`
						: `${username || 'username'} — ${color}`}
				class="font-serif"
			/>
		</div>

		{#if error}
			<p class="text-sm text-[var(--color-oxblood-300)]">{error}</p>
		{/if}

		{#if hasDossierReport}
			<div
				class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)]/60 p-3 text-xs text-[var(--color-parchment-400)]"
			>
				<span class="font-mono text-[10px] tracking-wider text-[var(--color-brass-300)] uppercase"
					>Style advice</span
				>
				<p class="mt-1 font-serif italic">
					A dossier scan is on file — each candidate in the editor will be tagged with a fit score
					matched against your fingerprint. Tree shape is unchanged; the advice is purely
					informational.
				</p>
			</div>
		{:else}
			<div
				class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)]/60 p-3 text-xs text-[var(--color-parchment-500)]"
			>
				<span class="font-mono text-[10px] tracking-wider uppercase">Style advice</span>
				<p class="mt-1 font-serif italic">
					Run a
					<a
						href={resolve('/dossier')}
						class="text-[var(--color-brass-300)] underline underline-offset-2">Dossier scan</a
					>
					first to get per-candidate style advice in the editor after this build.
				</p>
			</div>
		{/if}

		<div class="flex gap-2">
			{#if running}
				<Button variant="destructive" size="lg" onclick={cancel} type="button">
					<X class="size-4" />
					<span>Cancel</span>
				</Button>
			{:else if done && createdRepId}
				<Button
					type="button"
					variant="primary"
					size="lg"
					onclick={() => goto(resolve(`/repertoire/${createdRepId}`))}
				>
					<span>Open the repertoire</span>
					<ArrowRight class="size-4" />
				</Button>
			{:else}
				<Button type="submit" variant="primary" size="lg" disabled={!canRun}>
					<span>Start autobuild</span>
					<ArrowRight class="size-4" />
				</Button>
				<Button href="{base}/repertoire/new" variant="ghost" size="lg" type="button">Cancel</Button>
			{/if}
		</div>
	</form>

	{#if running || done || stats.probed > 0 || stats.tournamentsScanned > 0 || stats.gamesScanned > 0}
		<div class="ink-panel mt-10 p-4">
			<div class="eyebrow mb-3">Progress</div>
			<div class="grid grid-cols-4 gap-3 text-center">
				{#if mode === 'broadcasts'}
					<div>
						<div class="eyebrow">Tournaments</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.tournamentsScanned}<span class="text-[var(--color-parchment-500)]"
								>/{stats.tournamentsTotal}</span
							>
						</div>
					</div>
					<div>
						<div class="eyebrow">Games matched</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.gamesMatched}
						</div>
					</div>
					<div>
						<div class="eyebrow">Edges</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.edgesAdded}
						</div>
					</div>
					<div>
						<div class="eyebrow">Cards</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.cardsAdded}
						</div>
					</div>
				{:else if mode === 'lichess' && source === 'chesscom'}
					<div>
						<div class="eyebrow">Games</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.gamesMatched}<span class="text-[var(--color-parchment-500)]"
								>/{stats.gamesScanned}</span
							>
						</div>
					</div>
					<div>
						<div class="eyebrow">Positions</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.probed}
						</div>
					</div>
					<div>
						<div class="eyebrow">Edges</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.edgesAdded}
						</div>
					</div>
					<div>
						<div class="eyebrow">Cards</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.cardsAdded}
						</div>
					</div>
				{:else}
					<div>
						<div class="eyebrow">Positions</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.probed}
						</div>
					</div>
					<div>
						<div class="eyebrow">Edges</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.edgesAdded}
						</div>
					</div>
					<div>
						<div class="eyebrow">Cards</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{stats.cardsAdded}
						</div>
					</div>
					<div>
						<div class="eyebrow">Depth cap</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
							{depth}
						</div>
					</div>
				{/if}
			</div>
			{#if mode === 'broadcasts' && stats.currentTournament}
				<p class="mt-3 truncate font-mono text-[11px] text-[var(--color-parchment-500)]">
					{stats.currentTournament}
				</p>
			{/if}
		</div>
	{/if}
</div>
