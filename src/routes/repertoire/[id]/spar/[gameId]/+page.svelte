<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		AlertTriangle,
		ArrowLeft,
		Bot,
		Check,
		ExternalLink,
		Flag,
		Pencil,
		Play,
		RefreshCw,
		Trophy
	} from 'lucide-svelte';

	import { getRepertoire } from '$lib/storage/repertoires';
	import { getSparGame } from '$lib/storage/sparGames';
	import { reconcileSparGame } from '$lib/lichess/sparReview';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import { tryFenKey } from '$lib/chess/fen';
	import { Button, EmptyState } from '$lib/ui';
	import type { AppSettings, Repertoire, SparGame } from '$lib/types';

	let rep = $state<Repertoire | null>(null);
	let game = $state<SparGame | null>(null);
	let settings = $state<AppSettings | null>(null);
	let loading = $state(true);
	let polling = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let manualRefreshing = $state(false);

	const POLL_INTERVAL_MS = 15_000;
	// reconcileSparGame has its own 30s min-check throttle; we pass a
	// shorter interval here so the manual button and polling both feel
	// responsive without hammering Lichess.
	const RECONCILE_INTERVAL_MS = 10_000;

	onMount(async () => {
		const repId = page.params.id;
		const gameId = page.params.gameId;
		if (!repId || !gameId) {
			loading = false;
			return;
		}
		rep = (await getRepertoire(repId)) ?? null;
		settings = await getSettings();
		game = await getSparGame(gameId);
		loading = false;

		// Kick a first reconcile + start polling whenever the game is
		// still pending. If it's already analysed we don't touch Lichess.
		if (game && game.status !== 'analysed') {
			void runReconcile();
			pollTimer = setInterval(() => {
				if (game?.status === 'analysed') {
					stopPolling();
					return;
				}
				void runReconcile();
			}, POLL_INTERVAL_MS);
		}
	});

	onDestroy(() => {
		stopPolling();
	});

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	async function runReconcile(opts: { force?: boolean } = {}) {
		if (!game) return;
		if (polling && !opts.force) return;
		polling = true;
		try {
			const token = settings ? effectiveLichessToken(settings) : null;
			const username = settings?.lichessOAuth?.username;
			const next = await reconcileSparGame(game, {
				token: token ?? undefined,
				username: username ?? undefined,
				minCheckIntervalMs: opts.force ? 0 : RECONCILE_INTERVAL_MS
			});
			game = next;
			if (next.status === 'analysed') stopPolling();
		} finally {
			polling = false;
		}
	}

	async function manualRefresh() {
		if (manualRefreshing) return;
		manualRefreshing = true;
		try {
			await runReconcile({ force: true });
		} finally {
			manualRefreshing = false;
		}
	}

	function formatAgo(ms: number): string {
		const diff = Date.now() - ms;
		if (diff < 60_000) return 'just now';
		const min = Math.floor(diff / 60_000);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const d = Math.floor(hr / 24);
		if (d < 30) return `${d}d ago`;
		return new Date(ms).toLocaleDateString();
	}

	function outcomeLabel(): string {
		const outcome = game?.result?.outcome;
		if (outcome === 'win') return 'You won';
		if (outcome === 'loss') return 'You lost';
		if (outcome === 'draw') return 'Draw';
		return 'Unfinished';
	}

	/**
	 * URL back to the editor, jumping to the exact position the board was
	 * on when the user clicked Spar. Falls back to the editor root if the
	 * stored FEN can't be parsed for some reason.
	 */
	function editorJumpHref(): string {
		if (!rep || !game) return '';
		const key = tryFenKey(game.startFen);
		const suffix = key ? `?jump=${encodeURIComponent(key)}` : '';
		return `${base}/repertoire/${rep.id}/edit${suffix}`;
	}

	function outcomeTone(): string {
		const outcome = game?.result?.outcome;
		if (outcome === 'win') return 'text-[var(--color-olive-300)]';
		if (outcome === 'loss') return 'text-[var(--color-oxblood-300)]';
		return 'text-[var(--color-parchment-200)]';
	}

	/**
	 * Coach-note copy shown under the outcome headline. Celebratory on
	 * wins, reassuring + action-oriented on losses, neutral on draws.
	 * The deviation block below still provides the concrete next step
	 * (drill / edit tree) — this is just tone.
	 */
	function outcomeMessage(): string {
		const outcome = game?.result?.outcome;
		const onTree = game?.result?.deviationPly == null && outcome !== 'unfinished';
		if (outcome === 'win') {
			return onTree
				? 'Well played — and your prep held the whole way.'
				: 'Nicely done. A win is a win; let’s still tidy the line below so it wins faster next time.';
		}
		if (outcome === 'loss') {
			return onTree
				? 'Tough one — the prep held, so the game was lost past theory. Worth reviewing the middlegame on Lichess.'
				: 'Rough result, but a clear lesson below. Patch the line and you’ll stop giving this one away.';
		}
		if (outcome === 'draw') {
			return onTree
				? 'Solid half-point with the book holding up.'
				: 'Half-point salvaged — worth tightening the line below so next time you push for more.';
		}
		return 'Game didn’t reach a result — grab the rematch when you’re ready.';
	}
