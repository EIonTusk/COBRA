<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		ArrowLeft,
		ArrowDownCircle,
		ArrowUpCircle,
		ExternalLink,
		Link as LinkIcon,
		Plus,
		RefreshCw,
		Unlink
	} from 'lucide-svelte';

	import { getRepertoire, setLichessStudyLink } from '$lib/storage/repertoires';
	import { nodesMap, replaceRepertoireTree } from '$lib/storage/nodes';
	import { getCard, upsertCard } from '$lib/storage/cards';
	import { createFreshCard } from '$lib/fsrs/scheduler';
	import { colorToMove } from '$lib/chess/fen';
	import { parseRepertoirePgn, chapterizeRepertoire, type ExportNode } from '$lib/chess/pgn';
	import { getSettings } from '$lib/storage/settings';
	import { startOAuth, tokenIsFresh, tokenHasStudyScopes, STUDY_SCOPES } from '$lib/lichess/oauth';
	import {
		createStudy,
		deleteChapter,
		fetchStudyPgn,
		importPgnToStudy,
		listChapters,
		listMyStudies,
		parseStudyIdInput,
		type LichessStudyMeta,
		type StudyVisibility
	} from '$lib/lichess/studies';
	import { Button, Input, Label, Separator, confirmDialog } from '$lib/ui';
	import type { AppSettings, LichessStudyChapter, LichessStudyLink, Repertoire } from '$lib/types';

	let rep = $state<Repertoire | null>(null);
	let settings = $state<AppSettings | null>(null);
	let loading = $state(true);

	let studyList = $state<LichessStudyMeta[] | null>(null);
	let studyListLoading = $state(false);
	let manualIdInput = $state('');

	let busy = $state(false);
	let status = $state<string | null>(null);
	let error = $state<string | null>(null);

	// Inline "create new study" form. Shown when the user clicks "Create
	// new"; hidden again on cancel or successful create.
	let createOpen = $state(false);
	let createName = $state('');
	let createVisibility = $state<StudyVisibility>('private');
	let creating = $state(false);

	$effect(() => {
		const id = page.params.id;
		if (!id) return;
		(async () => {
			loading = true;
			rep = (await getRepertoire(id)) ?? null;
			settings = await getSettings();
			loading = false;
		})();
	});

	// Connected Lichess OAuth state, for the gate in the template. All
	// study sync requires OAuth (no personal-token fallback: Lichess's
	// personal tokens don't carry the study: scopes unless created with
	// them, and the UI for pasting scoped tokens is more fiddly than
	// just pushing the user through the one-click OAuth flow).
	const oauth = $derived(settings?.lichessOAuth ?? null);
	const connected = $derived(tokenIsFresh(oauth));
	const hasScopes = $derived(tokenHasStudyScopes(oauth));
	const ready = $derived(connected && hasScopes);

	// Fire an initial study-list fetch the moment OAuth scopes look good and
	// nothing is linked yet. Users were previously forced to click "Load my
	// studies" before they could do anything — no reason to make them.
	let autoLoaded = $state(false);
	$effect(() => {
		if (!ready || autoLoaded) return;
		if (rep?.lichessStudy) {
			// Already linked — don't pre-fetch the picker list; they'll see
			// the push/pull view instead.
			autoLoaded = true;
			return;
		}
		autoLoaded = true;
		void loadStudies();
	});

	async function reconnectForScopes() {
		// startOAuth navigates away; we don't come back to this function.
		await startOAuth([...STUDY_SCOPES]);
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

	function openCreateForm() {
		createName = rep?.name ?? '';
		createVisibility = 'private';
		createOpen = true;
		error = null;
	}

	function cancelCreate() {
		createOpen = false;
	}

	async function submitCreate() {
		if (!rep || !oauth?.accessToken || creating) return;
		const name = createName.trim();
		if (name.length < 2) {
			error = 'Study name must be at least 2 characters.';
			return;
		}
		creating = true;
		busy = true;
		error = null;
		status = 'Creating study on Lichess…';
		try {
			const { id } = await createStudy(oauth.accessToken, {
				name,
				visibility: createVisibility
			});
			await connect(id, name);
			createOpen = false;

			// Lichess creates an empty "Chapter 1" on study creation. Fetch
			// the study PGN, parse the chapter ID out of its [Site ...]
			// header, and hand the ID to doPush so it gets deleted as part
			// of the same delete-then-import pass. If the listing call fails
			// we still push — the user will just have an empty chapter they
			// can remove manually on Lichess.
			let initialChapterIds: string[] = [];
			try {
				status = 'Preparing study…';
				const chapters = await listChapters(oauth.accessToken, id);
				initialChapterIds = chapters.map((c) => c.id);
			} catch (e) {
				console.warn('Could not list initial chapters:', e);
			}

			await doPush(initialChapterIds);
			// Refresh the picker list so the newly-created study would show
			// up if the user unlinks later.
			void loadStudies();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create study.';
			status = null;
		} finally {
			creating = false;
			busy = false;
		}
	}

	async function connect(studyId: string, studyName: string) {
		if (!rep) return;
		const link: LichessStudyLink = {
			studyId,
			studyName,
			chapters: []
		};
		await setLichessStudyLink(rep.id, link);
		rep = { ...rep, lichessStudy: link };
		status = `Linked to study "${studyName}".`;
		setTimeout(() => (status = null), 3000);
	}

	async function connectFromInput() {
		const id = parseStudyIdInput(manualIdInput);
		if (!id) {
			error = `That doesn't look like a study ID or URL.`;
			return;
		}
		// We don't know the name yet — a pull will fill it in from PGN, or
		// the user can rename via the picker. Default to the ID.
		await connect(id, id);
		manualIdInput = '';
	}

	async function disconnect() {
		if (!rep) return;
		const ok = await confirmDialog({
			title: 'Unlink this study?',
			message: 'Your repertoire stays put — only the link to the Lichess study is removed.',
			confirmLabel: 'Unlink'
		});
		if (!ok) return;
		await setLichessStudyLink(rep.id, null);
		rep = { ...rep, lichessStudy: null };
	}

	async function sha256Hex(text: string): Promise<string> {
		const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
		return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * Core upload routine shared by the explicit Push button and the auto-
	 * push triggered right after a fresh Create. Builds chapterized PGN from
	 * the local tree, hashes each chapter, and diffs against the records
	 * stored from the last push:
	 *
	 *   - same name + same hash  → reuse; don't touch Lichess.
	 *   - same name, hash changed → delete the old chapter ID(s) for that
	 *     name, upload the new PGN.
	 *   - name is new            → upload.
	 *   - name disappeared       → delete the old chapter ID(s).
	 *
	 * `alsoDeleteIds` is used by the fresh-Create flow to strip the
	 * auto-generated "Chapter 1" Lichess makes on study creation. Links
	 * written by pre-diff-sync builds carry `chapterIds` instead of
	 * `chapters`; we can't match those by name, so the first push after
	 * upgrade falls back to full delete-then-reupload and transitions the
	 * link to the new format for subsequent pushes.
	 */
	async function doPush(alsoDeleteIds: string[] = []): Promise<void> {
		if (!rep || !rep.lichessStudy || !oauth?.accessToken) return;
		const link = rep.lichessStudy;
		const nmap = await nodesMap(rep.id);
		const exportMap = new SvelteMap<string, ExportNode>();
		for (const [k, v] of nmap) {
			exportMap.set(k, {
				fenKey: v.fenKey,
				comment: v.comment,
				nags: v.nags,
				children: v.children
			});
		}

		status = 'Chapterizing…';
		const chapters = chapterizeRepertoire(
			exportMap,
			rep.rootFenKey,
			rep.rootFen,
			rep.name,
			rep.color
		);
		const hashed = await Promise.all(
			chapters.map(async (c) => ({ ...c, hash: await sha256Hex(c.pgn) }))
		);

		// Group prior chapters by name. One local chapter may map to several
		// Lichess chapter IDs if importPgnToStudy split the PGN; grouping by
		// name keeps them together so the diff treats them as one unit.
		const priorByName = new SvelteMap<string, LichessStudyChapter[]>();
		for (const c of link.chapters ?? []) {
			const arr = priorByName.get(c.name) ?? [];
			arr.push(c);
			priorByName.set(c.name, arr);
		}
		const legacyDeleteIds = link.chapters?.length ? [] : (link.chapterIds ?? []);

		const keep: LichessStudyChapter[] = [];
		const toUpload: typeof hashed = [];
		const toDelete: string[] = [...legacyDeleteIds, ...alsoDeleteIds];

		for (const ch of hashed) {
			const priorGroup = priorByName.get(ch.name);
			const unchanged = priorGroup && priorGroup.every((p) => p.hash === ch.hash);
			if (priorGroup && unchanged) {
				keep.push(...priorGroup);
			} else if (priorGroup) {
				for (const p of priorGroup) toDelete.push(p.id);
				toUpload.push(ch);
			} else {
				toUpload.push(ch);
			}
			priorByName.delete(ch.name);
		}
		// Anything still in priorByName is a chapter whose name no longer
		// exists locally — drop it from Lichess too.
		for (const group of priorByName.values()) {
			for (const p of group) toDelete.push(p.id);
		}

		if (toDelete.length > 0) {
			status = `Removing ${toDelete.length} old chapter${toDelete.length === 1 ? '' : 's'}…`;
			for (const id of toDelete) {
				try {
					await deleteChapter(oauth.accessToken, link.studyId, id);
				} catch (e) {
					console.warn('Previous-chapter delete failed:', e);
				}
			}
		}

		const uploaded: LichessStudyChapter[] = [];
		let i = 0;
		for (const ch of toUpload) {
			i += 1;
			status = `Uploading chapter ${i}/${toUpload.length} — ${ch.name}…`;
			const created = await importPgnToStudy(
				oauth.accessToken,
				link.studyId,
				ch.pgn,
				ch.name,
				rep.color
			);
			for (const c of created) {
				uploaded.push({ id: c.id, name: ch.name, hash: ch.hash });
			}
		}

		const updated: LichessStudyLink = {
			...link,
			chapters: [...keep, ...uploaded],
			chapterIds: [],
			lastSyncedAt: Date.now(),
			lastSyncDirection: 'push'
		};
		await setLichessStudyLink(rep.id, updated);
		rep = { ...rep, lichessStudy: updated };

		const kept = keep.length > 0 ? `${keep.length} unchanged` : '';
		const pushed = toUpload.length > 0 ? `${toUpload.length} updated` : kept ? '' : '0 changes';
		const parts = [pushed, kept].filter(Boolean);
		status = parts.length > 0 ? `Pushed · ${parts.join(', ')}.` : 'Pushed.';
	}

	async function push() {
		if (!rep || !settings || !rep.lichessStudy || !oauth?.accessToken || busy) return;
		const ok = await confirmDialog({
			title: 'Push to Lichess study?',
			message:
				'Uploads only the chapters that changed since the last push; unchanged chapters are left alone. Chapters you created manually on Lichess are not touched.',
			confirmLabel: 'Push'
		});
		if (!ok) return;
		busy = true;
		error = null;
		try {
			await doPush();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Push failed.';
			status = null;
		} finally {
			busy = false;
			setTimeout(() => (status = null), 5000);
		}
	}

	async function pull() {
		if (!rep || !settings || !rep.lichessStudy || !oauth?.accessToken || busy) return;
		const ok = await confirmDialog({
			title: 'Pull from Lichess study?',
			message:
				"This replaces the local tree with the study's current content. FSRS history for positions still in the tree is kept; cards for positions no longer present are dropped.",
			confirmLabel: 'Pull and replace',
			variant: 'destructive'
		});
		if (!ok) return;
		busy = true;
		error = null;
		status = 'Fetching study PGN…';
		try {
			const pgn = await fetchStudyPgn(oauth.accessToken, rep.lichessStudy.studyId);
			if (!pgn.trim()) throw new Error('Study is empty — nothing to pull.');
			status = 'Parsing…';
			const lines = parseRepertoirePgn(pgn);
			if (lines.length === 0) throw new Error('No valid games found in the study PGN.');
			// Only merge games whose starting FEN matches this repertoire's
			// root. Chapters with a different initial position (custom FEN
			// puzzles, unrelated openings) are skipped rather than silently
			// re-rooting the tree.
			const matching = lines.filter((l) => l.rootFenKey === rep!.rootFenKey);
			if (matching.length === 0) {
				throw new Error(
					`No chapters in this study start from the repertoire's root position. (Found ${lines.length} chapter${lines.length === 1 ? '' : 's'} with different starts.)`
				);
			}
			const edges = matching.flatMap((l) => l.edges);

			status = 'Rewriting local tree…';
			await replaceRepertoireTree(rep.id, rep.rootFenKey, edges);

			// Seed fresh FSRS cards for any parent-position move the user is
			// responsible for that didn't already have one. Mirrors how
			// /import does it.
			for (const { fromFenKey, edge } of edges) {
				if (colorToMove(fromFenKey) !== rep.color) continue;
				const existing = await getCard(rep.id, fromFenKey);
				if (!existing) {
					await upsertCard(createFreshCard(rep.id, fromFenKey, edge.san));
				}
			}

			const updated: LichessStudyLink = {
				...rep.lichessStudy,
				lastSyncedAt: Date.now(),
				lastSyncDirection: 'pull'
			};
			await setLichessStudyLink(rep.id, updated);
			rep = { ...rep, lichessStudy: updated };
			status = `Pulled · ${edges.length} edges across ${matching.length} chapter${matching.length === 1 ? '' : 's'}.`;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Pull failed.';
			status = null;
		} finally {
			busy = false;
			setTimeout(() => (status = null), 5000);
		}
	}

	function fmtSync(link: LichessStudyLink | null | undefined): string {
		if (!link || !link.lastSyncedAt) return 'Never synced.';
		const when = new Date(link.lastSyncedAt).toLocaleString();
		const dir = link.lastSyncDirection === 'push' ? 'Pushed' : 'Pulled';
		return `${dir} ${when}`;
	}
</script>

<div class="mx-auto max-w-2xl px-6 pt-12 pb-16">
	{#if loading}
		<p class="text-sm text-[var(--color-parchment-400)]">Loading…</p>
	{:else if !rep}
		<p class="text-[var(--color-oxblood-300)]">Repertoire not found.</p>
		<a href={resolve('/library')} class="text-[var(--color-brass-300)] underline">Back to library</a
		>
	{:else}
		<a
			href={resolve(`/repertoire/${rep.id}`)}
			class="eyebrow mb-5 inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
		>
			<ArrowLeft class="size-3" />
			<span class="max-w-[240px] truncate">{rep.name}</span>
		</a>

		<div class="eyebrow mb-3">Lichess study</div>
		<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
			Sync with a <em class="text-[var(--color-brass-300)]">study</em>.
		</h1>
		<p class="mt-3 max-w-md text-[var(--color-parchment-400)]">
			Link this repertoire to a Lichess study — private or public — then push the tree into it or
			pull the study back onto your local copy.
		</p>

		<!-- OAuth gate -->
		{#if !connected}
			<div
				class="ink-panel mt-10 flex flex-col gap-3 p-5"
				style="background-color: color-mix(in oklab, var(--color-brass-500) 8%, var(--color-ink-900));"
			>
				<h2 class="font-serif text-lg">Connect Lichess first</h2>
				<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
					Sync uses OAuth so private studies work. You'll be asked to grant access to read and write
					studies.
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
			>
				<h2 class="font-serif text-lg">Reconnect to authorise studies</h2>
				<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
					Your current Lichess token doesn't include study access. Reconnecting re-runs the OAuth
					flow and requests <code class="rounded bg-[var(--color-ink-800)] px-1 font-mono text-xs"
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
		{/if}

		{#if ready}
			<!-- Connection card -->
			<section class="ink-panel mt-10 p-5">
				{#if rep.lichessStudy}
					<div class="mb-3 flex items-start justify-between gap-3">
						<div class="min-w-0">
							<div class="eyebrow mb-1">Linked study</div>
							<div class="flex items-baseline gap-2">
								<span class="truncate font-serif text-xl">
									{rep.lichessStudy.studyName || rep.lichessStudy.studyId}
								</span>
								<a
									href={`https://lichess.org/study/${rep.lichessStudy.studyId}`}
									target="_blank"
									rel="noopener"
									class="inline-flex items-center gap-0.5 font-mono text-xs text-[var(--color-brass-300)] underline underline-offset-2 hover:text-[var(--color-brass-200)]"
								>
									open<ExternalLink class="size-2.5" />
								</a>
							</div>
							<div class="mt-1 font-mono text-xs text-[var(--color-parchment-500)]">
								{rep.lichessStudy.studyId}
							</div>
							<div class="mt-1 font-serif text-xs text-[var(--color-parchment-500)] italic">
								{fmtSync(rep.lichessStudy)}
							</div>
						</div>
						<Button variant="ghost" size="sm" onclick={disconnect}>
							<Unlink class="size-3.5" />
							<span>Unlink</span>
						</Button>
					</div>

					<Separator class="my-4" />

					<div class="grid gap-3 sm:grid-cols-2">
						<Button variant="primary" size="md" onclick={push} disabled={busy}>
							<ArrowUpCircle class="size-4" />
							<span>Push to study</span>
						</Button>
						<Button variant="secondary" size="md" onclick={pull} disabled={busy}>
							<ArrowDownCircle class="size-4" />
							<span>Pull from study</span>
						</Button>
					</div>

					<p class="mt-3 font-serif text-xs text-[var(--color-parchment-500)] italic">
						<strong>Push</strong> uploads only the chapters that changed since the last push;
						unchanged chapters are left alone. <strong>Pull</strong> overwrites the local tree with the
						study. FSRS history is preserved for positions that remain.
					</p>
				{:else}
					<div class="eyebrow mb-2">Connect a study</div>
					<p class="mb-4 font-serif text-sm text-[var(--color-parchment-400)] italic">
						Create a new study, pick an existing one, or paste a study URL / ID.
					</p>

					<!-- Inline create-study form -->
					{#if createOpen}
						<div
							class="ink-panel mb-5 flex flex-col gap-3 p-4"
							style="background-color: color-mix(in oklab, var(--color-brass-500) 6%, var(--color-ink-900));"
						>
							<div class="eyebrow">New Lichess study</div>
							<div>
								<Label for="create-name">Name</Label>
								<Input
									id="create-name"
									bind:value={createName}
									placeholder="e.g. My London System"
									maxlength={100}
									onkeydown={(e: KeyboardEvent) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											submitCreate();
										}
									}}
								/>
							</div>
							<div>
								<Label>Visibility</Label>
								<div
									role="radiogroup"
									aria-label="Visibility"
									class="grid grid-cols-3 gap-0 overflow-hidden rounded-[5px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-0.5"
								>
									{#each [{ id: 'private', label: 'Private', hint: 'Members only' }, { id: 'unlisted', label: 'Unlisted', hint: 'With link' }, { id: 'public', label: 'Public', hint: 'Listed' }] as opt (opt.id)}
										{@const active = createVisibility === (opt.id as StudyVisibility)}
										<button
											type="button"
											role="radio"
											aria-checked={active}
											onclick={() => (createVisibility = opt.id as StudyVisibility)}
											class="flex flex-col items-center justify-center rounded-[4px] py-2 transition-colors {active
												? 'bg-[var(--color-brass-300)] text-[var(--color-ink-950)]'
												: 'text-[var(--color-parchment-200)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]'}"
										>
											<span class="text-[13px] font-medium tracking-tight">{opt.label}</span>
											<span
												class="mt-0.5 font-mono text-[10px] tracking-wider uppercase {active
													? 'text-[var(--color-ink-950)]/70'
													: 'text-[var(--color-parchment-500)]'}"
											>
												{opt.hint}
											</span>
										</button>
									{/each}
								</div>
							</div>
							<p class="font-serif text-xs text-[var(--color-parchment-500)] italic">
								Engine and explorer stay owner-only; cloning is off. Tweak on Lichess later if you
								want to share.
							</p>
							<div class="flex items-center gap-2">
								<Button
									variant="primary"
									size="md"
									onclick={submitCreate}
									disabled={creating || createName.trim().length < 2}
								>
									<Plus class="size-3.5" />
									<span>{creating ? 'Creating…' : 'Create and link'}</span>
								</Button>
								<Button variant="ghost" size="md" onclick={cancelCreate} disabled={creating}>
									Cancel
								</Button>
							</div>
						</div>
					{/if}

					<!-- Your studies: loaded on mount, click a row to link. -->
					<div class="mb-5">
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
							<div class="ml-auto">
								{#if !createOpen}
									<Button variant="outline" size="sm" onclick={openCreateForm}>
										<Plus class="size-3.5" />
										<span>Create new</span>
									</Button>
								{/if}
							</div>
						</div>

						{#if studyListLoading && !studyList}
							<p class="font-serif text-xs text-[var(--color-parchment-500)] italic">
								Loading your studies…
							</p>
						{:else if studyList && studyList.length > 0}
							<ul
								class="divide-y divide-[var(--color-ink-800)] border-y border-[var(--color-ink-800)]"
							>
								{#each studyList as s (s.id)}
									<li class="flex items-center gap-3 py-2">
										<span class="min-w-0 flex-1 truncate font-serif text-sm">{s.name}</span>
										{#if s.updatedAt}
											<span
												class="hidden font-mono text-[11px] text-[var(--color-parchment-500)] tabular-nums sm:inline"
											>
												{new Date(s.updatedAt).toLocaleDateString()}
											</span>
										{/if}
										<button
											type="button"
											onclick={() => connect(s.id, s.name)}
											class="inline-flex items-center gap-1 font-mono text-[11px] tracking-wider text-[var(--color-brass-300)] uppercase transition-colors hover:text-[var(--color-brass-200)]"
										>
											<LinkIcon class="size-3" />
											<span>Link</span>
										</button>
									</li>
								{/each}
							</ul>
						{:else if studyList}
							<p class="text-sm text-[var(--color-parchment-500)]">
								No studies on this account yet. Create one above to get started.
							</p>
						{/if}
					</div>

					<Separator class="my-4" />

					<!-- Manual ID/URL input -->
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
										connectFromInput();
									}
								}}
							/>
							<Button
								variant="primary"
								size="md"
								onclick={connectFromInput}
								disabled={!manualIdInput.trim()}
							>
								<LinkIcon class="size-3.5" />
								<span>Link</span>
							</Button>
						</div>
						<p class="mt-2 font-serif text-xs text-[var(--color-parchment-500)] italic">
							A Lichess study ID is the 8-character slug from the URL. Private studies work as long
							as you're a member.
						</p>
					</div>
				{/if}
			</section>
		{/if}

		{#if status}
			<p class="mt-4 font-mono text-xs text-[var(--color-olive-300)]">{status}</p>
		{/if}
		{#if error}
			<p class="mt-4 font-mono text-xs text-[var(--color-oxblood-300)]">{error}</p>
		{/if}
	{/if}
</div>
