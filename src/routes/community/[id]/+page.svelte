<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Download, Flag, Lightbulb } from 'lucide-svelte';
	import MiniBoard from '$lib/chess/MiniBoard.svelte';
	import MoveTree from '$lib/tree/MoveTree.svelte';
	import { buildTreeRows } from '$lib/tree/treeView';
	import { Button, DashboardBacklink } from '$lib/ui';
	import { getSettings } from '$lib/storage/settings';
	import { listRepertoires } from '$lib/storage/repertoires';
	import { CommunityClient, CommunityError, type MeResponse } from '$lib/community/client';
	import { importCommunityPublication, toRepertoireNodes } from '$lib/community/importTree';
	import type { PublicationDetail } from '$lib/community/types';
	import type { Repertoire, RepertoireNode } from '$lib/types';

	const id = $derived(page.params.id ?? '');

	let client = $state<CommunityClient | null>(null);
	let pub = $state<PublicationDetail | null>(null);
	let error = $state<string | null>(null);
	let me = $state<MeResponse | null>(null);
	let existingCopy = $state<Repertoire | null>(null);
	let importing = $state(false);
	let currentFenKey = $state('');
	const collapsed = new SvelteSet<string>();
	let reportOpen = $state(false);
	let reportReason = $state<'spam' | 'offensive' | 'other'>('spam');
	let reportNote = $state('');
	let reportStatus = $state<string | null>(null);

	const nodes = $derived(
		pub
			? new Map<string, RepertoireNode>(toRepertoireNodes(pub.tree, 0).map((n) => [n.fenKey, n]))
			: new Map<string, RepertoireNode>()
	);
	const rows = $derived(pub ? buildTreeRows(nodes, pub.rootFenKey, { collapsed }) : []);
	const current = $derived(nodes.get(currentFenKey));
	const currentIdea = $derived(pub?.tree.ideaCards.find((c) => c.fenKey === currentFenKey) ?? null);
	const isOwner = $derived(!!me && !!pub && me.publications.some((p) => p.id === pub!.id));

	onMount(async () => {
		const settings = await getSettings();
		client = CommunityClient.fromSettings(settings);
		if (!client) {
			error = 'Community openings need the hosted COBRA server, and this build has none set.';
			return;
		}
		try {
			pub = await client.get(id);
			currentFenKey = pub.rootFenKey;
		} catch (e) {
			error =
				e instanceof CommunityError && e.status === 404
					? 'This opening is no longer published.'
					: e instanceof Error
						? e.message
						: 'Could not load this opening.';
			return;
		}
		const reps = await listRepertoires();
		existingCopy = reps.find((r) => r.communitySource?.publicationId === id) ?? null;
		if (client.canSignIn) {
			try {
				me = await client.me();
			} catch {
				me = null;
			}
		}
	});

	async function onImport() {
		if (!pub || !client) return;
		importing = true;
		try {
			const rep = await importCommunityPublication(pub);
			// Best effort: the import count is a popularity signal, not a requirement.
			void client.countImport(pub.id).catch(() => {});
			await goto(resolve(`/repertoire/${rep.id}`));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed.';
			importing = false;
		}
	}

	async function onReport() {
		if (!client || !pub) return;
		try {
			const res = await client.report(pub.id, reportReason, reportNote);
			reportStatus = res.hidden
				? 'Thanks. It is now hidden until a moderator reviews it.'
				: 'Thanks, a moderator will take a look.';
			reportOpen = false;
		} catch (e) {
			reportStatus = e instanceof Error ? e.message : 'Report failed.';
		}
	}

	async function moderate(status: 'active' | 'hidden' | 'removed') {
		if (!client || !pub) return;
		await client.adminSetStatus(pub.id, status);
		pub = { ...pub, status };
	}

	function toggleCollapse(fenKey: string) {
		if (collapsed.has(fenKey)) collapsed.delete(fenKey);
		else collapsed.add(fenKey);
	}

	function fmtDate(ms: number): string {
		return new Date(ms).toLocaleDateString();
	}
</script>

<svelte:head><title>{pub ? `${pub.title} · Community` : 'Community'} · COBRA</title></svelte:head>

