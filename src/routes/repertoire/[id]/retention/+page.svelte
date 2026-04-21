<script lang="ts">
	import { onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ArrowLeft, AlertTriangle, Sparkles, Flame, BookOpen } from 'lucide-svelte';

	import { getRepertoire } from '$lib/storage/repertoires';
	import { listCards } from '$lib/storage/cards';
	import { nodesMap } from '$lib/storage/nodes';
	import { pathToFenKey } from '$lib/tree/traversal';
	import { Button, Badge, cn } from '$lib/ui';
	import type { Card, Repertoire } from '$lib/types';

	type Tier = 'struggling' | 'learning' | 'review' | 'mastered';

	interface Row {
		card: Card;
		stabilityDays: number;
		lapses: number;
		state: number;
		tier: Tier;
		lineSans: string[];
	}

	let rep = $state<Repertoire | null>(null);
	let rows = $state<Row[]>([]);
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
		const cards = await listCards(rep.id);
		const nodes = await nodesMap(rep.id);
		const built: Row[] = cards.map((card) => {
			const stabilityDays = cardStabilityDays(card);
			const lapses = card.fsrs.lapses ?? 0;
			const state = card.fsrs.state;
			const tier = classify(stabilityDays, lapses, state);
			const line = pathToFenKey(nodes, rep!.rootFenKey, card.fenKey);
			const lineSans = line ? line.map((e) => e.san) : [];
			return { card, stabilityDays, lapses, state, tier, lineSans };
		});
		built.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.stabilityDays - b.stabilityDays);
		rows = built;
		loading = false;
	});

	function cardStabilityDays(card: Card): number {
		const s = card.fsrs.stability;
		return typeof s === 'number' ? s : 0;
	}

	function classify(days: number, lapses: number, state: number): Tier {
		if (lapses >= 3) return 'struggling';
		if (state === 1 || state === 3 || days < 14) return 'learning';
		if (days < 60 || lapses > 0) return 'review';
		return 'mastered';
	}

	function tierRank(t: Tier): number {
		switch (t) {
			case 'struggling':
				return 0;
			case 'learning':
				return 1;
			case 'review':
				return 2;
			case 'mastered':
				return 3;
		}
	}

	function tierColor(t: Tier): string {
		switch (t) {
			case 'struggling':
				return 'var(--color-oxblood-300)';
			case 'learning':
				return 'var(--color-copper-300)';
			case 'review':
				return 'var(--color-brass-300)';
			case 'mastered':
				return 'var(--color-olive-300)';
		}
	}

	function tierLabel(t: Tier): string {
		switch (t) {
			case 'struggling':
				return 'Struggling';
			case 'learning':
				return 'Learning';
			case 'review':
				return 'Review';
			case 'mastered':
				return 'Mastered';
		}
	}

	function formatDays(d: number): string {
		if (d < 1) return `${Math.max(0.1, d).toFixed(1)} d`;
		if (d < 14) return `${Math.round(d)} d`;
		if (d < 60) return `${Math.round(d)} d`;
		if (d < 365) return `${Math.round(d / 30)} mo`;
		return `${Math.round(d / 365)} y`;
	}

	function moveNumberPrefix(i: number): string | null {
		return i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : null;
	}

	const totals = $derived.by(() => {
		const c = { struggling: 0, learning: 0, review: 0, mastered: 0 };
		for (const r of rows) c[r.tier] += 1;
		return c;
	});
</script>

