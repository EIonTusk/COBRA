<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ArrowLeft, RotateCcw } from 'lucide-svelte';

	import Board from '$lib/chess/Board.svelte';
	import { colorToMove } from '$lib/chess/fen';
	import { reviewCard, type DrillOutcome, outcomeToRating } from '$lib/fsrs/scheduler';
	import { getRepertoire } from '$lib/storage/repertoires';
	import { getSettings } from '$lib/storage/settings';
	import { duePlanCards, listPlanCards, upsertPlanCard } from '$lib/storage/planCards';
	import { nodesMap } from '$lib/storage/nodes';
	import { pathToFenKey } from '$lib/tree/traversal';
	import { Button } from '$lib/ui';
	import type { AppSettings, Color, PlanCard, Repertoire } from '$lib/types';

	interface QueueItem {
		card: PlanCard;
		lineSans: string[];
	}

	let rep = $state<Repertoire | null>(null);
	let settings = $state<AppSettings | null>(null);
	let queue = $state<QueueItem[]>([]);
	let cursor = $state(0);
	let revealed = $state(false);
	let loading = $state(true);
	let totalAtStart = $state(0);
	let totalInRep = $state(0);

	const current = $derived<QueueItem | null>(queue[cursor] ?? null);

	const currentFen = $derived.by(() => {
		if (!current) return null;
		return `${current.card.fenKey} 0 1`;
	});

	const sideToMove = $derived.by<Color>(() => {
		if (!current) return 'white';
		return colorToMove(current.card.fenKey);
	});

	const orientation = $derived<Color>(rep?.color ?? 'white');

	const sessionDone = $derived(queue.length > 0 && cursor >= queue.length);

	onMount(async () => {
		const id = page.params.id;
		if (!id) {
			loading = false;
			return;
		}
		const [r, s] = await Promise.all([getRepertoire(id), getSettings()]);
		rep = r ?? null;
		settings = s;
		if (!rep) {
			loading = false;
			return;
		}
		await rebuildQueue();
		loading = false;
	});

	async function rebuildQueue(): Promise<void> {
		if (!rep) return;
		const cap = settings?.drillSessionCap ?? 30;
		const due = await duePlanCards(rep.id, Date.now(), cap);
		const all = await listPlanCards(rep.id);
		totalInRep = all.length;
		const nodes = await nodesMap(rep.id);
		queue = due.map((card) => {
			const path = pathToFenKey(nodes, rep!.rootFenKey, card.fenKey);
			return { card, lineSans: path ? path.map((e) => e.san) : [] };
		});
		totalAtStart = queue.length;
		cursor = 0;
		revealed = false;
	}

	async function grade(outcome: DrillOutcome): Promise<void> {
		if (!current || !settings) return;
		const rating = outcomeToRating(outcome);
		const updated: PlanCard = reviewCard(current.card, rating, settings.fsrsParams);
		await upsertPlanCard(updated);
		cursor += 1;
		revealed = false;
	}

	function reveal() {
		revealed = true;
	}

	function moveNumberPrefix(i: number): string | null {
		return i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : null;
	}

	function formatLine(sans: string[]): string {
		if (sans.length === 0) return 'Root position';
		const parts: string[] = [];
		for (let i = 0; i < sans.length; i++) {
			const prefix = moveNumberPrefix(i);
			if (prefix) parts.push(prefix);
			parts.push(sans[i]);
		}
		return parts.join(' ');
	}
</script>

<svelte:head>
	<title>Plan drill — {rep?.name ?? 'Repertoire'}</title>
</svelte:head>

<div class="mx-auto max-w-5xl px-6 pt-12 pb-16">
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

		<div class="eyebrow mb-3">Plan drill</div>
		<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
			What's the <em class="text-[var(--color-brass-300)]">plan</em>?
		</h1>
		<p class="mt-3 max-w-xl text-[var(--color-parchment-400)]">
			Structural-plan recall for every position you've pinned a middle-game guide on. Each card asks
			one question, you think about it, reveal the master-game–derived answer, and self-grade. FSRS
			schedules the next showing.
		</p>

		{#if queue.length === 0 && totalInRep === 0}
			<div
				class="ink-panel mt-10 flex flex-col items-start gap-3 p-6 text-[var(--color-parchment-400)]"
			>
				<p class="max-w-prose">
					No plan cards yet. Pin a middle-game guide in the editor — saving one auto-creates the
					plan card for that position.
				</p>
				<Button href={resolve(`/repertoire/${rep.id}/edit`)} variant="secondary" size="sm">
					Open editor
				</Button>
			</div>
		{:else if queue.length === 0}
			<div
				class="ink-panel mt-10 flex flex-col items-start gap-3 p-6 text-[var(--color-parchment-400)]"
			>
				<p class="max-w-prose">
					All {totalInRep} plan card{totalInRep === 1 ? '' : 's'} in this repertoire are scheduled for
					later. Come back when something's due.
				</p>
				<Button href={resolve(`/repertoire/${rep.id}`)} variant="secondary" size="sm">
					Back to repertoire
				</Button>
			</div>
		{:else if sessionDone}
			<div
				class="ink-panel mt-10 flex flex-col items-start gap-3 p-6 text-[var(--color-parchment-200)]"
			>
				<p class="max-w-prose">
					Session complete — {totalAtStart} card{totalAtStart === 1 ? '' : 's'} reviewed.
				</p>
				<div class="flex gap-2">
					<Button onclick={rebuildQueue} variant="secondary" size="sm">
						<RotateCcw class="size-3.5" />
						<span>Reload queue</span>
					</Button>
					<Button href={resolve(`/repertoire/${rep.id}`)} variant="ghost" size="sm">
						Back to repertoire
					</Button>
				</div>
			</div>
		{:else if current && currentFen}
			<div class="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<div>
					<div
						class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
					>
						Card {cursor + 1} / {totalAtStart}
					</div>
					<div class="mt-2 aspect-square w-full max-w-[520px]">
						<Board fen={currentFen} {orientation} turnColor={sideToMove} viewOnly coordinates />
					</div>
					<div
						class="mt-3 font-mono text-xs leading-snug text-[var(--color-parchment-400)] tabular-nums"
					>
						{formatLine(current.lineSans)}
					</div>
				</div>

				<div class="flex flex-col gap-4">
					<div class="ink-panel p-5">
						<div class="eyebrow mb-2 text-[10px] text-[var(--color-brass-300)]">Prompt</div>
						<p class="font-serif text-lg leading-snug text-[var(--color-parchment-100)]">
							{current.card.prompt}
						</p>
					</div>

					{#if revealed}
						<div class="ink-panel p-5">
							<div class="eyebrow mb-2 text-[10px] text-[var(--color-olive-300)]">Answer</div>
							<pre
								class="font-mono text-sm leading-relaxed whitespace-pre-wrap text-[var(--color-parchment-200)]">{current
									.card.answer}</pre>
						</div>

						<div class="flex flex-wrap gap-2">
							<Button onclick={() => grade('wrong')} variant="secondary" size="sm">Again</Button>
							<Button onclick={() => grade('peeked')} variant="secondary" size="sm">Hard</Button>
							<Button onclick={() => grade('correct')} variant="secondary" size="sm">Good</Button>
							<Button onclick={() => grade('easy')} variant="secondary" size="sm">Easy</Button>
						</div>
					{:else}
						<Button onclick={reveal} variant="secondary" size="sm">Reveal answer</Button>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>
