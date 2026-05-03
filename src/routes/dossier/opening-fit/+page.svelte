<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { buildOpeningProfile, type OpeningProfileRow } from '$lib/dossier/openingProfile';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const profile = $derived(
		result ? buildOpeningProfile(result.classified, result.evalAxes?.allMoves ?? null) : null
	);

	function pct(x: number, digits = 1) {
		return `${(x * 100).toFixed(digits)}%`;
	}
	function signedPct(x: number) {
		return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;
	}
	function signedCp(x: number) {
		return `${x >= 0 ? '+' : ''}${x.toFixed(1)}cp`;
	}
	function tint(v: OpeningProfileRow['verdict']) {
		if (v === 'strong') return 'border-emerald-500/50 bg-emerald-950/15';
		if (v === 'weak') return 'border-amber-300/40 bg-amber-950/15';
		return 'border-[var(--color-ink-800)] bg-[var(--color-ink-950)]';
	}
	function roleBadge(role: OpeningProfileRow['role']): string {
		if (role === 'played') return 'Played';
		if (role === 'faced') return 'Faced';
		return '';
	}
	function rowKey(r: OpeningProfileRow): string {
		return `${r.color}|${r.opening}`;
	}
</script>

<DossierSubpageShell
	title="Opening fit"
	subtitle="Per-opening win rate and CP-loss vs your overall baseline. Two grouped tables — As White and As Black — because the Queen's Gambit Declined faced as White is a different data point from the QGD played as Black, and the Queen's Gambit Accepted is its own row again."
	{loaded}
	hasReport={!!result}
>
	{#if profile}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Your baseline
			</div>
			<div class="mt-3 grid grid-cols-2 gap-3 text-xs">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Overall win rate (W + ½D)</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{pct(profile.userWinRate)}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">Overall avg CP loss</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{profile.userAvgCpLoss != null ? profile.userAvgCpLoss.toFixed(1) : '—'}
					</div>
				</div>
			</div>
		</section>

		{@const whiteRows = profile.rows.filter((r) => r.color === 'white')}
		{@const blackRows = profile.rows.filter((r) => r.color === 'black')}
		<p class="mt-6 text-xs text-[var(--color-parchment-500)]">
			Green = strong (≥+6pp win rate vs you and ≥10cp lower CP loss, or ≥+9pp on win rate alone).
			Amber = weak (≤−6pp win rate, or ≥+20cp CP loss). Cells with fewer than 5 games are dropped —
			too noisy to act on. Family comes from the PGN <code>[Opening]</code> header so QGA, QGD, Slav etc.
			stay distinct.
		</p>

		{#each [{ side: 'white' as const, label: 'As White', rows: whiteRows }, { side: 'black' as const, label: 'As Black', rows: blackRows }] as group (group.side)}
			<section
				class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="flex items-baseline justify-between">
					<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
						{group.label}
					</div>
					<div class="font-mono text-[10px] text-[var(--color-parchment-500)]">
						{group.rows.length}
						{group.rows.length === 1 ? 'family' : 'families'}
					</div>
				</div>

				{#if group.rows.length === 0}
					<div class="mt-3 text-xs text-[var(--color-parchment-500)]">
						No family with ≥5 games on this side yet.
					</div>
				{:else}
					<ul class="mt-3 grid gap-2">
						{#each group.rows as r (rowKey(r))}
							<li class="rounded border px-3 py-2 text-xs {tint(r.verdict)}">
								<div class="flex flex-wrap items-baseline justify-between gap-2">
									<span class="text-[var(--color-parchment-100)]">
										{r.opening}
										{#if roleBadge(r.role)}
											<span
												class="ml-2 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-[var(--color-parchment-400)] uppercase"
											>
												{roleBadge(r.role)}
											</span>
										{/if}
									</span>
									<span class="font-mono text-[var(--color-parchment-400)]">{r.games} games</span>
								</div>
								<div class="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
									<div>
										<div class="text-[var(--color-parchment-500)]">Win rate</div>
										<div class="mt-0.5 font-mono">{pct(r.winRate)}</div>
										<div class="text-[10px] text-[var(--color-parchment-500)]">
											{signedPct(r.winRateDelta)} vs you
										</div>
									</div>
									<div>
										<div class="text-[var(--color-parchment-500)]">Avg CP loss</div>
										<div class="mt-0.5 font-mono">
											{r.avgCpLoss != null ? r.avgCpLoss.toFixed(1) : '—'}
										</div>
										<div class="text-[10px] text-[var(--color-parchment-500)]">
											{r.cpLossDelta != null ? `${signedCp(r.cpLossDelta)} vs you` : 'needs eval'}
										</div>
									</div>
									<div>
										<div class="text-[var(--color-parchment-500)]">W / D / L</div>
										<div class="mt-0.5 font-mono">{r.wins} / {r.draws} / {r.losses}</div>
									</div>
									<div>
										<div class="text-[var(--color-parchment-500)]">Verdict</div>
										<div class="mt-0.5 font-mono capitalize">{r.verdict}</div>
									</div>
								</div>
								<div class="mt-2 text-[var(--color-parchment-300)]">{r.why}</div>
								{#if r.variations.length > 0}
									<details class="mt-2">
										<summary
											class="cursor-pointer text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
										>
											Top variations ({r.variations.length})
										</summary>
										<ul class="mt-1.5 grid gap-1 pl-2">
											{#each r.variations as v (v.label)}
												<li class="flex items-baseline justify-between gap-2 text-[11px]">
													<span class="text-[var(--color-parchment-300)]">{v.label}</span>
													<span class="font-mono text-[var(--color-parchment-400)]">
														{v.games}g · WR {pct(v.winRate, 0)} · {v.wins}/{v.draws}/{v.losses}
														{#if v.avgCpLoss != null}
															· {v.avgCpLoss.toFixed(0)}cp
														{/if}
													</span>
												</li>
											{/each}
										</ul>
									</details>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/each}

		{#if profile.best.length > 0 || profile.worst.length > 0}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">Headlines</div>
				<div class="mt-3 grid gap-3 sm:grid-cols-2">
					<div>
						<div class="text-[10px] tracking-wider text-emerald-400 uppercase">
							Strong ({profile.best.length})
						</div>
						{#if profile.best.length === 0}
							<div class="mt-1 text-xs text-[var(--color-parchment-500)]">No strong outliers.</div>
						{:else}
							<ul class="mt-1.5 grid gap-1 text-xs">
								{#each profile.best as r (rowKey(r))}
									<li>
										<span class="text-[var(--color-parchment-100)]">{r.opening}</span>
										<span class="text-[var(--color-parchment-500)]">
											as {r.color} · {signedPct(r.winRateDelta)}
										</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
					<div>
						<div class="text-[10px] tracking-wider text-amber-300 uppercase">
							Weak ({profile.worst.length})
						</div>
						{#if profile.worst.length === 0}
							<div class="mt-1 text-xs text-[var(--color-parchment-500)]">No weak outliers.</div>
						{:else}
							<ul class="mt-1.5 grid gap-1 text-xs">
								{#each profile.worst as r (rowKey(r))}
									<li>
										<span class="text-[var(--color-parchment-100)]">{r.opening}</span>
										<span class="text-[var(--color-parchment-500)]">
											as {r.color} · {signedPct(r.winRateDelta)}
										</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</div>
			</section>
		{/if}
	{/if}
</DossierSubpageShell>
