<script lang="ts">
	import { goto } from '$app/navigation';
	import { base, resolve } from '$app/paths';
	import { page } from '$app/state';
	import { ArrowRight, BookOpen, Link as LinkIcon, RefreshCw } from 'lucide-svelte';

	import { parseRepertoirePgn } from '$lib/chess/pgn';
	import { startOAuth, tokenIsFresh, tokenHasStudyScopes, STUDY_SCOPES } from '$lib/lichess/oauth';
	import {
		fetchStudyPgn,
		listMyStudies,
		parseStudyIdInput,
		type LichessStudyMeta
	} from '$lib/lichess/studies';
	import { mergeLinesIntoRepertoire } from '$lib/storage/importPgn';
	import { createRepertoire, listRepertoires, setLichessStudyLink } from '$lib/storage/repertoires';
	import { getSettings } from '$lib/storage/settings';
	import { Button, DashboardBacklink, Input, Label, Separator } from '$lib/ui';
	import type { AppSettings, Color, LichessStudyLink } from '$lib/types';

	let settings = $state<AppSettings | null>(null);
	let loading = $state(true);

	let studyList = $state<LichessStudyMeta[] | null>(null);
	let studyListLoading = $state(false);

	let selectedStudyId = $state<string | null>(null);
	let selectedStudyName = $state('');
	let manualIdInput = $state('');

	let name = $state('');
	let color: Color = $state('white');
	let linkForSync = $state(true);

	let submitting = $state(false);
	let status = $state<string | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		(async () => {
			loading = true;
			settings = await getSettings();
			loading = false;
		})();
	});

	const oauth = $derived(settings?.lichessOAuth ?? null);
	const connected = $derived(tokenIsFresh(oauth));
	const hasScopes = $derived(tokenHasStudyScopes(oauth));
	const ready = $derived(connected && hasScopes);

	let autoLoaded = $state(false);
	$effect(() => {
		if (!ready || autoLoaded) return;
		autoLoaded = true;
		void loadStudies();
	});

	async function reconnectForScopes() {
		// Land back on the import-study page rather than /settings so the
		// user can immediately resume picking a study after reconnecting.
		const returnTo = page.url.pathname + page.url.search + page.url.hash;
		await startOAuth([...STUDY_SCOPES], returnTo);
	}

	async function loadStudies() {
		if (!oauth?.accessToken || !oauth.username) {
			error = 'Lichess username unknown — reconnect Lichess from Settings.';
			return;
		}
		studyListLoading = true;
		error = null;
		try {
			studyList = await listMyStudies(oauth.accessToken, oauth.username);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to list studies.';
		} finally {
			studyListLoading = false;
		}
	}

	function pickStudy(s: LichessStudyMeta) {
		selectedStudyId = s.id;
		selectedStudyName = s.name;
		if (!name.trim()) name = s.name;
		manualIdInput = '';
	}

	function applyManualId() {
		const id = parseStudyIdInput(manualIdInput);
		if (!id) {
			error = `That doesn't look like a study ID or URL.`;
			return;
		}
		error = null;
		selectedStudyId = id;
		selectedStudyName = id;
		if (!name.trim()) name = id;
	}

	const canSubmit = $derived(
		!submitting && !!selectedStudyId && !!name.trim() && !!oauth?.accessToken
	);

	async function onImport(e: Event) {
		e.preventDefault();
		if (!canSubmit || !selectedStudyId || !oauth?.accessToken) return;
		submitting = true;
		error = null;
		status = 'Fetching study PGN…';
		try {
			const pgn = await fetchStudyPgn(oauth.accessToken, selectedStudyId);
			if (!pgn.trim()) throw new Error('Study is empty — nothing to import.');

			status = 'Parsing chapters…';
			const lines = parseRepertoirePgn(pgn);
			if (lines.length === 0) throw new Error('No valid games found in the study PGN.');

			const first = lines[0];

			// De-dup guard: if a repertoire is already linked to this study
			// (same id + colour), re-import into it instead of minting a fresh
			// UUID. Without this, re-importing an updated study produces a
			// duplicate repertoire — and with sync enabled that duplicate then
			// propagates to every device. Edges merge by FEN, so re-applying
			// the study's lines onto the existing rep is idempotent-safe.
			const existing = (await listRepertoires()).find(
				(r) => r.lichessStudy?.studyId === selectedStudyId && r.color === color
			);
			let rep = existing;
			if (rep) {
				status = 'Updating linked repertoire…';
			} else {
				status = 'Creating repertoire…';
				rep = await createRepertoire(name, color, first.rootFen);
			}

			await mergeLinesIntoRepertoire(rep.id, color, rep.rootFenKey, lines);

			if (linkForSync) {
				const link: LichessStudyLink = {
					studyId: selectedStudyId,
					studyName: selectedStudyName || selectedStudyId,
					chapterIds: [],
					lastSyncedAt: Date.now(),
					lastSyncDirection: 'pull'
				};
				await setLichessStudyLink(rep.id, link);
			}

			await goto(resolve(`/repertoire/${rep.id}`));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed.';
			status = null;
			submitting = false;
		}
	}
