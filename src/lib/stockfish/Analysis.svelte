<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getEngine, StockfishUnavailable, type EngineInfo } from './engine';
	import { edgeFromUci, fenAfterMove } from '$lib/chess/position';
	import { colorToMove } from '$lib/chess/fen';

	interface Props {
		fen: string;
		enabled: boolean;
		onDisable?: () => void;
		/**
		 * Called with a prefix of UCI moves from the current PV when the user
		 * clicks a move in the engine line. The Nth move clicked emits the
		 * first N moves so the edit page can apply the whole prefix to its
		 * tree.
		 */
		onselect?: (uciPrefix: string[]) => void;
	}
	let { fen, enabled, onDisable, onselect }: Props = $props();

	let info = $state<EngineInfo | null>(null);
	let error = $state<string | null>(null);
	let booting = $state(false);
	let unsub: (() => void) | null = null;

	$effect(() => {
		if (!enabled || !fen) return;
		const currentFen = fen;
		(async () => {
			const engine = getEngine();
			if (!unsub) unsub = engine.onInfo((i) => (info = i));
			booting = true;
			try {
				await engine.init();
				booting = false;
				info = null;
				await engine.go(currentFen, 20);
			} catch (e) {
				booting = false;
				error =
					e instanceof StockfishUnavailable
						? e.message
						: e instanceof Error
							? e.message
							: 'Engine error';
			}
		})();
	});

	onDestroy(() => {
		unsub?.();
		unsub = null;
		try {
			getEngine().stop();
		} catch {
			/* ignore */
		}
	});

	function formatScore(i: EngineInfo): string {
		if (i.scoreMate !== undefined) {
			const sign = i.scoreMate > 0 ? '+' : '';
			return `${sign}M${Math.abs(i.scoreMate)}`;
		}
		if (i.scoreCp !== undefined) {
			const cp = i.scoreCp / 100;
			return cp >= 0 ? `+${cp.toFixed(2)}` : cp.toFixed(2);
		}
		return '?';
	}

	const scoreTone = $derived.by(() => {
		if (!info) return 'text-[var(--color-parchment-100)]';
		const mate = info.scoreMate;
		const cp = info.scoreCp;
		if (mate !== undefined)
			return mate > 0 ? 'text-[var(--color-olive-300)]' : 'text-[var(--color-oxblood-300)]';
		if (cp === undefined) return 'text-[var(--color-parchment-100)]';
		if (cp > 80) return 'text-[var(--color-olive-300)]';
		if (cp < -80) return 'text-[var(--color-oxblood-300)]';
		return 'text-[var(--color-parchment-100)]';
	});

	// Translate the UCI PV into SAN by replaying it from the current FEN.
	// We stop at the first illegal move (engine output can race a position
	// change) so the UI always renders a coherent prefix.
	const pv = $derived.by<Array<{ san: string; uci: string }>>(() => {
		if (!info || !fen) return [];
		const out: Array<{ san: string; uci: string }> = [];
		let f = fen;
		for (const uci of info.pv.slice(0, 10)) {
			try {
				const orig = uci.slice(0, 2);
				const dest = uci.slice(2, 4);
				const promo = uci.length > 4 ? (uci[4] as 'q' | 'r' | 'b' | 'n') : undefined;
				const edge = edgeFromUci(f, orig, dest, promo);
				if (!edge) break;
				out.push({ san: edge.san, uci });
				f = fenAfterMove(f, edge);
			} catch {
				break;
			}
		}
		return out;
	});

	// Starting ply index: 0 when white to move, 1 when black. Drives move
	// numbering like the history ladder under the board.
	const startPly = $derived(fen ? (colorToMove(fen) === 'white' ? 0 : 1) : 0);

	function moveNumberPrefix(i: number): string | null {
		const ply = startPly + i;
		if (ply % 2 === 0) return `${Math.floor(ply / 2) + 1}.`;
		if (i === 0) return `${Math.floor(ply / 2) + 1}…`;
		return null;
	}

	function applyTo(index: number) {
		if (!onselect) return;
		const prefix = pv.slice(0, index + 1).map((p) => p.uci);
		onselect(prefix);
	}
</script>

<div>
	<div class="mb-3 flex items-center gap-2">
		<span class="eyebrow flex-1">Stockfish · NNUE</span>
		{#if enabled && onDisable}
			<button
				onclick={onDisable}
				class="font-mono text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase transition-colors hover:text-[var(--color-parchment-200)]"
				title="Turn off analysis"
			>
				off
			</button>
		{/if}
	</div>

	{#if !enabled}
		<p class="font-serif text-xs text-[var(--color-parchment-500)] italic">Analysis is off.</p>
	{:else if error}
		<p class="text-xs text-[var(--color-oxblood-300)]">{error}</p>
	{:else if booting}
		<p class="font-serif text-xs text-[var(--color-parchment-500)] italic">
			Warming up the engine…
		</p>
	{:else if !info}
		<p class="font-serif text-xs text-[var(--color-parchment-500)] italic">Thinking…</p>
	{:else}
		<div class="mb-1.5 flex items-baseline gap-3">
			<span class="font-mono text-[2rem] leading-none tabular-nums {scoreTone}"
				>{formatScore(info)}</span
			>
			<span class="font-mono text-[11px] tracking-wider text-[var(--color-parchment-500)] uppercase"
				>d{info.depth}{info.seldepth ? `/${info.seldepth}` : ''}</span
			>
		</div>
		{#if pv.length > 0}
			<div
				class="mt-2 flex flex-wrap gap-x-1.5 gap-y-0.5 rounded-[3px] border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2 font-mono text-[13px] leading-6"
			>
				{#each pv as step, i (i)}
					{@const prefix = moveNumberPrefix(i)}
					{#if prefix}
						<span class="text-[var(--color-parchment-500)]">{prefix}</span>
					{/if}
					<button
						type="button"
						onclick={() => applyTo(i)}
						disabled={!onselect}
						class="text-[var(--color-parchment-100)] transition-colors hover:text-[var(--color-brass-300)] disabled:cursor-default disabled:hover:text-[var(--color-parchment-100)]"
						title={onselect ? `Play up to ${step.san} into the tree` : undefined}
					>
						{step.san}
					</button>
				{/each}
			</div>
			{#if onselect}
				<p class="mt-2 font-serif text-[11px] text-[var(--color-parchment-500)] italic">
					Click a move to add the line up to there.
				</p>
			{/if}
		{/if}
	{/if}
</div>
