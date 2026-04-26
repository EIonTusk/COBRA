<script lang="ts">
	import type { AxisHighlight } from '$lib/dossier/fingerprint';
	import type { EvalInterpretation } from '$lib/dossier/evalInterpreter';
	import type { DossierBadge, DossierProfile } from '$lib/dossier/profile';
	import { AXIS_LABEL, barWidth } from '$lib/dossier/format';

	interface Props {
		highlights: AxisHighlight[];
		evalInterpretation: EvalInterpretation | null;
		profile: DossierProfile | null;
		evalDepth: number;
		baselineSource: string;
	}

	let { highlights, evalInterpretation, profile, evalDepth, baselineSource }: Props = $props();

	function signed(x: number): string {
		const v = (x * 100).toFixed(1);
		return x >= 0 ? `+${v}` : v;
	}

	function badgeTint(kind: DossierBadge['kind']): string {
		return kind === 'strength'
			? 'border-emerald-500/40 bg-emerald-950/20'
			: 'border-amber-300/40 bg-amber-950/20';
	}

	const showProfile = $derived(
		profile != null &&
			(profile.primary != null ||
				profile.strengths.length > 0 ||
				profile.weaknesses.length > 0 ||
				profile.dna.length > 0)
	);

	// Filter the primary badge out of the strength/weakness lists so it isn't
	// rendered twice (once as the headline card, once in the grid below).
	const otherStrengths = $derived(
		profile?.primary?.kind === 'strength'
			? profile.strengths.filter((b) => b.key !== profile?.primary?.key)
			: (profile?.strengths ?? [])
	);
	const otherWeaknesses = $derived(
		profile?.primary?.kind === 'weakness'
			? profile.weaknesses.filter((b) => b.key !== profile?.primary?.key)
			: (profile?.weaknesses ?? [])
	);
</script>