<div class="relative mx-auto max-w-6xl px-4 py-8">
	<DashboardBacklink href={resolve('/community')} label="Community" />

	{#if error}
		<p class="mt-8 text-sm text-amber-300" data-testid="community-detail-error">{error}</p>
	{:else if !pub}
		<p class="mt-8 text-sm text-[var(--color-parchment-500)]">Loading…</p>
	{:else}
		<div class="mt-4 flex flex-wrap items-start justify-between gap-4">
			<div class="min-w-0">
				<h1
					class="font-serif text-3xl text-[var(--color-parchment-50)]"
					data-testid="community-title"
				>
					{pub.title}
				</h1>
				<p class="mt-1 text-sm text-[var(--color-parchment-400)]">
					{pub.color === 'white' ? 'White' : 'Black'} repertoire by
					<span data-testid="community-author">{pub.author ?? 'anonymous'}</span>
					· version {pub.version} · updated {fmtDate(pub.updatedAt)}
					· {pub.positionCount} positions · {pub.importCount} imports
				</p>
				{#if pub.status !== 'active'}
					<p class="mt-1 text-xs text-amber-300">Hidden from the community ({pub.status}).</p>
				{/if}
				{#if pub.forkedFrom}
					<p class="mt-1 text-xs text-[var(--color-parchment-500)]">
						Based on <a class="underline" href={resolve(`/community/${pub.forkedFrom}`)}
							>another publication</a
						>.
					</p>
				{/if}
			</div>
			<div class="flex flex-col items-end gap-2">
				<Button onclick={onImport} disabled={importing} data-testid="community-import">
					<Download class="size-4" />
					{importing ? 'Importing…' : 'Import a copy'}
				</Button>
				{#if existingCopy}
					<a
						class="text-xs text-[var(--color-parchment-400)] underline"
						href={resolve(`/repertoire/${existingCopy.id}`)}
					>
						You already have a copy: {existingCopy.name}
					</a>
				{/if}
			</div>
		</div>

		{#if pub.description}
			<p class="mt-4 max-w-3xl text-sm whitespace-pre-line text-[var(--color-parchment-200)]">
				{pub.description}
			</p>
		{/if}
		{#if pub.tags.length || pub.openings.length}
			<div class="mt-3 flex flex-wrap gap-1.5 text-[11px]">
				{#each pub.tags as t (t)}
					<span
						class="rounded bg-[var(--color-ink-800)] px-1.5 py-0.5 text-[var(--color-parchment-300)]"
						>#{t}</span
					>
				{/each}
				{#each pub.openings.slice(0, 8) as [eco, name] (eco + name)}
					<span
						class="rounded border border-[var(--color-ink-700)] px-1.5 py-0.5 text-[var(--color-parchment-400)]"
					>
						{eco}
						{name}
					</span>
				{/each}
			</div>
		{/if}

		<div class="mt-6 grid gap-6 lg:grid-cols-[auto_1fr]">
			<div class="space-y-3">
				<MiniBoard fen={currentFenKey} orientation={pub.color} size={320} />
				{#if current?.comment}
					<p
						class="max-w-[320px] text-sm text-[var(--color-parchment-200)]"
						data-testid="community-comment"
					>
						{current.comment}
					</p>
				{/if}
				{#if currentIdea}
					<div class="max-w-[320px] rounded border border-[var(--color-ink-700)] p-2 text-sm">
						<div class="flex items-center gap-1.5 text-xs text-[var(--color-brass-300)]">
							<Lightbulb class="size-3.5" /> Idea
						</div>
						<p class="mt-1 text-[var(--color-parchment-100)]">{currentIdea.prompt}</p>
						{#if currentIdea.answer}
							<p class="mt-1 text-[var(--color-parchment-400)]">{currentIdea.answer}</p>
						{/if}
					</div>
				{/if}
			</div>
			<div class="ink-panel min-w-0 p-3" data-testid="community-tree">
				<MoveTree
					{rows}
					{currentFenKey}
					rootWhiteToMove={pub.rootFenKey.split(' ')[1] === 'w'}
					heightClass="max-h-[min(560px,70vh)]"
					onJump={(fenKey) => (currentFenKey = fenKey)}
					onToggleCollapse={toggleCollapse}
				/>
			</div>
		</div>

		<div
			class="mt-8 flex flex-wrap items-center gap-3 border-t border-[var(--color-ink-800)] pt-4 text-xs"
		>
			{#if !isOwner && client?.canSignIn}
				<button
					type="button"
					class="inline-flex items-center gap-1 text-[var(--color-parchment-500)] hover:text-[var(--color-parchment-200)]"
					onclick={() => (reportOpen = !reportOpen)}
					data-testid="community-report"
				>
					<Flag class="size-3.5" /> Report
				</button>
			{/if}
			{#if reportStatus}
				<span class="text-[var(--color-parchment-400)]">{reportStatus}</span>
			{/if}
			{#if me?.isAdmin}
				<span class="ml-auto flex gap-1">
					<Button size="xs" variant="outline" onclick={() => moderate('active')}>Restore</Button>
					<Button size="xs" variant="outline" onclick={() => moderate('hidden')}>Hide</Button>
					<Button size="xs" variant="destructive" onclick={() => moderate('removed')}>Remove</Button
					>
				</span>
			{/if}
		</div>
		{#if reportOpen}
			<div class="mt-3 flex max-w-xl flex-wrap items-center gap-2 text-sm">
				<select
					bind:value={reportReason}
					class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1.5"
					aria-label="Reason"
				>
					<option value="spam">Spam</option>
					<option value="offensive">Offensive</option>
					<option value="other">Other</option>
				</select>
				<input
					bind:value={reportNote}
					maxlength={500}
					placeholder="Optional note"
					class="min-w-40 flex-1 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1.5"
				/>
				<Button size="sm" variant="outline" onclick={onReport}>Send report</Button>
			</div>
		{/if}
	{/if}
</div>
