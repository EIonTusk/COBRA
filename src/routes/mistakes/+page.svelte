<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { onDestroy, onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { ExternalLink, RotateCcw, Trash2, X } from 'lucide-svelte';

	import { scanMistakes, type MistakeSource } from '$lib/lichess/mistakeScan';
	import { dismissMistake, listMistakes } from '$lib/storage/mistakes';
	import { getSettings, effectiveLichessToken, saveSettings } from '$lib/storage/settings';
	import { Button, DashboardBacklink, Input, Label, SourceUsernameInput, cn } from '$lib/ui';
	import type { AppSettings, StoredMistake } from '$lib/types';

	let username = $state('');
	let maxGames = $state(50);
	let ratedOnly = $state(true);
	let source = $state<MistakeSource>('lichess');
	let running = $state(false);
	let error = $state<string | null>(null);
	let settings = $state<AppSettings | null>(null);
	let controller: AbortController | null = null;

	let scanStatus = $state<string | null>(null);
	let filter = $state<'pending' | 'corrected' | 'all'>('pending');
	let stored = $state<StoredMistake[]>([]);

	const grouped = $derived.by(() => {
		const map = new SvelteMap<string, { name: string; items: StoredMistake[] }>();
		for (const m of stored) {
			if (filter === 'pending' && m.status !== 'pending') continue;
			if (filter === 'corrected' && m.status !== 'corrected') continue;
			if (!map.has(m.repertoireId)) {
				map.set(m.repertoireId, { name: m.repertoireName, items: [] });
			}
			map.get(m.repertoireId)!.items.push(m);
		}
		return [...map.entries()].map(([id, v]) => ({
			repertoireId: id,
			name: v.name,
			items: v.items.sort((a, b) => b.detectedAt - a.detectedAt)
		}));
	});

	const _pendingCount = $derived(stored.filter((m) => m.status === 'pending').length);

	async function refresh() {
		stored = await listMistakes({});
	}

	onMount(async () => {
		settings = await getSettings();
		if (settings?.lichessOAuth?.username && !username) username = settings.lichessOAuth.username;
		await refresh();
	});

	onDestroy(() => controller?.abort());

	const tokenConfigured = $derived(!!settings && !!effectiveLichessToken(settings));
	const canRun = $derived(
		!!username.trim() && !running && (source === 'chesscom' || tokenConfigured)
	);

	async function run(e: Event) {
		e.preventDefault();
		if (!settings || !canRun) return;
		let token = '';
		if (source === 'lichess') {
			token = effectiveLichessToken(settings);
			if (!token) {
				error = 'Connect Lichess or paste a token in Settings first.';
				return;
			}
		}
		error = null;
		running = true;
		controller = new AbortController();
		scanStatus = 'Streaming games…';

		try {
			const result = await scanMistakes({
				username,
				maxGames,
				token,
				source,
				rated: ratedOnly ? true : undefined,
				signal: controller.signal,
				onProgress: (s, f) => {
					scanStatus = `Scanned ${s} games · ${f} deviations detected`;
				}
			});
			scanStatus =
				result.newlyAdded > 0
					? `${result.newlyAdded} new mistake${result.newlyAdded === 1 ? '' : 's'} stored.`
					: 'No new mistakes since the last scan.';
			// Persist last scan time
			const next = { ...(settings ?? ({} as AppSettings)), lastMistakeScanAt: Date.now() };
			await saveSettings(JSON.parse(JSON.stringify(next)));
			settings = next as AppSettings;
			await refresh();
		} catch (e) {
			if ((e as Error).name !== 'AbortError') {
				error = e instanceof Error ? e.message : 'Scan failed';
			}
		} finally {
			running = false;
			controller = null;
		}
	}

	function cancel() {
		controller?.abort();
	}

	function fmtDate(ts: number): string {
		return new Date(ts).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric'
		});
	}

	async function onDismiss(id: string) {
		await dismissMistake(id);
		await refresh();
	}
</script>