<div class="mt-6 grid gap-3 md:grid-cols-2">
	{#if highlights.length > 0}
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-5 py-4">
			<div class="flex items-baseline justify-between gap-3">
				<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
					Style signature · v1 board-only axes
				</div>
			</div>
			<p class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
				Axis deviations vs same-rating peers · baseline: {baselineSource}
			</p>
			<div class="mt-3 grid gap-1.5 text-xs">
				{#each highlights as h (h.axis)}
					{@const mag = Math.abs(h.delta)}
					<div
						class="grid grid-cols-[minmax(0,5rem)_1fr_1fr_3rem] items-center gap-2 sm:grid-cols-[7rem_1fr_1fr_3.5rem]"
					>
						<span class="truncate text-[var(--color-parchment-200)]"
							>{AXIS_LABEL[h.axis] ?? h.axis}</span
						>
						<div class="flex justify-end">
							<div
								class="h-1.5 rounded bg-amber-500/60"
								style:width={h.direction === 'low' ? barWidth(mag, 0.2) : '0%'}
							></div>
						</div>
						<div>
							<div
								class="h-1.5 rounded bg-emerald-500/60"
								style:width={h.direction === 'high' ? barWidth(mag, 0.2) : '0%'}
							></div>
						</div>
						<span
							class="text-right font-mono {h.direction === 'high'
								? 'text-emerald-300'
								: 'text-amber-300'}"
						>
							{signed(h.delta)}pp
						</span>
					</div>
				{/each}
			</div>
			<p class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
				Amber = axis runs lower than peers; emerald = higher. Bars scaled to ±20pp.
			</p>
		</div>
	{/if}

	{#if evalInterpretation}
		<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-5 py-4">
			<div class="flex flex-wrap items-baseline justify-between gap-3">
				<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
					Engine read · v2 NNUE depth {evalDepth}
				</div>
			</div>
			<div class="mt-2 flex flex-wrap gap-2 text-xs">
				<span
					class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-0.5 text-[var(--color-parchment-200)] capitalize"
				>
					Tactical: <span class="font-mono text-[var(--color-parchment-100)]"
						>{evalInterpretation.tacticalProfile}</span
					>
				</span>
				<span
					class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-0.5 text-[var(--color-parchment-200)] capitalize"
				>
					Consistency: <span class="font-mono text-[var(--color-parchment-100)]"
						>{evalInterpretation.consistency}</span
					>
				</span>
			</div>
			{#if evalInterpretation.headlines.length > 0}
				<ul class="mt-3 space-y-1.5 text-sm leading-relaxed text-[var(--color-parchment-300)]">
					{#each evalInterpretation.headlines as h, i (i)}
						<li class="flex gap-2">
							<span class="text-[var(--color-parchment-500)]">—</span>
							<span>{h}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

{#if showProfile && profile}
	{@const sp = profile}
	<div
		class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-5 py-4"
	>
		<div class="flex flex-wrap items-baseline justify-between gap-3">
			<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
				Profile · who you are at the board
			</div>
			<span class="text-[10px] text-[var(--color-parchment-500)]">
				Structured badges backed by Stockfish.
			</span>
		</div>

		{#if sp.primary}
			<div
				class="mt-3 rounded border {sp.primary.kind === 'strength'
					? 'border-emerald-500/50 bg-emerald-950/20'
					: 'border-amber-300/50 bg-amber-950/20'} px-4 py-3"
			>
				<div class="flex items-baseline gap-3">
					<span
						class="text-[10px] tracking-wider uppercase {sp.primary.kind === 'strength'
							? 'text-emerald-300'
							: 'text-amber-300'}"
					>
						{sp.primary.kind === 'strength' ? 'Signature strength' : 'Standout weakness'}
					</span>
				</div>
				<div class="mt-1 font-serif text-xl text-[var(--color-parchment-50)]">
					{sp.primary.label}
				</div>
				<p class="mt-1 text-sm text-[var(--color-parchment-300)]">
					{sp.primary.tagline}
				</p>
				<p class="mt-1 font-mono text-[10px] text-[var(--color-parchment-500)]">
					{sp.primary.evidence}
				</p>
			</div>
		{/if}

		<div class="mt-3 grid gap-4 md:grid-cols-2">
			<div>
				<div class="text-[10px] tracking-wider text-emerald-300 uppercase">Strengths</div>
				{#if otherStrengths.length === 0}
					<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
						Nothing else stands out above peers yet — keep scanning games.
					</p>
				{:else}
					<ul class="mt-2 space-y-2">
						{#each otherStrengths as b (b.key)}
							<li class="rounded border {badgeTint(b.kind)} px-3 py-2">
								<div class="flex items-baseline justify-between gap-2">
									<span class="text-sm font-medium text-[var(--color-parchment-100)]"
										>{b.label}</span
									>
								</div>
								<p class="mt-0.5 text-xs text-[var(--color-parchment-300)]">
									{b.tagline}
								</p>
								<p class="mt-1 font-mono text-[10px] text-[var(--color-parchment-500)]">
									{b.evidence}
								</p>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div>
				<div class="text-[10px] tracking-wider text-amber-300 uppercase">Weaknesses</div>
				{#if otherWeaknesses.length === 0}
					<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
						No other red flags stand out — look at the scorecard for fine-grained gaps.
					</p>
				{:else}
					<ul class="mt-2 space-y-2">
						{#each otherWeaknesses as b (b.key)}
							<li class="rounded border {badgeTint(b.kind)} px-3 py-2">
								<div class="flex items-baseline justify-between gap-2">
									<span class="text-sm font-medium text-[var(--color-parchment-100)]"
										>{b.label}</span
									>
								</div>
								<p class="mt-0.5 text-xs text-[var(--color-parchment-300)]">
									{b.tagline}
								</p>
								<p class="mt-1 font-mono text-[10px] text-[var(--color-parchment-500)]">
									{b.evidence}
								</p>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>

		{#if sp.dna.length > 0}
			<div class="mt-4 border-t border-[var(--color-ink-800)] pt-3">
				<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
					Style DNA
				</div>
				<div class="mt-2 flex flex-wrap gap-1.5">
					{#each sp.dna as t (t.key)}
						<span
							title={t.description}
							class="rounded-full border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2.5 py-0.5 text-xs text-[var(--color-parchment-300)]"
						>
							{t.label}
						</span>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}
