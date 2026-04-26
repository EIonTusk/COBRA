<script lang="ts">
	import type { SessionProfile } from '$lib/dossier/sessionProfile';

	interface Props {
		profile: SessionProfile | null;
	}

	let { profile }: Props = $props();
</script>

{#if profile && profile.multiGameSessions > 0}
	{@const sp = profile}
	<section
		class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
	>
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
				Appendix E
			</div>
			<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">Session profile</h2>
			<span class="text-xs text-[var(--color-parchment-500)]">
				{sp.sessions} sessions · {sp.multiGameSessions} multi-game
			</span>
		</div>
		{#if sp.byIndex.length > 0}
			<div class="mt-3 grid gap-2 sm:grid-cols-6">
				{#each sp.byIndex as b (b.index)}
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-2 py-2 text-xs"
					>
						<div class="text-[var(--color-parchment-500)]">Game #{b.index + 1}</div>
						<div class="mt-1 font-mono text-[var(--color-parchment-200)]">
							{b.avgCpLoss != null ? `${Math.round(b.avgCpLoss)} cp` : '—'}
						</div>
						<div class="text-[var(--color-parchment-500)]">
							{b.games}g · {Math.round(b.winRate * 100)}% W
						</div>
					</div>
				{/each}
			</div>
		{/if}
		<div class="mt-3 grid gap-2 sm:grid-cols-2">
			<div
				class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2 text-xs"
			>
				<div class="text-[var(--color-parchment-400)]">After a loss, same session</div>
				<div class="mt-1 font-mono text-[var(--color-parchment-200)]">
					{sp.postLoss.avgCpLoss != null ? `${Math.round(sp.postLoss.avgCpLoss)} cp` : '—'}
					{#if sp.postLoss.delta != null}
						<span
							class={sp.postLoss.delta >= 15
								? 'text-amber-300'
								: 'text-[var(--color-parchment-500)]'}
						>
							({sp.postLoss.delta >= 0 ? '+' : ''}{Math.round(sp.postLoss.delta)} vs prior game)
						</span>
					{/if}
				</div>
				<div class="text-[var(--color-parchment-500)]">{sp.postLoss.games} samples</div>
			</div>
			<div
				class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2 text-xs"
			>
				<div class="text-[var(--color-parchment-400)]">After a win, same session</div>
				<div class="mt-1 font-mono text-[var(--color-parchment-200)]">
					{sp.postWin.avgCpLoss != null ? `${Math.round(sp.postWin.avgCpLoss)} cp` : '—'}
					{#if sp.postWin.delta != null}
						<span
							class={sp.postWin.delta <= -10
								? 'text-emerald-400'
								: 'text-[var(--color-parchment-500)]'}
						>
							({sp.postWin.delta >= 0 ? '+' : ''}{Math.round(sp.postWin.delta)} vs prior game)
						</span>
					{/if}
				</div>
				<div class="text-[var(--color-parchment-500)]">{sp.postWin.games} samples</div>
			</div>
		</div>
		{#if sp.headline}
			<p class="mt-3 text-sm text-[var(--color-parchment-200)]">{sp.headline}</p>
		{/if}
	</section>
{/if}
