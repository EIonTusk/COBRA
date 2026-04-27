<script lang="ts">
	import type { CriticalMoments } from '$lib/dossier/criticalMoments';

	interface Props {
		critical: CriticalMoments | null;
		/** Set to true once the v2 eval pass has produced numbers; without it
		 *  the section explains the prerequisite instead of rendering empty. */
		hasEvalData: boolean;
	}

	let { critical, hasEvalData }: Props = $props();
</script>

<section
	class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
>
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
			Appendix B
		</div>
		<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">Critical moments</h2>
		<span class="text-xs text-[var(--color-parchment-500)]">
			Where your rating actually gets decided — conversion, defense, and equality.
		</span>
	</div>
	{#if critical && hasEvalData}
		{@const cm = critical}
		<div class="mt-4 grid gap-3 sm:grid-cols-3">
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2">
				<div class="text-xs tracking-wider text-[var(--color-parchment-400)] uppercase">
					Conversion
				</div>
				<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)]">
					{Math.round(cm.conversion.rate * 100)}%
				</div>
				<div class="mt-1 text-xs text-[var(--color-parchment-400)]">
					{cm.conversion.wins}/{cm.conversion.games} wins from ≥+1.5
				</div>
				{#if cm.conversion.peerRate != null}
					<div
						class="mt-1 text-xs {cm.conversion.rate < cm.conversion.peerRate - 0.05
							? 'text-amber-300'
							: cm.conversion.rate > cm.conversion.peerRate + 0.05
								? 'text-emerald-400'
								: 'text-[var(--color-parchment-500)]'}"
					>
						Peers: {Math.round(cm.conversion.peerRate * 100)}%
					</div>
				{/if}
			</div>
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2">
				<div class="text-xs tracking-wider text-[var(--color-parchment-400)] uppercase">
					Defense
				</div>
				<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)]">
					{Math.round(cm.defense.rate * 100)}%
				</div>
				<div class="mt-1 text-xs text-[var(--color-parchment-400)]">
					{cm.defense.saves}/{cm.defense.games} saved from ≤−1.5
				</div>
				{#if cm.defense.peerRate != null}
					<div
						class="mt-1 text-xs {cm.defense.rate < cm.defense.peerRate - 0.05
							? 'text-amber-300'
							: cm.defense.rate > cm.defense.peerRate + 0.05
								? 'text-emerald-400'
								: 'text-[var(--color-parchment-500)]'}"
					>
						Peers: {Math.round(cm.defense.peerRate * 100)}%
					</div>
				{/if}
			</div>
			<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2">
				<div class="text-xs tracking-wider text-[var(--color-parchment-400)] uppercase">
					From equality
				</div>
				<div class="mt-1 flex items-baseline gap-2">
					<span class="font-serif text-xl text-emerald-400">
						{Math.round(cm.equality.winRate * 100)}%
					</span>
					<span class="text-xs text-[var(--color-parchment-500)]">win</span>
					<span class="font-serif text-xl text-amber-300">
						{Math.round(cm.equality.lossRate * 100)}%
					</span>
					<span class="text-xs text-[var(--color-parchment-500)]">loss</span>
				</div>
				<div class="mt-1 text-xs text-[var(--color-parchment-400)]">
					{cm.equality.games} balanced openings
				</div>
				{#if cm.equality.peerWinRate != null && cm.equality.peerLossRate != null}
					<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
						Peers: {Math.round(cm.equality.peerWinRate * 100)}% W · {Math.round(
							cm.equality.peerLossRate * 100
						)}% L
					</div>
				{/if}
			</div>
		</div>
		{#if cm.sampledGames === 0}
			<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
				No games had enough evaluated moves — scan more games and re-run v2.
			</p>
		{/if}
	{:else}
		<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
			Needs v2 eval data. Re-scan with <em>Include v2 eval axes</em> on.
		</p>
	{/if}
</section>
