<script lang="ts">
	import type { DossierScanResult } from '$lib/dossier/scan';

	interface Props {
		perAccount: DossierScanResult['perAccount'];
	}

	let { perAccount }: Props = $props();
</script>

<section class="mt-8">
	<h2 class="font-serif text-xl">Per-account</h2>
	<ul class="mt-3 space-y-1 text-sm">
		{#each perAccount as a (a.account.source + a.account.username)}
			<li class="font-mono">
				{a.account.source}/{a.account.username}: {a.scanned} games{a.error
					? ` — error: ${a.error}`
					: ''}
			</li>
		{/each}
	</ul>
</section>