</script>

{#if loading}
	<div class="mx-auto max-w-3xl px-6 pt-16">
		<p class="text-sm text-[var(--color-parchment-400)]">Loading…</p>
	</div>
{:else if !rep}
	<div class="mx-auto max-w-3xl px-6 pt-16">
		<p class="text-[var(--color-oxblood-300)]">Repertoire not found.</p>
		<a href={resolve('/')} class="text-[var(--color-brass-300)] underline underline-offset-4"
			>Back to library</a
		>
	</div>
{:else if !game}
	<div class="mx-auto max-w-3xl px-6 pt-16">
		<a
			href={resolve(`/repertoire/${rep.id}`)}
			class="eyebrow mb-5 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
		>
			<ArrowLeft class="size-3" />
			<span>Back to {rep.name}</span>
		</a>
		<EmptyState
			title="Spar game not found"
			description="This game isn't in your ledger. It may have been started from a different browser, or the record was cleared."
		/>
	</div>
{:else}
	<div class="stagger mx-auto max-w-3xl px-6 pt-12 pb-16">
		<a
			href={resolve(`/repertoire/${rep.id}`)}
			class="eyebrow mb-5 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
			style:--i="0"
		>
			<ArrowLeft class="size-3" />
			<span>Back to {rep.name}</span>
		</a>

		<!-- Header: opponent + colour + when launched. -->
		<div class="mb-8 flex items-end justify-between gap-4" style:--i="1">
			<div class="min-w-0">
				<div class="eyebrow mb-2 flex items-center gap-2">
					<Bot class="size-3 text-[var(--color-brass-300)]" />
					<span>Spar</span>
				</div>
				<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
					{game.opponentLabel}
				</h1>
				<p class="mt-3 text-sm text-[var(--color-parchment-400)]">
					Playing <span class="text-[var(--color-parchment-200)]">{game.userColor}</span>
					· launched {formatAgo(game.startedAt)}
				</p>
			</div>
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href={game.gameUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="inline-flex shrink-0 items-center gap-1.5 rounded-[4px] border border-[var(--color-ink-700)] px-3 py-2 font-mono text-[11px] tracking-wider text-[var(--color-parchment-300)] uppercase transition-colors hover:border-[var(--color-brass-300)] hover:text-[var(--color-brass-200)]"
			>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
				<ExternalLink class="size-3" />
				<span>Open on Lichess</span>
			</a>
		</div>

		{#if game.status === 'pending'}
			<!-- Waiting card. Spinner-style status + gentle nudge that we
				 poll in the background. Manual refresh for the impatient. -->
			<div class="ink-panel p-8" style:--i="2">
				<div class="flex items-start gap-4">
					<span
						class="mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-brass-500)]/15 text-[var(--color-brass-300)]"
					>
						<RefreshCw class={`size-4 ${polling ? 'animate-spin' : ''}`} strokeWidth={1.75} />
					</span>
					<div class="min-w-0 flex-1">
						<h2 class="font-serif text-2xl text-[var(--color-parchment-50)]">
							Waiting for the game to finish…
						</h2>
						<p class="mt-2 text-sm text-[var(--color-parchment-400)]">
							Play your game on the Lichess tab. Cobra will fetch the PGN once it's over and walk it
							against your tree to flag any move that left prep.
						</p>
						<p
							class="mt-3 font-mono text-[11px] tracking-wider text-[var(--color-parchment-500)] uppercase"
						>
							{#if game.lastCheckedAt}
								Last checked {formatAgo(game.lastCheckedAt)}
							{:else}
								Checking Lichess…
							{/if}
							{#if game.lastError}
								<span class="ml-2 text-[var(--color-oxblood-300)]">
									· {game.lastError}
								</span>
							{/if}
						</p>
						<div class="mt-5 flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								variant="secondary"
								onclick={manualRefresh}
								disabled={manualRefreshing || polling}
							>
								<RefreshCw
									class={`size-3.5 ${manualRefreshing || polling ? 'animate-spin' : ''}`}
								/>
								<span>{manualRefreshing ? 'Checking…' : 'Check now'}</span>
							</Button>
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={game.gameUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-wider text-[var(--color-parchment-400)] uppercase transition-colors hover:text-[var(--color-brass-200)]"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<ExternalLink class="size-3" />
								<span>Jump to Lichess tab</span>
							</a>
						</div>
					</div>
				</div>
			</div>
		{:else if game.status === 'error'}
			<!-- Error state — usually a transient PGN fetch failure.
				 Manual retry; the background poller will also keep trying
				 until either success or Lichess 404s the game. -->
			<div class="ink-panel border border-[var(--color-oxblood-500)]/40 p-8" style:--i="2">
				<div class="flex items-start gap-4">
					<span
						class="mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-oxblood-500)]/20 text-[var(--color-oxblood-300)]"
					>
						<AlertTriangle class="size-4" strokeWidth={1.75} />
					</span>
					<div class="min-w-0 flex-1">
						<h2 class="font-serif text-2xl text-[var(--color-parchment-50)]">
							Couldn't fetch the game
						</h2>
						<p class="mt-2 text-sm text-[var(--color-parchment-400)]">
							{game.lastError ?? 'Unknown error.'}
						</p>
						<div class="mt-5 flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								variant="secondary"
								onclick={manualRefresh}
								disabled={manualRefreshing}
							>
								<RefreshCw class={`size-3.5 ${manualRefreshing ? 'animate-spin' : ''}`} />
								<span>Retry</span>
							</Button>
						</div>
					</div>
				</div>
			</div>
		{:else if game.status === 'analysed'}
			<!-- Post-game analysis. Outcome headline + either the deviation
				 breakdown with CTAs or an "on tree" confirmation. -->
			{@const result = game.result}
			<section class="ink-panel p-8" style:--i="2">
				<div class="flex items-start gap-4">
					<span
						class="mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full {result?.outcome ===
						'win'
							? 'bg-[var(--color-olive-500)]/20 text-[var(--color-olive-300)]'
							: result?.outcome === 'loss'
								? 'bg-[var(--color-oxblood-500)]/20 text-[var(--color-oxblood-300)]'
								: 'bg-[var(--color-ink-800)] text-[var(--color-parchment-300)]'}"
					>
						{#if result?.outcome === 'win'}
							<Trophy class="size-4" strokeWidth={1.75} />
						{:else if result?.outcome === 'loss'}
							<Flag class="size-4" strokeWidth={1.75} />
						{:else}
							<Check class="size-4" strokeWidth={1.75} />
						{/if}
					</span>
					<div class="min-w-0 flex-1">
						<h2 class="font-serif text-3xl tracking-tight">
							<span class={outcomeTone()}>{outcomeLabel()}</span>
							<span class="ml-2 text-[var(--color-parchment-500)]">
								· {result?.plies ?? 0} plies
							</span>
						</h2>
						<!-- Coach note. Tone varies by outcome so a win feels
							 celebrated and a loss feels like a heads-up rather
							 than a pile-on. -->
						<p
							class="mt-2 font-serif text-base italic {result?.outcome === 'win'
								? 'text-[var(--color-olive-200)]'
								: result?.outcome === 'loss'
									? 'text-[var(--color-oxblood-200)]'
									: 'text-[var(--color-parchment-300)]'}"
						>
							{outcomeMessage()}
						</p>
						{#if result?.deviationPly != null && result.deviationFenKey}
							<p class="mt-3 text-sm text-[var(--color-parchment-300)]">
								You left prep on
								<span class="font-mono text-[var(--color-parchment-100)] tabular-nums">
									ply {result.deviationPly}
								</span>
								— you played
								<span class="font-mono text-[var(--color-oxblood-300)]">
									{result.deviationPlayedSan}
								</span>
								; your tree says
								<span class="font-mono text-[var(--color-olive-300)]">
									{result.deviationExpectedSan}
								</span>.
							</p>
							<p class="mt-2 text-sm text-[var(--color-parchment-400)]">
								A mistake has been logged. Drill it to retrain, or edit the tree to accept the new
								move.
							</p>
							<div class="mt-5 flex flex-wrap items-center gap-2">
								<Button
									href={`${base}/repertoire/${rep.id}/drill?mode=mistakes`}
									variant="primary"
									size="sm"
								>
									<Play class="size-3.5" />
									<span>Drill mistake</span>
								</Button>
								<Button
									href={`${base}/repertoire/${rep.id}/edit?jump=${encodeURIComponent(result.deviationFenKey)}`}
									variant="secondary"
									size="sm"
								>
									<Pencil class="size-3.5" />
									<span>Jump to position</span>
								</Button>
								<Button
									href={`${base}/repertoire/${rep.id}/mistakes`}
									variant="secondary"
									size="sm"
								>
									<AlertTriangle class="size-3.5" />
									<span>All mistakes</span>
								</Button>
							</div>
						{:else}
							<p class="mt-3 text-sm text-[var(--color-parchment-300)]">
								<span class="text-[var(--color-olive-300)]">On tree the whole way.</span>
								No deviation recorded — you stayed inside your prep.
							</p>
							<div class="mt-5 flex flex-wrap items-center gap-2">
								<Button href={editorJumpHref()} variant="secondary" size="sm">
									<Pencil class="size-3.5" />
									<span>Back to editor</span>
								</Button>
							</div>
						{/if}
					</div>
				</div>
			</section>
		{/if}
	</div>
{/if}
