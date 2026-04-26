<script lang="ts">
	import { severityLabel, type Severity } from '$lib/dossier/deepInsights';
	import type { DossierFingerprint, PickedBaseline } from '$lib/dossier/fingerprint';
	import { barWidth, pct, severityDot, severityTint, signedPctFmt } from '$lib/dossier/format';

	interface Props {
		fingerprint: DossierFingerprint;
		activeBaseline: PickedBaseline;
		tensionDelta: { release: number; create: number };
		/** Anchor prefix for the card id, e.g. `'section-3'`. */
		anchor: string;
		/** Section number — drives the exhibit numbering. */
		sectionNum: number;
		/** 1-based ordinal position after the regular finding cards. */
		cardIdx: number;
	}

	let { fingerprint, activeBaseline, tensionDelta, anchor, sectionNum, cardIdx }: Props = $props();

	const fpTension = $derived(fingerprint.tension);

	// Interpret the deltas into a one-line player archetype.
	const tensionRead = $derived(
		tensionDelta.release < -0.025 && tensionDelta.create < -0.015
			? 'Avoids structural change — leaves the pawn skeleton alone.'
			: tensionDelta.release > 0.025 && tensionDelta.create > 0.015
				? 'Active trader — initiates and resolves contact.'
				: tensionDelta.release > 0.025
					? 'Simplifier — resolves tension when it appears.'
					: tensionDelta.create > 0.015
						? 'Aggressor — creates contact, lets it sit.'
						: tensionDelta.release < -0.025
							? 'Patient — keeps tension on the board.'
							: 'Balanced across both tension axes.'
	);

	// Currently both branches resolve to 'observation', but the conditional
	// is preserved as a hook for future thresholds (concern when very far off
	// peers, etc.) without a wider refactor.
	const tensionSeverity: Severity = 'observation';
</script>

<article
	id="{anchor}-{cardIdx}"
	class="flex scroll-mt-6 flex-col gap-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-5 sm:grid sm:grid-cols-[5rem_1fr] sm:gap-x-5 sm:gap-y-0 sm:px-5"
	style="border-left-width: 3px;"
>
	<div class="flex flex-wrap items-center gap-2 text-xs sm:block">
		<div class="font-mono text-[var(--color-parchment-500)]">
			{sectionNum}.{cardIdx}
		</div>
		<div
			class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] tracking-wider uppercase sm:mt-1 {severityTint(
				tensionSeverity
			)}"
		>
			<span class="inline-block size-1.5 rounded-full {severityDot(tensionSeverity)}"></span>
			{severityLabel(tensionSeverity)}
		</div>
	</div>
	<div class="min-w-0">
		<h3 class="font-serif text-xl leading-snug text-[var(--color-parchment-100)]">
			{tensionRead}
		</h3>
		<p class="mt-2 text-sm leading-relaxed text-[var(--color-parchment-300)]">
			<span class="text-[var(--color-parchment-200)]">Tension management.</span>
			Counts pawn–pawn contact pairs and how you treat them: release rate is how often you resolve tension
			when it's on the board; creation rate is how often you introduce new contact yourself. Both compared
			against your same-rating peer baseline.
		</p>

		<figure
			class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-4 py-3"
		>
			<figcaption
				class="flex items-baseline justify-between text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
			>
				<span>Exhibit {sectionNum}.{cardIdx}</span>
				<span class="tracking-normal normal-case"> Release + creation rate vs peer baseline </span>
			</figcaption>
			<div class="mt-3 grid grid-cols-2 gap-3 text-xs">
				<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2">
					<div class="text-[10px] text-[var(--color-parchment-500)]">Release rate</div>
					<div class="mt-1 font-mono text-base">{pct(fpTension.releaseRate)}</div>
					<div class="mt-1 flex h-1 rounded bg-[var(--color-ink-950)]">
						<div
							class="h-full rounded bg-[var(--color-brass-300)]/70"
							style:width={barWidth(fpTension.releaseRate, 1)}
						></div>
					</div>
					<div
						class="mt-1 flex items-baseline justify-between text-[10px] text-[var(--color-parchment-500)]"
					>
						<span>peer {pct(activeBaseline.tension.releaseRate)}</span>
						<span
							class="font-mono {tensionDelta.release > 0.025
								? 'text-emerald-300'
								: tensionDelta.release < -0.025
									? 'text-amber-300'
									: ''}"
						>
							{signedPctFmt(tensionDelta.release, 1)}
						</span>
					</div>
				</div>
				<div class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2">
					<div class="text-[10px] text-[var(--color-parchment-500)]">Creation rate</div>
					<div class="mt-1 font-mono text-base">{pct(fpTension.creationRate)}</div>
					<div class="mt-1 flex h-1 rounded bg-[var(--color-ink-950)]">
						<div
							class="h-full rounded bg-[var(--color-brass-300)]/70"
							style:width={barWidth(fpTension.creationRate, 0.3)}
						></div>
					</div>
					<div
						class="mt-1 flex items-baseline justify-between text-[10px] text-[var(--color-parchment-500)]"
					>
						<span>peer {pct(activeBaseline.tension.creationRate)}</span>
						<span
							class="font-mono {tensionDelta.create > 0.015
								? 'text-emerald-300'
								: tensionDelta.create < -0.015
									? 'text-amber-300'
									: ''}"
						>
							{signedPctFmt(tensionDelta.create, 1)}
						</span>
					</div>
				</div>
			</div>
			<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
				{fpTension.tensionedMoves.toLocaleString()} moves with pawn contact on the board.
			</div>
		</figure>
	</div>
</article>
