<script lang="ts">
	import { DOSSIER_BASELINE, type PickedBaseline } from '$lib/dossier/fingerprint';

	interface Props {
		activeBaseline: PickedBaseline | null;
	}

	let { activeBaseline }: Props = $props();
</script>

<details class="mt-6 text-xs text-[var(--color-parchment-500)]">
	<summary class="cursor-pointer">
		Baseline used
		{#if activeBaseline}
			<span class="ml-1 text-[var(--color-parchment-400)]">
				· {activeBaseline.source}{activeBaseline.bucket
					? ` · ${activeBaseline.bucket.bucket ?? 'any'} ${activeBaseline.bucket.ratingMin}–${activeBaseline.bucket.ratingMax} (${activeBaseline.bucket.games} games)`
					: ''}
			</span>
		{/if}
	</summary>
	<pre class="mt-2 whitespace-pre-wrap">{JSON.stringify(
			activeBaseline ?? DOSSIER_BASELINE,
			null,
			2
		)}</pre>
</details>
