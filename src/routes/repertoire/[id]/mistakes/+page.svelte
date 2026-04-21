<script lang="ts">
	import { onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		AlertTriangle,
		ArrowLeft,
		ExternalLink,
		Pencil,
		Play,
		RotateCcw,
		Trash2
	} from 'lucide-svelte';

	import { getRepertoire } from '$lib/storage/repertoires';
	import { listMistakes, dismissMistake } from '$lib/storage/mistakes';
	import { Button, cn } from '$lib/ui';
	import type { Repertoire, StoredMistake } from '$lib/types';

	type Filter = 'pending' | 'corrected' | 'dismissed' | 'all';

	let rep = $state<Repertoire | null>(null);
	let all = $state<StoredMistake[]>([]);
	let filter = $state<Filter>('pending');
	let loading = $state(true);

	onMount(async () => {
		const id = page.params.id;
		if (!id) {
			loading = false;
			return;
		}
		rep = (await getRepertoire(id)) ?? null;
		if (!rep) {
			loading = false;
			return;
		}
		all = await listMistakes({ repertoireId: rep.id });
		loading = false;
	});

	const counts = $derived.by(() => ({
		pending: all.filter((m) => m.status === 'pending').length,
		corrected: all.filter((m) => m.status === 'corrected').length,
		dismissed: all.filter((m) => m.status === 'dismissed').length,
		all: all.length
	}));

	const rows = $derived(filter === 'all' ? all : all.filter((m) => m.status === filter));

	async function onDismiss(m: StoredMistake) {
		await dismissMistake(m.id);
		all = all.map((x) => (x.id === m.id ? { ...x, status: 'dismissed' } : x));
	}

	async function onRestore(m: StoredMistake) {
		const { getDB } = await import('$lib/storage/db');
		const db = await getDB();
		const row = await db.get('mistakes', m.id);
		if (!row) return;
		row.status = 'pending';
		await db.put('mistakes', row);
		all = all.map((x) => (x.id === m.id ? { ...x, status: 'pending' } : x));
	}

	function formatAgo(ms: number): string {
		const diff = Date.now() - ms;
		if (diff < 60_000) return 'just now';
		const min = Math.floor(diff / 60_000);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const d = Math.floor(hr / 24);
		if (d < 30) return `${d}d ago`;
		return new Date(ms).toLocaleDateString();
	}

	function statusTone(s: StoredMistake['status']): string {
		switch (s) {
			case 'pending':
				return 'text-[var(--color-oxblood-300)]';
			case 'corrected':
				return 'text-[var(--color-olive-300)]';
			case 'dismissed':
				return 'text-[var(--color-parchment-500)]';
		}
	}

	function statusLabel(s: StoredMistake['status']): string {
		switch (s) {
			case 'pending':
				return 'Pending';
			case 'corrected':
				return 'Corrected';
			case 'dismissed':
				return 'Dismissed';
		}
	}
</script>

