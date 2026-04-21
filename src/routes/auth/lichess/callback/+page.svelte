<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { handleCallback } from '$lib/lichess/oauth';

	let status = $state<'working' | 'ok' | 'error'>('working');
	let message = $state('Finishing the handshake with Lichess…');

	onMount(async () => {
		const params = page.url.searchParams;
		const code = params.get('code');
		const state = params.get('state');
		const error = params.get('error');

		if (error) {
			status = 'error';
			message = `Lichess returned "${error}". You can try connecting again from Settings.`;
			return;
		}
		if (!code || !state) {
			status = 'error';
			message = 'Missing authorization code. Try connecting again from Settings.';
			return;
		}
		try {
			await handleCallback(code, state);
			status = 'ok';
			message = 'Connected. Heading back to Settings…';
			setTimeout(() => goto(resolve(`/settings`)), 700);
		} catch (e) {
			status = 'error';
			message = e instanceof Error ? e.message : 'Unknown error during OAuth callback.';
		}
	});
</script>

<div class="mx-auto max-w-md px-6 pt-24 text-center">
	<div class="eyebrow mb-3">Lichess · Connect</div>
	<h1 class="mb-4 font-serif text-3xl">
		{#if status === 'working'}
			Linking your account…
		{:else if status === 'ok'}
			<span class="text-[var(--color-olive-300)]">Connected.</span>
		{:else}
			<span class="text-[var(--color-oxblood-300)]">Couldn't connect.</span>
		{/if}
	</h1>
	<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">{message}</p>
	{#if status === 'error'}
		<div class="mt-6">
			<a
				href={resolve('/settings')}
				class="text-[var(--color-brass-300)] underline underline-offset-2"
			>
				Back to Settings
			</a>
		</div>
	{/if}
</div>
