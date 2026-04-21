<script lang="ts">
	import { onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { Pencil, Play, Plus } from 'lucide-svelte';

	import { listRepertoires } from '$lib/storage/repertoires';
	import { countDue, countCards } from '$lib/storage/cards';
	import { countDueIdeaCards } from '$lib/storage/ideaCards';
	import { listNodes } from '$lib/storage/nodes';
	import { Button, Badge, DashboardBacklink, EmptyState } from '$lib/ui';
	import type { Repertoire } from '$lib/types';

	let reps = $state<Repertoire[]>([]);
	let stats = $state<Record<string, { due: number; total: number; positions: number }>>({});
	let loaded = $state(false);

	onMount(async () => {
		reps = await listRepertoires();
		const s: typeof stats = {};
		for (const r of reps) {
			s[r.id] = {
				due: (await countDue(r.id)) + (await countDueIdeaCards(r.id)),
				total: await countCards(r.id),
				positions: (await listNodes(r.id)).length
			};
		}
		stats = s;
		loaded = true;
	});

	function relTime(ts: number): string {
		const diff = Date.now() - ts;
		const days = Math.floor(diff / 86_400_000);
		if (days === 0) return 'today';
		if (days === 1) return 'yesterday';
		if (days < 7) return `${days} days ago`;
		if (days < 30) return `${Math.floor(days / 7)}w ago`;
		return `${Math.floor(days / 30)}mo ago`;
	}
</script>

<div class="relative mx-auto max-w-3xl px-4 pt-10 pb-12 sm:px-6 sm:pt-14">
	<DashboardBacklink />

	<div class="stagger">
		<!--
			Header group: the title + intro sit on the left; the New-repertoire
			action sits in the top-right on sm+, aligned with the eyebrow row
			so there's no button floating alone below the prose.
			On phones the button drops to the end of the title block.
		-->
		<div class="flex items-start justify-between gap-4" style:--i="0">
			<div class="min-w-0 flex-1">
				<div class="eyebrow mb-3">
					Library · {reps.length}
					{reps.length === 1 ? 'repertoire' : 'repertoires'}
				</div>
				<h1 class="font-serif text-[2.5rem] leading-[1.05] tracking-tight sm:text-5xl">
					Your <em class="font-serif text-[var(--color-brass-300)]">openings</em>, shelved.
				</h1>
				<p class="mt-3 max-w-md text-[var(--color-parchment-400)]">
					Every repertoire you've built. Click one to dive in.
				</p>
			</div>
			<div class="shrink-0">
				<Button href="{base}/repertoire/new" size="md" variant="primary">
					<Plus class="size-3.5" />
					<span class="hidden sm:inline">New repertoire</span>
					<span class="sm:hidden">New</span>
				</Button>
			</div>
		</div>
	</div>

	<div class="paper-divider mt-10 mb-2 font-serif text-lg">
		<span class="ornament">⁂</span>
	</div>

	{#if !loaded}
		<p class="py-8 text-sm text-[var(--color-parchment-400)]">Loading your library…</p>
	{:else if reps.length === 0}
		<EmptyState
			class="mt-6"
			title="An empty shelf."
			description="No repertoires yet. Start a new one from scratch, import a PGN, or autobuild from a Lichess player or broadcast."
		>
			{#snippet actions()}
				<Button href="{base}/repertoire/new" variant="primary" size="sm">
					<Plus class="size-3.5" />
					<span>New repertoire</span>
				</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<ul class="stagger">
			{#each reps as rep, i (rep.id)}
				{@const due = stats[rep.id]?.due ?? 0}
				<li style:--i={i + 4}>
					<!--
						Row uses the stretched-link pattern: the title <a>
						expands via ::after to cover the whole card, so the
						entire row navigates to the repertoire overview —
						but the quick-action buttons on the right sit on a
						higher stacking layer (relative z-10) so they
						intercept clicks for Drill / Edit directly,
						bypassing the overview.
					-->
					<div
						class="group relative -mx-3 grid grid-cols-[1fr_auto] items-center gap-4 rounded-[4px] border-b border-[var(--color-ink-800)] px-3 py-5 transition-colors hover:bg-[var(--color-ink-900)]/60"
					>
						<div class="min-w-0">
							<div class="mb-1.5 flex flex-wrap items-center gap-2">
								<h2
									class="truncate font-serif text-2xl leading-none text-[var(--color-parchment-50)] transition-colors group-hover:text-[var(--color-brass-300)] md:text-[1.75rem]"
								>
									<a
										href={resolve(`/repertoire/${rep.id}`)}
										class="after:absolute after:inset-0 after:content-['']"
									>
										{rep.name}
									</a>
								</h2>
								{#if due > 0}
									<Badge variant="brass">{due} due</Badge>
								{/if}
							</div>
							<div
								class="flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[11.5px] tracking-wider text-[var(--color-parchment-400)] uppercase"
							>
								<span>{rep.color}</span>
								<span class="text-[var(--color-ink-600)]">·</span>
								<span>{stats[rep.id]?.positions ?? 0} positions</span>
								<span class="text-[var(--color-ink-600)]">·</span>
								<span>{stats[rep.id]?.total ?? 0} cards</span>
								<span class="text-[var(--color-ink-600)]">·</span>
								<span>updated {relTime(rep.updatedAt)}</span>
							</div>
						</div>

						<!--
							Quick actions, margin-note style. Serif italic
							labels with a hairline divider read like pencilled
							annotations in a chess book rather than two
							floating button boxes. Drill reads brass when
							due (matching the hero tile on the overview),
							both pick up brass on hover. `relative z-10`
							keeps them above the stretched title link so
							clicks land on the quick action, not the row.
						-->
						<div
							class="relative z-10 flex shrink-0 items-center gap-3.5 font-serif text-[15px] italic"
						>
							<a
								href={resolve(`/repertoire/${rep.id}/drill`)}
								title={due > 0
									? `Drill — ${due} card${due === 1 ? '' : 's'} due`
									: 'Drill this repertoire'}
								aria-label="Drill {rep.name}"
								class={due > 0
									? 'inline-flex items-center gap-1.5 text-[var(--color-brass-300)] transition-colors hover:text-[var(--color-brass-200)]'
									: 'inline-flex items-center gap-1.5 text-[var(--color-parchment-300)] transition-colors hover:text-[var(--color-brass-300)]'}
							>
								<Play
									class={due > 0 ? 'size-3 fill-[var(--color-brass-300)]' : 'size-3'}
									strokeWidth={1.75}
								/>
								<span>Drill</span>
							</a>
							<span aria-hidden="true" class="h-3.5 w-px bg-[var(--color-ink-700)]"></span>
							<a
								href={resolve(`/repertoire/${rep.id}/edit`)}
								title="Edit tree"
								aria-label="Edit {rep.name}"
								class="inline-flex items-center gap-1.5 text-[var(--color-parchment-300)] transition-colors hover:text-[var(--color-parchment-50)]"
							>
								<Pencil class="size-3" strokeWidth={1.75} />
								<span>Edit</span>
							</a>
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