{#if loading}
	<div class="mx-auto max-w-4xl px-6 pt-16">
		<p class="text-sm text-[var(--color-parchment-400)]">Loading…</p>
	</div>
{:else if !rep}
	<div class="mx-auto max-w-4xl px-6 pt-16">
		<p class="text-[var(--color-oxblood-300)]">Repertoire not found.</p>
		<a href={resolve('/')} class="text-[var(--color-brass-300)] underline underline-offset-4"
			>Back to library</a
		>
	</div>
{:else}
	<div class="stagger mx-auto max-w-4xl px-6 pt-12 pb-16">
		<a
			href={resolve(`/repertoire/${rep.id}`)}
			class="eyebrow mb-5 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
			style:--i="0"
		>
			<ArrowLeft class="size-3" />
			<span>Back to {rep.name}</span>
		</a>

		<div class="mb-8 flex items-end justify-between gap-4" style:--i="1">
			<div>
				<div class="eyebrow mb-2 flex items-center gap-2">
					<AlertTriangle class="size-3 text-[var(--color-oxblood-300)]" />
					<span>Mistakes</span>
				</div>
				<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
					Where your games <em class="text-[var(--color-oxblood-300)]">left prep</em>.
				</h1>
				<p class="mt-3 max-w-md text-sm text-[var(--color-parchment-400)]">
					Detected from scanned Lichess + chess.com games. Drill to retrain, or add a correction to
					the tree so this line stops biting.
				</p>
			</div>
			{#if counts.pending > 0}
				<Button
					href={`${base}/repertoire/${rep.id}/drill?mode=mistakes`}
					variant="primary"
					size="lg"
				>
					<Play class="size-4" />
					<span>Drill all {counts.pending}</span>
				</Button>
			{/if}
		</div>

		<!-- Filter chips. 'all' hidden when zero. -->
		<div class="mb-6 flex flex-wrap items-center gap-2" style:--i="2">
			{#each ['pending', 'corrected', 'dismissed', 'all'] as f (f)}
				{@const c = counts[f as Filter]}
				<button
					type="button"
					onclick={() => (filter = f as Filter)}
					class={cn(
						'rounded-[3px] border px-3 py-1 font-mono text-[11px] tracking-wider uppercase transition-colors',
						filter === f
							? 'border-[var(--color-brass-300)] bg-[var(--color-brass-500)]/15 text-[var(--color-brass-200)]'
							: 'border-[var(--color-ink-700)] text-[var(--color-parchment-400)] hover:border-[var(--color-ink-600)] hover:text-[var(--color-parchment-200)]'
					)}
				>
					{f}
					<span class="ml-1.5 font-mono text-[var(--color-parchment-500)] tabular-nums">{c}</span>
				</button>
			{/each}
		</div>

		{#if rows.length === 0}
			<div class="ink-panel p-10 text-center" style:--i="3">
				<p class="font-serif text-lg text-[var(--color-parchment-300)] italic">
					{#if filter === 'pending' && counts.all > 0}
						Nothing pending. Every detected mistake has been corrected or dismissed.
					{:else if counts.all === 0}
						No mistakes recorded yet. Scan your games from the library to detect deviations.
					{:else}
						No mistakes in this filter.
					{/if}
				</p>
			</div>
		{:else}
			<ul class="space-y-2" style:--i="3">
				{#each rows as m (m.id)}
					<li class="ink-panel grid grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3">
						<!-- Played → expected, SAN pair with an arrow. -->
						<div class="flex flex-col gap-0.5 font-mono text-sm tabular-nums">
							<span
								class="text-[var(--color-oxblood-300)] line-through"
								title="The move you played"
							>
								{m.playedSan}
							</span>
							<span class="text-[var(--color-olive-300)]" title="What your tree says">
								→ {m.expectedSan}
							</span>
						</div>

						<!-- Context: opponent · when · status. -->
						<div class="flex min-w-0 flex-col gap-0.5">
							<span
								class="truncate font-mono text-[12px] text-[var(--color-parchment-200)]"
								title={`vs ${m.opponent}`}
							>
								vs {m.opponent} · <span class="capitalize">{m.color}</span> · {m.speed}
							</span>
							<span
								class="flex items-center gap-2 font-serif text-[11px] text-[var(--color-parchment-500)] italic"
							>
								<span>{formatAgo(m.playedAt)}</span>
								<span class="text-[var(--color-ink-600)]">·</span>
								<span class={statusTone(m.status)}>{statusLabel(m.status)}</span>
								{#if m.correctCount > 0}
									<span class="text-[var(--color-ink-600)]">·</span>
									<span class="font-mono tabular-nums">drilled {m.correctCount}×</span>
								{/if}
								{#if m.plyOffTree >= 0}
									<span class="text-[var(--color-ink-600)]">·</span>
									<span class="font-mono tabular-nums">ply {m.plyOffTree}</span>
								{/if}
							</span>
						</div>

						<!-- Per-row actions. -->
						<div class="flex items-center gap-1">
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={m.gameUrl}
								target="_blank"
								rel="noopener noreferrer"
								title="Open game on Lichess"
								class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-500)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-200)]"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<ExternalLink class="size-3.5" />
							</a>
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={`${base}/repertoire/${rep.id}/edit?jump=${encodeURIComponent(m.fenKey)}`}
								title="Open the editor at this position — fix it in the tree."
								class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-brass-300)]"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<Pencil class="size-3.5" />
							</a>
							{#if m.status === 'pending'}
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href={`${base}/repertoire/${rep.id}/drill?mode=mistakes&focus=${encodeURIComponent(m.fenKey)}`}
									title="Drill just this mistake."
									class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-brass-500)]/15 hover:text-[var(--color-brass-300)]"
								>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
									<Play class="size-3.5" />
								</a>
								<button
									type="button"
									onclick={() => onDismiss(m)}
									title="Dismiss — remove from the pending list without drilling."
									class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-500)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-oxblood-300)]"
								>
									<Trash2 class="size-3.5" />
								</button>
							{:else}
								<button
									type="button"
									onclick={() => onRestore(m)}
									title="Move back to pending."
									class="flex size-8 items-center justify-center rounded-[3px] text-[var(--color-parchment-500)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-200)]"
								>
									<RotateCcw class="size-3.5" />
								</button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
