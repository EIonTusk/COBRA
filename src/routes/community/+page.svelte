<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { Search, Users } from 'lucide-svelte';
	import MiniBoard from '$lib/chess/MiniBoard.svelte';
	import { Button, DashboardBacklink } from '$lib/ui';
	import { getSettings } from '$lib/storage/settings';
	import { CommunityClient, type AdminReportItem, type MeResponse } from '$lib/community/client';
	import type { PublicationSummary } from '$lib/community/types';

	let client = $state<CommunityClient | null>(null);
	let unavailable = $state(false);
	let q = $state('');
	let color = $state<'' | 'white' | 'black'>('');
	let sort = $state<'popular' | 'new'>('popular');
	let items = $state<PublicationSummary[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let me = $state<MeResponse | null>(null);
	let reports = $state<AdminReportItem[]>([]);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(async () => {
		const settings = await getSettings();
		client = CommunityClient.fromSettings(settings);
		if (!client) {
			unavailable = true;
			return;
		}
		void load(true);
		if (client.canSignIn) {
			try {
				me = await client.me();
				if (me.isAdmin) reports = (await client.adminReports()).items;
			} catch {
				me = null;
			}
		}
	});

	async function load(reset: boolean) {
		if (!client) return;
		loading = true;
		error = null;
		try {
			const res = await client.list({ q, color, sort, cursor: reset ? null : cursor });
			items = reset ? res.publications : [...items, ...res.publications];
			cursor = res.cursor;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load community openings.';
		} finally {
			loading = false;
		}
	}

	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => void load(true), 300);
	}

	function openingLine(p: PublicationSummary): string {
		return p.openings
			.slice(0, 2)
			.map(([, name]) => name)
			.join(' · ');
	}

	async function moderate(id: string, status: 'active' | 'hidden' | 'removed') {
		if (!client) return;
		await client.adminSetStatus(id, status);
		reports = (await client.adminReports()).items;
		void load(true);
	}
</script>

<svelte:head><title>Community · COBRA</title></svelte:head>

