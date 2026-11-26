<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base, resolve } from '$app/paths';
	import { Check } from 'lucide-svelte';
	import { Button } from '$lib/ui';
	import { getSettings, saveSettings } from '$lib/storage/settings';
	import { startOAuth, ALL_SCOPES } from '$lib/lichess/oauth';
	import { sync } from '$lib/sync/syncStore.svelte';
	import { welcomeStep, type WelcomeStep } from '$lib/welcome';
	import type { AppSettings } from '$lib/types';

	// The welcome page is also where both Lichess sign-ins return to, so it
	// resumes wherever the user is: intro → (sync identity) → turning sync on.
	const RETURN_TO = `${base}/welcome`;

	let step = $state<WelcomeStep | 'loading' | 'syncing' | 'ready' | 'error'>('loading');
	let wantSync = $state(true);
	let busy = $state(false);
	let errorMessage = $state('');

	const syncTarget = sync.hostedAvailable
		? 'with the COBRA DB'
		: 'in a private study on your Lichess account';

	async function update(patch: Partial<AppSettings>): Promise<void> {
		const s = await getSettings();
		await saveSettings(JSON.parse(JSON.stringify({ ...s, ...patch })), { skipDirtyMark: true });
	}

	async function refresh(): Promise<void> {
		const s = await getSettings();
		const next = welcomeStep(s, sync.hostedAvailable);
		if (next === 'done') {
			await goto(resolve('/'));
			return;
		}
		step = next;
		if (next === 'enable') await turnOnSync();
	}

	async function connectLichess(): Promise<void> {
		busy = true;
		await update({ welcomeSeen: true, welcomeSyncPending: wantSync });
		await startOAuth([...ALL_SCOPES], RETURN_TO);
		busy = false;
	}

	async function connectSyncIdentity(): Promise<void> {
		busy = true;
		await startOAuth([], RETURN_TO, 'identity');
		busy = false;
	}

	async function skip(): Promise<void> {
		await update({ welcomeSeen: true, welcomeSyncPending: false });
		await goto(resolve('/'));
	}

	async function turnOnSync(): Promise<void> {
		step = 'syncing';
		try {
			await sync.configureBackend(sync.hostedAvailable ? 'cobra' : 'lichess');
			await sync.enable({ mode: 'auto' });
			await update({ welcomeSyncPending: false });
			step = 'ready';
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : String(e);
			step = 'error';
		}
	}

	onMount(() => {
		void sync.init().then(refresh);
	});
</script>

<svelte:head>
	<title>Welcome · COBRA</title>
</svelte:head>

<div class="mx-auto max-w-md px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
	<div class="eyebrow mb-3 text-[var(--color-brass-300)]">Welcome to COBRA</div>

	{#if step === 'intro'}
		<h1 class="mb-4 font-serif text-3xl">Connect your Lichess account</h1>
		<p class="mb-3 font-serif text-sm text-[var(--color-parchment-300)]">
			COBRA works without an account, but connecting Lichess lets you:
		</p>
		<ul class="mb-6 space-y-2 font-serif text-sm text-[var(--color-parchment-200)]">
			{#each ['See opening statistics while you build a repertoire', 'Find the mistakes you make in your own games', 'Play training games against Stockfish and Maia bots', 'Keep your repertoires and progress in sync across devices'] as line (line)}
				<li class="flex items-start gap-2">
					<Check class="mt-0.5 size-4 shrink-0 text-[var(--color-olive-300)]" />
					<span>{line}</span>
				</li>
			{/each}
		</ul>

		<label
			class="ink-panel mb-6 flex cursor-pointer items-start gap-3 p-4 font-serif text-sm text-[var(--color-parchment-100)]"
		>
			<input
				type="checkbox"
				bind:checked={wantSync}
				class="mt-0.5 size-4 accent-[var(--color-brass-300)]"
			/>
			<span>
				Sync my repertoires across devices
				<span class="mt-1 block text-xs text-[var(--color-parchment-500)] italic">
					Stored {syncTarget}. You can change this any time in Settings.
				</span>
			</span>
		</label>

		<div class="flex flex-wrap items-center gap-3">
			<Button variant="primary" onclick={connectLichess} disabled={busy}>Connect Lichess</Button>
			<Button variant="ghost" onclick={skip} disabled={busy}>Skip for now</Button>
		</div>
	{:else if step === 'identity'}
		<h1 class="mb-4 font-serif text-3xl">One more approval</h1>
		<p class="mb-6 font-serif text-sm text-[var(--color-parchment-300)]">
			Lichess is connected. To sync, Lichess asks once more, this time for a sign-in that only
			proves who you are. The COBRA DB never gets a token that can act on your Lichess account.
		</p>
		<div class="flex flex-wrap items-center gap-3">
			<Button variant="primary" onclick={connectSyncIdentity} disabled={busy}>
				Approve sync sign-in
			</Button>
			<Button variant="ghost" onclick={skip} disabled={busy}>Skip sync</Button>
		</div>
	{:else if step === 'syncing'}
		<h1 class="mb-4 font-serif text-3xl">Turning on sync…</h1>
		<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
			Bringing in anything you already synced from another device.
		</p>
	{:else if step === 'ready'}
		<h1 class="mb-4 font-serif text-3xl">
			<span class="text-[var(--color-olive-300)]">You're all set.</span>
		</h1>
		<p class="mb-6 font-serif text-sm text-[var(--color-parchment-300)]">
			Lichess is connected and sync is on. Sign in on your other devices and tick sync there too.
		</p>
		<Button variant="primary" onclick={() => goto(resolve('/'))}>Start</Button>
	{:else if step === 'error'}
		<h1 class="mb-4 font-serif text-3xl">
			<span class="text-[var(--color-oxblood-300)]">Sync couldn't start.</span>
		</h1>
		<p class="mb-6 font-serif text-sm text-[var(--color-parchment-300)]">{errorMessage}</p>
		<div class="flex flex-wrap items-center gap-3">
			<Button variant="primary" onclick={turnOnSync}>Try again</Button>
			<Button variant="ghost" onclick={() => goto(resolve('/settings#sync'))}>Open Settings</Button>
			<Button variant="ghost" onclick={skip}>Skip sync</Button>
		</div>
	{/if}
</div>
