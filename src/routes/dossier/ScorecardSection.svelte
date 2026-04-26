<script lang="ts">
	import type { Scorecard } from '$lib/dossier/scorecard';
	import { PHASE_LABEL } from '$lib/dossier/format';

	interface Props {
		scorecard: Scorecard | null;
	}

	let { scorecard }: Props = $props();

	const phaseKeys = ['opening', 'middle', 'end'] as const;
	const colorKeys = ['white', 'black'] as const;
	type PhaseKey = (typeof phaseKeys)[number];
	type ColorKey = (typeof colorKeys)[number];

	function tileAt(p: PhaseKey, c: ColorKey) {
		return scorecard?.tiles.find((t) => t.phase === p && t.color === c);
	}
</script>

<section
	class="mt-4 rounded border border-[var(--color-brass-300)]/40 bg-[var(--color-ink-900)] px-4 py-4"
>
	{#if scorecard}
		<!-- Hero: overall CP/move with peer delta. Single number
		     the user should walk away with. -->
		<div class="flex flex-wrap items-end justify-between gap-4">
			<div>
				<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
					Appendix A · Scorecard
				</div>
				<div class="mt-0.5 text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
					Average CP loss per move
				</div>
				{#if scorecard.overall.sparse}
					<div class="mt-1 font-mono text-sm text-[var(--color-parchment-500)]">
						Not enough analysed moves — scan more games.
					</div>
				{:else}
					<div class="mt-1 flex items-baseline gap-3">
						<span class="font-serif text-5xl text-[var(--color-parchment-50)]">
							{Math.round(scorecard.overall.cpLoss)}
						</span>
						<span class="text-sm text-[var(--color-parchment-400)]">cp/move</span>
						{#if scorecard.overall.peerDelta != null}
							<span
								class="text-xs {scorecard.overall.verdict === 'weak'
									? 'text-amber-300'
									: scorecard.overall.verdict === 'strong'
										? 'text-emerald-400'
										: 'text-[var(--color-parchment-500)]'}"
							>
								{scorecard.overall.peerDelta >= 0 ? '+' : ''}{Math.round(
									scorecard.overall.peerDelta
								)} vs peers
							</span>
						{/if}
					</div>
					<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
						{scorecard.overall.moves} user moves · blunder rate {Math.round(
							scorecard.overall.blunderRate * 100
						)}%
					</div>
				{/if}
			</div>
			<div class="text-right text-xs text-[var(--color-parchment-500)]">
				<div>Lower is better.</div>
				<div class="mt-0.5">Peer = same rating + speed.</div>
			</div>
		</div>

		<!-- Matrix: phase columns × colour rows. -->
		<div class="mt-5">
			<div
				class="grid items-center gap-2 text-xs tracking-wider text-[var(--color-parchment-500)] uppercase"
				style="grid-template-columns: 80px repeat(3, minmax(0, 1fr));"
			>
				<div></div>
				{#each phaseKeys as p (p)}
					<div class="text-center">{PHASE_LABEL[p]}</div>
				{/each}
				{#each colorKeys as c (c)}
					<div class="text-[var(--color-parchment-300)]">
						{c === 'white' ? 'As White' : 'As Black'}
					</div>
					{#each phaseKeys as p (p)}
						{@const t = tileAt(p, c)}
						{#if t}
							{@const isWeakest = scorecard.weakest === t}
							{@const isStrongest = scorecard.strongest === t}
							<div
								class="rounded border px-3 py-2 {isWeakest
									? 'border-amber-300/60 bg-amber-950/20'
									: isStrongest
										? 'border-emerald-500/60 bg-emerald-950/20'
										: t.verdict === 'weak'
											? 'border-amber-300/20 bg-[var(--color-ink-950)]'
											: t.verdict === 'strong'
												? 'border-emerald-500/20 bg-[var(--color-ink-950)]'
												: 'border-[var(--color-ink-800)] bg-[var(--color-ink-950)]'}"
							>
								{#if t.sparse}
									<div class="font-mono text-xs text-[var(--color-parchment-500)]">— / too few</div>
								{:else}
									<div class="flex items-baseline justify-between gap-2">
										<span class="font-serif text-2xl text-[var(--color-parchment-50)]">
											{Math.round(t.cpLoss)}
										</span>
										<span class="font-mono text-[10px] text-[var(--color-parchment-500)]">
											{t.moves}m
										</span>
									</div>
									{#if t.peerDelta != null}
										<div
											class="mt-0.5 text-[11px] {t.verdict === 'weak'
												? 'text-amber-300'
												: t.verdict === 'strong'
													? 'text-emerald-400'
													: 'text-[var(--color-parchment-500)]'}"
										>
											{t.peerDelta >= 0 ? '+' : ''}{Math.round(t.peerDelta)} vs peers
										</div>
									{/if}
								{/if}
							</div>
						{/if}
					{/each}
				{/each}
			</div>
		</div>

		{#if scorecard.headline}
			<p class="mt-4 text-sm text-[var(--color-parchment-200)]">{scorecard.headline}</p>
		{/if}
	{:else}
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">Scorecard</h2>
		</div>
		<p class="mt-3 text-xs text-[var(--color-parchment-500)]">Scan to populate the scorecard.</p>
	{/if}
</section>
