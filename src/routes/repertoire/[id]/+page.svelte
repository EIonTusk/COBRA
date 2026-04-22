<script lang="ts">
	import { page } from '$app/state';
	import { base, resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import {
		AlertTriangle,
		BookOpen,
		Bookmark,
		Bot,
		Gauge,
		Pencil,
		Play,
		Download,
		ExternalLink,
		LineChart,
		Link as LinkIcon,
		Share2,
		Trash2,
		Type,
		Settings,
		UserCheck
	} from 'lucide-svelte';

	import {
		getRepertoire,
		deleteRepertoire,
		renameRepertoire,
		setCoverageGoal,
		saveCoverageSnapshot,
		setStartingPosition
	} from '$lib/storage/repertoires';
	import { furthestNonBranchingFenKey, pathToFenKey } from '$lib/tree/traversal';
	import type { RepertoireNode } from '$lib/types';
	import { countCards, countDue, countMistakeCards, listCards } from '$lib/storage/cards';
	import { countDueIdeaCards } from '$lib/storage/ideaCards';
	import { nodesMap } from '$lib/storage/nodes';
	import { buildShareBundle, encodeShare } from '$lib/storage/share';
	import { computeCoverage, COVERAGE_GOALS } from '$lib/tree/coverage';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import { listSparGames } from '$lib/storage/sparGames';
	import { reconcileAllPending } from '$lib/lichess/sparReview';
	import { loadDossierReport } from '$lib/storage/dossierReport';
	import { Button, DashboardBacklink, Separator, Input, Select, confirmDialog } from '$lib/ui';
	import type { AppSettings, Card, CoverageSnapshot, Repertoire, SparGame } from '$lib/types';

	let rep = $state<Repertoire | null>(null);
	let total = $state(0);
	let due = $state(0);
	let mistakes = $state(0);
	let nodeCount = $state(0);
	let loading = $state(true);
	let editingName = $state(false);
	let draftName = $state('');
	let settings = $state<AppSettings | null>(null);
	let computing = $state(false);
	let coverageStatus = $state<string | null>(null);
	// Settings gear popover — replaces the previous "More" menu. Holds
	// repertoire-level admin actions (rename/export/share/sync/delete),
	// separated from the body's action rail so actions and admin don't
	// blur into a single overlong row.
	let gearMenuOpen = $state(false);
	let shareStatus = $state<string | null>(null);
	let shareBusy = $state(false);
	let sparGames = $state<SparGame[]>([]);
	let sparReconciling = $state(false);

	// Review-rail tile data. Populated alongside the main mount effect.
	let masteredPct = $state<number | null>(null);
	let hasStyleScan = $state(false);

	// Analysis-gate state for the starting-position panel. `repNodes` is
	// the full node map — only used to (a) resolve the auto-detected
	// furthest-non-branching position and (b) build the SAN label for
	// whichever gate is active. Re-fetched on every page visit alongside
	// `nodeCount`.
	let repNodes = $state<Map<string, RepertoireNode>>(new Map());

	$effect(() => {
		const id = page.params.id;
		if (!id) return;
		loading = true;
		(async () => {
			const fetched = await getRepertoire(id);
			rep = fetched ?? null;
			if (fetched) {
				total = await countCards(id);
				due = (await countDue(id)) + (await countDueIdeaCards(id));
				mistakes = await countMistakeCards(id);
				const nodes = await nodesMap(id);
				nodeCount = nodes.size;
				repNodes = nodes;
				// Retention-tile headline: share of cards that have graduated
				// past the learning phase (same tiering rule as the full
				// /retention view). Null when the rep has no cards yet — the
				// tile switches to a "start drilling" prompt in that case.
				const cards = await listCards(id);
				masteredPct = computeMasteredPct(cards);
			}
			settings = await getSettings();
			sparGames = fetched ? await listSparGames(fetched.id, 6) : [];
			// Style-advice tile: presence of a cached dossier report gates
			// whether the tile shows a "view" link or a "run scan" prompt.
			try {
				const saved = await loadDossierReport();
				hasStyleScan = !!saved?.payload;
			} catch {
				hasStyleScan = false;
			}
			loading = false;

			// Fire post-game reconciliation in the background: any pending
			// spar game whose Lichess PGN is ready gets its result + any
			// deviation recorded, then the strip refreshes. Non-blocking
			// so the page doesn't wait on Lichess round-trips to render.
			if (fetched && sparGames.some((g) => g.status === 'pending')) {
				void (async () => {
					sparReconciling = true;
					try {
						const token = settings ? effectiveLichessToken(settings) : null;
						const username = settings?.lichessOAuth?.username;
						await reconcileAllPending({
							token: token ?? undefined,
							username: username ?? undefined
						});
						sparGames = await listSparGames(fetched.id, 6);
						// Mistakes may have been added — refresh the count.
						mistakes = await countMistakeCards(fetched.id);
					} finally {
						sparReconciling = false;
					}
				})();
			}
		})();
	});

	function formatAgo(ms: number): string {
		const diff = Date.now() - ms;
		if (diff < 60_000) return 'just now';
		const min = Math.floor(diff / 60_000);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const d = Math.floor(hr / 24);
		if (d < 30) return `${d}d ago`;
		return new Date(ms).toLocaleDateString();
	}

	async function copyShareUrl() {
		if (!rep || shareBusy) return;
		shareBusy = true;
		shareStatus = 'Building share link…';
		try {
			const bundle = await buildShareBundle(rep.id);
			if (!bundle) throw new Error('Repertoire not found');
			const data = await encodeShare(bundle);
			const url = `${window.location.origin}${base}/import-share#data=${data}`;
			try {
				await navigator.clipboard.writeText(url);
				shareStatus = `Link copied · ${Math.ceil(url.length / 1024)} KB`;
			} catch {
				// Clipboard blocked (e.g. non-secure context). Surface the
				// URL inline so the user can copy it by hand.
				shareStatus = url;
			}
		} catch (e) {
			shareStatus = e instanceof Error ? e.message : 'Share failed';
		} finally {
			shareBusy = false;
			setTimeout(() => (shareStatus = null), 6000);
		}
	}

	async function onCoverageGoalChange(goal: number | null) {
		if (!rep) return;
		await setCoverageGoal(rep.id, goal);
		rep = { ...rep, coverageGoal: goal, coverageSnapshot: null };
	}

	async function onComputeCoverage() {
		if (!rep || !rep.coverageGoal || !settings || computing) return;
		const token = effectiveLichessToken(settings);
		if (!token) {
			coverageStatus = 'Connect Lichess or paste a token in Settings first.';
			setTimeout(() => (coverageStatus = null), 3500);
			return;
		}
		computing = true;
		coverageStatus = 'Probing explorer…';
		try {
			const nodes = await nodesMap(rep.id);
			const snap = await computeCoverage(
				{
					rootFen: rep.rootFen,
					rootFenKey: rep.rootFenKey,
					color: rep.color,
					goal: rep.coverageGoal
				},
				nodes,
				(key) => {
					const parts = key.split(' ');
					return parts.length === 4 ? `${key} 0 1` : key;
				},
				{
					speeds: settings.explorerSpeeds,
					ratings: settings.explorerRatings,
					token,
					onProgress: (p) => {
						coverageStatus = `Probed ${p} positions…`;
					}
				}
			);
			await saveCoverageSnapshot(rep.id, snap);
			rep = { ...rep, coverageSnapshot: snap };
			coverageStatus = null;
		} catch (e) {
			coverageStatus = e instanceof Error ? e.message : 'Coverage computation failed.';
			setTimeout(() => (coverageStatus = null), 4000);
		} finally {
			computing = false;
		}
	}

	// Effective analysis gate for this rep. Auto mode → furthest
	// non-branching node from the root (updates automatically as the
	// tree grows). Pinned → the fenKey the user chose in the builder.
	const effectiveStartingFenKey = $derived.by<string>(() => {
		if (!rep) return '';
		if (rep.startingFenKey) return rep.startingFenKey;
		if (repNodes.size === 0) return rep.rootFenKey;
		return furthestNonBranchingFenKey(repNodes, rep.rootFenKey);
	});
	const startingIsPinned = $derived(!!rep?.startingFenKey);
	const startingIsRoot = $derived(!!rep && effectiveStartingFenKey === rep.rootFenKey);
	/**
	 * Human-readable move sequence from root to the gate position —
	 * "1.e4 e5 2.Nf3" style. Falls back to "opening position" when
	 * the gate is the root (auto mode on a rep with no trunk, or a
	 * rep whose root already branches).
	 */
	const startingLineLabel = $derived.by<string>(() => {
		if (!rep || !effectiveStartingFenKey) return '';
		if (startingIsRoot) return 'opening position';
		const edges = pathToFenKey(repNodes, rep.rootFenKey, effectiveStartingFenKey);
		if (!edges || edges.length === 0) return 'opening position';
		const parts: string[] = [];
		for (let i = 0; i < edges.length; i++) {
			const san = edges[i].san;
			if (i % 2 === 0) parts.push(`${Math.floor(i / 2) + 1}.${san}`);
			else parts[parts.length - 1] += ` ${san}`;
		}
		return parts.join(' ');
	});

	async function switchStartingToAuto() {
		if (!rep) return;
		await setStartingPosition(rep.id, undefined);
		rep = { ...rep, startingFenKey: undefined };
	}

	function coverageLabel(snap: CoverageSnapshot | null | undefined): string {
		if (!snap) return 'Not measured.';
		if (snap.needed === 0) return 'No threshold-popular lines — tree is trivially covered.';
		return `${snap.covered} of ${snap.needed} frequent branches covered`;
	}

	function coverageRatio(snap: CoverageSnapshot | null | undefined): number {
		if (!snap) return 0;
		return Math.max(0, Math.min(1, snap.ratio));
	}

	async function onDelete() {
		if (!rep) return;
		const ok = await confirmDialog({
			title: `Delete "${rep.name}"?`,
			message: 'This removes the whole repertoire: positions, drill cards, FSRS history — the lot.',
			confirmLabel: 'Delete',
			variant: 'destructive'
		});
		if (!ok) return;
		await deleteRepertoire(rep.id);
		await goto(resolve(`/library`));
	}

	function handleKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && gearMenuOpen) {
			e.preventDefault();
			gearMenuOpen = false;
		}
	}

	/**
	 * Share of cards past the "learning" phase — mirrors the classifier in
	 * /retention so both views agree on what "mastered" means. Lapses >= 3
	 * demotes back to struggling; FSRS state 1/3 or <14-day stability still
	 * counts as learning. Returns null when there's nothing to measure.
	 */
	function computeMasteredPct(cards: Card[]): number | null {
		if (cards.length === 0) return null;
		let mastered = 0;
		for (const c of cards) {
			const stability = typeof c.fsrs.stability === 'number' ? c.fsrs.stability : 0;
			const lapses = c.fsrs.lapses ?? 0;
			const state = c.fsrs.state;
			if (lapses >= 3) continue;
			if (state === 1 || state === 3 || stability < 14) continue;
			if (stability < 60 || lapses > 0) continue;
			mastered += 1;
		}
		return Math.round((mastered / cards.length) * 100);
	}

	async function saveName() {
		if (!rep) return;
		await renameRepertoire(rep.id, draftName);
		rep = { ...rep, name: draftName.trim() || rep.name };
		editingName = false;
	}

	function fmtDate(ts: number): string {
		return new Date(ts).toLocaleDateString(undefined, {
			month: 'long',
			day: 'numeric',
			year: 'numeric'
		});
	}