<div class="relative mx-auto max-w-2xl px-6 pt-14 pb-16">
	<DashboardBacklink />

	<div class="eyebrow mb-3">Mistakes</div>
	<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
		Where you went <em class="text-[var(--color-brass-300)]">off-book</em>.
	</h1>
	<p class="mt-3 max-w-md text-[var(--color-parchment-400)]">
		Scans your Lichess games against every matching-colour repertoire. Detected deviations persist
		across sessions; retrain them and they move to "corrected".
	</p>

	{#if source === 'lichess' && !tokenConfigured}
		<div
			class="mt-6 rounded border border-[var(--color-brass-400)]/30 bg-[var(--color-brass-500)]/10 p-4 text-sm"
		>
			<p class="text-[var(--color-brass-200)]">
				Scanning Lichess needs a token.
				<a
					href={resolve('/settings')}
					class="text-[var(--color-brass-300)] underline underline-offset-2"
				>
					Connect in Settings
				</a>, or switch to chess.com below (public API, no token needed).
			</p>
		</div>
	{/if}

	<form onsubmit={run} class="mt-6 grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_auto]">
		<div>
			<Label for="user">Username</Label>
			<SourceUsernameInput id="user" bind:source bind:username required disabled={running} />
		</div>
		<div class="w-28">
			<Label for="max">Max</Label>
			<Input
				id="max"
				type="number"
				min={1}
				max={200}
				bind:value={maxGames}
				disabled={running}
				class="font-mono"
			/>
		</div>
		<div class="flex gap-2">
			{#if running}
				<Button variant="destructive" size="md" type="button" onclick={cancel}>
					<X class="size-4" />
					<span>Stop</span>
				</Button>
			{:else}
				<Button variant="primary" size="md" type="submit" disabled={!canRun}>
					<span>Scan</span>
				</Button>
			{/if}
		</div>
	</form>

	<label class="mt-3 flex items-center gap-2 text-sm text-[var(--color-parchment-300)]">
		<input
			type="checkbox"
			bind:checked={ratedOnly}
			disabled={running}
			class="accent-[var(--color-brass-300)]"
		/>
		<span>Rated only</span>
	</label>

	{#if error}
		<p class="mt-4 text-sm text-[var(--color-oxblood-300)]">{error}</p>
	{/if}
	{#if scanStatus}
		<p class="mt-3 font-mono text-xs text-[var(--color-parchment-500)]">{scanStatus}</p>
	{/if}

	<div class="mt-8 flex items-center gap-2 border-b border-[var(--color-ink-800)]">
		{#each [{ id: 'pending' as const, label: 'Pending', count: stored.filter((m) => m.status === 'pending').length }, { id: 'corrected' as const, label: 'Corrected', count: stored.filter((m) => m.status === 'corrected').length }, { id: 'all' as const, label: 'All', count: stored.length }] as tab (tab.id)}
			{@const active = filter === tab.id}
			<button
				type="button"
				class={cn(
					'eyebrow relative h-10 px-1 transition-colors hover:text-[var(--color-parchment-100)]',
					active && '!text-[var(--color-parchment-50)]'
				)}
				onclick={() => (filter = tab.id)}
			>
				{tab.label} <span class="text-[var(--color-parchment-500)]">({tab.count})</span>
				{#if active}
					<span class="absolute inset-x-0 -bottom-px h-[2px] bg-[var(--color-brass-300)]"></span>
				{/if}
			</button>
		{/each}
	</div>

	{#if grouped.length === 0}
		<p class="mt-6 font-serif text-sm text-[var(--color-parchment-400)] italic">
			{filter === 'pending'
				? 'Nothing pending. Great job — or time to scan.'
				: filter === 'corrected'
					? 'No corrected mistakes yet. Retrain a pending one.'
					: 'No mistakes stored yet.'}
		</p>
	{:else}
		{#each grouped as group (group.repertoireId)}
			<section class="mt-8">
				<div class="mb-3 flex items-baseline gap-3">
					<h2 class="truncate font-serif text-2xl">{group.name}</h2>
					<span class="eyebrow text-[var(--color-parchment-500)]">{group.items.length}</span>
					{#if filter !== 'corrected'}
						{@const pend = group.items.filter((m) => m.status === 'pending').length}
						{#if pend > 0}
							<div class="ml-auto">
								<Button
									href={`${base}/repertoire/${group.repertoireId}/drill?mode=retrain`}
									variant="primary"
									size="sm"
								>
									<RotateCcw class="size-3.5" />
									<span>Retrain ({pend})</span>
								</Button>
							</div>
						{/if}
					{/if}
				</div>
				<ul class="stagger">
					{#each group.items as m, i (m.id)}
						<li style:--i={i}>
							<div
								class="-mx-3 grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 rounded-[4px] border-b border-[var(--color-ink-800)] px-3 py-3"
							>
								<div class="eyebrow tabular-nums">{fmtDate(m.playedAt)}</div>
								<div class="min-w-0">
									<div class="truncate font-serif text-[1.2rem] leading-tight">
										<span class="font-mono text-[var(--color-oxblood-300)] not-italic"
											>{m.playedSan}</span
										>
										<span class="mx-1 font-mono text-[var(--color-parchment-500)] not-italic"
											>→</span
										>
										<span class="font-mono text-[var(--color-brass-300)] not-italic"
											>{m.expectedSan}</span
										>
									</div>
									<div
										class="mt-1 flex flex-wrap gap-x-2 font-mono text-[11px] text-[var(--color-parchment-500)]"
									>
										<span>vs {m.opponent}</span>
										<span class="text-[var(--color-ink-600)]">·</span>
										<span>{m.speed}</span>
										<span class="text-[var(--color-ink-600)]">·</span>
										<span>ply {m.plyOffTree + 1}</span>
										{#if m.status === 'corrected'}
											<span class="text-[var(--color-ink-600)]">·</span>
											<span class="text-[var(--color-olive-300)]">corrected ×{m.correctCount}</span>
										{/if}
									</div>
								</div>
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href={m.gameUrl}
									target="_blank"
									rel="noopener"
									title="Open the game on Lichess"
									class="flex size-8 items-center justify-center text-[var(--color-parchment-500)] transition-colors hover:text-[var(--color-brass-300)]"
								>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
									<ExternalLink class="size-3.5" />
								</a>
								<button
									type="button"
									onclick={() => onDismiss(m.id)}
									title="Dismiss — remove from this list"
									class="flex size-8 items-center justify-center text-[var(--color-parchment-500)] transition-colors hover:text-[var(--color-oxblood-300)]"
								>
									<Trash2 class="size-3.5" />
								</button>
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}
</div>