</script>

<div class="stagger relative mx-auto max-w-2xl px-6 pt-14 pb-12">
	<DashboardBacklink />

	<div class="eyebrow mb-3" style:--i="1">From a study</div>

	<h1 class="font-serif text-5xl leading-[1.05] tracking-tight" style:--i="2">
		Pull a <em class="text-[var(--color-brass-300)]">Lichess study</em>.
	</h1>

	<p class="mt-3 max-w-md text-[var(--color-parchment-400)]" style:--i="3">
		Every chapter, every variation — imported as one repertoire. Transpositions merge; chapters that
		start from a different position are skipped.
	</p>

	{#if loading}
		<p class="mt-10 text-sm text-[var(--color-parchment-400)]">Loading…</p>
	{:else if !connected}
		<div
			class="ink-panel mt-10 flex flex-col gap-3 p-5"
			style="background-color: color-mix(in oklab, var(--color-brass-500) 8%, var(--color-ink-900));"
			style:--i="4"
		>
			<h2 class="font-serif text-lg">Connect Lichess first</h2>
			<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
				OAuth is needed so private studies work. You'll be asked to grant read-and-write access to
				studies — write is optional, but it lets you push updates back later without reconnecting.
			</p>
			<div>
				<Button variant="primary" size="md" onclick={reconnectForScopes}>
					<LinkIcon class="size-3.5" />
					<span>Connect Lichess</span>
				</Button>
			</div>
		</div>
	{:else if !hasScopes}
		<div
			class="ink-panel mt-10 flex flex-col gap-3 p-5"
			style="background-color: color-mix(in oklab, var(--color-brass-500) 8%, var(--color-ink-900));"
			style:--i="4"
		>
			<h2 class="font-serif text-lg">Reconnect to authorise studies</h2>
			<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
				Your current Lichess token doesn't include study access. Reconnecting re-runs the OAuth flow
				and requests <code class="rounded bg-[var(--color-ink-800)] px-1 font-mono text-xs"
					>study:read</code
				>
				and
				<code class="rounded bg-[var(--color-ink-800)] px-1 font-mono text-xs">study:write</code>.
			</p>
			<div>
				<Button variant="primary" size="md" onclick={reconnectForScopes}>
					<RefreshCw class="size-3.5" />
					<span>Reconnect with study access</span>
				</Button>
			</div>
		</div>
	{:else}
		<form onsubmit={onImport} class="mt-10 space-y-8" style:--i="4">
			<section class="ink-panel p-5">
				<div class="mb-2 flex items-center gap-2">
					<div class="eyebrow">
						Your studies{#if studyList}
							<span class="ml-2 font-mono text-[var(--color-parchment-500)] normal-case">
								{studyList.length}
							</span>
						{/if}
					</div>
					<button
						type="button"
						onclick={loadStudies}
						disabled={studyListLoading}
						aria-label="Reload studies"
						title="Reload studies"
						class="flex size-7 items-center justify-center rounded-[3px] text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)] disabled:opacity-50"
					>
						<RefreshCw class="size-3.5 {studyListLoading ? 'animate-spin' : ''}" />
					</button>
				</div>

				{#if studyListLoading && !studyList}
					<p class="font-serif text-xs text-[var(--color-parchment-500)] italic">
						Loading your studies…
					</p>
				{:else if studyList && studyList.length > 0}
					<ul class="divide-y divide-[var(--color-ink-800)] border-y border-[var(--color-ink-800)]">
						{#each studyList as s (s.id)}
							{@const active = selectedStudyId === s.id}
							<li>
								<button
									type="button"
									onclick={() => pickStudy(s)}
									class="flex w-full items-center gap-3 py-2 text-left transition-colors {active
										? 'text-[var(--color-brass-300)]'
										: 'text-[var(--color-parchment-100)] hover:text-[var(--color-parchment-50)]'}"
								>
									<BookOpen
										class="size-3.5 shrink-0 {active
											? 'text-[var(--color-brass-300)]'
											: 'text-[var(--color-parchment-500)]'}"
									/>
									<span class="min-w-0 flex-1 truncate font-serif text-sm">{s.name}</span>
									{#if s.updatedAt}
										<span
											class="hidden font-mono text-[11px] text-[var(--color-parchment-500)] tabular-nums sm:inline"
										>
											{new Date(s.updatedAt).toLocaleDateString()}
										</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{:else if studyList}
					<p class="text-sm text-[var(--color-parchment-500)]">
						No studies on this account yet. Paste a URL below to import a shared one.
					</p>
				{/if}

				<Separator class="my-4" />

				<div>
					<Label for="study-id">Or paste study URL / ID</Label>
					<div class="flex gap-2">
						<Input
							id="study-id"
							bind:value={manualIdInput}
							placeholder="https://lichess.org/study/abc12345"
							class="font-mono text-[13px]"
							onkeydown={(e: KeyboardEvent) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									applyManualId();
								}
							}}
						/>
						<Button
							variant="outline"
							size="md"
							onclick={applyManualId}
							disabled={!manualIdInput.trim()}
							type="button"
						>
							<LinkIcon class="size-3.5" />
							<span>Use</span>
						</Button>
					</div>
					<p class="mt-2 font-serif text-xs text-[var(--color-parchment-500)] italic">
						Works for any study you can open on Lichess — yours, a friend's, or a public one.
					</p>
				</div>

				{#if selectedStudyId}
					<div
						class="mt-4 flex items-center gap-2 rounded-[4px] border border-[var(--color-brass-300)]/40 bg-[var(--color-brass-300)]/5 px-3 py-2"
					>
						<BookOpen class="size-3.5 text-[var(--color-brass-300)]" />
						<span class="min-w-0 flex-1 truncate font-serif text-sm">{selectedStudyName}</span>
						<span class="font-mono text-[11px] text-[var(--color-parchment-500)]"
							>{selectedStudyId}</span
						>
					</div>
				{/if}
			</section>

			<div>
				<Label for="name">Repertoire title</Label>
				<Input
					id="name"
					bind:value={name}
					required
					placeholder="Defaults to the study name"
					class="h-12 font-serif text-base"
				/>
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

			<label
				class="flex cursor-pointer items-start gap-3 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)]/50 p-3"
			>
				<input
					type="checkbox"
					bind:checked={linkForSync}
					class="mt-0.5 accent-[var(--color-brass-300)]"
				/>
				<div class="min-w-0">
					<div class="font-serif text-sm text-[var(--color-parchment-100)]">
						Link the study for later push/pull
					</div>
					<p class="mt-0.5 font-serif text-xs text-[var(--color-parchment-500)] italic">
						You can sync the new repertoire back to this study from its page — or uncheck to keep
						them independent.
					</p>
				</div>
			</label>

			{#if status}
				<p class="font-mono text-xs text-[var(--color-olive-300)]">{status}</p>
			{/if}
			{#if error}
				<p class="text-sm text-[var(--color-oxblood-300)]">{error}</p>
			{/if}

			<div class="flex items-center gap-3">
				<Button type="submit" variant="primary" size="lg" disabled={!canSubmit}>
					<span>{submitting ? 'Importing…' : 'Import'}</span>
					<ArrowRight class="size-4" />
				</Button>
				<Button href="{base}/repertoire/new" variant="ghost" size="lg">Cancel</Button>
			</div>
		</form>
	{/if}
</div>
