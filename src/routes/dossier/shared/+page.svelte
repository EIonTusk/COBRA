<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { ArrowLeft, Upload } from 'lucide-svelte';

	import { decodeDossierShare, type DossierShareBundle } from '$lib/storage/shareDossierReport';
	import { setSharedReportOverride } from '$lib/storage/dossierReport';

	let error = $state<string | null>(null);
	let decoding = $state(true);

	onMount(async () => {
		try {
			const hash = typeof window !== 'undefined' ? window.location.hash : '';
			if (hash) {
				const params = new URLSearchParams(hash.replace(/^#/, ''));
				const data = params.get('data');
				if (data) {
					const bundle = await decodeDossierShare(data);
					activateAndRedirect(bundle);
					return;
				}
			}
			// No fragment — wait for file upload.
			decoding = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not decode the share payload.';
			decoding = false;
		}
	});

	function activateAndRedirect(bundle: DossierShareBundle) {
		setSharedReportOverride(bundle.report);
		goto(resolve(`/dossier?shared=1`));
	}

	async function onFileChosen(ev: Event) {
		const input = ev.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		error = null;
		decoding = true;
		try {
			const text = await file.text();
			const parsed = JSON.parse(text);
			if (parsed.version !== 1 || !parsed.report) {
				throw new Error('File does not look like a cobra dossier-share bundle.');
			}
			activateAndRedirect(parsed as DossierShareBundle);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not read the file.';
			decoding = false;
		}
	}
</script>

<div class="mx-auto max-w-2xl px-4 py-10 sm:px-6">
	<a
		href={resolve('/dossier')}
		class="inline-flex items-center gap-1.5 text-sm text-[var(--color-parchment-400)] hover:text-[var(--color-parchment-100)]"
	>
		<ArrowLeft class="size-4" />
		Style review
	</a>

	<div class="mt-6 text-[10px] tracking-[0.25em] text-[var(--color-brass-300)] uppercase">
		Cobra Analytics · Shared report
	</div>
	<h1 class="mt-2 font-serif text-3xl leading-tight text-[var(--color-parchment-50)]">
		Opening a style review
	</h1>
	<p class="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--color-parchment-300)]">
		A shared report is being decoded and displayed as a read-only view. Your own saved report is not
		touched.
	</p>

	{#if decoding}
		<div
			class="mt-8 flex items-center gap-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4 text-sm text-[var(--color-parchment-300)]"
			role="status"
			aria-live="polite"
		>
			<span
				class="inline-block size-4 animate-spin rounded-full border-2 border-[var(--color-brass-300)] border-t-transparent"
				aria-hidden="true"
			></span>
			<span>Decoding shared report…</span>
		</div>
	{:else if error}
		<p class="mt-6 text-sm text-red-400">{error}</p>
		<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
			If the share came as a file, upload it below. If it's a link, make sure the full URL
			(including the <span class="font-mono">#data=…</span> fragment) is in the address bar.
		</p>

		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="text-[10px] tracking-wider text-[var(--color-brass-300)] uppercase">
				Upload a file
			</div>
			<p class="mt-1 text-xs text-[var(--color-parchment-400)]">
				Drag-and-drop or pick a <span class="font-mono">cobra-style-*.json</span> file.
			</p>
			<label
				class="mt-3 inline-flex cursor-pointer items-center gap-2 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-3 py-1.5 text-xs hover:border-[var(--color-brass-300)]/40"
			>
				<Upload class="size-3" />
				Choose file
				<input type="file" accept="application/json,.json" onchange={onFileChosen} class="hidden" />
			</label>
		</section>
	{/if}
</div>
