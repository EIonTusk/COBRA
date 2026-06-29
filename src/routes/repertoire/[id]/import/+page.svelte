<script lang="ts">
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { FileText, ArrowRight } from 'lucide-svelte';

	import { parseRepertoirePgn } from '$lib/chess/pgn';
	import { getRepertoire } from '$lib/storage/repertoires';
	import { mergeLinesIntoRepertoire, type MergeLinesResult } from '$lib/storage/importPgn';
	import { Button, DashboardBacklink, Label, Textarea } from '$lib/ui';
	import type { Repertoire } from '$lib/types';

	let rep = $state<Repertoire | null>(null);
	let loading = $state(true);

	let pgnText = $state('');
	let fileName = $state<string | null>(null);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let result = $state<MergeLinesResult | null>(null);

	$effect(() => {
		const id = page.params.id;
		if (!id) return;
		loading = true;
		(async () => {
			rep = (await getRepertoire(id)) ?? null;
			loading = false;
		})();
	});

	async function onFile(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		pgnText = await file.text();
		fileName = file.name;
	}

	async function onImport(e: Event) {
		e.preventDefault();
		if (!rep || submitting || !pgnText.trim()) return;
		submitting = true;
		error = null;
		result = null;
		try {
			const lines = parseRepertoirePgn(pgnText);
			if (lines.length === 0) throw new Error('No valid games found in the PGN.');
			const merged = await mergeLinesIntoRepertoire(rep.id, rep.color, rep.rootFenKey, lines);
			if (merged.importedLines === 0) {
				// Everything was skipped: the pasted lines all start from a
				// different position than this repertoire's root, so none of
				// them can attach to the tree.
				throw new Error(
					`None of the ${merged.skippedLines} line(s) start from this repertoire's opening position, so nothing was imported.`
				);
			}
			result = merged;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="stagger relative mx-auto max-w-2xl px-6 pt-14 pb-12">
	<DashboardBacklink
		href={rep ? `${base}/repertoire/${rep.id}` : `${base}/library`}
		label={rep ? rep.name : 'Library'}
	/>

	{#if loading}
		<p class="mt-10 text-sm text-[var(--color-parchment-400)]">Loading…</p>
	{:else if !rep}
		<p class="mt-10 text-[var(--color-oxblood-300)]">Repertoire not found.</p>
	{:else}
		<div class="eyebrow mb-3" style:--i="1">Import into · {rep.name}</div>

		<h1 class="font-serif text-5xl leading-[1.05] tracking-tight" style:--i="2">
			Add <em class="text-[var(--color-brass-300)]">PGN</em> lines.
		</h1>

		<p class="mt-3 max-w-md text-[var(--color-parchment-400)]" style:--i="3">
			Merge variations from a study, book, or <code
				class="rounded-[3px] bg-[var(--color-ink-800)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-parchment-200)]"
				>.pgn</code
			>
			file into this <span class="capitalize">{rep.color}</span> repertoire. Existing moves and your drill
			progress are kept — only new lines are added. Lines must start from this repertoire's opening position.
		</p>

		{#if result}
			<!--
				Post-import summary. Reports what actually changed so the user
				can reconcile against the PGN they pasted — new moves added,
				and any lines skipped because they began from a different
				position than this repertoire's root.
			-->
			<div class="ink-panel mt-10 p-5" style:--i="4">
				<h2 class="eyebrow mb-3 text-[var(--color-olive-300)]">Imported</h2>
				<dl class="grid grid-cols-2 gap-4 sm:grid-cols-3">
					<div>
						<dt
							class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
						>
							New moves
						</dt>
						<dd class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)] tabular-nums">
							{result.addedEdges}
						</dd>
					</div>
					<div>
						<dt
							class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
						>
							New cards
						</dt>
						<dd class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)] tabular-nums">
							{result.addedCards}
						</dd>
					</div>
					<div>
						<dt
							class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
						>
							Lines merged
						</dt>
						<dd class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)] tabular-nums">
							{result.importedLines}
						</dd>
					</div>
				</dl>
				{#if result.skippedLines > 0}
					<p class="mt-4 font-serif text-sm text-[var(--color-brass-200)] italic">
						{result.skippedLines} line(s) were skipped — they start from a different position than this
						repertoire's opening.
					</p>
				{/if}
				<div class="mt-5 flex items-center gap-3">
					<Button href="{base}/repertoire/{rep.id}" variant="primary" size="lg">
						<span>Back to repertoire</span>
						<ArrowRight class="size-4" />
					</Button>
					<Button href="{base}/repertoire/{rep.id}/edit" variant="ghost" size="lg"
						>Open builder</Button
					>
					<Button
						variant="ghost"
						size="lg"
						onclick={() => {
							result = null;
							pgnText = '';
							fileName = null;
						}}>Import more</Button
					>
				</div>
			</div>
		{:else}
			<form onsubmit={onImport} class="mt-10 space-y-8" style:--i="4">
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
						disabled={submitting || !pgnText.trim()}
					>
						<span>{submitting ? 'Importing…' : 'Import into repertoire'}</span>
						<ArrowRight class="size-4" />
					</Button>
					<Button href="{base}/repertoire/{rep.id}" variant="ghost" size="lg">Cancel</Button>
				</div>
			</form>
		{/if}
	{/if}
</div>
