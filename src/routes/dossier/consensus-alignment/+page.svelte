<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { Button } from '$lib/ui';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { effectiveLichessToken, getSettings } from '$lib/storage/settings';
	import { analyseConsensus, type ConsensusSummary } from '$lib/dossier/consensus';
	import type { DossierScanResult } from '$lib/dossier/scan';
	import type { AppSettings } from '$lib/types';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);
	let settings = $state<AppSettings | null>(null);

	let gameCap = $state(20);
	let source = $state<'lichess' | 'masters'>('lichess');
	let running = $state(false);
	let progress = $state('');
	let summary = $state<ConsensusSummary | null>(null);
	let summarySource = $state<'lichess' | 'masters' | null>(null);
	let error = $state<string | null>(null);
	let controller: AbortController | null = null;

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		settings = await getSettings();
		loaded = true;
	});

	async function run() {
		if (!result || running) return;
		error = null;
		summary = null;
		summarySource = null;
		running = true;
		controller = new AbortController();
		const token = settings ? effectiveLichessToken(settings) : '';
		const ranSource = source;
		try {
			const games = [...result.classified]
				.sort((a, b) => b.playedAt - a.playedAt)
				.slice(0, gameCap);
			summary = await analyseConsensus(games, {
				token: token || undefined,
				signal: controller.signal,
				source: ranSource,
				onProgress: (done, total) => {
					progress = `${done}/${total}`;
				}
			});
			summarySource = ranSource;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			running = false;
			progress = '';
		}
	}

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}

	function lichessUrl(fen: string) {
		return `https://lichess.org/analysis/standard/${encodeURIComponent(fen)}`;
	}
</script>

<DossierSubpageShell
	title="Consensus alignment"
	subtitle="For each of your non-opening moves, the Lichess Explorer is queried for what others actually played in the same position. Your move's share of that pool = alignment. A consensus miss is when the comparison pool had a clear majority pick and you didn't play it. Switch the comparison pool below: peers (your rating + speed) or masters (OTB)."
	{loaded}
	hasReport={!!result}
>
	{#if result}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Run the pass</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Expensive — Lichess Explorer API calls per position, rate-limited. 20 games ≈ 20–60 seconds.
				Results cached for 30 days in your local IndexedDB.
			</p>
			<div class="mt-3 flex flex-wrap items-end gap-3 text-xs">
				<label class="flex flex-col gap-1">
					<span class="text-[var(--color-parchment-500)]">Recent games</span>
					<input
						type="number"
						bind:value={gameCap}
						min="5"
						max="40"
						class="w-24 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1"
					/>
				</label>
				<div class="flex flex-col gap-1">
					<span class="text-[var(--color-parchment-500)]">Compare against</span>
					<div class="inline-flex rounded border border-[var(--color-ink-800)]">
						<button
							type="button"
							class="px-3 py-1 transition-colors {source === 'lichess'
								? 'bg-[var(--color-brass-300)]/20 text-[var(--color-parchment-100)]'
								: 'text-[var(--color-parchment-400)] hover:text-[var(--color-parchment-200)]'}"
							disabled={running}
							onclick={() => (source = 'lichess')}
						>
							Peers
						</button>
						<button
							type="button"
							class="px-3 py-1 transition-colors {source === 'masters'
								? 'bg-[var(--color-brass-300)]/20 text-[var(--color-parchment-100)]'
								: 'text-[var(--color-parchment-400)] hover:text-[var(--color-parchment-200)]'}"
							disabled={running}
							onclick={() => (source = 'masters')}
						>
							Masters
						</button>
					</div>
				</div>
				<Button onclick={run} disabled={running}>
					{running ? `Analysing ${progress}…` : 'Run consensus pass'}
				</Button>
				{#if running}
					<button
						type="button"
						onclick={() => controller?.abort()}
						class="text-[var(--color-parchment-400)] underline"
					>
						Cancel
					</button>
				{/if}
			</div>
			{#if error}
				<p class="mt-2 text-xs text-red-400">{error}</p>
			{/if}
		</section>

		{#if summary}
			{@const ranAgainst =
				summarySource === 'masters' ? 'masters (OTB explorer)' : 'peers (rating + speed)'}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Summary</div>
				<div class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
					Compared against {ranAgainst}.
				</div>
				<div class="mt-3 grid grid-cols-3 gap-3 text-xs">
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
					>
						<div class="text-[var(--color-parchment-500)]">Avg alignment</div>
						<div class="mt-1 font-mono text-lg">{pct(summary.avgAlignment)}</div>
					</div>
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
					>
						<div class="text-[var(--color-parchment-500)]">Moves analysed</div>
						<div class="mt-1 font-mono text-lg">{summary.movesAnalysed}</div>
					</div>
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
					>
						<div class="text-[var(--color-parchment-500)]">Consensus misses</div>
						<div class="mt-1 font-mono text-lg text-amber-300">{summary.misses.length}</div>
					</div>
				</div>
				<p class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
					Skipped {summary.movesSkippedOpening} opening moves and {summary.movesSkippedSparse} moves with
					sparse {summarySource === 'masters' ? 'master' : 'peer'} data.
				</p>
			</section>

			{#if summary.misses.length > 0}
				<section
					class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
				>
					<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
						Consensus misses
					</div>
					<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
						Positions where the {summarySource === 'masters' ? 'masters DB' : 'crowd'} had a clear majority
						pick and you didn't play it. Click a row to open it in Lichess analysis.
					</p>
					<ul class="mt-3 grid gap-1 text-xs">
						{#each summary.misses.slice(0, 30) as m (m.gameId + m.ply)}
							<li
								class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-2 py-1"
							>
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href={lichessUrl(m.fenBefore)}
									target="_blank"
									rel="noopener"
									class="flex items-baseline justify-between gap-2 hover:text-[var(--color-brass-300)]"
								>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
									<span class="font-mono">
										#{m.gameId.slice(0, 6)} · ply {m.ply} · you played
										<span class="text-[var(--color-parchment-100)]">{m.san}</span>
									</span>
									<span class="font-mono text-[var(--color-parchment-400)]">
										align {pct(m.alignment)}{#if m.topAlternative}
											· {summarySource === 'masters' ? 'masters' : 'crowd'} picked {m.topAlternative
												.san} ({pct(m.topAlternative.share)}){/if}
									</span>
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if summary.perGame.length > 0}
				<section
					class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
				>
					<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
						Lowest-alignment games
					</div>
					<ol class="mt-3 grid gap-1 text-xs">
						{#each [...summary.perGame]
							.sort((a, b) => a.avgAlignment - b.avgAlignment)
							.slice(0, 10) as g (g.gameId)}
							<li
								class="flex items-baseline justify-between rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-2 py-1"
							>
								<span class="font-mono">#{g.gameId.slice(0, 6)}</span>
								<span class="font-mono text-[var(--color-parchment-400)]">
									{g.moves} moves · align {pct(g.avgAlignment)}
								</span>
							</li>
						{/each}
					</ol>
				</section>
			{/if}
		{/if}
	{/if}
</DossierSubpageShell>