<div class="mx-auto max-w-3xl px-6 pt-12 pb-16">
	{#if loading}
		<p class="text-[var(--color-parchment-400)]">Loading…</p>
	{:else if !rep}
		<p class="text-[var(--color-oxblood-300)]">Not found.</p>
	{:else}
		<a
			href={resolve(`/repertoire/${rep.id}`)}
			class="eyebrow mb-5 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
		>
			<ArrowLeft class="size-3" />
			<span class="max-w-[240px] truncate">{rep.name}</span>
		</a>

		<div class="eyebrow mb-3">Retention</div>
		<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
			How well you <em class="text-[var(--color-brass-300)]">remember it</em>.
		</h1>
		<p class="mt-3 max-w-md text-[var(--color-parchment-400)]">
			Every card you've built, scored by FSRS stability. Weakest first — so the lines slipping out
			of memory rise to the top.
		</p>

		<!--
			Summary tiles. 2x2 on phones, 4-up from sm. Each tile has a
			tier-coloured vertical accent bar on the left, a big tabular
			number on the right, and the label + icon under the number.
			Much more legible than the old plain four-column row.
		-->
		<div class="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-4">
			{#each [{ tier: 'struggling' as Tier, icon: AlertTriangle, label: 'Struggling', count: totals.struggling }, { tier: 'learning' as Tier, icon: Flame, label: 'Learning', count: totals.learning }, { tier: 'review' as Tier, icon: BookOpen, label: 'Review', count: totals.review }, { tier: 'mastered' as Tier, icon: Sparkles, label: 'Mastered', count: totals.mastered }] as t (t.tier)}
				{@const Icon = t.icon}
				<div class="ink-panel relative overflow-hidden p-4" style:--accent={tierColor(t.tier)}>
					<!-- Tier-coloured left edge -->
					<span
						class="absolute inset-y-0 left-0 w-1"
						style:background-color="var(--accent)"
						aria-hidden="true"
					></span>
					<div class="pl-2">
						<div
							class="font-serif text-[2.25rem] leading-none tabular-nums"
							style:color={t.count > 0 ? 'var(--accent)' : 'var(--color-parchment-500)'}
						>
							{t.count}
						</div>
						<div
							class="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] tracking-wider uppercase"
							style:color="var(--accent)"
						>
							<Icon class="size-3" />
							<span>{t.label}</span>
						</div>
					</div>
				</div>
			{/each}
		</div>

		<!-- Heat strip: stacked segments showing the distribution -->
		{#if rows.length > 0}
			<div
				class="mt-5 flex h-1.5 overflow-hidden rounded-full bg-[var(--color-ink-800)]"
				title="Distribution across tiers"
			>
				<span
					class="bg-[var(--color-oxblood-300)]"
					style:width="{(totals.struggling / rows.length) * 100}%"
				></span>
				<span
					class="bg-[var(--color-copper-300)]"
					style:width="{(totals.learning / rows.length) * 100}%"
				></span>
				<span
					class="bg-[var(--color-brass-300)]"
					style:width="{(totals.review / rows.length) * 100}%"
				></span>
				<span
					class="bg-[var(--color-olive-300)]"
					style:width="{(totals.mastered / rows.length) * 100}%"
				></span>
			</div>
		{/if}

		{#if rows.length === 0}
			<p class="mt-10 font-serif text-sm text-[var(--color-parchment-400)] italic">
				No cards yet. Build some lines and come back after a drill session.
			</p>
		{:else}
			<ul class="stagger mt-8">
				{#each rows as r, i (r.card.fenKey)}
					<li style:--i={i}>
						<a
							href={resolve(`/repertoire/${rep.id}/edit#${encodeURIComponent(r.card.fenKey)}`)}
							class="group -mx-3 grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-[4px] border-b border-[var(--color-ink-800)] px-3 py-4 hover:bg-[var(--color-ink-900)]/60"
						>
							<span
								class={cn(
									'inline-flex size-2.5 flex-shrink-0 items-center justify-center rounded-full'
								)}
								style:background-color={tierColor(r.tier)}
								aria-hidden="true"
							></span>
							<div class="min-w-0">
								{#if r.lineSans.length > 0}
									<div
										class="flex flex-wrap gap-x-1.5 gap-y-0 truncate font-mono text-[13px] leading-6"
									>
										{#each r.lineSans as san, j (j)}
											{@const prefix = moveNumberPrefix(j)}
											{#if prefix}
												<span class="text-[var(--color-parchment-500)]">{prefix}</span>
											{/if}
											<span
												class:text-[var(--color-brass-300)]={j === r.lineSans.length - 1}
												class:text-[var(--color-parchment-200)]={j < r.lineSans.length - 1}
												>{san}</span
											>
										{/each}
									</div>
								{:else}
									<div class="font-mono text-[13px] text-[var(--color-parchment-500)]">
										Starting position
									</div>
								{/if}
								<div
									class="mt-1 flex gap-2 font-mono text-[11px] tracking-wider text-[var(--color-parchment-500)] uppercase"
								>
									<span style:color={tierColor(r.tier)}>{tierLabel(r.tier)}</span>
									<span class="text-[var(--color-ink-600)]">·</span>
									<span>stab {formatDays(r.stabilityDays)}</span>
									{#if r.lapses > 0}
										<span class="text-[var(--color-ink-600)]">·</span>
										<span>{r.lapses} lapse{r.lapses > 1 ? 's' : ''}</span>
									{/if}
								</div>
							</div>
							<Badge
								variant={r.tier === 'struggling'
									? 'oxblood'
									: r.tier === 'learning'
										? 'default'
										: r.tier === 'review'
											? 'brass'
											: 'olive'}
							>
								{r.card.expectedSan}
							</Badge>
						</a>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="mt-8">
			<Button href={`${base}/repertoire/${rep.id}`} variant="ghost" size="sm"
				>Back to dashboard</Button
			>
		</div>
	{/if}
</div>
