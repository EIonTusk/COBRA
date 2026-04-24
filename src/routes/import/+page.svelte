<script lang="ts">
	import { goto } from '$app/navigation';
	import { base, resolve } from '$app/paths';
	import { FileText, ArrowRight } from 'lucide-svelte';

	import { parseRepertoirePgn } from '$lib/chess/pgn';
	import { createRepertoire } from '$lib/storage/repertoires';
	import { addEdge, applyImportedNote } from '$lib/storage/nodes';
	import { upsertCard, getCard } from '$lib/storage/cards';
	import { createFreshCard } from '$lib/fsrs/scheduler';
	import { colorToMove } from '$lib/chess/fen';
	import { Button, DashboardBacklink, Input, Label, Textarea } from '$lib/ui';
	import type { Color } from '$lib/types';

	let pgnText = $state('');
	let name = $state('Imported repertoire');
	let color: Color = $state('white');
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let fileName = $state<string | null>(null);

	async function onFile(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		pgnText = await file.text();
		fileName = file.name;
		if (!name || name === 'Imported repertoire') {
			name = file.name.replace(/\.pgn$/i, '');
		}
	}

	async function onImport(e: Event) {
		e.preventDefault();
		if (submitting || !pgnText.trim()) return;
		submitting = true;
		error = null;
		try {
			const lines = parseRepertoirePgn(pgnText);
			if (lines.length === 0) throw new Error('No valid games found in the PGN.');
			const first = lines[0];
			const rep = await createRepertoire(name, color, first.rootFen);
			for (const line of lines) {
				for (const { fromFenKey, edge, comment, nags } of line.edges) {
					await addEdge(rep.id, fromFenKey, edge);
					await applyImportedNote(rep.id, edge.toFenKey, { comment, nags });
					if (colorToMove(fromFenKey) === color) {
						const existing = await getCard(rep.id, fromFenKey);
						if (!existing) {
							await upsertCard(createFreshCard(rep.id, fromFenKey, edge.san));
						}
					}
				}
			}
			await goto(resolve(`/repertoire/${rep.id}`));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed';
			submitting = false;
		}
	}
</script>

<div class="stagger relative mx-auto max-w-2xl px-6 pt-14 pb-12">
	<DashboardBacklink />

	<div class="eyebrow mb-3" style:--i="1">Import</div>

	<h1 class="font-serif text-5xl leading-[1.05] tracking-tight" style:--i="2">
		Bring a <em class="text-[var(--color-brass-300)]">PGN</em>.
	</h1>

	<p class="mt-3 max-w-md text-[var(--color-parchment-400)]" style:--i="3">
		From Lichess studies, chess books, or any <code
			class="rounded-[3px] bg-[var(--color-ink-800)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-parchment-200)]"
			>.pgn</code
		> file. Variations are preserved; transpositions merge automatically.
	</p>

	<form onsubmit={onImport} class="mt-10 space-y-8" style:--i="4">
		<div>
			<Label for="name">Title</Label>
			<Input id="name" bind:value={name} required class="h-12 font-serif text-base" />
		</div>

		<div>
			<Label>Color to drill</Label>
			<div class="mt-1.5 grid grid-cols-2 gap-3">
				<button
					type="button"
					class="group rounded-[6px] border p-4 text-left transition-all
						{color === 'white'
						? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/8'
						: 'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] hover:border-[var(--color-ink-600)]'}"
					onclick={() => (color = 'white')}
				>
					<div class="flex items-center gap-3">
						<span
							class="chess-king-white font-serif text-3xl leading-none text-[var(--color-brass-300)]"
						></span>
						<span class="eyebrow">White</span>
					</div>
				</button>
				<button
					type="button"
					class="group rounded-[6px] border p-4 text-left transition-all
						{color === 'black'
						? 'border-[var(--color-brass-300)] bg-[var(--color-brass-300)]/8'
						: 'border-[var(--color-ink-700)] bg-[var(--color-ink-900)] hover:border-[var(--color-ink-600)]'}"
					onclick={() => (color = 'black')}
				>
					<div class="flex items-center gap-3">
						<span
							class="chess-king-black font-serif text-3xl leading-none text-[var(--color-parchment-300)]"
						></span>
						<span class="eyebrow">Black</span>
					</div>
				</button>
			</div>
		</div>

		<div>
			<Label for="pgn-file">From file</Label>
			<label
				for="pgn-file"
				class="flex cursor-pointer items-center gap-3 rounded-[6px] border border-dashed border-[var(--color-ink-700)] p-4 transition-colors hover:border-[var(--color-brass-300)]/60 hover:bg-[var(--color-ink-900)]/50"
			>
				<FileText
					class="size-5 {fileName
						? 'text-[var(--color-brass-300)]'
						: 'text-[var(--color-parchment-400)]'}"
				/>
				<div class="min-w-0 flex-1">
					<div class="truncate text-sm text-[var(--color-parchment-100)]">
						{fileName ?? 'Choose a .pgn file'}
					</div>
					<div class="font-serif text-xs text-[var(--color-parchment-500)] italic">
						Or paste the text below.
					</div>
				</div>
				<input
					id="pgn-file"
					type="file"
					accept=".pgn,text/plain"
					onchange={onFile}
					class="sr-only"
				/>
			</label>
		</div>

		<div>
			<Label for="pgn">PGN text</Label>
			<Textarea
				id="pgn"
				bind:value={pgnText}
				rows={10}
				required
				placeholder="1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 Bc5 ..."
				class="font-mono text-[13px] leading-6"
			/>
		</div>

		{#if error}
			<p class="text-sm text-[var(--color-oxblood-300)]">{error}</p>
		{/if}

		<div class="flex items-center gap-3">
			<Button
				type="submit"
				variant="primary"
				size="lg"
				disabled={submitting || !pgnText.trim() || !name.trim()}
			>
				<span>{submitting ? 'Importing…' : 'Import'}</span>
				<ArrowRight class="size-4" />
			</Button>
			<Button href="{base}/" variant="ghost" size="lg">Cancel</Button>
		</div>
	</form>
</div>
