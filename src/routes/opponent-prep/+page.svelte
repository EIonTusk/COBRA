<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { onDestroy, onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { Search, X, PlayCircle } from 'lucide-svelte';

	import { listRepertoires } from '$lib/storage/repertoires';
	import { nodesMap } from '$lib/storage/nodes';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import { pathToFenKey } from '$lib/tree/traversal';
	import {
		analyzeOpponent,
		type OpponentMoveStat,
		type OpponentPrepResult
	} from '$lib/lichess/opponentPrep';
	import { Button, DashboardBacklink, Input, Label, Select } from '$lib/ui';
	import type { AppSettings, Repertoire, RepertoireNode } from '$lib/types';

	let settings = $state<AppSettings | null>(null);
	let reps = $state<Repertoire[]>([]);
	let repertoireId = $state<string>('');
	let username = $state('');
	let maxGames = $state(100);
	let ratedOnly = $state(true);
	let running = $state(false);
	let error = $state<string | null>(null);
	let status = $state<string | null>(null);
	let result = $state<OpponentPrepResult | null>(null);
	let analyzedRep = $state<{
		id: string;
		name: string;
		nodes: Map<string, RepertoireNode>;
		rootFenKey: string;
		rootFen: string;
	} | null>(null);
	let controller: AbortController | null = null;

	onMount(async () => {
		settings = await getSettings();
		reps = await listRepertoires();
		if (reps.length > 0 && !repertoireId) repertoireId = reps[0].id;
	});

	onDestroy(() => controller?.abort());

	const selectedRep = $derived(reps.find((r) => r.id === repertoireId) ?? null);
	const tokenConfigured = $derived(!!settings && !!effectiveLichessToken(settings));
	const canRun = $derived(!!username.trim() && !!selectedRep && tokenConfigured && !running);

	async function run(e: Event) {
		e.preventDefault();
		if (!settings || !selectedRep || !canRun) return;
		const token = effectiveLichessToken(settings);
		if (!token) {
			error = 'Connect Lichess or paste a token in Settings first.';
			return;
		}
		error = null;
		running = true;
		result = null;
		status = 'Streaming games…';
		controller = new AbortController();

		try {
			const nodes = await nodesMap(selectedRep.id);
			analyzedRep = {
				id: selectedRep.id,
				name: selectedRep.name,
				nodes,
				rootFenKey: selectedRep.rootFenKey,
				rootFen: selectedRep.rootFen
			};
			const r = await analyzeOpponent({
				username: username.trim(),
				ourColor: selectedRep.color,
				maxGames,
				rated: ratedOnly ? true : undefined,
				since: settings.gamesSince,
				token,
				signal: controller.signal,
				rep: {
					rootFenKey: selectedRep.rootFenKey,
					color: selectedRep.color,
					nodes
				},
				onProgress: (seen, used) => {
					status = `Scanned ${seen} games · ${used} usable`;
				}
			});
			result = r;
			status =
				r.gamesUsed === 0
					? `No games as ${selectedRep.color === 'white' ? 'Black' : 'White'} found for this opponent (out of ${r.gamesScanned} games).`
					: `Scanned ${r.gamesScanned} games, ${r.gamesUsed} as ${selectedRep.color === 'white' ? 'Black' : 'White'}. Found ${r.uncovered.length} uncovered ${r.uncovered.length === 1 ? 'move' : 'moves'}.`;
		} catch (e) {
			if ((e as Error).name !== 'AbortError') {
				error = e instanceof Error ? e.message : 'Scan failed';
			}
		} finally {
			running = false;
			controller = null;
		}
	}

	function cancel() {
		controller?.abort();
	}

	/**
	 * Turn a fromFenKey into a human line like "1.e4 e5 2.Nf3". Empty string
	 * for the root position. Falls back to fenKey prefix if the node isn't
	 * reachable (shouldn't happen — we only record positions inside the tree).
	 */
	function linePrefix(fromFenKey: string): string {
		if (!analyzedRep) return '';
		if (fromFenKey === analyzedRep.rootFenKey) return '';
		const edges = pathToFenKey(analyzedRep.nodes, analyzedRep.rootFenKey, fromFenKey);
		if (!edges) return '…';
		// Work out the starting move number from the root FEN.
		const rootParts = analyzedRep.rootFen.split(' ');
		const rootFullMove = parseInt(rootParts[5] ?? '1', 10) || 1;
		const rootTurn = rootParts[1] === 'w' ? 'white' : 'black';
		let whiteToMove = rootTurn === 'white';
		let moveNo = rootFullMove;
		const parts: string[] = [];
		for (const edge of edges) {
			if (whiteToMove) parts.push(`${moveNo}.${edge.san}`);
			else parts.push(edge.san);
			if (!whiteToMove) moveNo += 1;
			whiteToMove = !whiteToMove;
		}
		return parts.join(' ');
	}

	interface GroupedRow {
		fromFenKey: string;
		line: string;
		moves: OpponentMoveStat[];
		total: number;
	}

	const grouped = $derived.by<GroupedRow[]>(() => {
		if (!result) return [];
		const map = new SvelteMap<string, OpponentMoveStat[]>();
		for (const m of result.uncovered) {
			const list = map.get(m.fromFenKey) ?? [];
			list.push(m);
			map.set(m.fromFenKey, list);
		}
		const rows: GroupedRow[] = [];
		for (const [fromFenKey, moves] of map.entries()) {
			moves.sort((a, b) => b.count - a.count);
			const total = moves.reduce((acc, m) => acc + m.count, 0);
			rows.push({ fromFenKey, line: linePrefix(fromFenKey), moves, total });
		}
		rows.sort((a, b) => b.total - a.total);
		return rows;
	});

	function jumpHref(fromFenKey: string): string {
		if (!analyzedRep) return '#';
		return `${base}/repertoire/${analyzedRep.id}/edit?jump=${encodeURIComponent(fromFenKey)}`;
	}

	/**
	 * Session-storage key the editor reads to drive the "Add each" walk.
	 * Shape: `{ repertoireId, created, gaps: [{fromFenKey, san, uci, count}] }`.
	 */
	const WALK_STORAGE_KEY = 'cobra:opp-prep-walk';

	function startWalkthrough() {
		if (!analyzedRep || !result) return;
		const gaps = grouped.flatMap((g) =>
			g.moves.map((m) => ({
				fromFenKey: m.fromFenKey,
				san: m.san,
				uci: m.uci,
				count: m.count,
				line: g.line
			}))
		);
		if (gaps.length === 0) return;
		const payload = {
			repertoireId: analyzedRep.id,
			repertoireName: analyzedRep.name,
			opponent: username.trim(),
			created: Date.now(),
			gaps
		};
		try {
			sessionStorage.setItem(WALK_STORAGE_KEY, JSON.stringify(payload));
		} catch {
			/* storage can fail in private mode — the editor falls back to a
			   plain ?jump= deep-link if the session payload is missing. */
		}
		void goto(resolve(`/repertoire/${analyzedRep.id}/edit?prep=walk&gapIdx=0`));
	}

	function fmtPct(n: number, total: number): string {
		if (!total) return '';
		const p = (n / total) * 100;
		if (p >= 10) return `${p.toFixed(0)}%`;
		return `${p.toFixed(1)}%`;
	}
</script>

<div class="relative mx-auto max-w-3xl px-6 pt-14 pb-16">
	<DashboardBacklink />

	<div class="eyebrow mb-3">Opponent prep</div>
	<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
		What they play that you <em class="text-[var(--color-brass-300)]">haven't</em> prepared.
	</h1>
	<p class="mt-3 max-w-md text-[var(--color-parchment-400)]">
		Pulls a Lichess player's recent games, walks each one against the repertoire you pick, and
		surfaces the opponent moves at each level that your tree doesn't answer yet — ranked by how
		often they show up.
	</p>

	{#if !tokenConfigured}
		<div
			class="mt-6 rounded border border-[var(--color-brass-400)]/30 bg-[var(--color-brass-500)]/10 p-4 text-sm"
		>
			<p class="text-[var(--color-brass-200)]">
				Needs a Lichess connection.
				<a
					href={resolve('/settings')}
					class="text-[var(--color-brass-300)] underline underline-offset-2"
				>
					Connect in Settings
				</a>.
			</p>
		</div>
	{/if}

	{#if reps.length === 0}
		<p class="mt-8 font-serif text-sm text-[var(--color-parchment-400)] italic">
			You need at least one repertoire first. <a
				href={resolve('/repertoire/new')}
				class="text-[var(--color-brass-300)] underline underline-offset-2">Create one</a
			>.
		</p>
	{:else}
		<form onsubmit={run} class="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
			<div>
				<Label for="user">Opponent's Lichess username</Label>
				<Input
					id="user"
					bind:value={username}
					required
					disabled={running}
					placeholder="DrNykterstein"
					class="font-mono"
				/>
			</div>
			<div>
				<Label for="rep">Repertoire to diff against</Label>
				<Select
					id="rep"
					value={repertoireId}
					onchange={(v) => (repertoireId = v)}
					options={reps.map((r) => ({
						value: r.id,
						label: `${r.name} · ${r.color}`
					}))}
				/>
			</div>
			<div class="w-28">
				<Label for="max">Max games</Label>
				<Input
					id="max"
					type="number"
					min={1}
					max={500}
					bind:value={maxGames}
					disabled={running}
					class="font-mono"
				/>
			</div>
			<div class="flex items-end gap-2 sm:col-span-2">
				<label class="flex items-center gap-2 text-sm text-[var(--color-parchment-300)]">
					<input
						type="checkbox"
						bind:checked={ratedOnly}
						disabled={running}
						class="accent-[var(--color-brass-300)]"
					/>
					<span>Rated only</span>
				</label>
				<div class="ml-auto">
					{#if running}
						<Button variant="destructive" size="md" type="button" onclick={cancel}>
							<X class="size-4" />
							<span>Stop</span>
						</Button>
					{:else}
						<Button variant="primary" size="md" type="submit" disabled={!canRun}>
							<Search class="size-4" />
							<span>Scan</span>
						</Button>
					{/if}
				</div>
			</div>
		</form>
	{/if}

	{#if error}
		<p class="mt-4 text-sm text-[var(--color-oxblood-300)]">{error}</p>
	{/if}
	{#if status}
		<p class="mt-3 font-mono text-xs text-[var(--color-parchment-500)]">{status}</p>
	{/if}

	{#if result && analyzedRep && result.gamesUsed > 0}
		<div class="mt-8 grid grid-cols-3 gap-2 sm:gap-3">
			<div class="ink-panel rounded-[4px] p-3 sm:p-4">
				<div class="eyebrow text-[9.5px] sm:text-[10.5px]">Games matched</div>
				<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
					{result.gamesUsed}
				</div>
			</div>
			<div class="ink-panel rounded-[4px] p-3 sm:p-4">
				<div class="eyebrow text-[9.5px] sm:text-[10.5px]">Opponent plies inside tree</div>
				<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums">
					{result.plyCovered}
				</div>
			</div>
			<div class="ink-panel rounded-[4px] p-3 sm:p-4">
				<div class="eyebrow text-[9.5px] sm:text-[10.5px]">Uncovered moves</div>
				<div
					class="mt-1 font-serif text-2xl tabular-nums"
					class:text-[var(--color-oxblood-300)]={result.uncovered.length > 0}
					class:text-[var(--color-olive-300)]={result.uncovered.length === 0}
				>
					{result.uncovered.length}
				</div>
			</div>
		</div>

		{#if grouped.length === 0}
			<p class="mt-8 font-serif text-sm text-[var(--color-parchment-400)] italic">
				Nothing uncovered. Your repertoire answers every opponent move in {result.gamesUsed}
				games.
			</p>
		{:else}
			<div class="mt-10 flex flex-wrap items-baseline justify-between gap-3">
				<h2 class="font-serif text-2xl">Gaps, by frequency</h2>
				<Button variant="primary" size="sm" onclick={startWalkthrough}>
					<PlayCircle class="size-3.5" />
					<span>Add each to the repertoire ({grouped.reduce((n, g) => n + g.moves.length, 0)})</span
					>
				</Button>
			</div>
			<p class="mt-1 font-serif text-xs text-[var(--color-parchment-500)] italic">
				Click a move to jump straight into the editor at that position.
			</p>
			<ul
				class="mt-3 divide-y divide-[var(--color-ink-800)] border-y border-[var(--color-ink-800)]"
			>
				{#each grouped as row (row.fromFenKey)}
					<li class="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-2">
						<div
							class="truncate font-mono text-[12px] text-[var(--color-parchment-300)]"
							title={row.line}
						>
							{row.line || '(start)'}
						</div>
						<span class="font-mono text-[11px] text-[var(--color-parchment-500)] tabular-nums">
							{row.total}×
						</span>
						<div class="col-span-2 flex flex-wrap gap-1">
							{#each row.moves as m (m.uci)}
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href={jumpHref(m.fromFenKey)}
									title="Add a reply to {m.san} — played {m.count}× ({fmtPct(m.count, row.total)})"
									class="inline-flex items-center gap-1 rounded-[3px] border border-[var(--color-oxblood-400)]/30 bg-[var(--color-oxblood-500)]/10 px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-oxblood-300)] transition-colors hover:bg-[var(--color-oxblood-500)]/20"
								>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
									<span>{m.san}</span>
									<span class="text-[var(--color-parchment-500)] tabular-nums">{m.count}</span>
								</a>
							{/each}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>
