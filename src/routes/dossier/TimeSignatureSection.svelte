<script lang="ts">
	import type { ClockSpendReport } from '$lib/dossier/clockSpend';
	import { fmtSec } from '$lib/dossier/format';

	interface Props {
		clockSpend: ClockSpendReport | null;
	}

	let { clockSpend }: Props = $props();
</script>

{#if clockSpend && clockSpend.secondsSpent > 0}
	{@const cs = clockSpend}
	<section
		class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
	>
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
				Appendix C
			</div>
			<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">Time signature</h2>
			<span class="text-xs text-[var(--color-parchment-500)]">
				Where your clock goes vs. where your blunders land.
			</span>
		</div>
		<div class="mt-4 space-y-3">
			<div>
				<div class="flex items-baseline justify-between text-xs text-[var(--color-parchment-400)]">
					<span>Clock spent</span>
					<span class="font-mono">{fmtSec(cs.secondsSpent)} across {cs.gamesWithClock} games</span>
				</div>
				<div
					class="mt-1 flex h-6 overflow-hidden rounded border border-[var(--color-ink-800)] text-xs"
				>
					<div
						class="flex items-center justify-center bg-emerald-900/40 text-emerald-200"
						style="width: {cs.alloc.opening * 100}%"
					>
						{cs.alloc.opening > 0.08 ? `${Math.round(cs.alloc.opening * 100)}%` : ''}
					</div>
					<div
						class="flex items-center justify-center bg-amber-900/40 text-amber-200"
						style="width: {cs.alloc.middle * 100}%"
					>
						{cs.alloc.middle > 0.08 ? `${Math.round(cs.alloc.middle * 100)}%` : ''}
					</div>
					<div
						class="bg-oxblood-900/40 flex items-center justify-center bg-red-950/40 text-red-200"
						style="width: {cs.alloc.end * 100}%"
					>
						{cs.alloc.end > 0.08 ? `${Math.round(cs.alloc.end * 100)}%` : ''}
					</div>
				</div>
			</div>
			{#if cs.blunderCount > 0}
				<div>
					<div
						class="flex items-baseline justify-between text-xs text-[var(--color-parchment-400)]"
					>
						<span>Blunders</span>
						<span class="font-mono">{cs.blunderCount} blunders from v2 eval</span>
					</div>
					<div
						class="mt-1 flex h-6 overflow-hidden rounded border border-[var(--color-ink-800)] text-xs"
					>
						<div
							class="flex items-center justify-center bg-emerald-900/20 text-emerald-200"
							style="width: {cs.blunders.opening * 100}%"
						>
							{cs.blunders.opening > 0.08 ? `${Math.round(cs.blunders.opening * 100)}%` : ''}
						</div>
						<div
							class="flex items-center justify-center bg-amber-900/20 text-amber-200"
							style="width: {cs.blunders.middle * 100}%"
						>
							{cs.blunders.middle > 0.08 ? `${Math.round(cs.blunders.middle * 100)}%` : ''}
						</div>
						<div
							class="flex items-center justify-center bg-red-950/20 text-red-200"
							style="width: {cs.blunders.end * 100}%"
						>
							{cs.blunders.end > 0.08 ? `${Math.round(cs.blunders.end * 100)}%` : ''}
						</div>
					</div>
				</div>
			{/if}
			<div class="flex gap-3 text-[10px] text-[var(--color-parchment-500)]">
				<span class="flex items-center gap-1"
					><span class="inline-block h-2 w-2 rounded-sm bg-emerald-900/60"></span>Opening</span
				>
				<span class="flex items-center gap-1"
					><span class="inline-block h-2 w-2 rounded-sm bg-amber-900/60"></span>Middlegame</span
				>
				<span class="flex items-center gap-1"
					><span class="inline-block h-2 w-2 rounded-sm bg-red-950/60"></span>Endgame</span
				>
			</div>
		</div>
		{#if cs.mismatchHeadline}
			<p class="mt-3 text-sm text-[var(--color-parchment-200)]">{cs.mismatchHeadline}</p>
		{/if}
		{#if cs.peerAlloc}
			<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
				Peer clock allocation: {Math.round(cs.peerAlloc.opening * 100)}% / {Math.round(
					cs.peerAlloc.middle * 100
				)}% / {Math.round(cs.peerAlloc.end * 100)}%
			</p>
		{/if}
	</section>
{/if}
