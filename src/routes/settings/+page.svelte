<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { onMount, tick } from 'svelte';
	import { slide } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { ExternalLink, AlertTriangle, Check } from 'lucide-svelte';

	import { getSettings, saveSettings, defaultSettings } from '$lib/storage/settings';
	import { applySoundSettings, playMove, playCorrect, playIncorrect } from '$lib/ui/sounds';
	import { wipeAllData } from '$lib/storage/db';
	import { exportAll, importAll, type LibraryExport } from '$lib/storage/bulk';
	import {
		disconnectOAuth,
		startOAuth,
		tokenIsFresh,
		tokenHasStudyScopes,
		tokenHasChallengeScopes,
		isSafeReturnPath,
		ALL_SCOPES
	} from '$lib/lichess/oauth';
	import {
		Badge,
		Button,
		DashboardBacklink,
		DatePicker,
		Input,
		Label,
		MultiSelect,
		Separator,
		SourceIcon,
		SourceUsernameInput,
		cn,
		confirmDialog,
		toast
	} from '$lib/ui';
	import { sync } from '$lib/sync/syncStore.svelte';
	import {
		listStoredBaselines,
		deleteStoredBaseline,
		type StoredBaselineBucket
	} from '$lib/storage/baselines';
	import { setRuntimeBaselines } from '$lib/dossier/fingerprint';
	import { baselineCalibration } from '$lib/dossier/baselineCalibrationStore.svelte';
	import BaselineCalibrationProgress from '$lib/dossier/BaselineCalibrationProgress.svelte';
	import BoardPiecePicker from '$lib/board/BoardPiecePicker.svelte';
	import { appearance } from '$lib/board/appearance.svelte';
	import type { AppSettings, DrillIntroSpeed, ScanAccount } from '$lib/types';

	const INTRO_SPEEDS: { id: DrillIntroSpeed; label: string; hint: string }[] = [
		{ id: 'off', label: 'Off', hint: 'jump' },
		{ id: 'fast', label: 'Fast', hint: '200 ms' },
		{ id: 'normal', label: 'Normal', hint: '300 ms' },
		{ id: 'slow', label: 'Slow', hint: '400 ms' },
		{ id: 'slowest', label: 'Slowest', hint: '500 ms' }
	];

	// Lichess explorer filter options, matching the /lichess endpoint's
	// accepted values. Same vocabulary Lichess uses on its own explorer panel.
	const SPEED_OPTIONS: { value: string; label: string }[] = [
		{ value: 'ultraBullet', label: 'UltraBullet' },
		{ value: 'bullet', label: 'Bullet' },
		{ value: 'blitz', label: 'Blitz' },
		{ value: 'rapid', label: 'Rapid' },
		{ value: 'classical', label: 'Classical' },
		{ value: 'correspondence', label: 'Correspondence' }
	];
	const RATING_OPTIONS: { value: number; label: string }[] = [
		{ value: 0, label: '<1000' },
		{ value: 1000, label: '1000' },
		{ value: 1200, label: '1200' },
		{ value: 1400, label: '1400' },
		{ value: 1600, label: '1600' },
		{ value: 1800, label: '1800' },
		{ value: 2000, label: '2000' },
		{ value: 2200, label: '2200' },
		{ value: 2500, label: '2500+' }
	];

	let settings = $state<AppSettings | null>(null);
	let savedSnapshot = $state<string>('');
	let saving = $state(false);
	let justSaved = $state(false);
	let showToken = $state(false);
	let newAccountSource = $state<'lichess' | 'chesscom'>('lichess');
	let newAccountUsername = $state('');

	// When another page sends the user here to connect (e.g. the offline
	// banner on the repertoire edit page), it tacks `?return=<path>` onto
	// the URL so the callback can land them back where they started instead
	// of stranding them on /settings. Validate same-origin here so an
	// attacker-crafted `?return=//evil.com` link can't turn the OAuth
	// callback into an open redirect; oauth.ts re-validates at write/read
	// time, but rejecting at the entry point is the cleaner story.
	const lichessReturnTo = $derived.by(() => {
		const r = page.url.searchParams.get('return');
		return isSafeReturnPath(r) ? r : undefined;
	});

	function addScanAccount() {
		if (!settings) return;
		const u = newAccountUsername.trim();
		if (!u) return;
		const list = [...(settings.scanAccounts ?? [])];
		const key = `${newAccountSource}:${u.toLowerCase()}`;
		const oauthKey = settings.lichessOAuth?.username
			? `lichess:${settings.lichessOAuth.username.toLowerCase()}`
			: null;
		if (key === oauthKey || list.some((a) => `${a.source}:${a.username.toLowerCase()}` === key)) {
			newAccountUsername = '';
			return;
		}
		list.push({ source: newAccountSource, username: u });
		settings.scanAccounts = list;
		newAccountUsername = '';
	}

	function removeScanAccount(account: ScanAccount) {
		if (!settings) return;
		settings.scanAccounts = (settings.scanAccounts ?? []).filter(
			(a) => !(a.source === account.source && a.username === account.username)
		);
	}

	function onGamesSinceChange(next: number | undefined) {
		if (!settings) return;
		settings.gamesSince = next;
	}

	interface DisplayedScanAccount extends ScanAccount {
		pinned?: boolean;
	}

	const displayedScanAccounts = $derived.by<DisplayedScanAccount[]>(() => {
		if (!settings) return [];
		const rows: DisplayedScanAccount[] = [];
		const seen = new SvelteSet<string>();
		const oauthName = settings.lichessOAuth?.username?.trim();
		if (oauthName && tokenIsFresh(settings.lichessOAuth)) {
			rows.push({ source: 'lichess', username: oauthName, pinned: true });
			seen.add(`lichess:${oauthName.toLowerCase()}`);
		}
		for (const a of settings.scanAccounts ?? []) {
			const key = `${a.source}:${a.username.toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			rows.push(a);
		}
		return rows;
	});

	let storedBaselines = $state<StoredBaselineBucket[]>([]);
	// Calibration state lives in a module singleton so it survives nav and
	// shows progress in the layout-level BaselineProgressBar. This page
	// just reads from it and proxies start/cancel.
	const baselineBusy = $derived(baselineCalibration.running);
	const baselineError = $derived(baselineCalibration.error);
	let baselineGames = $state(50);
	/** Subset of scan-account keys (`${source}:${lower-user}`) that should
	 *  drive the baseline. Empty = use every configured account. */
	let baselineAccountKeys = $state<string[]>([]);

	const baselineAccountOptions = $derived(
		displayedScanAccounts.map((a) => ({
			value: `${a.source}:${a.username.toLowerCase()}`,
			label: a.username,
			account: { source: a.source, username: a.username }
		}))
	);
	const baselineAccountByValue = $derived(
		new Map(baselineAccountOptions.map((o) => [o.value, o.account]))
	);

	onMount(async () => {
		const s = await getSettings();
		settings = s;
		savedSnapshot = JSON.stringify(s);
		storedBaselines = await listStoredBaselines();
		setRuntimeBaselines(storedBaselines);

		// Hash-anchor scroll fixup: the page body is gated by `{#if settings}`,
		// so the target section (e.g. `#lichess`) doesn't exist on first paint.
		// SvelteKit's built-in scroll-on-navigate has already given up by the
		// time settings load resolves, so we re-attempt the scroll ourselves
		// once the DOM catches up. Using `scrollIntoView` honours the section's
		// `scroll-mt-*` so it lands clear of the sticky header.
		const hash = window.location.hash.replace(/^#/, '');
		if (hash) {
			await tick();
			const el = document.getElementById(hash);
			el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	});

	// Live-apply sound prefs as the user drags the volume slider or toggles
	// the switch, so the preview buttons below (and any sound fired
	// elsewhere) immediately reflect the new values.
	$effect(() => {
		if (!settings) return;
		applySoundSettings({
			soundsEnabled: settings.soundsEnabled,
			soundsVolume: settings.soundsVolume
		});
	});

	async function calibrateNow() {
		if (!settings || baselineBusy) return;
		const scopedAccounts = baselineAccountKeys
			.map((k) => baselineAccountByValue.get(k))
			.filter((a): a is { source: 'lichess' | 'chesscom'; username: string } => !!a);
		// Walk chess.com opponents whenever a chess.com account is in scope,
		// or no scope is set (scan everything the user has configured).
		const includeChesscom =
			scopedAccounts.length === 0 || scopedAccounts.some((a) => a.source === 'chesscom');

		const bucket = await baselineCalibration.start({
			settings,
			gamesPerAccount: baselineGames,
			accountsOverride: scopedAccounts.length > 0 ? scopedAccounts : undefined,
			includeChesscom
		});
		if (bucket) {
			storedBaselines = await listStoredBaselines();
			// `setRuntimeBaselines` already runs inside the store on success;
			// refreshing the local list view here keeps the table in sync.
		}
	}

	function cancelCalibration() {
		baselineCalibration.cancel();
	}

	async function forgetBaseline(id: string) {
		await deleteStoredBaseline(id);
		storedBaselines = await listStoredBaselines();
		setRuntimeBaselines(storedBaselines);
	}

	async function clearAllBaselines() {
		const ok = await confirmDialog({
			title: 'Forget all baselines',
			message:
				'This drops every self-calibrated baseline. The headlines will fall back to the eyeballed default until you calibrate again.',
			confirmLabel: 'Forget all',
			variant: 'destructive'
		});
		if (!ok) return;
		for (const b of storedBaselines) await deleteStoredBaseline(b.id);
		storedBaselines = await listStoredBaselines();
		setRuntimeBaselines(storedBaselines);
	}

	const dirty = $derived(settings ? JSON.stringify(settings) !== savedSnapshot : false);

	async function save() {
		if (!settings || !dirty || saving) return;
		saving = true;
		const snap = $state.snapshot(settings);
		await saveSettings(snap);
		savedSnapshot = JSON.stringify(snap);
		saving = false;
		justSaved = true;
		setTimeout(() => (justSaved = false), 1800);
	}

	function discard() {
		if (!savedSnapshot) return;
		settings = JSON.parse(savedSnapshot);
		// Roll the live preview back too — the user just rejected the
		// in-flight tweaks they were trying out.
		if (settings) {
			appearance.setBoard(settings.boardTheme);
			appearance.setPieces(settings.pieceSet);
		}
	}

	async function restoreDefaults() {
		const ok = await confirmDialog({
			title: 'Restore defaults',
			message: 'Reset every setting to its default? You will still need to save.',
			confirmLabel: 'Restore'
		});
		if (!ok) return;
		settings = defaultSettings();
		appearance.setBoard(settings.boardTheme);
		appearance.setPieces(settings.pieceSet);
	}

	async function wipe() {
		const first = await confirmDialog({
			title: 'Wipe all data',
			message:
				'This deletes every repertoire, every card, every mistake, and every setting. Continue?',
			confirmLabel: 'Wipe',
			variant: 'destructive'
		});
		if (!first) return;
		const second = await confirmDialog({
			title: 'Really?',
			message: 'There is no undo. Export a backup first if you want to keep anything.',
			confirmLabel: 'Yes, wipe everything',
			variant: 'destructive'
		});
		if (!second) return;
		await wipeAllData();
		location.href = `${base}/`;
	}

	let importing = $state(false);
	let importMsg = $state<string | null>(null);

	// Diagnostic-overlay toggle. Read at boot by the inline script in
	// src/app.html via `localStorage['cobra:diag-on']`. When on, trace
	// entries (engine init state, deep-link steps, COI/header probe)
	// paint the on-screen overlay; when off, only genuine errors do.
	// Lets us flip diagnostics on for a single device without shipping
	// a separate debug build.
	const DIAG_OVERLAY_KEY = 'cobra:diag-on';
	let diagOverlay = $state(false);
	onMount(() => {
		try {
			diagOverlay = localStorage.getItem(DIAG_OVERLAY_KEY) === '1';
		} catch {
			/* ignore */
		}
	});
	function toggleDiagOverlay(next: boolean) {
		diagOverlay = next;
		try {
			if (next) localStorage.setItem(DIAG_OVERLAY_KEY, '1');
			else localStorage.removeItem(DIAG_OVERLAY_KEY);
		} catch {
			/* ignore */
		}
	}

	async function onExportAll() {
		const bundle = await exportAll();
		const blob = new Blob([JSON.stringify(bundle, null, 2)], {
			type: 'application/json'
		});
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `cobra-${new Date().toISOString().slice(0, 10)}.cobra`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 5000);
	}

	async function onImportAll(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		const ok = await confirmDialog({
			title: 'Import library',
			message:
				'This wipes everything currently stored and replaces it with the file you picked. Export a backup first if you need to keep what you have.',
			confirmLabel: 'Import and replace',
			variant: 'destructive'
		});
		if (!ok) {
			(e.target as HTMLInputElement).value = '';
			return;
		}
		importing = true;
		importMsg = null;
		try {
			const data = JSON.parse(await file.text()) as LibraryExport;
			await importAll(data, { includeSettings: true });
			importMsg = `Imported ${data.repertoires.length} repertoires, ${data.cards.length} cards.`;
			setTimeout(() => (location.href = `${base}/`), 900);
		} catch (err) {
			importMsg = `Import failed: ${err instanceof Error ? err.message : 'unknown'}`;
		} finally {
			importing = false;
			(e.target as HTMLInputElement).value = '';
		}
	}

	function handleKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 's') {
			e.preventDefault();
			void save();
		}
	}

	// --- Sync (Beta) -----------------------------------------------------
	const syncEnabled = $derived(sync.enabled);
	const syncStatus = $derived(sync.status);
	const syncBusy = $derived(syncStatus === 'pulling' || syncStatus === 'pushing');
	const syncLastPushAt = $derived(sync.lastPushAt);
	const syncLastPullAt = $derived(sync.lastPullAt);
	const syncStudyId = $derived(sync.studyId);
	const syncDirtyCount = $derived(sync.dirty.size);
	const syncError = $derived(sync.error);
	const syncTelemetry = $derived(sync.telemetry);
	let syncBusyLocal = $state(false);

	const lichessReadyForSync = $derived.by(() => {
		if (!settings) return false;
		if (!tokenIsFresh(settings.lichessOAuth)) return false;
		if (!tokenHasStudyScopes(settings.lichessOAuth)) return false;
		return true;
	});

	function fmtAgo(ms: number | null): string {
		if (!ms) return '—';
		const delta = Date.now() - ms;
		if (delta < 60_000) return 'just now';
		if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
		if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
		try {
			return new Date(ms).toLocaleDateString();
		} catch {
			return '—';
		}
	}

	async function enableSync() {
		if (!settings) return;
		syncBusyLocal = true;
		try {
			// First: probe-only enable so we can tell whether remote already
			// has data; we tear that probe down before deciding direction.
			const { remoteHasData } = await sync.enable({ mode: 'fresh' }).catch(async (e) => {
				// enable() with mode:'fresh' will push if remote is empty, but
				// we want to ask the user before clobbering. So: if it failed
				// purely on the probe step, surface the error; otherwise treat
				// success as "first-run pushed up local data".
				throw e;
			});
			if (remoteHasData) {
				const useRemote = await confirmDialog({
					title: 'Existing data on Lichess',
					message:
						'A COBRA Sync study with chapters already exists on Lichess. Pull that data down (replaces local), or overwrite the remote with this device?',
					confirmLabel: 'Pull remote',
					cancelLabel: 'Overwrite remote'
				});
				if (useRemote) {
					await sync.pullAll();
				} else {
					await sync.pushAll();
				}
			}
			settings = await getSettings();
			savedSnapshot = JSON.stringify(settings);
		} catch (e) {
			toast.warn('Couldn’t enable sync', {
				body: e instanceof Error ? e.message : String(e)
			});
		} finally {
			syncBusyLocal = false;
		}
	}

	async function disableSync() {
		const ok = await confirmDialog({
			title: 'Disable sync?',
			message:
				'Stops mirroring this device to your private Lichess study. The study and its data stay on Lichess — re-enable any time to resume. Use “Disconnect & forget” if you also want to wipe the Lichess copy.',
			confirmLabel: 'Disable'
		});
		if (!ok) return;
		await sync.disable();
		settings = await getSettings();
		savedSnapshot = JSON.stringify(settings);
	}

	async function disconnectAndForget() {
		const ok = await confirmDialog({
			title: 'Disconnect and forget?',
			message:
				'Stops sync AND deletes every COBRA-SYNC chapter from your Lichess study. The empty study itself stays — you can delete it on Lichess if you like. Local data is untouched.',
			confirmLabel: 'Disconnect',
			variant: 'destructive'
		});
		if (!ok) return;
		syncBusyLocal = true;
		try {
			await sync.disconnectAndForget();
			settings = await getSettings();
			savedSnapshot = JSON.stringify(settings);
		} finally {
			syncBusyLocal = false;
		}
	}

	async function syncNow() {
		syncBusyLocal = true;
		try {
			await sync.syncNow();
			settings = await getSettings();
			savedSnapshot = JSON.stringify(settings);
		} finally {
			syncBusyLocal = false;
		}
	}
</script>

<svelte:window on:keydown={handleKey} />

<div class="stagger relative mx-auto max-w-2xl px-6 pt-14 pb-40">
	<DashboardBacklink />

	<div class="eyebrow mb-3" style:--i="0">Settings</div>
	<h1 class="font-serif text-5xl leading-[1.05] tracking-tight" style:--i="1">
		Dials &amp; <em class="text-[var(--color-brass-300)]">defaults</em>.
	</h1>
	<p class="mt-3 max-w-md text-[var(--color-parchment-400)]" style:--i="2">
		Tune the drill pace, connect Lichess, or clear the slate.
	</p>

	{#if !settings}
		<p class="mt-10 text-[var(--color-parchment-400)]">Loading…</p>
	{:else}
		<div class="mt-10 space-y-12">
			<!-- Drill section -->
			<section style:--i="3">
				<div class="mb-4 flex items-baseline gap-3">
					<h2 class="font-serif text-2xl">Drill</h2>
					<span class="eyebrow text-[var(--color-parchment-500)]">Pace &amp; scope</span>
				</div>
				<div class="grid gap-5 sm:grid-cols-2">
					<div>
						<Label for="newcap">New cards per session</Label>
						<Input
							id="newcap"
							name="newcap"
							type="number"
							min="0"
							max="200"
							autocomplete="off"
							bind:value={settings.dailyNewCardCap}
							class="font-mono"
						/>
					</div>
					<div>
						<Label for="seshcap">Moves per session</Label>
						<Input
							id="seshcap"
							name="seshcap"
							type="number"
							min="5"
							max="200"
							autocomplete="off"
							bind:value={settings.drillSessionCap}
							class="font-mono"
						/>
					</div>
				</div>

				<div class="mt-5">
					<Label>Position intro animation</Label>
					<div
						role="radiogroup"
						aria-label="Drill intro speed"
						class="grid grid-cols-5 gap-0 overflow-hidden rounded-[5px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-0.5"
					>
						{#each INTRO_SPEEDS as opt (opt.id)}
							{@const active = settings.drillIntroSpeed === opt.id}
							<button
								type="button"
								role="radio"
								aria-checked={active}
								onclick={() => (settings!.drillIntroSpeed = opt.id)}
								class={cn(
									'flex flex-col items-center justify-center rounded-[4px] py-2 transition-colors',
									active
										? 'bg-[var(--color-brass-300)] text-[var(--color-ink-950)] shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_1px_2px_rgba(0,0,0,0.35)]'
										: 'text-[var(--color-parchment-200)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-50)]'
								)}
							>
								<span class="text-[13px] font-medium tracking-tight">{opt.label}</span>
								<span
									class={cn(
										'mt-0.5 font-mono text-[10px] tracking-wider uppercase',
										active ? 'text-[var(--color-ink-950)]/70' : 'text-[var(--color-parchment-500)]'
									)}>{opt.hint}</span
								>
							</button>
						{/each}
					</div>
					<p class="mt-2 font-serif text-xs text-[var(--color-parchment-500)] italic">
						Plays the line into the drill position before you answer, so you arrive with context.
					</p>
				</div>

				<label
					class="mt-4 flex cursor-pointer items-start gap-3 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-3 transition-colors hover:border-[var(--color-ink-600)]"
				>
					<input
						type="checkbox"
						checked={settings.openAtStartingPosition !== false}
						onchange={(e) =>
							(settings!.openAtStartingPosition = (e.currentTarget as HTMLInputElement).checked)}
						class="mt-0.5 size-4 accent-[var(--color-brass-300)]"
					/>
					<div class="min-w-0 flex-1">
						<span class="font-serif text-sm text-[var(--color-parchment-100)]">
							Open at the starting position
						</span>
						<p
							class="mt-1 font-serif text-xs leading-relaxed text-[var(--color-parchment-500)] italic"
						>
							Skips the forced prefix when you open the builder or start a drill. Per repertoire —
							set the starting position with the bookmark icon on the Line strip.
						</p>
					</div>
				</label>

				<label
					class="mt-3 flex cursor-pointer items-start gap-3 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-3 transition-colors hover:border-[var(--color-ink-600)]"
				>
					<input
						type="checkbox"
						checked={(settings.drillIntermediateMoves ?? 'play') === 'play'}
						onchange={(e) =>
							(settings!.drillIntermediateMoves = (e.currentTarget as HTMLInputElement).checked
								? 'play'
								: 'auto')}
						class="mt-0.5 size-4 accent-[var(--color-brass-300)]"
					/>
					<div class="min-w-0 flex-1">
						<span class="font-serif text-sm text-[var(--color-parchment-100)]">
							Walk every move of a line
						</span>
						<p
							class="mt-1 font-serif text-xs leading-relaxed text-[var(--color-parchment-500)] italic"
						>
							When a card from late in a line is due, the drill walks each earlier user move first
							instead of jumping past them. Prefix moves don't count towards FSRS — getting them
							right is a free pass, getting them wrong replays without a lapse. Disable to drill the
							due card directly.
						</p>
					</div>
				</label>

				<label
					class="mt-3 flex cursor-pointer items-start gap-3 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-3 transition-colors hover:border-[var(--color-ink-600)]"
				>
					<input
						type="checkbox"
						checked={settings.showMiddlegameGuides === true}
						onchange={(e) =>
							(settings!.showMiddlegameGuides = (e.currentTarget as HTMLInputElement).checked)}
						class="mt-0.5 size-4 accent-[var(--color-brass-300)]"
					/>
					<div class="min-w-0 flex-1">
						<span class="font-serif text-sm text-[var(--color-parchment-100)]">
							Show saved middle-game guide arrows in drill
						</span>
						<p
							class="mt-1 font-serif text-xs leading-relaxed text-[var(--color-parchment-500)] italic"
						>
							When you reach a position where you've pinned a middle-game guide in the editor, the
							drill paints those arrows on the board. They auto-hide while a wrong move is being
							refuted or while the drill is showing its own hint arrows so the two don't overlap.
						</p>
					</div>
				</label>

				<div
					class="mt-3 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-3"
				>
					<div class="flex items-baseline justify-between gap-3">
						<Label for="welllearneddays" class="!mb-0">Animate past well-learned moves</Label>
						<div class="flex items-baseline gap-1.5">
							<Input
								id="welllearneddays"
								name="welllearneddays"
								type="number"
								min="0"
								max="365"
								autocomplete="off"
								bind:value={settings.drillWellLearnedDays}
								class="w-20 font-mono"
							/>
							<span class="font-mono text-xs text-[var(--color-parchment-500)]">days</span>
						</div>
					</div>
					<p
						class="mt-2 font-serif text-xs leading-relaxed text-[var(--color-parchment-500)] italic"
					>
						Threshold for treating a graduated FSRS card as well-learned. Prefix and suffix moves in
						a line walk skip the drill and play out as animation when their stability is at or above
						this value. Lower keeps more moves in the recall pool; higher trusts the schedule
						sooner. 0 animates everything that's reached Review state.
					</p>
				</div>
			</section>

			<Separator />

			<!-- Appearance section -->
			<section style:--i="3b">
				<div class="mb-4 flex items-baseline gap-3">
					<h2 class="font-serif text-2xl">Appearance</h2>
					<span class="eyebrow text-[var(--color-parchment-500)]">Board &amp; pieces</span>
				</div>
				<p class="mb-4 max-w-md font-serif text-sm text-[var(--color-parchment-400)] italic">
					Picks apply everywhere a board is shown. Click a tile to preview live; commit with Save.
				</p>
				<BoardPiecePicker
					boardTheme={settings.boardTheme}
					pieceSet={settings.pieceSet}
					onBoardChange={(id) => (settings!.boardTheme = id)}
					onPieceChange={(id) => (settings!.pieceSet = id)}
				/>
			</section>

			<Separator />

			<!-- Lichess section -->
			<section id="lichess" class="scroll-mt-24" style:--i="4">
				<div class="mb-4 flex items-baseline gap-3">
					<h2 class="font-serif text-2xl">Lichess</h2>
					<span class="eyebrow text-[var(--color-parchment-500)]">Explorer &amp; account</span>
				</div>

				<div class="ink-panel mb-5 flex items-start justify-between gap-3 p-4">
					<div class="flex-1">
						<div class="eyebrow mb-1">Connected account</div>
						{#if tokenIsFresh(settings.lichessOAuth)}
							<p class="font-mono text-sm">
								<span class="text-[var(--color-olive-300)]">●</span>
								{settings.lichessOAuth?.username ?? 'Connected'}
							</p>
							<p class="mt-1 font-serif text-xs text-[var(--color-parchment-500)] italic">
								Used for the explorer, for fetching your games, and — with study access granted —
								for syncing repertoires to Lichess studies.
							</p>
							{#if !tokenHasStudyScopes(settings.lichessOAuth)}
								<p class="mt-2 font-serif text-xs text-[var(--color-brass-300)] italic">
									Study sync is not authorised on the current token. Reconnect to enable linking
									repertoires to private studies.
								</p>
							{/if}
							{#if !tokenHasChallengeScopes(settings.lichessOAuth)}
								<p class="mt-2 font-serif text-xs text-[var(--color-brass-300)] italic">
									Bot challenges (Stockfish / Maia) need additional scopes. Reconnect to enable
									them.
								</p>
							{/if}
						{:else}
							<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
								Not connected. Sign in for the explorer, autobuild, and study sync.
							</p>
						{/if}
					</div>
					{#if tokenIsFresh(settings.lichessOAuth)}
						{#if !tokenHasStudyScopes(settings.lichessOAuth) || !tokenHasChallengeScopes(settings.lichessOAuth)}
							<Button
								variant="primary"
								size="sm"
								onclick={() => startOAuth([...ALL_SCOPES], lichessReturnTo)}
							>
								Reconnect
							</Button>
						{/if}
						<Button
							variant="outline"
							size="sm"
							onclick={async () => {
								await disconnectOAuth();
								settings = await getSettings();
								savedSnapshot = JSON.stringify(settings);
							}}
						>
							Disconnect
						</Button>
					{:else}
						<Button
							variant="primary"
							size="sm"
							onclick={() => startOAuth([...ALL_SCOPES], lichessReturnTo)}
						>
							Connect Lichess
						</Button>
					{/if}
				</div>

				<div>
					<Label for="lichess-token">Or paste a personal API token</Label>
					<!--
						Render as type="text" — not type="password" — so Firefox's
						password manager doesn't claim it as a credential (and
						stops flagging nearby number inputs as the "username"
						slot). Visual masking comes from the CSS class below,
						which uses `-webkit-text-security` (supported in current
						Chromium and Firefox). Click the eye toggle to reveal.
					-->
					<div class="relative">
						<Input
							id="lichess-token"
							name="cobra-api-key"
							type="text"
							autocomplete="off"
							data-form-type="other"
							data-lpignore="true"
							data-1p-ignore="true"
							bind:value={settings.lichessApiToken}
							placeholder="lip_..."
							class={cn('pr-16 font-mono text-[13px]', !showToken && 'cobra-token-masked')}
						/>
						<button
							type="button"
							onclick={() => (showToken = !showToken)}
							class="eyebrow absolute top-1/2 right-2 -translate-y-1/2 rounded px-2 py-1 text-[var(--color-parchment-400)] transition-colors hover:bg-[var(--color-ink-800)] hover:text-[var(--color-parchment-100)]"
							aria-label={showToken ? 'Hide token' : 'Show token'}
						>
							{showToken ? 'Hide' : 'Show'}
						</button>
					</div>
					<p
						class="mt-2 font-serif text-xs leading-relaxed text-[var(--color-parchment-500)] italic"
					>
						Used only when no OAuth account is connected. Generate one at
						<a
							href="https://lichess.org/account/oauth/token/create?description=Opening+Trainer"
							target="_blank"
							rel="noopener"
							class="inline-flex items-center gap-0.5 text-[var(--color-brass-300)] underline underline-offset-2 hover:text-[var(--color-brass-200)]"
						>
							lichess.org<ExternalLink class="size-2.5" />
						</a>
						— no scopes needed. Stored only in this browser.
					</p>
				</div>
				<div class="mt-5 grid gap-5 sm:grid-cols-2">
					<div>
						<Label for="speeds">Game speeds</Label>
						<MultiSelect
							id="speeds"
							options={SPEED_OPTIONS}
							selected={settings.explorerSpeeds}
							onchange={(next) => (settings!.explorerSpeeds = next)}
							placeholder="Any speed"
						/>
					</div>
					<div>
						<Label for="ratings">Rating brackets</Label>
						<MultiSelect
							id="ratings"
							options={RATING_OPTIONS}
							selected={settings.explorerRatings}
							onchange={(next) => (settings!.explorerRatings = next)}
							placeholder="Any rating"
						/>
					</div>
				</div>

				<label
					class="mt-6 flex cursor-pointer items-start gap-3 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-3 transition-colors hover:border-[var(--color-ink-600)]"
				>
					<input
						type="checkbox"
						checked={settings.useLichessServerEval !== false}
						onchange={(e) =>
							(settings!.useLichessServerEval = (e.currentTarget as HTMLInputElement).checked)}
						class="mt-0.5 size-4 accent-[var(--color-brass-300)]"
					/>
					<div class="min-w-0 flex-1">
						<div class="flex items-baseline gap-2">
							<span class="font-serif text-sm text-[var(--color-parchment-100)]"
								>Use Lichess-side engine evals when available</span
							>
						</div>
						<p
							class="mt-1 font-serif text-xs leading-relaxed text-[var(--color-parchment-500)] italic"
						>
							For Lichess games that have already been analysed on the site (the "Request computer
							analysis" button), Cobra adopts Lichess's per-move evals and skips the local Stockfish
							pass on those moves. Moves without server evals fall back to local analysis unchanged.
							No effect on chess.com games.
						</p>
					</div>
				</label>
			</section>

			<Separator />

			<!-- Accounts for mistake scanning -->
			<section style:--i="4b">
				<div class="mb-4 flex items-baseline gap-3">
					<h2 class="font-serif text-2xl">Additional accounts</h2>
					<span class="eyebrow text-[var(--color-parchment-500)]"> Lichess &amp; chess.com </span>
				</div>
				<p class="mb-4 max-w-md font-serif text-sm text-[var(--color-parchment-400)] italic">
					Usernames swept by the hourly mistake auto-scan — across both platforms. Your connected
					Lichess account is pinned at the top; add more below.
				</p>

				{#if displayedScanAccounts.length > 0}
					<ul
						class="mb-4 divide-y divide-[var(--color-ink-800)] border-y border-[var(--color-ink-800)]"
					>
						{#each displayedScanAccounts as a (`${a.source}:${a.username}`)}
							<li
								in:slide={{ duration: 220 }}
								animate:flip={{ duration: 220 }}
								class="flex items-center gap-3 py-2"
							>
								<span
									class="flex w-5 shrink-0 items-center justify-center"
									class:text-[var(--color-brass-300)]={a.source === 'lichess'}
									aria-label={a.source === 'lichess' ? 'Lichess' : 'chess.com'}
									title={a.source === 'lichess' ? 'Lichess' : 'chess.com'}
								>
									<SourceIcon source={a.source} />
								</span>
								<span class="flex-1 truncate font-mono text-sm">{a.username}</span>
								{#if a.pinned}
									<span class="eyebrow text-[var(--color-olive-300)]">Connected</span>
								{:else}
									<button
										type="button"
										onclick={() => removeScanAccount(a)}
										class="eyebrow text-[var(--color-parchment-500)] transition-colors hover:text-[var(--color-oxblood-300)]"
									>
										Remove
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				<div class="flex flex-wrap items-end gap-2">
					<SourceUsernameInput
						id="new-scan-account"
						class="flex-1"
						bind:source={newAccountSource}
						bind:username={newAccountUsername}
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								addScanAccount();
							}
						}}
					/>
					<Button
						variant="secondary"
						size="sm"
						onclick={addScanAccount}
						disabled={!newAccountUsername.trim()}
					>
						Add
					</Button>
				</div>
			</section>

			<Separator />

			<!-- Game query window — global since-date applied to every scan
			     that pulls games (mistakes, dossier, opponent prep, autobuild
			     chess.com). Useful when recent games stop being representative:
			     return after a long break, sharp rating change, deliberate
			     style shift. -->
			<section id="games-since" class="scroll-mt-24" style:--i="4b2">
				<div class="mb-4 flex items-baseline gap-3">
					<h2 class="font-serif text-2xl">Game query window</h2>
					<span class="eyebrow text-[var(--color-parchment-500)]">Since date</span>
				</div>
				<p class="mb-4 max-w-md font-serif text-sm text-[var(--color-parchment-400)] italic">
					Skip games played before this date in every scan — mistakes, dossier, opponent prep,
					autobuild. Set this when your recent play stops being representative: returning after a
					break, a rating jump, or a deliberate style shift. Leave empty to scan as far back as the
					per-scan game cap allows.
				</p>

				<div class="max-w-xs">
					<Label for="games-since-input">Since</Label>
					<DatePicker
						id="games-since-input"
						value={settings.gamesSince}
						onchange={onGamesSinceChange}
					/>
				</div>
			</section>

			<Separator />

			<!-- Dossier baseline section -->
			<section id="dossier-baseline" style:--i="4c">
				<div class="mb-4 flex items-baseline gap-3">
					<h2 class="font-serif text-2xl">Dossier baseline</h2>
					<span class="eyebrow text-[var(--color-parchment-500)]">Self-calibrated</span>
				</div>
				<p class="mb-4 max-w-md font-serif text-sm text-[var(--color-parchment-400)] italic">
					The "you vs baseline" headlines on the Style page compare against a population rate.
					Calibrating from your own opponents replaces the eyeballed default with a rate measured at
					your actual rating band. Snowballs through opponents within ±150 points of you.
				</p>

				<div class="mb-2 flex flex-wrap items-end gap-3">
					<div class="min-w-[14rem] flex-1">
						<Label for="baseline-accounts">Based on accounts</Label>
						<MultiSelect
							id="baseline-accounts"
							options={baselineAccountOptions}
							selected={baselineAccountKeys}
							onchange={(next) => (baselineAccountKeys = next)}
							placeholder="All accounts"
						>
							{#snippet renderOption(opt)}
								{@const account = baselineAccountByValue.get(opt.value)}
								{#if account}
									<span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
										<SourceIcon source={account.source} />
									</span>
									<span class="truncate">{account.username}</span>
								{:else}
									<span class="truncate">{opt.label}</span>
								{/if}
							{/snippet}
							{#snippet renderSummary(chosen)}
								<span class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
									{#each chosen as opt (opt.value)}
										{@const account = baselineAccountByValue.get(opt.value)}
										{#if account}
											<span
												class="inline-flex items-center gap-1 rounded-[3px] bg-[var(--color-ink-850)] px-1.5 py-0.5 font-mono text-[12px]"
											>
												<span class="flex h-3 w-3 items-center justify-center">
													<SourceIcon source={account.source} />
												</span>
												<span class="truncate">{account.username}</span>
											</span>
										{/if}
									{/each}
								</span>
							{/snippet}
						</MultiSelect>
					</div>
					<div class="shrink-0">
						<Label for="baseline-games">Games to scan</Label>
						<Input
							id="baseline-games"
							type="number"
							bind:value={baselineGames}
							min={20}
							max={300}
							disabled={baselineBusy}
							class="w-24 font-mono"
						/>
					</div>
					<Button
						variant="primary"
						size="md"
						class="h-10"
						onclick={calibrateNow}
						disabled={baselineBusy}
					>
						<span>{baselineBusy ? 'Working…' : 'Calibrate now'}</span>
					</Button>
					{#if baselineBusy}
						<Button variant="ghost" size="md" class="h-10" onclick={cancelCalibration}>
							Cancel
						</Button>
					{/if}
				</div>
				<p class="mb-3 font-serif text-xs text-[var(--color-parchment-500)] italic">
					Leave the account list empty to base the baseline on every configured scan account.
				</p>
				{#if baselineBusy}
					<BaselineCalibrationProgress />
				{/if}
				{#if baselineError}
					<p class="mt-2 text-xs text-[var(--color-oxblood-300)]">{baselineError}</p>
				{/if}

				{#if storedBaselines.length > 0}
					<ul class="mb-3 space-y-1 text-xs">
						{#each storedBaselines as b (b.id)}
							<li
								in:slide={{ duration: 220 }}
								animate:flip={{ duration: 220 }}
								class="flex flex-wrap items-baseline justify-between gap-2 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
							>
								<div>
									<div class="font-mono">
										{b.bucket ?? 'any'} · {b.ratingMin}–{b.ratingMax}
									</div>
									<div class="text-[var(--color-parchment-500)]">
										{b.games} games · {b.totalMoves} moves · {b.sampledUsers} opponents ·
										{new Date(b.computedAt).toLocaleDateString()}
									</div>
								</div>
								<button
									type="button"
									onclick={() => forgetBaseline(b.id)}
									class="text-[var(--color-parchment-400)] underline"
								>
									Forget
								</button>
							</li>
						{/each}
					</ul>
					<Button variant="ghost" size="sm" onclick={clearAllBaselines}>
						Forget all baselines
					</Button>
				{:else}
					<p class="text-xs text-[var(--color-parchment-500)]">
						No calibrated baselines yet — headlines fall back to the eyeballed default.
					</p>
				{/if}

				<label
					class="mt-6 flex cursor-pointer items-start gap-3 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-3 transition-colors hover:border-[var(--color-ink-600)]"
				>
					<input
						type="checkbox"
						checked={settings.styleAdviceEnabled === true}
						onchange={(e) =>
							(settings!.styleAdviceEnabled = (e.currentTarget as HTMLInputElement).checked)}
						class="mt-0.5 size-4 accent-[var(--color-brass-300)]"
					/>
					<div class="min-w-0 flex-1">
						<div class="flex items-baseline gap-2">
							<span class="font-serif text-sm text-[var(--color-parchment-100)]"
								>Style advice in Explorer</span
							>
						</div>
						<p
							class="mt-1 font-serif text-xs leading-relaxed text-[var(--color-parchment-500)] italic"
						>
							Annotates each candidate move in the editor's Explorer panel with a fit score derived
							from your latest dossier scan. Off by default — requires a dossier scan.
						</p>
					</div>
				</label>
			</section>

			<Separator />

			<!-- Sounds section -->
			<section>
				<div class="mb-4 flex items-baseline gap-3">
					<h2 class="font-serif text-2xl">Sounds</h2>
					<span class="eyebrow text-[var(--color-parchment-500)]">Move & feedback cues</span>
				</div>

				<label
					class="flex cursor-pointer items-start gap-3 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-3 transition-colors hover:border-[var(--color-ink-600)]"
				>
					<input
						type="checkbox"
						checked={settings.soundsEnabled !== false}
						onchange={(e) =>
							(settings!.soundsEnabled = (e.currentTarget as HTMLInputElement).checked)}
						class="mt-0.5 size-4 accent-[var(--color-brass-300)]"
					/>
					<div class="min-w-0 flex-1">
						<span class="font-serif text-sm text-[var(--color-parchment-100)]">
							Enable sounds
						</span>
						<p
							class="mt-1 font-serif text-xs leading-relaxed text-[var(--color-parchment-500)] italic"
						>
							Lichess move and capture cues on every board; positive / error cues when drilling.
						</p>
					</div>
				</label>

				<div class="mt-4">
					<div class="mb-2 flex items-baseline justify-between gap-3">
						<span class="font-serif text-sm text-[var(--color-parchment-100)]">Volume</span>
						<span class="font-mono text-xs text-[var(--color-parchment-500)]">
							{Math.round((settings.soundsVolume ?? 1) * 100)}%
						</span>
					</div>
					<input
						type="range"
						min="0"
						max="1"
						step="0.05"
						disabled={settings.soundsEnabled === false}
						value={settings.soundsVolume ?? 1}
						oninput={(e) =>
							(settings!.soundsVolume = Number((e.currentTarget as HTMLInputElement).value))}
						class="w-full accent-[var(--color-brass-300)] disabled:opacity-40"
					/>
					<div class="mt-3 flex flex-wrap gap-2">
						<Button variant="ghost" size="sm" onclick={() => playMove()}>Test move</Button>
						<Button variant="ghost" size="sm" onclick={() => playCorrect()}>Test correct</Button>
						<Button variant="ghost" size="sm" onclick={() => playIncorrect()}>Test error</Button>
					</div>
				</div>
			</section>

			<Separator />

			<!-- Sync (Beta) section -->
			<section id="sync" class="scroll-mt-24" style:--i="4d">
				<div class="mb-4 flex items-baseline gap-3">
					<h2 class="font-serif text-2xl">Sync</h2>
					<Badge variant="brass">Beta</Badge>
					<span class="eyebrow text-[var(--color-parchment-500)]">Multi-device</span>
				</div>
				<p class="mb-5 max-w-md font-serif text-sm text-[var(--color-parchment-400)] italic">
					Mirror this device's repertoires, drill progress, mistakes, and dossier into a private
					Lichess study. Sign in on another device with the same Lichess account, enable Sync there,
					and the two stay in step. Off by default — your data only leaves this browser when you
					turn it on.
				</p>

				{#if !lichessReadyForSync}
					<div
						class="ink-panel mb-4 p-4 font-serif text-sm leading-relaxed text-[var(--color-parchment-300)]"
					>
						Connect Lichess (above, with study scopes) before enabling Sync. The feature uses a
						private study under your Lichess account as the storage backend — there's no separate
						COBRA server.
					</div>
				{:else if !syncEnabled}
					<div class="ink-panel mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
						<div class="flex-1">
							<div class="eyebrow mb-1">Status</div>
							<p class="font-serif text-sm text-[var(--color-parchment-400)] italic">
								Disabled. Enabling will create (or reuse) a private Lichess study named "COBRA
								Sync".
							</p>
						</div>
						<Button
							variant="primary"
							size="sm"
							onclick={enableSync}
							disabled={syncBusyLocal || syncBusy}
						>
							{syncBusyLocal ? 'Working…' : 'Enable Sync'}
						</Button>
					</div>
				{:else}
					<div class="ink-panel mb-4 grid gap-3 p-4">
						<div class="grid grid-cols-2 gap-3 font-mono text-xs">
							<div>
								<div class="eyebrow mb-1">Last push</div>
								<div class="text-[var(--color-parchment-200)]">
									{fmtAgo(syncLastPushAt)}
								</div>
							</div>
							<div>
								<div class="eyebrow mb-1">Last pull</div>
								<div class="text-[var(--color-parchment-200)]">
									{fmtAgo(syncLastPullAt)}
								</div>
							</div>
							<div>
								<div class="eyebrow mb-1">Pending</div>
								<div class="text-[var(--color-parchment-200)]">
									{syncDirtyCount === 0 ? 'nothing dirty' : `${syncDirtyCount} pending`}
								</div>
							</div>
							<div>
								<div class="eyebrow mb-1">Study</div>
								<div class="truncate text-[var(--color-parchment-200)]">
									{#if syncStudyId}
										<a
											href="https://lichess.org/study/{syncStudyId}"
											target="_blank"
											rel="noopener"
											class="text-[var(--color-brass-300)] underline underline-offset-2 hover:text-[var(--color-brass-200)]"
											>{syncStudyId}</a
										>
									{:else}
										—
									{/if}
								</div>
							</div>
						</div>
						{#if syncError}
							<p class="text-xs text-[var(--color-oxblood-300)]">{syncError}</p>
						{/if}
						<div class="flex flex-wrap gap-2">
							<Button
								variant="primary"
								size="sm"
								onclick={syncNow}
								disabled={syncBusyLocal || syncBusy}
							>
								{syncBusyLocal || syncBusy ? 'Working…' : 'Sync now'}
							</Button>
							<Button
								variant="outline"
								size="sm"
								onclick={disableSync}
								disabled={syncBusyLocal || syncBusy}
							>
								Disable
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onclick={disconnectAndForget}
								disabled={syncBusyLocal || syncBusy}
							>
								Disconnect &amp; forget
							</Button>
						</div>
					</div>

					<label
						class="flex cursor-pointer items-start gap-3 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-3 transition-colors hover:border-[var(--color-ink-600)]"
					>
						<input
							type="checkbox"
							checked={syncTelemetry}
							onchange={(e) => sync.setTelemetry((e.currentTarget as HTMLInputElement).checked)}
							class="mt-0.5 size-4 accent-[var(--color-brass-300)]"
						/>
						<div class="min-w-0 flex-1">
							<span class="font-serif text-sm text-[var(--color-parchment-100)]"
								>Also sync scan history (telemetry)</span
							>
							<p
								class="mt-1 font-serif text-xs leading-relaxed text-[var(--color-parchment-500)] italic"
							>
								Mistakes, empirical gaps, spar games and position WDL. Off by default — this data is
								bulky and regenerable by re-scanning, and excluding it keeps large repertoires under
								Lichess's per-chapter size limit. Your authored tree (moves, cards, ideas) always
								syncs regardless.
							</p>
						</div>
					</label>
				{/if}

				<details class="ink-panel p-4 font-serif text-sm text-[var(--color-parchment-400)]">
					<summary
						class="cursor-pointer text-[var(--color-parchment-200)] transition-colors hover:text-[var(--color-parchment-50)]"
					>
						What's actually synced, and what stays on this device?
					</summary>
					<ul class="mt-3 list-disc space-y-1 pl-5 italic">
						<li>
							Always synced: repertoires, FSRS card progress, idea cards, baselines, settings.
						</li>
						<li>
							Synced only with “scan history” enabled above: mistakes, empirical gaps, spar games,
							position WDL. Off by default — bulky and regenerable by re-scanning.
						</li>
						<li>
							Not synced: Lichess token (stays device-local), explorer + opening name caches
							(rebuild themselves), in-flight scan checkpoints, the latest dossier scan + masters
							baseline (too large for Lichess study chapters — re-run a dossier scan on each device
							to populate them locally).
						</li>
						<li>
							Pulls merge per-record: the more recent review wins per card, edges union, mistake
							status follows whichever side drilled-or-dismissed it more recently. Concurrent
							same-day drilling on two devices doesn't lose progress on either side. The header pill
							shows live sync activity.
						</li>
						<li>
							If two devices push to the same chapter without one pulling first, the second push
							gets a manual conflict prompt (pull / overwrite / cancel) — that's the only case the
							merge can't resolve silently.
						</li>
						<li>
							Data lives in a private Lichess study under your account. Lichess staff can see
							private study contents. If that's a problem, don't enable this.
						</li>
					</ul>
				</details>
			</section>

			<Separator />

			<!-- Data section -->
			<section style:--i="5">
				<div class="mb-4 flex items-baseline gap-3">
					<h2 class="font-serif text-2xl">Data</h2>
					<span class="eyebrow text-[var(--color-parchment-500)]">Local-only</span>
				</div>
				<p class="mb-5 max-w-md font-serif text-sm text-[var(--color-parchment-400)] italic">
					Everything lives in your browser's IndexedDB. Export the whole library as a single JSON to
					back it up or move it to another browser.
				</p>

				<div class="mb-4 flex flex-wrap gap-2">
					<Button variant="secondary" size="sm" onclick={onExportAll}>
						<span>Export library</span>
					</Button>
					<label
						class="inline-flex h-8 cursor-pointer items-center gap-2 rounded-[3px] border border-[var(--color-ink-700)] px-3 text-xs text-[var(--color-parchment-100)] transition-colors hover:border-[var(--color-ink-600)] hover:bg-[var(--color-ink-850)]"
					>
						<span>{importing ? 'Importing…' : 'Import library'}</span>
						<input
							type="file"
							accept=".cobra,.json,application/json"
							class="sr-only"
							onchange={onImportAll}
							disabled={importing}
						/>
					</label>
				</div>
				{#if importMsg}
					<p
						class="mb-4 font-mono text-xs"
						class:text-[var(--color-olive-300)]={!importMsg.startsWith('Import failed')}
						class:text-[var(--color-oxblood-300)]={importMsg.startsWith('Import failed')}
					>
						{importMsg}
					</p>
				{/if}
				<div class="flex flex-wrap gap-2">
					<Button variant="outline" size="sm" onclick={restoreDefaults}>Restore defaults</Button>
					<Button variant="destructive" size="sm" onclick={wipe}>
						<AlertTriangle class="size-3.5" />
						<span>Wipe all data</span>
					</Button>
				</div>

				<label
					class="mt-6 flex cursor-pointer items-start gap-3 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-3 transition-colors hover:border-[var(--color-ink-600)]"
				>
					<input
						type="checkbox"
						checked={diagOverlay}
						onchange={(e) => toggleDiagOverlay((e.currentTarget as HTMLInputElement).checked)}
						class="mt-0.5 size-4 accent-[var(--color-brass-300)]"
					/>
					<div class="min-w-0 flex-1">
						<div class="flex items-baseline gap-2">
							<span class="font-serif text-sm text-[var(--color-parchment-100)]"
								>Diagnostic overlay</span
							>
						</div>
						<p
							class="mt-1 font-serif text-xs leading-relaxed text-[var(--color-parchment-500)] italic"
						>
							When on, paints internal trace events and JavaScript errors at the bottom of the
							screen — engine init state, cross-origin-isolation status, deep-link routing. Off by
							default; nothing paints. Captures still record silently (available from devtools via
							<code>__cobraDiag.dump()</code>) so toggling on later still has context. Useful for
							diagnosing problems on a device where you can't reach browser devtools.
						</p>
					</div>
				</label>
			</section>

			<Separator />

			<!-- Support section -->
			<section style:--i="6">
				<div class="mb-4 flex items-baseline gap-3">
					<h2 class="font-serif text-2xl">Support</h2>
					<span class="eyebrow text-[var(--color-parchment-500)]">Optional</span>
				</div>
				<p class="mb-5 max-w-md font-serif text-sm text-[var(--color-parchment-400)] italic">
					COBRA is free and local-first. If it's useful to you, a coffee helps fuel the next
					feature.
				</p>
				<div class="flex flex-wrap items-center gap-2">
					<a
						href="https://www.buymeacoffee.com/EIonTusk"
						target="_blank"
						rel="noopener"
						class="inline-flex h-9 items-center gap-2 rounded-[3px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-4 text-sm text-[var(--color-parchment-100)] transition-colors hover:border-[var(--color-brass-300)]/50 hover:bg-[var(--color-ink-850)]"
					>
						<span aria-hidden="true">☕</span>
						<span>Buy me a coffee</span>
					</a>
					<a
						href="https://github.com/EIonTusk/COBRA/issues/new?labels=enhancement&template=feature_request.md"
						target="_blank"
						rel="noopener"
						class="inline-flex h-9 items-center gap-2 rounded-[3px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-4 text-sm text-[var(--color-parchment-100)] transition-colors hover:border-[var(--color-brass-300)]/50 hover:bg-[var(--color-ink-850)]"
					>
						<span aria-hidden="true">💡</span>
						<span>Request a feature</span>
						<ExternalLink class="size-3 text-[var(--color-parchment-500)]" strokeWidth={1.75} />
					</a>
					<a
						href="https://github.com/EIonTusk/COBRA/issues/new?labels=bug&template=bug_report.md"
						target="_blank"
						rel="noopener"
						class="inline-flex h-9 items-center gap-2 rounded-[3px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-4 text-sm text-[var(--color-parchment-100)] transition-colors hover:border-[var(--color-brass-300)]/50 hover:bg-[var(--color-ink-850)]"
					>
						<AlertTriangle class="size-3.5 text-[var(--color-parchment-400)]" />
						<span>Report a bug</span>
						<ExternalLink class="size-3 text-[var(--color-parchment-500)]" strokeWidth={1.75} />
					</a>
				</div>
			</section>
		</div>
	{/if}
</div>

<!-- Sticky save bar -->
{#if settings}
	<div
		class="fixed inset-x-0 bottom-0 z-30 transition-transform duration-200"
		class:translate-y-full={!dirty && !justSaved}
	>
		<div
			class="border-t border-[var(--color-ink-700)] bg-[var(--color-ink-900)]/95 shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.5)] backdrop-blur-md"
		>
			<div class="mx-auto flex max-w-2xl items-center gap-3 px-6 py-3">
				<div class="flex flex-1 items-center gap-2">
					{#if justSaved && !dirty}
						<div class="ot-fade flex items-center gap-1.5 text-[var(--color-olive-300)]">
							<Check class="size-3.5" strokeWidth={2.5} />
							<span class="eyebrow !text-[var(--color-olive-300)]">Saved</span>
						</div>
					{:else if dirty}
						<span class="eyebrow text-[var(--color-brass-300)]">Unsaved changes</span>
						<span class="hidden font-mono text-[11px] text-[var(--color-parchment-500)] sm:inline">
							<kbd
								class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-800)] px-1 py-0.5"
								>⌘S</kbd
							>
						</span>
					{/if}
				</div>
				<Button variant="ghost" size="sm" onclick={discard} disabled={!dirty || saving}>
					Discard
				</Button>
				<Button variant="primary" size="sm" onclick={save} disabled={!dirty || saving}>
					<span>{saving ? 'Saving…' : 'Save changes'}</span>
				</Button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Mask the API token visually without using type="password" (which would
	   otherwise trip Firefox's password manager). -webkit-text-security is
	   supported in current Chromium and Firefox; a plain font fallback looks
	   the same in any engine that ignores it. */
	:global(.cobra-token-masked) {
		/* Currently implemented (prefixed) in Chromium 115+ and Firefox 142+. */
		-webkit-text-security: disc;
		letter-spacing: 0.15em;
	}
</style>
