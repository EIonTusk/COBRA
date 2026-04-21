<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ArrowLeft, Download, Copy, Check } from 'lucide-svelte';

	import { getRepertoire } from '$lib/storage/repertoires';
	import { nodesMap } from '$lib/storage/nodes';
	import { listCards } from '$lib/storage/cards';
	import { exportRepertoirePgn, type ExportNode } from '$lib/chess/pgn';
	import { STARTPOS_FEN } from '$lib/chess/fen';
	import { Button } from '$lib/ui';
	import type { Repertoire } from '$lib/types';

	let rep = $state<Repertoire | null>(null);
	let pgn = $state('');
	let jsonText = $state('');
	let loading = $state(true);
	let copied = $state(false);

	onMount(async () => {
		const id = page.params.id;
		if (!id) {
			loading = false;
			return;
		}
		const r = await getRepertoire(id);
		if (!r) {
			loading = false;
			return;
		}
		rep = r;
		const nmap = await nodesMap(r.id);
		const exportMap = new SvelteMap<string, ExportNode>();
		for (const [k, v] of nmap) {
			exportMap.set(k, {
				fenKey: v.fenKey,
				comment: v.comment,
				nags: v.nags,
				children: v.children
			});
		}
		const headers: Record<string, string> = {
			Event: r.name,
			Site: 'COBRA',
			White: r.color === 'white' ? 'Repertoire' : 'Opponent',
			Black: r.color === 'black' ? 'Repertoire' : 'Opponent',
			Result: '*'
		};
		if (r.rootFen !== STARTPOS_FEN) {
			headers.SetUp = '1';
			headers.FEN = r.rootFen;
		}
		pgn = exportRepertoirePgn(exportMap, r.rootFenKey, headers);

		const cards = await listCards(r.id);
		jsonText = JSON.stringify(
			{ version: 1, repertoire: r, nodes: Array.from(nmap.values()), cards },
			null,
			2
		);
		loading = false;
	});

	function slug(s: string): string {
		return (
			s
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '') || 'repertoire'
		);
	}

	function downloadPgn() {
		if (!rep) return;
		download(new Blob([pgn], { type: 'application/x-chess-pgn' }), `${slug(rep.name)}.pgn`);
	}

	function downloadJson() {
		if (!rep) return;
		download(new Blob([jsonText], { type: 'application/json' }), `${slug(rep.name)}.json`);
	}

	function download(b: Blob, filename: string) {
		const url = URL.createObjectURL(b);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
	}

	async function copyPgn() {
		await navigator.clipboard.writeText(pgn);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="mx-auto max-w-4xl px-6 pt-12 pb-16">
	{#if loading}
		<p class="pt-6 text-sm text-[var(--color-parchment-400)]">Loading…</p>
	{:else if !rep}
		<p class="pt-6 text-[var(--color-oxblood-300)]">Repertoire not found.</p>
	{:else}
		<a
			href={resolve(`/repertoire/${rep.id}`)}
			class="eyebrow mb-5 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
		>
			<ArrowLeft class="size-3" />
			<span class="max-w-[240px] truncate">{rep.name}</span>
		</a>

		<div class="eyebrow mb-3">Export</div>
		<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
			Take it <em class="text-[var(--color-brass-300)]">elsewhere</em>.
		</h1>
		<p class="mt-3 max-w-md text-[var(--color-parchment-400)]">
			A PGN for other tools. A JSON backup for your own safekeeping.
		</p>

		<div class="mt-7 flex flex-wrap items-center gap-2">
			<Button onclick={downloadPgn} variant="primary" size="md">
				<Download class="size-3.5" />
				<span>Download .pgn</span>
			</Button>
			<Button onclick={copyPgn} variant="outline" size="md">
				{#if copied}
					<Check class="size-3.5" />
					<span>Copied</span>
				{:else}
					<Copy class="size-3.5" />
					<span>Copy PGN</span>
				{/if}
			</Button>
			<Button onclick={downloadJson} variant="ghost" size="md">
				<Download class="size-3.5" />
				<span>.json backup</span>
			</Button>
		</div>

		<div class="paper-divider mt-10 mb-4 font-serif text-lg">
			<span class="ornament">⁂</span>
		</div>

		<div class="eyebrow mb-2">Preview</div>
		<pre
			class="ink-panel max-h-[60vh] overflow-auto p-5 font-mono text-[12.5px] leading-6 break-all whitespace-pre-wrap text-[var(--color-parchment-200)]">{pgn}</pre>
	{/if}
</div>
