<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import type { DossierScanResult } from '$lib/dossier/scan';
	import type { WeeklyAxisSample } from '$lib/dossier/fingerprint';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
	function signed(x: number) {
		return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
	}
	function deltaClass(d: number): string {
		if (d > 0.03) return 'text-emerald-400';
		if (d < -0.03) return 'text-amber-300';
		return 'text-[var(--color-parchment-500)]';
	}

	const AXIS_LABEL: Record<string, string> = {
		forcing: 'Forcing moves',
		capture: 'Captures',
		pawnPlay: 'Pawn moves',
		queenside: 'Queenside play',
		earlyCastle: 'Early castle',
		tensionRelease: 'Tension release rate',
		tensionCreate: 'Tension creation rate'
	};

	function sparklinePath(
		weekly: WeeklyAxisSample[],
		axis: string,
		width = 140,
		height = 28
	): string | null {
		if (weekly.length < 2) return null;
		const axes = weekly.map((w) => w.axes as unknown as Record<string, number>);
		const ys = axes.map((a) => a[axis] ?? 0);
		const min = Math.min(...ys);
		const max = Math.max(...ys);
		const span = max - min || 1;
		const stepX = width / (weekly.length - 1);
		return ys
			.map((v, i) => {
				const x = (i * stepX).toFixed(1);
				const y = (height - ((v - min) / span) * height).toFixed(1);
				return `${i === 0 ? 'M' : 'L'}${x},${y}`;
			})
			.join(' ');
	}

	function dateShort(ms: number): string {
		return new Date(ms).toISOString().slice(0, 10);
	}
</script>

<DossierSubpageShell
	title="Drift"
	subtitle="How your style has shifted in the last 30 days compared with the prior 90. You vs your past self — self-baselined, no peer comparison."
	{loaded}
	hasReport={!!result}
>
	{#if result?.drift}
		{@const d = result.drift}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Window</div>
			<div class="mt-3 grid grid-cols-2 gap-3 text-xs">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Recent (30d)</div>
					<div class="mt-1 font-mono text-[var(--color-parchment-100)]">
						{dateShort(d.recentRange.fromMs)} → {dateShort(d.recentRange.toMs)}
					</div>
					<div class="mt-1 text-[var(--color-parchment-400)]">{d.recentGames} games</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Prior (90d before)</div>
					<div class="mt-1 font-mono text-[var(--color-parchment-100)]">
						{dateShort(d.priorRange.fromMs)} → {dateShort(d.priorRange.toMs)}
					</div>
					<div class="mt-1 text-[var(--color-parchment-400)]">{d.priorGames} games</div>
				</div>
			</div>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Result rate</div>
			<div class="mt-3 text-sm">
				<span class="text-[var(--color-parchment-400)]">Recent</span>
				<span class="ml-2 font-mono">
					{pct(d.results.recent.winRate)}
					({d.results.recent.win}W/{d.results.recent.draw}D/{d.results.recent.loss}L)
				</span>
				<span class="mx-3 text-[var(--color-parchment-500)]">vs</span>
				<span class="text-[var(--color-parchment-400)]">Prior</span>
				<span class="ml-2 font-mono">
					{pct(d.results.prior.winRate)}
					({d.results.prior.win}W/{d.results.prior.draw}D/{d.results.prior.loss}L)
				</span>
				<span class="ml-3 font-mono {deltaClass(d.results.winRateDelta)}">
					{signed(d.results.winRateDelta)}pp
				</span>
			</div>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Axis deltas</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Each row shows the recent-window value vs the prior-window value, with a weekly sparkline
				across both windows.
			</p>
			<ul class="mt-3 grid gap-2 sm:grid-cols-2">
				{#each d.axes as a (a.axis)}
					{@const sparkPath = sparklinePath(d.weekly, a.axis)}
					<li
						class="flex items-baseline justify-between gap-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
					>
						<div class="min-w-0 flex-1">
							<div class="font-medium">{AXIS_LABEL[a.axis] ?? a.axis}</div>
							<div class="text-xs text-[var(--color-parchment-500)]">
								recent {pct(a.recent)} · prior {pct(a.prior)}
							</div>
						</div>
						{#if sparkPath}
							<svg
								viewBox="0 0 140 28"
								width="140"
								height="28"
								class="shrink-0 text-[var(--color-brass-300)]"
								aria-hidden="true"
							>
								<path
									d={sparkPath}
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
									vector-effect="non-scaling-stroke"
								/>
							</svg>
						{/if}
						<div class="shrink-0 font-mono text-sm {deltaClass(a.delta)}">
							{signed(a.delta)}pp
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{:else if result}
		<div
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4 text-sm"
		>
			Not enough games in either the recent 30-day or prior 90-day window — drift needs ≥ 10 games
			on each side.
		</div>
	{/if}
</DossierSubpageShell>
