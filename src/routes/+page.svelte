<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { ArrowRight, Plus, AlertTriangle, RotateCcw, BookOpen, Play, Zap } from 'lucide-svelte';

	import { listRepertoires } from '$lib/storage/repertoires';
	import { countDue, countCards } from '$lib/storage/cards';
	import { countDueIdeaCards } from '$lib/storage/ideaCards';
	import { filterActiveMistakes, listMistakes } from '$lib/storage/mistakes';
	import { nodesMap } from '$lib/storage/nodes';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import { Button, Badge } from '$lib/ui';
	import type { Repertoire, StoredMistake, AppSettings } from '$lib/types';
	import type { RecommendedGame } from '$lib/walkthrough/recommend';

	let reps = $state<Repertoire[]>([]);
	let loaded = $state(false);
	let pending = $state<StoredMistake[]>([]);
	let totalDue = $state(0);
	let totalCards = $state(0);
	let recommend = $state<RecommendedGame | null>(null);
	let recommendLoading = $state(false);

	onMount(async () => {
		reps = await listRepertoires();
		let due = 0;
		let cards = 0;
		for (const r of reps) {
			due += await countDue(r.id);
			due += await countDueIdeaCards(r.id);
			cards += await countCards(r.id);
		}
		totalDue = due;
		totalCards = cards;
		pending = await filterActiveMistakes(await listMistakes({ status: 'pending' }));
		loaded = true;

		// Kick off the walkthrough recommendation async — not required for the
		// initial paint, and each probe hits the explorer so we don't want to
		// block the dashboard on it.
		if (reps.length > 0) {
			void loadRecommendation();
			void scanNewGamesSinceLastVisit();
		}
	});

	/**
	 * Dashboard-load mistake auto-scan. Sweeps every configured account
	 * (OAuth Lichess + the extras added in Settings → Additional accounts),
	 * filtered to games played after `lastScannedGameAt` so each visit
	 * only does incremental work. Silent — results surface in the
	 * pending banner.
	 */
	async function scanNewGamesSinceLastVisit() {
		try {
			const settings = await getSettings();
			const { scanAllAccounts, collectAccountsFromSettings } =
				await import('$lib/lichess/mistakeScan');
			const accounts = collectAccountsFromSettings(settings);
			if (accounts.length === 0) return;
			const { saveSettings } = await import('$lib/storage/settings');
			const since = settings.lastScannedGameAt ? settings.lastScannedGameAt + 1 : undefined;
			const result = await scanAllAccounts(settings, {
				maxGamesPerAccount: 50,
				rated: true,
				since
			});
			let latestGameAt = settings.lastScannedGameAt ?? 0;
			for (const pa of result.perAccount) {
				if (pa.result && pa.result.latestGameAt > latestGameAt)
					latestGameAt = pa.result.latestGameAt;
			}
			const next: AppSettings = {
				...settings,
				lastMistakeScanAt: Date.now(),
				lastScannedGameAt: latestGameAt || settings.lastScannedGameAt
			};
			await saveSettings(JSON.parse(JSON.stringify(next)));
			if (result.totalNewlyAdded > 0) {
				pending = await filterActiveMistakes(await listMistakes({ status: 'pending' }));
			}
		} catch {
			/* silent — don't nag the user on the dashboard */
		}
	}

	async function loadRecommendation() {
		recommendLoading = true;
		try {
			const settings: AppSettings = await getSettings();
			const token = effectiveLichessToken(settings);
			const { recommendDeepGames } = await import('$lib/walkthrough/recommend');
			const { viewedWalkthroughGameIds } = await import('$lib/walkthrough/viewed');
			const full = await Promise.all(
				reps.map(async (r) => ({
					id: r.id,
					name: r.name,
					color: r.color,
					rootFen: r.rootFen,
					rootFenKey: r.rootFenKey,
					nodes: await nodesMap(r.id)
				}))
			);
			const recs = await recommendDeepGames({
				reps: full,
				token: token || undefined,
				limit: 12,
				maxProbes: 15
			});
			if (recs.length > 0) {
				// Prefer games the user hasn't opened yet — once they've
				// walked through one, surfacing it again on the next visit
				// just nags them with the same suggestion. Fall back to the
				// full pool only when every candidate has been seen.
				const seen = viewedWalkthroughGameIds(settings);
				const fresh = recs.filter((r) => !seen.has(r.game.id));
				const pool = fresh.length > 0 ? fresh : recs;
				// Pick one seeded by today's UTC date so the same recommendation
				// is stable across refreshes on the same day, and rolls over
				// once a day automatically.
				const today = new Date().toISOString().slice(0, 10);
				let h = 0;
				for (let i = 0; i < today.length; i++) h = ((h << 5) - h + today.charCodeAt(i)) | 0;
				recommend = pool[Math.abs(h) % pool.length];
			}
		} catch {
			/* silent — not worth surfacing a failure on the dashboard */
		} finally {
			recommendLoading = false;
		}
	}

	const pendingByRep = $derived.by(() => {
		const map = new SvelteMap<string, { name: string; count: number }>();
		for (const m of pending) {
			const prev = map.get(m.repertoireId);
			if (prev) prev.count += 1;
			else map.set(m.repertoireId, { name: m.repertoireName, count: 1 });
		}
		return [...map.entries()].map(([id, v]) => ({ id, ...v }));
	});