<div class="relative mx-auto max-w-6xl px-4 py-8">
	<DashboardBacklink />
	<div class="mt-4 flex items-center gap-3">
		<Users class="size-6 text-[var(--color-brass-300)]" />
		<h1 class="font-serif text-3xl text-[var(--color-parchment-50)]">Community openings</h1>
	</div>
	<p class="mt-2 max-w-2xl text-sm text-[var(--color-parchment-400)]">
		Repertoires other players have published. Preview any of them and import a copy to train. To
		share your own, open a repertoire and choose <i>Publish to community</i> from its settings menu.
	</p>

	{#if unavailable}
		<p class="mt-8 text-sm text-amber-300" data-testid="community-unavailable">
			Community openings need the hosted COBRA server, and this build has none set. You can set a
			Cloudflare sync URL in <a class="underline" href={resolve('/settings')}>Settings</a>.
		</p>
	{:else}
		<div class="mt-6 flex flex-wrap items-center gap-2">
			<div class="relative min-w-60 flex-1">
				<Search class="absolute top-2.5 left-2.5 size-4 text-[var(--color-parchment-500)]" />
				<input
					type="search"
					bind:value={q}
					oninput={onSearchInput}
					placeholder="Search openings, e.g. Najdorf, Caro-Kann, B90"
					class="w-full rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] py-2 pr-2 pl-8 text-sm text-[var(--color-parchment-100)] focus:border-[var(--color-brass-300)]/60 focus:outline-none"
					data-testid="community-search"
				/>
			</div>
			<select
				bind:value={color}
				onchange={() => load(true)}
				class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-2 text-sm text-[var(--color-parchment-100)]"
				aria-label="Colour"
			>
				<option value="">Both colours</option>
				<option value="white">White</option>
				<option value="black">Black</option>
			</select>
			<select
				bind:value={sort}
				onchange={() => load(true)}
				class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-2 text-sm text-[var(--color-parchment-100)]"
				aria-label="Sort"
			>
				<option value="popular">Most imported</option>
				<option value="new">Newest</option>
			</select>
		</div>

		{#if error}
			<p class="mt-6 text-sm text-red-400">{error}</p>
		{/if}

		{#if me && me.publications.length > 0}
			<section class="mt-8">
				<h2 class="text-[11px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
					Your publications
				</h2>
				<ul class="mt-2 space-y-1 text-sm">
					{#each me.publications as p (p.id)}
						<li>
							<a
								class="text-[var(--color-parchment-100)] underline-offset-2 hover:underline"
								href={resolve(`/community/${p.id}`)}
							>
								{p.title}
							</a>
							<span class="text-xs text-[var(--color-parchment-500)]">
								v{p.version} · {p.visibility} · {p.importCount} imports{p.status === 'hidden'
									? ' · hidden by moderation'
									: ''}
							</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if me?.isAdmin && reports.length > 0}
			<section
				class="mt-8 rounded border border-amber-700/40 p-4"
				data-testid="community-moderation"
			>
				<h2 class="text-[11px] tracking-[0.2em] text-amber-300 uppercase">Moderation</h2>
				<ul class="mt-3 space-y-3 text-sm">
					{#each reports as r (r.publication.id)}
						<li class="flex flex-wrap items-start justify-between gap-2">
							<div>
								<a class="underline" href={resolve(`/community/${r.publication.id}`)}
									>{r.publication.title}</a
								>
								<span class="text-xs text-[var(--color-parchment-500)]">
									by {r.publication.author ?? 'unknown'} · {r.publication.status} · {r.openReports} open
									reports
								</span>
								<ul class="mt-1 text-xs text-[var(--color-parchment-400)]">
									{#each r.reports as rep, i (i)}
										<li>{rep.reason}{rep.note ? `: ${rep.note}` : ''}</li>
									{/each}
								</ul>
							</div>
							<div class="flex gap-1">
								<Button
									size="xs"
									variant="outline"
									onclick={() => moderate(r.publication.id, 'active')}
								>
									Keep
								</Button>
								<Button
									size="xs"
									variant="outline"
									onclick={() => moderate(r.publication.id, 'hidden')}
								>
									Hide
								</Button>
								<Button
									size="xs"
									variant="destructive"
									onclick={() => moderate(r.publication.id, 'removed')}
								>
									Remove
								</Button>
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<div class="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="community-results">
			{#each items as p (p.id)}
				<a
					href={resolve(`/community/${p.id}`)}
					class="ink-panel flex gap-3 p-3 transition-colors hover:border-[var(--color-brass-300)]/40"
					data-testid="community-card"
				>
					<MiniBoard fen={p.rootFenKey} orientation={p.color} size={88} />
					<div class="min-w-0 flex-1">
						<div class="truncate font-serif text-[15px] text-[var(--color-parchment-50)]">
							{p.title}
						</div>
						<div class="text-xs text-[var(--color-parchment-500)]">
							{p.color === 'white' ? 'White' : 'Black'} · {p.author ?? 'anonymous'}
						</div>
						{#if openingLine(p)}
							<div class="mt-1 truncate text-xs text-[var(--color-parchment-300)]">
								{openingLine(p)}
							</div>
						{/if}
						<div class="mt-1 text-[11px] text-[var(--color-parchment-500)] tabular-nums">
							{p.positionCount} positions · {p.importCount} imports
						</div>
					</div>
				</a>
			{/each}
		</div>

		{#if !loading && items.length === 0 && !error}
			<p class="mt-8 text-sm text-[var(--color-parchment-500)]" data-testid="community-empty">
				{q ? 'No community openings match that search.' : 'Nobody has published an opening yet.'}
			</p>
		{/if}

		{#if cursor}
			<div class="mt-6">
				<Button variant="outline" disabled={loading} onclick={() => load(false)}>Load more</Button>
			</div>
		{/if}
	{/if}
</div>