</script>

<svelte:window on:keydown={handleKey} />

{#if loading}
	<div class="mx-auto max-w-4xl px-6 pt-16">
		<p class="text-sm text-[var(--color-parchment-400)]">Loading…</p>
	</div>
{:else if !rep}
	<div class="mx-auto max-w-4xl px-6 pt-16">
		<p class="text-[var(--color-oxblood-300)]">Repertoire not found.</p>
		<a href={resolve('/')} class="text-[var(--color-brass-300)] underline underline-offset-4"
			>Back to library</a
		>
	</div>
{:else}
	<div class="stagger relative mx-auto max-w-4xl px-6 pt-12 pb-16">
		<DashboardBacklink class="mb-6 xl:top-12" href="{base}/library" label="Library" />

		<!--
			Header row. Title is inline-editable: click the h1 to swap it for
			an input (the old Rename menu item is now redundant but stays in
			the gear menu for discoverability). The gear at the right opens a
			popover with admin/distribution actions — replaces the former
			"More" button so the action rail below can stay focused on verbs.
			`relative z-40` creates a stacking context above the Coverage
			panel's z-20 (it runs its own <Select> z-index for its dropdown)
			so the gear popover doesn't disappear behind later sections.
		-->
		<div class="relative z-40 flex items-start gap-4" style:--i="1">
			<div class="min-w-0 flex-1">
				<div class="eyebrow mb-2">
					<span class="capitalize">{rep.color}</span> · opened {fmtDate(rep.createdAt)}
				</div>
				{#if editingName}
					<Input
						bind:value={draftName}
						onblur={saveName}
						onkeydown={(e) =>
							e.key === 'Enter' ? saveName() : e.key === 'Escape' ? (editingName = false) : null}
						class="h-14 font-serif text-4xl"
						autofocus
					/>
				{:else}
					<button
						type="button"
						onclick={() => {
							draftName = rep!.name;
							editingName = true;
						}}
						title="Click to rename"
						class="group flex max-w-full items-center gap-3 text-left"
					>
						<h1 class="truncate font-serif text-[2.75rem] leading-none tracking-tight md:text-5xl">
							{rep.name}
						</h1>
						<Pencil
							class="size-4 shrink-0 text-[var(--color-parchment-500)] opacity-0 transition-opacity group-hover:opacity-100"
							strokeWidth={1.75}
						/>
					</button>
				{/if}
			</div>

			<!-- Gear menu (admin + distribution). -->
			<div class="relative shrink-0">
				<button
					type="button"
					onclick={() => (gearMenuOpen = !gearMenuOpen)}
					aria-haspopup="menu"
					aria-expanded={gearMenuOpen}
					title="Settings"
					class="flex size-9 items-center justify-center rounded-[4px] border border-[var(--color-ink-700)] text-[var(--color-parchment-400)] transition-colors hover:border-[var(--color-ink-600)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
				>
					<Settings class="size-4" strokeWidth={1.75} />
				</button>
				{#if gearMenuOpen}
					<button
						type="button"
						aria-label="Close menu"
						class="fixed inset-0 z-30"
						onclick={() => (gearMenuOpen = false)}
					></button>
					<div
						role="menu"
						class="absolute top-full right-0 z-50 mt-1 w-60 overflow-hidden rounded-[4px] border border-[var(--color-ink-700)] shadow-[var(--shadow-lg)]"
						style:background-color="var(--color-ink-900)"
					>
						<button
							type="button"
							role="menuitem"
							onclick={() => {
								gearMenuOpen = false;
								draftName = rep!.name;
								editingName = true;
							}}
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]"
						>
							<Type class="size-3.5 text-[var(--color-parchment-400)]" />
							<span>Rename</span>
						</button>
						<a
							role="menuitem"
							href={resolve(`/repertoire/${rep.id}/export`)}
							class="flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]"
							onclick={() => (gearMenuOpen = false)}
						>
							<Download class="size-3.5 text-[var(--color-parchment-400)]" />
							<span>Export PGN</span>
						</a>
						<button
							type="button"
							role="menuitem"
							disabled={shareBusy}
							onclick={() => {
								gearMenuOpen = false;
								void copyShareUrl();
							}}
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)] disabled:opacity-60"
						>
							<Share2 class="size-3.5 text-[var(--color-parchment-400)]" />
							<span>Copy share link</span>
						</button>
						<a
							role="menuitem"
							href={resolve(`/repertoire/${rep.id}/lichess-sync`)}
							class="flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--color-parchment-200)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]"
							onclick={() => (gearMenuOpen = false)}
						>
							<LinkIcon class="size-3.5 text-[var(--color-parchment-400)]" />
							<span>
								{rep.lichessStudy ? 'Lichess study · linked' : 'Link Lichess study'}
							</span>
						</a>
						<div class="border-t border-[var(--color-ink-800)]"></div>
						<button
							type="button"
							role="menuitem"
							onclick={() => {
								gearMenuOpen = false;
								void onDelete();
							}}
							class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--color-oxblood-300)] transition-colors hover:bg-[var(--color-oxblood-500)]/15"
						>
							<Trash2 class="size-3.5" />
							<span>Delete repertoire</span>
						</button>
					</div>
				{/if}
			</div>
		</div>

		<!--
			Primary action trio. Drill / Edit tree / Browse are the three
			things the user is here to do — equal real estate at the top
			of the page, stats folded inline so the old three-panel stat
			row isn't needed. Drill tints brass when due; Edit and Browse
			stay ink-neutral so the eye still lands on Drill first when
			there's work to do. On mobile all three stack (Drill first).
			`md:grid-cols-3` avoids cramming three tiles into <640px
			viewports where the subtitles would wrap ugly.
		-->
		<div class="mt-8 grid gap-3 md:grid-cols-3" style:--i="2">
			<!-- Drill hero: primary CTA. Brass-tinted when there are cards
				 due now, subdued when the queue is empty. Stat line folds
				 `due` + `total` into one descriptor so the separate stats
				 row can go away. -->
			<a
				href={resolve(`/repertoire/${rep.id}/drill`)}
				class="ink-panel group flex min-h-[7rem] items-center justify-between gap-4 rounded-[4px] px-5 py-5 transition-colors"
				class:border-[var(--color-brass-400)]={due > 0}
				class:hover:bg-[var(--color-brass-500)]={due > 0}
				class:bg-[var(--color-ink-900)]={due === 0}
				class:hover:bg-[var(--color-ink-850)]={due === 0}
				style:background-color={due > 0
					? 'color-mix(in oklab, var(--color-brass-500) 12%, var(--color-ink-900))'
					: undefined}
			>
				<div class="flex min-w-0 items-center gap-4">
					<span
						class="flex size-12 shrink-0 items-center justify-center rounded-full"
						class:bg-[var(--color-brass-300)]={due > 0}
						class:text-[var(--color-ink-950)]={due > 0}
						class:bg-[var(--color-ink-800)]={due === 0}
						class:text-[var(--color-parchment-300)]={due === 0}
					>
						<Play class="size-5" strokeWidth={2.5} />
					</span>
					<div class="flex min-w-0 flex-col">
						<span class="font-serif text-2xl leading-none text-[var(--color-parchment-50)]">
							Drill
						</span>
						<span
							class="mt-1.5 flex flex-col gap-0.5 font-mono text-[11px] leading-tight tracking-wider text-[var(--color-parchment-400)] uppercase tabular-nums"
						>
							{#if due > 0}
								<span class="text-[var(--color-brass-200)]">{due} due now</span>
								<span>{total} total</span>
							{:else if total > 0}
								<span>Nothing due</span>
								<span>{total} cards</span>
							{:else}
								<span>Empty — edit tree first</span>
							{/if}
						</span>
					</div>
				</div>
				<span class="eyebrow transition-colors" class:!text-[var(--color-brass-200)]={due > 0}>
					Start →
				</span>
			</a>

			<!-- Edit hero: secondary but equally prominent. Pencil in a
				 subtle brass-tint circle so it reads as "action" without
				 competing with the drill CTA for attention. -->
			<a
				href={resolve(`/repertoire/${rep.id}/edit`)}
				class="ink-panel group flex min-h-[7rem] items-center justify-between gap-4 rounded-[4px] bg-[var(--color-ink-900)] px-5 py-5 transition-colors hover:bg-[var(--color-ink-850)]"
			>
				<div class="flex min-w-0 items-center gap-4">
					<span
						class="flex size-12 shrink-0 items-center justify-center rounded-full bg-[var(--color-ink-800)] text-[var(--color-brass-300)]"
					>
						<Pencil class="size-5" strokeWidth={2} />
					</span>
					<div class="flex min-w-0 flex-col">
						<span class="font-serif text-2xl leading-none text-[var(--color-parchment-50)]">
							Edit tree
						</span>
						<span
							class="mt-1.5 flex flex-col gap-0.5 font-mono text-[11px] leading-tight tracking-wider text-[var(--color-parchment-400)] uppercase tabular-nums"
						>
							<span>{nodeCount} positions</span>
							<span>Updated {formatAgo(rep.updatedAt)}</span>
						</span>
					</div>
				</div>
				<span class="eyebrow transition-colors group-hover:text-[var(--color-parchment-200)]">
					Open →
				</span>
			</a>

			<!-- Browse hero: read-only tour. BookOpen icon in a muted
				 parchment tone — signals "reading" rather than "action."
				 Promoted from a chip because it's the third verb the user
				 reaches for (study a line, don't change it) and deserves
				 parity with Drill / Edit in the main CTA row. -->
			<a
				href={resolve(`/repertoire/${rep.id}/tour`)}
				class="ink-panel group flex min-h-[7rem] items-center justify-between gap-4 rounded-[4px] bg-[var(--color-ink-900)] px-5 py-5 transition-colors hover:bg-[var(--color-ink-850)]"
			>
				<div class="flex min-w-0 items-center gap-4">
					<span
						class="flex size-12 shrink-0 items-center justify-center rounded-full bg-[var(--color-ink-800)] text-[var(--color-parchment-200)]"
					>
						<BookOpen class="size-5" strokeWidth={2} />
					</span>
					<div class="flex min-w-0 flex-col">
						<span class="font-serif text-2xl leading-none text-[var(--color-parchment-50)]">
							Browse
						</span>
						<span
							class="mt-1.5 font-mono text-[11px] tracking-wider text-[var(--color-parchment-400)] uppercase"
						>
							Read-only · autoplay & notes
						</span>
					</div>
				</div>
				<span class="eyebrow transition-colors group-hover:text-[var(--color-parchment-200)]">
					Open →
				</span>
			</a>
		</div>

		<!--
			Quick chip. Mistakes only surfaces when there's something to
			retrain — it's conditional context, not a primary verb, so it
			sits as a small pill under the hero row rather than competing
			with the three main tiles.
		-->
		{#if mistakes > 0}
			<div class="mt-3 flex flex-wrap items-center gap-2" style:--i="3">
				<Button href={`${base}/repertoire/${rep.id}/mistakes`} size="sm" variant="secondary">
					<AlertTriangle class="size-3.5" />
					<span>Mistakes · {mistakes}</span>
				</Button>
			</div>
		{/if}

		{#if sparGames.length > 0}
			{@const analysedGames = sparGames.filter((g) => g.status === 'analysed')}
			{@const offPrepCount = analysedGames.filter((g) => g.result?.deviationPly != null).length}
			<section class="ink-panel mt-6 p-4" style:--i="2">
				<div class="mb-3 flex items-center gap-3">
					<Bot class="size-4 text-[var(--color-brass-300)]" />
					<h2 class="eyebrow">Recent spar</h2>
					{#if analysedGames.length > 0}
						<span class="font-mono text-[11px] text-[var(--color-parchment-500)] tabular-nums">
							{offPrepCount} of {analysedGames.length} left your prep
						</span>
					{/if}
					{#if sparReconciling}
						<span class="ml-auto font-mono text-[10px] text-[var(--color-parchment-500)] italic">
							checking…
						</span>
					{/if}
				</div>
				<ul class="divide-y divide-[var(--color-ink-800)] border-y border-[var(--color-ink-800)]">
					{#each sparGames as g (g.id)}
						{@const outcome = g.result?.outcome}
						{@const outcomeTone =
							outcome === 'win'
								? 'text-[var(--color-olive-300)]'
								: outcome === 'loss'
									? 'text-[var(--color-oxblood-300)]'
									: 'text-[var(--color-parchment-300)]'}
						{@const outcomeLabel =
							outcome === 'win' ? 'W' : outcome === 'loss' ? 'L' : outcome === 'draw' ? '½' : '…'}
						<li class="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 py-2 text-sm">
							<span
								class="flex size-5 items-center justify-center rounded-full border border-[var(--color-ink-700)] font-mono text-[11px] tabular-nums {outcomeTone}"
								title={outcome ?? 'ongoing'}
							>
								{outcomeLabel}
							</span>
							<span class="flex min-w-0 flex-col">
								<span class="truncate font-mono text-[12px] text-[var(--color-parchment-200)]">
									{g.opponentLabel} · {g.userColor}
								</span>
								<span class="font-serif text-[11px] text-[var(--color-parchment-500)] italic">
									{formatAgo(g.startedAt)}{#if g.status === 'pending'}
										· in progress{:else if g.status === 'error'}
										· couldn't fetch PGN{/if}
								</span>
							</span>
							{#if g.result?.deviationPly != null && g.result.deviationFenKey}
								<a
									href={resolve(
										`/repertoire/${rep.id}/edit?jump=${encodeURIComponent(g.result.deviationFenKey)}`
									)}
									title="Jump to the position where you left prep ({g.result
										.deviationPlayedSan} — tree says {g.result.deviationExpectedSan})"
									class="inline-flex items-center gap-1 rounded border border-[var(--color-brass-400)]/40 bg-[var(--color-brass-500)]/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-brass-200)]"
								>
									<AlertTriangle class="size-3" />
									off-tree ply {g.result.deviationPly}
								</a>
							{:else if g.status === 'analysed'}
								<span class="font-mono text-[10px] text-[var(--color-olive-300)]">on tree</span>
							{:else}
								<span></span>
							{/if}
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={g.gameUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-0.5 text-[var(--color-parchment-500)] transition-colors hover:text-[var(--color-brass-300)]"
								title="Open game on Lichess"
							>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<ExternalLink class="size-3" />
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<!-- Coverage panel -->
		<section class="ink-panel relative z-20 mt-6 p-4" style:--i="2">
			<div class="mb-3 flex items-center gap-3">
				<Gauge class="size-4 text-[var(--color-brass-300)]" />
				<h2 class="eyebrow">Coverage goal</h2>
				{#if rep.coverageSnapshot}
					<span
						class="ml-auto font-mono text-[11px] text-[var(--color-parchment-500)] tabular-nums"
					>
						{new Date(rep.coverageSnapshot.computedAt).toLocaleString()}
					</span>
				{/if}
			</div>

			<p class="mb-3 font-serif text-sm text-[var(--color-parchment-400)] italic">
				Cover every opponent line played in at least
				<span class="font-medium text-[var(--color-parchment-100)] not-italic">
					1 in {rep.coverageGoal ?? 100}
				</span>
				games from this opening's root.
			</p>

			<div class="mb-4 flex flex-wrap items-center gap-3">
				<label for="coverage-goal-select" class="eyebrow text-[var(--color-parchment-300)]">
					Threshold
				</label>
				<Select
					id="coverage-goal-select"
					class="min-w-[180px]"
					value={rep.coverageGoal ?? 100}
					onchange={(v) => onCoverageGoalChange(v ?? 100)}
					options={COVERAGE_GOALS.map((g) => ({ value: g, label: `1 in ${g} games` }))}
				/>
			</div>

			{#if rep.coverageGoal}
				<div class="mb-3 flex items-center gap-3">
					<div class="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-ink-800)]">
						<div
							class="h-full bg-[var(--color-brass-300)] transition-[width] duration-500"
							style:width="{Math.round(coverageRatio(rep.coverageSnapshot) * 100)}%"
						></div>
					</div>
					<span class="font-serif text-2xl tabular-nums">
						{Math.round(coverageRatio(rep.coverageSnapshot) * 100)}%
					</span>
				</div>
				<div class="flex items-center gap-3">
					<Button size="sm" variant="secondary" onclick={onComputeCoverage} disabled={computing}>
						<span
							>{computing
								? 'Probing…'
								: rep.coverageSnapshot
									? 'Recompute'
									: 'Compute coverage'}</span
						>
					</Button>
					<span class="flex-1 font-serif text-[11px] text-[var(--color-parchment-500)] italic">
						{coverageStatus ?? coverageLabel(rep.coverageSnapshot)}
						{#if rep.coverageSnapshot?.incomplete}
							<span class="text-[var(--color-brass-300)]"> · partial walk</span>
						{/if}
					</span>
				</div>
			{/if}
		</section>

		<!--
			Analysis starting position. Auto mode picks the furthest
			non-branching node from the root (last forced ply before the
			tree opens up), so a rep with a fixed opening sequence
			auto-gates at the first real choice. Pinning overrides —
			done from the builder's Line strip via the bookmark icon
			next to any trunk ply. Read-only here: this page is the
			repertoire overview, not an editor.
		-->
		<section class="ink-panel mt-6 p-4" style:--i="2">
			<div class="mb-3 flex items-center gap-3">
				<Bookmark
					class="size-4 text-[var(--color-brass-300)]"
					fill={startingIsPinned ? 'currentColor' : 'none'}
					strokeWidth={1.75}
				/>
				<h2 class="eyebrow">Analysis starts from</h2>
				<span
					class="ml-auto rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase tabular-nums"
					class:border-[var(--color-brass-400)]={startingIsPinned}
					class:text-[var(--color-brass-200)]={startingIsPinned}
					class:border-[var(--color-ink-700)]={!startingIsPinned}
					class:text-[var(--color-parchment-400)]={!startingIsPinned}
				>
					{startingIsPinned ? 'Pinned' : 'Auto'}
				</span>
			</div>
			<p class="mb-3 font-serif text-sm text-[var(--color-parchment-400)] italic">
				Games only contribute mistakes and gaps once they reach
				<span class="font-mono text-[13px] text-[var(--color-parchment-100)] not-italic">
					{startingLineLabel}
				</span>.
				{#if !startingIsPinned}
					<span class="text-[var(--color-parchment-500)]">
						Auto-detected — updates as the tree grows.
					</span>
				{/if}
			</p>
			<div class="flex flex-wrap items-center gap-2">
				{#if startingIsPinned}
					<Button
						size="sm"
						variant="secondary"
						onclick={switchStartingToAuto}
						title="Switch back to auto mode (furthest non-branching position from the root)."
					>
						Switch to auto
					</Button>
				{/if}
				<Button
					size="sm"
					variant="secondary"
					href={resolve(`/repertoire/${rep.id}/edit`)}
					title="Pick a different starting position in the builder (bookmark icon on the Line strip)."
				>
					{startingIsPinned ? 'Change in builder' : 'Pin in builder'}
				</Button>
			</div>
		</section>

		<!--
			Review rail. Two analytics tiles promoted out of the old
			"More" menu so progress reads at a glance. Coverage has its
			own full panel below, so it isn't duplicated here.
		-->
		<div class="mt-6 grid gap-3 sm:grid-cols-2" style:--i="4">
			<!-- Retention tile: headline = mastered share. "No data" when
				 the tree has no cards yet. -->
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href={`${base}/repertoire/${rep.id}/retention`}
				class="ink-panel group flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-[var(--color-ink-850)]"
			>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
				<div class="flex min-w-0 items-center gap-3">
					<span
						class="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-olive-500)]/20 text-[var(--color-olive-300)]"
					>
						<LineChart class="size-4" strokeWidth={1.75} />
					</span>
					<div class="min-w-0">
						<div class="eyebrow">Retention</div>
						<div class="mt-1 flex items-baseline gap-2">
							{#if masteredPct === null}
								<span class="font-serif text-lg text-[var(--color-parchment-400)] italic">
									Nothing drilled yet
								</span>
							{:else}
								<span
									class="font-serif text-2xl leading-none text-[var(--color-parchment-50)] tabular-nums"
								>
									{masteredPct}%
								</span>
								<span class="font-mono text-[11px] text-[var(--color-parchment-500)]">
									mastered
								</span>
							{/if}
						</div>
					</div>
				</div>
				<span
					class="eyebrow opacity-60 transition-opacity group-hover:text-[var(--color-parchment-200)] group-hover:opacity-100"
					>↗</span
				>
			</a>

			<!-- Style advice tile: shows a one-line status (scan on file or
				 not) and deep-links to the dossier. Picking the advisor up
				 from the root /dossier route keeps it rep-independent — the
				 advice is computed per-position in the editor, not here. -->
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href={`${base}/dossier`}
				class="ink-panel group flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-[var(--color-ink-850)]"
				title={hasStyleScan
					? 'Dossier scan is on file. Style advice will annotate candidates in the editor.'
					: 'Run a dossier scan to unlock per-move style advice in the editor.'}
			>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
				<div class="flex min-w-0 items-center gap-3">
					<span
						class="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-brass-500)]/20 text-[var(--color-brass-300)]"
					>
						<UserCheck class="size-4" strokeWidth={1.75} />
					</span>
					<div class="min-w-0">
						<div class="eyebrow">Style advice</div>
						<div class="mt-1 font-serif text-lg text-[var(--color-parchment-200)]">
							{hasStyleScan ? 'Scan on file' : 'Not scanned yet'}
						</div>
					</div>
				</div>
				<span
					class="eyebrow opacity-60 transition-opacity group-hover:text-[var(--color-parchment-200)] group-hover:opacity-100"
					>↗</span
				>
			</a>
		</div>

		{#if shareStatus}
			<p
				class="mt-3 font-mono text-[12px] break-all text-[var(--color-parchment-400)] tabular-nums"
			>
				{shareStatus}
			</p>
		{/if}

		<Separator class="mt-10" />

		<div
			class="mt-6 flex items-center gap-4 font-mono text-xs tracking-wider text-[var(--color-parchment-500)] uppercase"
			style:--i="4"
		>
			<span>Updated {fmtDate(rep.updatedAt)}</span>
			<span class="text-[var(--color-ink-600)]">·</span>
			<span>Stored in this browser</span>
		</div>
	</div>
{/if}
