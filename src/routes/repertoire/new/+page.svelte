<script lang="ts">
	import { goto } from '$app/navigation';
	import { base, resolve } from '$app/paths';
	import { ArrowLeft, ArrowRight, BookOpen, Sparkles, Upload } from 'lucide-svelte';

	import { createRepertoire } from '$lib/storage/repertoires';
	import { Button, Input, Label } from '$lib/ui';
	import type { Color } from '$lib/types';

	let name = $state('');
	let color: Color = $state('white');
	let submitting = $state(false);
	let error = $state<string | null>(null);

	async function onSubmit(e: Event) {
		e.preventDefault();
		if (submitting || !name.trim()) return;
		submitting = true;
		error = null;
		try {
			const rep = await createRepertoire(name, color);
			await goto(resolve(`/repertoire/${rep.id}/edit`));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create repertoire';
			submitting = false;
		}
	}
</script>

<div class="stagger mx-auto max-w-xl px-6 pt-16 pb-12">
	<a
		href={resolve('/')}
		class="eyebrow mb-5 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
		style:--i="0"
	>
		<ArrowLeft class="size-3" />
		<span>Library</span>
	</a>

	<div class="eyebrow mb-4" style:--i="1">Chapter one</div>

	<h1 class="font-serif text-5xl leading-[1.05] tracking-tight md:text-6xl" style:--i="2">
		A new <em class="text-[var(--color-brass-300)]">repertoire</em>.
	</h1>

	<p class="mt-3 max-w-sm text-[var(--color-parchment-400)]" style:--i="3">
		Name it, pick a side, and start laying down the lines.
	</p>

	<form onsubmit={onSubmit} class="mt-10 space-y-8" style:--i="4">
		<div>
			<Label for="name">Title</Label>
			<Input
				id="name"
				bind:value={name}
				required
				placeholder="e.g. Italian for White"
				autocomplete="off"
				autofocus
				class="h-12 font-serif text-base"
			/>
			<p class="mt-1.5 font-serif text-xs text-[var(--color-parchment-500)] italic">
				The working title — you can rename any time.
			</p>
		</div>

		<div>
			<Label>I play as</Label>
			<div class="mt-1.5 grid grid-cols-2 gap-3">
				<button
					type="button"
					class="group relative rounded-[6px] border p-5 text-left transition-all duration-150
						{color === 'white'
						? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/8 shadow-[0_0_0_3px_var(--color-brass-300)_/_12%]'
						: 'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] hover:border-[var(--color-ink-600)]'}"
					onclick={() => (color = 'white')}
				>
					<span
						class="chess-king-white font-serif text-5xl leading-none text-[var(--color-brass-300)]"
					></span>
					<div class="eyebrow mt-4">White</div>
					<p class="mt-1 font-serif text-xs text-[var(--color-parchment-400)] italic">
						First move.
					</p>
				</button>
				<button
					type="button"
					class="group relative rounded-[6px] border p-5 text-left transition-all duration-150
						{color === 'black'
						? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/8 shadow-[0_0_0_3px_var(--color-brass-300)_/_12%]'
						: 'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] hover:border-[var(--color-ink-600)]'}"
					onclick={() => (color = 'black')}
				>
					<span
						class="chess-king-black font-serif text-5xl leading-none text-[var(--color-parchment-300)]"
					></span>
					<div class="eyebrow mt-4">Black</div>
					<p class="mt-1 font-serif text-xs text-[var(--color-parchment-400)] italic">
						Respond with intent.
					</p>
				</button>
			</div>
		</div>

		{#if error}
			<p class="font-sans text-sm text-[var(--color-oxblood-300)]">{error}</p>
		{/if}

		<div class="flex items-center gap-3 pt-2">
			<Button type="submit" variant="primary" size="lg" disabled={submitting || !name.trim()}>
				<span>{submitting ? 'Creating…' : 'Create'}</span>
				<ArrowRight class="size-4" />
			</Button>
			<Button href="{base}/" variant="ghost" size="lg">Cancel</Button>
		</div>
	</form>

	<div class="paper-divider mt-12 mb-6 font-serif text-lg" style:--i="5">
		<span class="ornament">⁂</span>
	</div>

	<div style:--i="6">
		<div class="eyebrow mb-3">Or skip the blank page</div>
		<div class="grid gap-3 sm:grid-cols-3">
			<a
				href={resolve('/autobuild')}
				class="group ink-panel p-4 transition-colors hover:border-[var(--color-brass-300)]/60"
			>
				<div class="flex items-baseline gap-2">
					<Sparkles class="size-4 text-[var(--color-brass-300)]" />
					<h3 class="font-serif text-lg">Autobuild</h3>
				</div>
				<p class="mt-1.5 font-serif text-xs text-[var(--color-parchment-500)] italic">
					Seed from your Lichess games, or walk the masters database.
				</p>
			</a>
			<a
				href={resolve('/import-study')}
				class="group ink-panel p-4 transition-colors hover:border-[var(--color-brass-300)]/60"
			>
				<div class="flex items-baseline gap-2">
					<BookOpen class="size-4 text-[var(--color-brass-300)]" />
					<h3 class="font-serif text-lg">From a study</h3>
				</div>
				<p class="mt-1.5 font-serif text-xs text-[var(--color-parchment-500)] italic">
					Pull the chapters of a Lichess study — yours or a shared one.
				</p>
			</a>
			<a
				href={resolve('/import')}
				class="group ink-panel p-4 transition-colors hover:border-[var(--color-brass-300)]/60"
			>
				<div class="flex items-baseline gap-2">
					<Upload class="size-4 text-[var(--color-brass-300)]" />
					<h3 class="font-serif text-lg">Import a PGN</h3>
				</div>
				<p class="mt-1.5 font-serif text-xs text-[var(--color-parchment-500)] italic">
					Paste or upload a PGN file with the lines already prepared.
				</p>
			</a>
		</div>
	</div>
</div>