</script>

<div class="mx-auto max-w-3xl px-4 pt-10 pb-10 sm:px-6 sm:pt-16 sm:pb-12">
	<div class="stagger">
		<h1
			class="font-serif text-[2.75rem] leading-[1.02] tracking-tight sm:text-5xl md:text-6xl"
			style:--i="1"
		>
			Your openings,
			<br />
			<em class="font-serif text-[var(--color-brass-300)]">remembered.</em>
		</h1>

		<p class="mt-5 max-w-md text-base text-[var(--color-parchment-400)]" style:--i="2">
			Build a repertoire as a move tree. Drill it with spaced repetition.
		</p>

		<div class="mt-7 flex flex-wrap gap-2" style:--i="3">
			{#if loaded && reps.length > 0}
				<Button href="{base}/drill" size="md" variant="primary">
					<Zap class="size-3.5" />
					<span>Quick drill{totalDue > 0 ? ` · ${totalDue} due` : ''}</span>
				</Button>
			{/if}
			<Button
				href="{base}/library"
				size="md"
				variant={loaded && reps.length > 0 ? 'outline' : 'primary'}
			>
				<BookOpen class="size-3.5" />
				<span>Open library</span>
			</Button>
			<Button href="{base}/repertoire/new" size="md" variant="outline">
				<Plus class="size-3.5" />
				<span>New repertoire</span>
			</Button>
		</div>
	</div>

	{#if loaded && reps.length > 0}
		<!--
			Stats grid. Mobile: 3 compact cards still fit on one row; the
			numbers scale down from 3xl to 2xl so a 4-digit count doesn't
			overflow on 320-px wide screens. Padding also tightens.
		-->
		<div class="mt-8 grid grid-cols-3 gap-2 sm:mt-10 sm:gap-3">
			<a
				href={resolve('/library')}
				class="ink-panel rounded-[4px] p-3 transition-colors hover:bg-[var(--color-ink-850)] sm:p-4"
			>
				<div class="eyebrow text-[9.5px] sm:text-[10.5px]">Repertoires</div>
				<div
					class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums sm:text-3xl"
				>
					{reps.length}
				</div>
			</a>
			<div class="ink-panel rounded-[4px] p-3 sm:p-4">
				<div class="eyebrow text-[9.5px] sm:text-[10.5px]">Due today</div>
				<div
					class="mt-1 font-serif text-2xl tabular-nums sm:text-3xl"
					class:text-[var(--color-brass-300)]={totalDue > 0}
					class:text-[var(--color-parchment-50)]={totalDue === 0}
				>
					{totalDue}
				</div>
			</div>
			<div class="ink-panel rounded-[4px] p-3 sm:p-4">
				<div class="eyebrow text-[9.5px] sm:text-[10.5px]">Cards stored</div>
				<div
					class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)] tabular-nums sm:text-3xl"
				>
					{totalCards}
				</div>
			</div>
		</div>
	{/if}

	{#if loaded && pending.length > 0}
		<div
			class="ink-panel mt-6 border-[var(--color-oxblood-400)]/30 bg-[var(--color-oxblood-500)]/5 p-4"
		>
			<div class="flex items-start gap-3">
				<AlertTriangle class="mt-0.5 size-5 shrink-0 text-[var(--color-oxblood-300)]" />
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
						<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">
							<span class="text-[var(--color-oxblood-300)]">{pending.length}</span>
							opening {pending.length === 1 ? 'mistake' : 'mistakes'} to retrain
						</h2>
						<a
							href={resolve('/mistakes')}
							class="eyebrow shrink-0 text-[var(--color-parchment-400)] transition-colors hover:text-[var(--color-parchment-100)]"
						>
							Review all →
						</a>
					</div>
					<p class="mt-1 font-serif text-xs text-[var(--color-parchment-500)] italic">
						Detected from your recent Lichess games, grouped by repertoire.
					</p>
					<div class="mt-3 flex flex-wrap gap-1.5">
						{#each pendingByRep as g (g.id)}
							<a
								href={resolve(`/repertoire/${g.id}/drill?mode=retrain`)}
								class="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-oxblood-400)]/40 bg-[var(--color-oxblood-500)]/10 px-2.5 py-1 font-mono text-xs text-[var(--color-oxblood-300)] transition-colors hover:bg-[var(--color-oxblood-500)]/20"
							>
								<RotateCcw class="size-3" />
								<span class="max-w-[140px] truncate sm:max-w-[160px]">{g.name}</span>
								<span>({g.count})</span>
							</a>
						{/each}
					</div>
				</div>
			</div>
		</div>
	{/if}

	{#if loaded && reps.length > 0}
		<div class="mt-6">
			{#if recommend}
				<a
					href={resolve(
						`/walkthrough?gameId=${recommend.game.id}&repertoireId=${recommend.repertoireId}`
					)}
					class="group ink-panel block rounded-[4px] border-[var(--color-brass-400)]/20 bg-[var(--color-brass-500)]/5 p-4 transition-colors hover:bg-[var(--color-brass-500)]/10"
				>
					<div class="flex items-start gap-3">
						<Play class="mt-0.5 size-5 shrink-0 text-[var(--color-brass-300)]" />
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
								<div class="eyebrow text-[var(--color-brass-300)]">Recommended walkthrough</div>
								<Badge variant="brass">{recommend.depth} ply match</Badge>
							</div>
							<h2
								class="mt-1 font-serif text-lg leading-tight text-[var(--color-parchment-50)] transition-colors group-hover:text-[var(--color-brass-300)] sm:text-xl"
							>
								{recommend.game.white.name}
								<span class="text-[var(--color-parchment-500)]">vs</span>
								{recommend.game.black.name}
								{#if recommend.game.year}
									<span class="font-mono text-sm text-[var(--color-parchment-400)]">
										({recommend.game.year})
									</span>
								{/if}
							</h2>
							<p class="mt-1 font-serif text-xs text-[var(--color-parchment-500)] italic">
								Follows <em class="text-[var(--color-parchment-300)]">{recommend.repertoireName}</em
								>
								for {recommend.depth} plies. Good chance to see how masters played past your prep.
							</p>
						</div>
						<ArrowRight
							class="mt-1 hidden size-4 shrink-0 text-[var(--color-parchment-400)] transition-all group-hover:translate-x-0.5 group-hover:text-[var(--color-brass-300)] sm:block"
						/>
					</div>
				</a>
			{:else if recommendLoading}
				<div
					class="ink-panel rounded-[4px] border-dashed p-4 text-sm text-[var(--color-parchment-500)]"
				>
					<div class="flex items-center gap-2">
						<Play class="size-4 opacity-50" />
						<span class="font-serif italic">Finding a game that follows your prep…</span>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
