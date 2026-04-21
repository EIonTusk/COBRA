<script lang="ts">
	import { onMount } from 'svelte';

	import DossierSubpageShell from '$lib/dossier/DossierSubpageShell.svelte';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { analysePieceAffinity, minorTradeLean } from '$lib/dossier/pieceAffinity';
	import type { DossierScanResult } from '$lib/dossier/scan';

	let loaded = $state(false);
	let result = $state<DossierScanResult | null>(null);

	onMount(async () => {
		const saved = await loadDossierReport();
		if (saved?.payload) result = saved.payload as DossierScanResult;
		loaded = true;
	});

	const summary = $derived(result ? analysePieceAffinity(result.classified) : null);
	const lean = $derived(summary ? minorTradeLean(summary) : null);

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}

	const ROLE_LABEL: Record<string, string> = {
		pawn: 'Pawn',
		knight: 'Knight',
		bishop: 'Bishop',
		rook: 'Rook',
		queen: 'Queen',
		king: 'King'
	};
</script>

<DossierSubpageShell
	title="Piece affinity"
	subtitle="Which pieces you like to keep, which you cash first. Derived from every capture in your scanned games."
	{loaded}
	hasReport={!!result}
>
	{#if summary && lean}
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Minor-piece lean
			</div>
			<p class="mt-2 text-sm text-[var(--color-parchment-200)]">
				{#if lean.lean === 'bishop'}
					You trade <span class="text-[var(--color-parchment-50)]">knights for bishops</span> more
					often than the reverse ({pct(lean.kfbPct)} vs {pct(lean.bfkPct)}) — you prefer keeping the
					bishop pair.
				{:else if lean.lean === 'knight'}
					You trade <span class="text-[var(--color-parchment-50)]">bishops for knights</span> more
					often than the reverse ({pct(lean.bfkPct)} vs {pct(lean.kfbPct)}) — you lean toward knight
					play.
				{:else}
					Your minor-piece trades are balanced (B×N {summary.trades.bishopForKnight} vs N×B {summary
						.trades.knightForBishop}).
				{/if}
			</p>
			<div class="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">B × N</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.trades.bishopForKnight}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">N × B</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.trades.knightForBishop}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">B × B</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.trades.bishopForBishop}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">N × N</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{summary.trades.knightForKnight}
					</div>
				</div>
			</div>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Trade lean by color
			</div>
			<table class="mt-3 w-full text-xs">
				<thead class="text-[var(--color-parchment-500)]">
					<tr>
						<th class="text-left">Color</th>
						<th class="text-right">B × N</th>
						<th class="text-right">N × B</th>
						<th class="text-right">Bishop-keeper?</th>
					</tr>
				</thead>
				<tbody class="font-mono text-[var(--color-parchment-100)]">
					{#each ['white', 'black'] as const as color (color)}
						{@const t = summary.tradesByColor[color]}
						{@const total = t.bishopForKnight + t.knightForBishop}
						{@const kfbPct = total > 0 ? t.knightForBishop / total : 0}
						<tr class="border-t border-[var(--color-ink-800)]">
							<td class="py-1.5 capitalize">{color}</td>
							<td class="py-1.5 text-right">{t.bishopForKnight}</td>
							<td class="py-1.5 text-right">{t.knightForBishop}</td>
							<td
								class="py-1.5 text-right {kfbPct > 0.55
									? 'text-emerald-400'
									: kfbPct < 0.45
										? 'text-amber-300'
										: ''}"
							>
								{total > 0 ? pct(kfbPct) : '—'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				Most common captures
			</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
				Top capture pairs across all {summary.totalCaptures.toLocaleString()} captures.
			</p>
			<ul class="mt-3 grid gap-1 text-xs">
				{#each [...summary.minorPairs, ...summary.majorPairs].slice(0, 12) as p (`${p.captor}-${p.captured}`)}
					<li
						class="flex items-baseline justify-between rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-2 py-1"
					>
						<span class="font-mono">
							{ROLE_LABEL[p.captor]} × {ROLE_LABEL[p.captured]}
						</span>
						<span class="font-mono text-[var(--color-parchment-300)]">{p.count}</span>
					</li>
				{/each}
			</ul>
		</section>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
				When do you take?
			</div>
			<div class="mt-3 grid grid-cols-3 gap-3 text-xs">
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">While ahead (&gt;+1.5)</div>
					<div class="mt-1 font-mono text-lg text-emerald-300">
						{pct(summary.capturesWhileAhead)}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">While equal</div>
					<div class="mt-1 font-mono text-lg text-[var(--color-parchment-100)]">
						{pct(summary.capturesWhileEqual)}
					</div>
				</div>
				<div
					class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
				>
					<div class="text-[var(--color-parchment-500)]">While behind (&lt;−1.5)</div>
					<div class="mt-1 font-mono text-lg text-amber-300">
						{pct(summary.capturesWhileBehind)}
					</div>
				</div>
			</div>
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				Heavy weight on "while ahead" = you like to simplify when winning. Heavy "while behind" =
				you fight for counterplay instead of clinging.
			</p>
		</section>

		{#if result}
			{@const fp = result.fingerprint}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Style axes by color
				</div>
				<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
					Forcing / pawn / early-castle rates split by the side you played. Paired with the trade
					tables above so you can see whether a color-specific trade bias tracks a broader style
					change.
				</p>
				<table class="mt-3 w-full border-collapse text-sm">
					<thead class="text-left text-xs text-[var(--color-parchment-500)]">
						<tr>
							<th class="py-2 pr-4">Color</th>
							<th class="py-2 pr-4">Games</th>
							<th class="py-2 pr-4">Forcing</th>
							<th class="py-2 pr-4">Pawn</th>
							<th class="py-2 pr-4">Early O-O</th>
						</tr>
					</thead>
					<tbody>
						{#each ['white', 'black'] as const as c (c)}
							{@const r = fp.byColor[c]}
							<tr class="border-t border-[var(--color-ink-800)]">
								<td class="py-2 pr-4 font-medium capitalize">{c}</td>
								<td class="py-2 pr-4 font-mono">{r.games}</td>
								<td class="py-2 pr-4 font-mono">{pct(r.forcing)}</td>
								<td class="py-2 pr-4 font-mono">{pct(r.pawnPlay)}</td>
								<td class="py-2 pr-4 font-mono">{pct(r.earlyCastle)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}
	{/if}
</DossierSubpageShell>
