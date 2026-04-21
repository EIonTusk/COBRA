<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { ArrowLeft, Copy, Download, Printer, Share2, X } from 'lucide-svelte';

	import { Button, DashboardBacklink, Label, MultiSelect, Select, SourceIcon } from '$lib/ui';
	import { getSettings, effectiveLichessToken } from '$lib/storage/settings';
	import { analyseEvalAxes, type EvalAxesSummary } from '$lib/dossier/evalAxes';
	import { interpretEvalAxes } from '$lib/dossier/evalInterpreter';
	import { buildScorecard } from '$lib/dossier/scorecard';
	import {
		loadDossierReport,
		clearDossierReport,
		getSharedReportOverride,
		clearSharedReportOverride
	} from '$lib/storage/dossierReport';
	import { buildCriticalMoments } from '$lib/dossier/criticalMoments';
	import { buildClockSpend } from '$lib/dossier/clockSpend';
	import {
		buildBlunderAtlas,
		blunderAtlasItemToStoredMistake,
		type BlunderCluster
	} from '$lib/dossier/blunderAtlas';
	import { buildSessionProfile } from '$lib/dossier/sessionProfile';
	import { buildDossierProfile, type DossierBadge } from '$lib/dossier/profile';
	import { buildOpeningProfile, type OpeningProfileRow } from '$lib/dossier/openingProfile';
	import { listStoredBaselines, type StoredBaselineBucket } from '$lib/storage/baselines';
	import { collectAccountsFromSettings } from '$lib/lichess/mistakeScan';
	import { type DossierScanResult } from '$lib/dossier/scan';
	import { dossierScan } from '$lib/dossier/scanStore.svelte';
	import {
		highlightAxes,
		DOSSIER_BASELINE,
		BASELINE_META,
		pickBaseline,
		primarySpeed,
		setRuntimeBaselines
	} from '$lib/dossier/fingerprint';
	// The v1 archetype module is still used by the library page, but /dossier
	// now derives its own profile from v2 data via buildDossierProfile below.
	import { leakToStoredMistake } from '$lib/dossier/leakDrills';
	import { analyseLeaks, avgCpLossByType, type AnalysedLeak } from '$lib/dossier/leakEval';
	import {
		buildDeepInsightCards,
		auditAreaLabel,
		severityLabel,
		severityRank,
		type InsightCard,
		type InsightGroup,
		type Severity
	} from '$lib/dossier/deepInsights';
	import { MOVE_QUALITY_LABEL } from '$lib/dossier/sota';
	import { buildAuditSummary } from '$lib/dossier/auditSummary';
	import { buildFixFirst } from '$lib/dossier/fixFirst';
	import {
		buildDossierShareBundle,
		encodeDossierShare,
		estimateShareSize
	} from '$lib/storage/shareDossierReport';
	import { analysePieceAffinity } from '$lib/dossier/pieceAffinity';
	import { analyseStructureTaste, structureLabel } from '$lib/dossier/structureTaste';
	import { analyseExchangePropensity } from '$lib/dossier/exchangePropensity';
	import { analysePlanTaste } from '$lib/dossier/planTaste';
	import { analyseOpeningFit } from '$lib/dossier/openingFit';
	import { analyseEndgameSubtypes, endgameFamilyLabel } from '$lib/dossier/endgameSubtypes';
	import { analyseTacticalMotifs, motifLabel } from '$lib/dossier/tacticalMotifs';
	import { analyseCalculationDepth } from '$lib/dossier/calculationDepth';
	import { analyseDefensiveResource, difficultyLabel } from '$lib/dossier/defensiveResource';
	import { analyseProphylaxis } from '$lib/dossier/prophylaxis';
	import { analyseBlunderTiming } from '$lib/dossier/blunderTiming';
	import { analyseTimeOfDay, dayLabel } from '$lib/dossier/timeOfDay';
	import { analyseSessionDecay } from '$lib/dossier/sessionDecay';
	import { analyseRepeatOffenders, offenderHeading } from '$lib/dossier/repeatOffenders';
	import { analyseRecoveryArc } from '$lib/dossier/recoveryArc';
	import { analyseOpponentStrength } from '$lib/dossier/opponentStrength';
	import { buildLevelUp, AXIS_LABEL as LEVELUP_AXIS_LABEL } from '$lib/dossier/levelUp';
	import { buildExemplars } from '$lib/dossier/exemplars';
	import { analyseProgression } from '$lib/dossier/progression';
	import { listRepertoires } from '$lib/storage/repertoires';
	import { saveMistakes } from '$lib/storage/mistakes';
	import type { AppSettings, Repertoire, ScanAccount } from '$lib/types';
	import type { LeakInstance } from '$lib/dossier/mismatch';

	let settings = $state<AppSettings | null>(null);
	let accounts = $state<ScanAccount[]>([]);
	/** Subset of account keys (`${source}:${lower-user}`) that should drive
	 *  the scan. Empty = use every configured account. */
	let selectedAccountKeys = $state<string[]>([]);

	const accountOptions = $derived(
		accounts.map((a) => ({
			value: `${a.source}:${a.username.toLowerCase()}`,
			label: a.username,
			account: { source: a.source, username: a.username }
		}))
	);
	const accountByValue = $derived(new Map(accountOptions.map((o) => [o.value, o.account])));
	/** Actual accounts to hand to the scanner — the user's selection, or
	 *  every configured account when nothing is picked. */
	const scopedAccounts = $derived.by<ScanAccount[]>(() => {
		if (selectedAccountKeys.length === 0) return accounts;
		return selectedAccountKeys
			.map((k) => accountByValue.get(k))
			.filter((a): a is ScanAccount => !!a);
	});

	let maxGames = $state(100);
	/**
	 * Stockfish NNUE depth for the bulk scan eval pass. 14 is the default —
	 * fast enough for a 100-game report (~2 min) and reliable for CP-loss
	 * aggregates + blunder classification. 18 is sharper on tactics at ~4×
	 * the cost. 22 is verify-grade but slow. Leak re-eval always runs at
	 * depth 20 regardless of this setting (see `analyseLeaks` call).
	 */
	let evalDepth = $state(14);

	// Scan orchestration lives in a shared store so the scan survives
	// navigating away from /dossier — a layout-level ScanProgressBar
	// renders live status everywhere else. We mirror the store's scalar
	// fields into $derived values here so the rest of the page's template
	// can keep the same names it used before the refactor.
	const running = $derived(dossierScan.running);
	const scanPhase = $derived(dossierScan.phase);
	const progress = $derived(dossierScan.progressText);
	const scanGamesDone = $derived(dossierScan.scanGamesDone);
	const evalDone = $derived(dossierScan.evalDone);
	const evalTotal = $derived(dossierScan.evalTotal);
	let error = $state<string | null>(null);
	let result = $state<DossierScanResult | null>(null);

	let repertoires = $state<Repertoire[]>([]);
	let drillRepId = $state<string>('');
	let savedLeakIds = $state<Set<string>>(new Set());
	let saveAllStatus = $state<string>('');

	let analysing = $state(false);
	let analyseProgress = $state<string>('');
	let analysed = $state<AnalysedLeak[] | null>(null);
	let analysedAvg = $state<Record<string, number> | null>(null);
	let analyseError = $state<string | null>(null);

	let evalGameCap = $state(10);
	let evalRunning = $state(false);
	let evalProgress = $state<string>('');
	let evalSummary = $state<EvalAxesSummary | null>(null);
	let evalError = $state<string | null>(null);
	let evalController: AbortController | null = null;

	let storedBaselines = $state<StoredBaselineBucket[]>([]);
	let atlasStatusByBucket = $state<Record<string, string>>({});
	let reportSavedAt = $state<number | null>(null);
	let reportLoading = $state(true);

	let shareOpen = $state(false);
	let shareEncoding = $state(false);
	let shareUrl = $state<string | null>(null);
	let shareError = $state<string | null>(null);
	let shareSize = $state<{ base64Chars: number; jsonBytes: number } | null>(null);
	let shareCopyStatus = $state<string>('');

	let viewingShared = $state(false);

	onMount(async () => {
		settings = await getSettings();
		accounts = collectAccountsFromSettings(settings);
		repertoires = await listRepertoires();
		if (repertoires.length > 0 && !drillRepId) drillRepId = repertoires[0].id;
		// Load any user-calibrated baselines and inject them into the
		// runtime cache so pickBaseline() picks them on first render.
		storedBaselines = await listStoredBaselines();
		setRuntimeBaselines(storedBaselines);

		// Restore the most recent report so the diagnostic sections
		// render on navigation without forcing a fresh scan. If /dossier/shared
		// pushed a decoded bundle into the session override, loadDossierReport
		// returns that and we render as a shared view.
		viewingShared = !!getSharedReportOverride();
		// Prefer the in-memory store (live scan or most recent result this
		// session) over the IDB copy so we don't clobber fresher data.
		if (dossierScan.result) {
			result = dossierScan.result;
			reportSavedAt = dossierScan.reportSavedAt;
			if (dossierScan.result.evalAxes) evalSummary = dossierScan.result.evalAxes;
			reportLoading = false;
		} else {
			try {
				const saved = await loadDossierReport();
				if (saved && saved.payload) {
					const r = saved.payload as DossierScanResult;
					result = r;
					reportSavedAt = saved.savedAt;
					if (r.evalAxes) evalSummary = r.evalAxes;
					dossierScan.adoptResult(r, saved.savedAt);
				}
			} catch (e) {
				console.warn('[style] failed to load saved report:', e);
			} finally {
				reportLoading = false;
			}
		}
	});

	function formatSavedAt(ms: number): string {
		const diff = Date.now() - ms;
		const min = Math.round(diff / 60000);
		if (min < 1) return 'just now';
		if (min < 60) return `${min}m ago`;
		const hr = Math.round(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const d = Math.round(hr / 24);
		return `${d}d ago`;
	}

	function leakRowId(l: LeakInstance): string {
		return `${l.gameId}:${l.ply}`;
	}

	/**
	 * Build an SVG path string for a sparkline of one axis across the
	 * weekly samples. Returns null if there aren't enough samples to draw.
	 * Y is normalized within the series' own min/max so each axis fills
	 * the same vertical range and trends are easy to read.
	 */

	const evalInterpretation = $derived.by(() => {
		if (!result || !evalSummary || evalSummary.movesAnalysed === 0) return null;
		return interpretEvalAxes(evalSummary);
	});

	const cpLossByLeakRow = $derived.by(() => {
		const map = new SvelteMap<string, number>();
		if (analysed) for (const a of analysed) map.set(leakRowId(a), a.cpLoss);
		return map;
	});

	async function saveLeakAsDrill(l: LeakInstance) {
		const rep = repertoires.find((r) => r.id === drillRepId);
		if (!rep) return;
		const stored = leakToStoredMistake(l, rep);
		if (!stored) return;
		await saveMistakes([stored]);
		savedLeakIds = new Set([...savedLeakIds, leakRowId(l)]);
	}

	async function saveClusterAsDrills(cluster: BlunderCluster) {
		const rep = repertoires.find((r) => r.id === drillRepId);
		if (!rep) {
			atlasStatusByBucket = {
				...atlasStatusByBucket,
				[cluster.bucket]: 'Pick a repertoire above first.'
			};
			return;
		}
		const rows = cluster.items
			.map((it) => blunderAtlasItemToStoredMistake(it, rep))
			.filter((m): m is NonNullable<typeof m> => m != null);
		if (rows.length === 0) {
			atlasStatusByBucket = {
				...atlasStatusByBucket,
				[cluster.bucket]: 'No valid positions to save.'
			};
			return;
		}
		const added = await saveMistakes(rows);
		atlasStatusByBucket = {
			...atlasStatusByBucket,
			[cluster.bucket]: `Saved ${rows.length} to "${rep.name}" (${added} new).`
		};
	}

	function phaseLabel(phase: string) {
		return phase === 'opening'
			? 'Opening'
			: phase === 'middle'
				? 'Middlegame'
				: phase === 'end'
					? 'Endgame'
					: phase;
	}

	function fmtSec(sec: number): string {
		if (sec >= 3600) return `${(sec / 3600).toFixed(1)}h`;
		if (sec >= 60) return `${Math.round(sec / 60)}m`;
		return `${Math.round(sec)}s`;
	}

	async function runEvalAxes() {
		if (!result || evalRunning) return;
		evalError = null;
		evalSummary = null;
		evalRunning = true;
		evalController = new AbortController();
		try {
			const games = [...result.classified]
				.sort((a, b) => b.playedAt - a.playedAt)
				.slice(0, evalGameCap);
			const out = await analyseEvalAxes(games, {
				depth: 14,
				signal: evalController.signal,
				onProgress: (done, total) => {
					evalProgress = `${done}/${total}`;
				},
				lichessToken: settings ? effectiveLichessToken(settings) || undefined : undefined
			});
			evalSummary = out;
		} catch (e) {
			evalError = e instanceof Error ? e.message : String(e);
		} finally {
			evalRunning = false;
			evalProgress = '';
		}
	}

	async function deepAnalyseLeaks() {
		if (!result || analysing) return;
		analyseError = null;
		analysing = true;
		analysed = null;
		analysedAvg = null;
		try {
			const ranked = await analyseLeaks(result.leaks.worst, {
				depth: 20,
				onProgress: (done, total) => {
					analyseProgress = `${done}/${total}`;
				}
			});
			ranked.sort((a, b) => b.cpLoss - a.cpLoss);
			analysed = ranked;
			analysedAvg = avgCpLossByType(ranked);
		} catch (e) {
			analyseError = e instanceof Error ? e.message : String(e);
		} finally {
			analysing = false;
			analyseProgress = '';
		}
	}

	async function saveAllWorstLeaks() {
		if (!result) return;
		const rep = repertoires.find((r) => r.id === drillRepId);
		if (!rep) return;
		const rows = result.leaks.worst
			.map((l) => leakToStoredMistake(l, rep))
			.filter((m): m is NonNullable<typeof m> => m != null);
		const added = await saveMistakes(rows);
		savedLeakIds = new Set([...savedLeakIds, ...result.leaks.worst.map(leakRowId)]);
		saveAllStatus = `Saved ${rows.length} drill${rows.length === 1 ? '' : 's'} (${added} new) to "${rep.name}".`;
	}

	async function run() {
		if (!settings || running) return;
		error = null;
		result = null;
		const r = await dossierScan.start({
			settings,
			maxGamesPerAccount: maxGames,
			evalDepth,
			accountsOverride: scopedAccounts
		});
		if (r) {
			result = r;
			reportSavedAt = dossierScan.reportSavedAt;
			if (r.evalAxes) evalSummary = r.evalAxes;
		} else if (dossierScan.error) {
			error = dossierScan.error;
		}
	}

	// If the scan completes while the user was on another page, the store
	// holds the fresh result. Re-sync whenever it flips.
	$effect(() => {
		const r = dossierScan.result;
		if (r && r !== result) {
			result = r;
			reportSavedAt = dossierScan.reportSavedAt;
			if (r.evalAxes) evalSummary = r.evalAxes;
		}
	});

	async function discardReport() {
		try {
			await clearDossierReport();
		} catch (e) {
			console.warn('[style] failed to clear report:', e);
		}
		result = null;
		evalSummary = null;
		reportSavedAt = null;
		dossierScan.clearResult();
		atlasStatusByBucket = {};
	}

	function printReport() {
		if (typeof window === 'undefined') return;
		// Expand every <details> so appendices print in full.
		const details = document.querySelectorAll<HTMLDetailsElement>('details');
		const previousOpen = new SvelteMap<HTMLDetailsElement, boolean>();
		for (const d of details) {
			previousOpen.set(d, d.open);
			d.open = true;
		}
		const cleanup = () => {
			for (const [d, was] of previousOpen) d.open = was;
			window.removeEventListener('afterprint', cleanup);
		};
		window.addEventListener('afterprint', cleanup);
		window.print();
	}

	function exitSharedView() {
		clearSharedReportOverride();
		// Full reload so every module re-reads state (and the 21 subpages
		// that import loadDossierReport lose the override too).
		if (typeof window !== 'undefined') window.location.assign(`${base}/dossier`);
	}

	async function openShareDialog() {
		if (!result) return;
		shareOpen = true;
		shareError = null;
		shareUrl = null;
		shareSize = null;
		shareCopyStatus = '';
		shareEncoding = true;
		try {
			const bundle = buildDossierShareBundle(result);
			const encoded = await encodeDossierShare(bundle);
			shareSize = await estimateShareSize(result);
			const origin = typeof window !== 'undefined' ? window.location.origin : '';
			shareUrl = `${origin}${base}/dossier/shared#data=${encoded}`;
		} catch (e) {
			shareError = e instanceof Error ? e.message : String(e);
		} finally {
			shareEncoding = false;
		}
	}

	function closeShareDialog() {
		shareOpen = false;
		shareUrl = null;
		shareSize = null;
		shareCopyStatus = '';
		shareError = null;
	}

	async function copyShareUrl() {
		if (!shareUrl) return;
		try {
			await navigator.clipboard.writeText(shareUrl);
			shareCopyStatus = 'Link copied.';
		} catch {
			shareCopyStatus = "Couldn't access clipboard — select + copy manually.";
		}
	}

	function downloadShareFile() {
		if (!result) return;
		const bundle = buildDossierShareBundle(result);
		const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		const stamp = new Date().toISOString().slice(0, 10);
		const who = reportUsername ? reportUsername.replace(/[^a-z0-9-]/gi, '_') : 'report';
		a.href = url;
		a.download = `cobra-style-${who}-${stamp}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		shareCopyStatus = 'Download started.';
	}

	function formatKB(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(2)} MB`;
	}

	const evalFraction = $derived(evalTotal > 0 ? Math.min(1, evalDone / evalTotal) : 0);

	const highlights = $derived(result ? highlightAxes(result.fingerprint, 4) : []);
	const scorecard = $derived.by(() => {
		if (!result || !evalSummary || evalSummary.movesAnalysed === 0) return null;
		const baseline = pickBaseline(
			result.fingerprint.avgUserRating,
			primarySpeed(result.fingerprint)
		);
		return buildScorecard(evalSummary, baseline);
	});
	const criticalMoments = $derived.by(() => {
		if (!result || !evalSummary) return null;
		const baseline = pickBaseline(
			result.fingerprint.avgUserRating,
			primarySpeed(result.fingerprint)
		);
		return buildCriticalMoments(evalSummary.allMoves, baseline.criticalMoments ?? null);
	});
	const clockSpendReport = $derived.by(() => {
		if (!result) return null;
		const baseline = pickBaseline(
			result.fingerprint.avgUserRating,
			primarySpeed(result.fingerprint)
		);
		return buildClockSpend(
			result.classified,
			evalSummary?.allMoves ?? null,
			baseline.clockSpend ?? null
		);
	});
	const blunderAtlas = $derived.by(() => {
		if (!evalSummary || evalSummary.movesAnalysed === 0) return null;
		return buildBlunderAtlas(evalSummary.allMoves);
	});
	const sessionProfile = $derived.by(() => {
		if (!result) return null;
		return buildSessionProfile(result.classified, evalSummary?.allMoves ?? null);
	});
	const styleProfile = $derived.by(() => {
		if (!result) return null;
		const baseline = pickBaseline(
			result.fingerprint.avgUserRating,
			primarySpeed(result.fingerprint)
		);
		const cm =
			evalSummary && evalSummary.movesAnalysed > 0
				? buildCriticalMoments(evalSummary.allMoves, baseline.criticalMoments ?? null)
				: null;
		return buildDossierProfile(result.fingerprint, evalSummary, cm, baseline);
	});
	const _openingProfile = $derived.by(() => {
		if (!result) return null;
		return buildOpeningProfile(result.classified, evalSummary?.allMoves ?? null);
	});

	function badgeTint(kind: DossierBadge['kind']) {
		return kind === 'strength'
			? 'border-emerald-500/40 bg-emerald-950/20'
			: 'border-amber-300/40 bg-amber-950/20';
	}

	function _openingTint(verdict: OpeningProfileRow['verdict']) {
		if (verdict === 'strong') return 'border-emerald-500/50 bg-emerald-950/15';
		if (verdict === 'weak') return 'border-amber-300/40 bg-amber-950/15';
		return 'border-[var(--color-ink-800)] bg-[var(--color-ink-950)]';
	}

	const activeBaseline = $derived.by(() => {
		if (!result) return null;
		return pickBaseline(result.fingerprint.avgUserRating, primarySpeed(result.fingerprint));
	});
	const tensionDelta = $derived.by(() => {
		if (!result || !activeBaseline) return null;
		return {
			release: result.fingerprint.tension.releaseRate - activeBaseline.tension.releaseRate,
			create: result.fingerprint.tension.creationRate - activeBaseline.tension.creationRate
		};
	});

	const AXIS_LABEL: Record<string, string> = {
		forcing: 'Forcing moves',
		capture: 'Captures',
		pawnPlay: 'Pawn moves',
		queenside: 'Queenside play',
		earlyCastle: 'Early castle',
		tensionRelease: 'Tension release rate',
		tensionCreate: 'Tension creation rate'
	};

	const PHASE_LABEL = {
		opening: 'Opening',
		middle: 'Middlegame',
		end: 'Endgame'
	} as const;

	function pct(x: number) {
		return `${(x * 100).toFixed(1)}%`;
	}
	function signed(x: number) {
		const v = (x * 100).toFixed(1);
		return x >= 0 ? `+${v}` : v;
	}
	function lichessAnalysisUrl(fen: string) {
		return `https://lichess.org/analysis/standard/${encodeURIComponent(fen)}`;
	}

	const LEAK_LABEL = {
		missed_capture: 'Missed capture',
		impatient_forcing: 'Impatient forcing',
		missed_attack: 'Missed attack'
	} as const;

	const _RESULT_LABEL = { win: 'In wins', loss: 'In losses', draw: 'In draws' } as const;
	const _CLOCK_LABEL = {
		low: '<10s',
		mid: '10–60s',
		high: '60s+'
	} as const;

	/** Color a delta only if it's meaningful (≥3pp). */
	function _deltaClass(delta: number): string {
		if (delta > 0.03) return 'text-emerald-400';
		if (delta < -0.03) return 'text-amber-300';
		return 'text-[var(--color-parchment-400)]';
	}

	const clockHasData = $derived.by(() => {
		if (!result) return false;
		const c = result.fingerprint.byClock;
		return c.low.moves + c.mid.moves + c.high.moves > 0;
	});

	/**
	 * Read the win-vs-loss split as a one-line story: pick the axis where
	 * the gap is largest and turn it into a sentence the user can act on.
	 */
	const _resultRead = $derived.by(() => {
		if (!result) return null;
		const r = result.fingerprint.byResult;
		if (r.win.moves < 50 || r.loss.moves < 50) return null;
		const axes = ['forcing', 'capture', 'pawnPlay', 'queenside'] as const;
		let worst: { axis: (typeof axes)[number]; delta: number } | null = null;
		for (const a of axes) {
			const d = r.loss[a] - r.win[a];
			if (!worst || Math.abs(d) > Math.abs(worst.delta)) worst = { axis: a, delta: d };
		}
		if (!worst || Math.abs(worst.delta) < 0.03) return null;
		const dir = worst.delta > 0 ? 'spikes' : 'drops';
		return `${AXIS_LABEL[worst.axis]} ${dir} by ${Math.abs(worst.delta * 100).toFixed(1)}pp in losses vs wins.`;
	});

	/**
	 * Pull the most informative opening rows: top by game count *and* the
	 * outliers by win rate (vs your overall). Limits to 10 to keep the
	 * table scannable; everything else folds into "Other".
	 */
	const _openingRows = $derived.by(() => {
		if (!result) return { top: [], other: null };
		const all = result.fingerprint.byOpening;
		const big = all.filter((o) => o.games >= 5);
		const small = all.filter((o) => o.games < 5);
		const top = big.slice(0, 10);
		const other =
			small.length === 0
				? null
				: {
						games: small.reduce((s, o) => s + o.games, 0),
						wins: small.reduce((s, o) => s + o.wins, 0),
						losses: small.reduce((s, o) => s + o.losses, 0),
						draws: small.reduce((s, o) => s + o.draws, 0)
					};
		return { top, other };
	});

	const auditSummary = $derived(result ? buildAuditSummary(result) : null);
	const deepInsightCards = $derived(result ? buildDeepInsightCards(result) : []);
	const findingGroups = $derived(
		(() => {
			const order: InsightGroup[] = ['preferences', 'abilities', 'tendencies', 'synthesis'];
			const byGroup: Record<InsightGroup, InsightCard[]> = {
				preferences: [],
				abilities: [],
				tendencies: [],
				synthesis: []
			};
			for (const c of deepInsightCards) byGroup[c.group].push(c);
			// Sort each group by severity rank so the most pressing finding leads.
			for (const g of order) {
				byGroup[g].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
			}
			return order.map((g) => ({ group: g, label: auditAreaLabel(g), cards: byGroup[g] }));
		})()
	);
	const auditRecommendations = $derived(result ? buildFixFirst(result).candidates.slice(0, 5) : []);

	const severityCountsView = $derived(
		auditSummary
			? [
					{ sev: 'critical' as Severity, label: 'Critical', n: auditSummary.counts.critical },
					{ sev: 'concern' as Severity, label: 'Concerns', n: auditSummary.counts.concern },
					{
						sev: 'observation' as Severity,
						label: 'Observations',
						n: auditSummary.counts.observation
					},
					{ sev: 'strength' as Severity, label: 'Strengths', n: auditSummary.counts.strength },
					{
						sev: 'inconclusive' as Severity,
						label: 'Inconclusive',
						n: auditSummary.counts.inconclusive
					}
				]
			: []
	);

	/**
	 * Structured sections for the body of the paper. One section per
	 * finding area, each with an intro paragraph that sets up the findings
	 * that follow. The numbers (3..6) line up with the document TOC.
	 */
	const paperSections = $derived(
		(() => {
			const byGroup = new SvelteMap<InsightGroup, InsightCard[]>();
			for (const fg of findingGroups) byGroup.set(fg.group, fg.cards);
			return [
				{
					num: 3,
					anchor: 'section-3',
					title: 'Stylistic profile',
					intro:
						'Describes how you shape positions when you have latitude — the pieces you keep, the structures you walk into, and the plans you gravitate towards. These are descriptive findings; they tell us what kind of player you are, not yet whether you play well.',
					cards: byGroup.get('preferences') ?? []
				},
				{
					num: 4,
					anchor: 'section-4',
					title: 'Technical skills assessment',
					intro:
						'Measurable competencies benchmarked against rating-band peers: tactical recognition, calculation under branching pressure, endgame conversion, defensive resilience, and prophylactic play.',
					cards: byGroup.get('abilities') ?? []
				},
				{
					num: 5,
					anchor: 'section-5',
					title: 'Behavioural tendencies',
					intro:
						'Patterns across time-of-day, session length, post-blunder sequences, and opponent strength. Often the most actionable — a schedule adjustment can move accuracy without any study.',
					cards: byGroup.get('tendencies') ?? []
				},
				{
					num: 6,
					anchor: 'section-6',
					title: 'Synthesis and outlook',
					intro:
						'Integrative findings — the narrative profile, exemplar games, the axis gap to the next rating band, and your month-over-month progression. Read together, these frame where you are and where the data says you are heading.',
					cards: (byGroup.get('synthesis') ?? []).filter((c) => c.slug !== 'fix-first')
				}
			];
		})()
	);

	/** Eagerly compute every finding's analysis so the paper can embed
	 * charts / tables inline. Each analyser is a pure function over the
	 * already-loaded scan data, so running them on the main page adds
	 * milliseconds, not seconds. */
	const exhibits = $derived.by(() => {
		if (!result) return null;
		const evalMoves = result.evalAxes?.allMoves ?? null;
		return {
			pieceAffinity: analysePieceAffinity(result.classified),
			structureTaste: analyseStructureTaste(result.classified),
			exchangePropensity: analyseExchangePropensity(result.classified),
			planTaste: analysePlanTaste(result.classified),
			openingFit: analyseOpeningFit(result.classified, evalMoves),
			endgameSubtypes: analyseEndgameSubtypes(result.classified, evalMoves),
			tacticalMotifs: analyseTacticalMotifs(evalMoves),
			calculationDepth: analyseCalculationDepth(result.classified, evalMoves),
			defensiveResource: analyseDefensiveResource(result.classified, evalMoves),
			prophylaxis: analyseProphylaxis(evalMoves),
			blunderTiming: analyseBlunderTiming(evalMoves),
			timeOfDay: analyseTimeOfDay(result.classified, evalMoves),
			sessionDecay: analyseSessionDecay(result.classified, evalMoves),
			repeatOffenders: analyseRepeatOffenders(result.classified, evalMoves),
			recoveryArc: analyseRecoveryArc(evalMoves),
			opponentStrength: analyseOpponentStrength(result.classified, evalMoves),
			levelUp: buildLevelUp(result.fingerprint, 200),
			exemplars: buildExemplars(result.classified),
			progression: analyseProgression(result.classified, evalMoves)
		};
	});

	function pctFmt(x: number, digits = 1): string {
		return `${(x * 100).toFixed(digits)}%`;
	}
	function signedPctFmt(x: number, digits = 1): string {
		const sign = x >= 0 ? '+' : '';
		return `${sign}${(x * 100).toFixed(digits)}pp`;
	}
	function barWidth(value: number, max: number): string {
		if (max <= 0) return '0%';
		return `${Math.min(100, Math.max(2, (value / max) * 100)).toFixed(1)}%`;
	}
	function hourHeat(winRate: number): string {
		if (winRate >= 0.6) return 'bg-emerald-500/70';
		if (winRate >= 0.5) return 'bg-emerald-500/45';
		if (winRate >= 0.4) return 'bg-[var(--color-parchment-400)]/40';
		if (winRate >= 0.3) return 'bg-amber-500/45';
		return 'bg-amber-500/70';
	}

	function exhibitCaption(slug: string): string {
		switch (slug) {
			case 'piece-affinity':
				return 'Minor-piece trade counts and captures-by-material-state';
			case 'structure-taste':
				return 'Top structures by game count · win-rate delta vs you';
			case 'exchange-propensity':
				return 'Piece-trade rate by material state';
			case 'plan-taste':
				return 'Middlegame destination wing distribution';
			case 'opening-fit':
				return 'ECO families ranked by fit to your axes';
			case 'endgame-subtypes':
				return 'Conversion & defense rate by endgame family';
			case 'tactical-motifs':
				return 'Blunders bucketed by tactical motif';
			case 'calculation-depth':
				return 'Avg CP loss by branching factor';
			case 'defensive-resource':
				return 'Defense rate by difficulty (legal-move count)';
			case 'prophylaxis':
				return 'Threats faced vs neutralised';
			case 'blunder-timing':
				return 'Blunder + mistake rate by move range';
			case 'time-of-day':
				return 'Hour-of-day heat strip & weekday win rate';
			case 'session-decay':
				return 'CP loss by game-in-session × phase';
			case 'repeat-offenders':
				return 'Top repeat motif + piece blunders';
			case 'recovery-arc':
				return 'CP loss offsets 0…5 after a blunder';
			case 'opponent-strength':
				return 'Avg CP loss vs rating-gap bucket';
			case 'narrative':
				return 'Coach-style paragraph summary';
			case 'level-up':
				return `Axis gap vs baseline at +200 rating`;
			case 'exemplars':
				return 'Representative vs contradictory games';
			case 'progression':
				return 'Monthly CP loss trajectory';
			default:
				return '';
		}
	}

	const reportUsername = $derived.by(() => {
		if (!auditSummary || auditSummary.scope.accounts.length === 0) return null;
		const first = auditSummary.scope.accounts[0];
		const slash = first.indexOf('/');
		return slash >= 0 ? first.slice(slash + 1) : first;
	});

	function todayString(): string {
		const d = new Date();
		return d.toISOString().slice(0, 10);
	}

	function severityNarrative(s: Severity): string {
		switch (s) {
			case 'critical':
				return "this is the report's most urgent finding";
			case 'concern':
				return 'this is a concern worth addressing';
			case 'strength':
				return 'this is a strength to build around';
			case 'observation':
				return 'this is an observation, not a concern';
			default:
				return 'the sample was too small to rate this confidently';
		}
	}

	function severityTint(s: Severity): string {
		switch (s) {
			case 'critical':
				return 'border-red-500/60 bg-red-950/20 text-red-300';
			case 'concern':
				return 'border-amber-300/50 bg-amber-950/20 text-amber-300';
			case 'strength':
				return 'border-emerald-500/50 bg-emerald-950/20 text-emerald-300';
			case 'observation':
				return 'border-[var(--color-ink-700)] bg-[var(--color-ink-950)] text-[var(--color-parchment-300)]';
			default:
				return 'border-[var(--color-ink-800)] bg-[var(--color-ink-950)] text-[var(--color-parchment-500)]';
		}
	}

	function severityDot(s: Severity): string {
		switch (s) {
			case 'critical':
				return 'bg-red-400';
			case 'concern':
				return 'bg-amber-400';
			case 'strength':
				return 'bg-emerald-400';
			case 'observation':
				return 'bg-[var(--color-parchment-400)]';
			default:
				return 'bg-[var(--color-ink-700)]';
		}
	}

	function formatDateShort(ms: number | null): string {
		if (ms == null) return '—';
		const d = new Date(ms);
		return d.toISOString().slice(0, 10);
	}

	function _findingId(groupIdx: number, cardIdx: number): string {
		const letter = 'ABCD'[groupIdx] ?? 'X';
		return `F-${letter}${(cardIdx + 1).toString().padStart(2, '0')}`;
	}

	const _clockRead = $derived.by(() => {
		if (!result || !clockHasData) return null;
		const c = result.fingerprint.byClock;
		if (c.low.moves < 30 || c.high.moves < 30) return null;
		const axes = ['forcing', 'capture', 'pawnPlay'] as const;
		let worst: { axis: (typeof axes)[number]; delta: number } | null = null;
		for (const a of axes) {
			const d = c.low[a] - c.high[a];
			if (!worst || Math.abs(d) > Math.abs(worst.delta)) worst = { axis: a, delta: d };
		}
		if (!worst || Math.abs(worst.delta) < 0.03) return null;
		const dir = worst.delta > 0 ? 'jumps' : 'drops';
		return `${AXIS_LABEL[worst.axis]} ${dir} by ${Math.abs(worst.delta * 100).toFixed(1)}pp under 10s vs 60s+.`;
	});
</script>

<div
	class={result
		? 'mx-auto max-w-5xl px-4 py-8 sm:px-6'
		: 'relative mx-auto max-w-2xl px-6 pt-14 pb-16'}
>
	{#if result}
		<a
			href={resolve('/')}
			class="eyebrow inline-flex items-center gap-1 transition-colors hover:text-[var(--color-parchment-100)]"
		>
			<ArrowLeft class="size-3" />
			<span>Dashboard</span>
		</a>
	{:else}
		<DashboardBacklink />
	{/if}

	{#if viewingShared}
		<div
			class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--color-brass-300)]/50 bg-[var(--color-brass-300)]/10 px-4 py-2.5 text-xs"
		>
			<div class="flex items-center gap-2">
				<span class="inline-block size-1.5 rounded-full bg-[var(--color-brass-300)]"></span>
				<span class="text-[var(--color-parchment-100)]"> Viewing a shared style review. </span>
				<span class="text-[var(--color-parchment-400)]">
					Nothing has been written to your local storage.
				</span>
			</div>
			<button
				type="button"
				onclick={exitSharedView}
				class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1 hover:border-[var(--color-brass-300)]/40"
			>
				Exit shared view
			</button>
		</div>
	{/if}

	{#if shareOpen}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
			role="dialog"
			aria-modal="true"
			aria-labelledby="share-title"
			tabindex="-1"
			onclick={(e) => {
				if (e.target === e.currentTarget) closeShareDialog();
			}}
			onkeydown={(e) => {
				if (e.key === 'Escape') closeShareDialog();
			}}
		>
			<div
				class="w-full max-w-xl rounded border border-[var(--color-brass-300)]/40 bg-[var(--color-ink-900)] shadow-2xl"
			>
				<div
					class="flex items-center justify-between border-b border-[var(--color-ink-800)] px-5 py-3"
				>
					<div>
						<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
							Share report
						</div>
						<h3 id="share-title" class="mt-0.5 font-serif text-lg text-[var(--color-parchment-50)]">
							Hand this report to someone
						</h3>
					</div>
					<button
						type="button"
						onclick={closeShareDialog}
						class="text-[var(--color-parchment-400)] hover:text-[var(--color-parchment-100)]"
						aria-label="Close"
					>
						<X class="size-4" />
					</button>
				</div>

				<div class="space-y-4 px-5 py-5 text-sm text-[var(--color-parchment-200)]">
					<p class="leading-relaxed text-[var(--color-parchment-300)]">
						Share bundles the full scan — classified games, engine moves, and every finding — into a
						single encoded string. The recipient opens the link, previews what they're about to
						import, and decides whether to adopt it as their local report.
					</p>

					{#if shareEncoding}
						<p class="text-xs text-[var(--color-parchment-500)]">Compressing report…</p>
					{:else if shareError}
						<p class="text-xs text-red-400">{shareError}</p>
					{:else if shareUrl && shareSize}
						<div>
							<label
								class="mb-1 block text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
								for="share-url"
							>
								Share link
							</label>
							<div class="flex gap-2">
								<input
									id="share-url"
									type="text"
									readonly
									value={shareUrl}
									class="flex-1 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1.5 font-mono text-xs text-[var(--color-parchment-200)]"
									onclick={(e) => (e.currentTarget as HTMLInputElement).select()}
								/>
								<button
									type="button"
									onclick={copyShareUrl}
									class="inline-flex items-center gap-1 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1.5 text-xs hover:border-[var(--color-brass-300)]/40"
								>
									<Copy class="size-3" />
									Copy
								</button>
							</div>
							<p class="mt-1.5 text-[10px] text-[var(--color-parchment-500)]">
								Encoded payload: <span class="font-mono"
									>{shareSize.base64Chars.toLocaleString()}</span
								>
								base64 chars · raw <span class="font-mono">{formatKB(shareSize.jsonBytes)}</span>
								{#if shareSize.base64Chars > 500_000}
									·
									<span class="text-amber-300">
										Very long URL — some mail clients will truncate. Prefer the file download below.
									</span>
								{:else if shareSize.base64Chars > 100_000}
									· <span class="text-[var(--color-parchment-400)]"
										>URL is long — some chat apps may shorten it; download as file if in doubt.</span
									>
								{/if}
							</p>
						</div>

						<div class="border-t border-[var(--color-ink-800)] pt-4">
							<label
								class="mb-1 block text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
								for="share-download"
							>
								Or download as a file
							</label>
							<button
								id="share-download"
								type="button"
								onclick={downloadShareFile}
								class="inline-flex items-center gap-1 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-3 py-1.5 text-xs hover:border-[var(--color-brass-300)]/40"
							>
								<Download class="size-3" />
								Download .json
							</button>
							<p class="mt-1.5 text-[10px] text-[var(--color-parchment-500)]">
								Recipient uploads the file at <span class="font-mono">/dossier/shared</span>. Works
								for reports of any size.
							</p>
						</div>

						{#if shareCopyStatus}
							<p class="text-xs text-emerald-400">{shareCopyStatus}</p>
						{/if}

						<p
							class="border-t border-[var(--color-ink-800)] pt-3 text-[10px] text-[var(--color-parchment-500)]"
						>
							Shared bundles contain opponent usernames, game IDs, and ratings from the scan — same
							information Lichess / chess.com make public on your games. Don't share if your game
							history should stay private.
						</p>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if result && auditSummary}
		<section class="mt-8 border-b-2 border-[var(--color-brass-300)]/60 pb-8">
			<div class="text-[10px] tracking-[0.25em] text-[var(--color-brass-300)] uppercase">
				Cobra Analytics · Dossier
			</div>
			<h1
				class="mt-3 font-serif text-4xl leading-tight text-[var(--color-parchment-50)] sm:text-5xl"
			>
				A review of {reportUsername ? `${reportUsername}'s` : 'your'} recent play
			</h1>
			<p class="mt-4 max-w-3xl text-sm leading-relaxed text-[var(--color-parchment-300)]">
				{auditSummary.scope.games} rated games · {auditSummary.scope.totalUserMoves.toLocaleString()}
				user moves ·
				{#if auditSummary.scope.evalMovesAnalysed > 0}
					{auditSummary.scope.evalMovesAnalysed.toLocaleString()} engine-analysed moves at depth {auditSummary
						.scope.evalDepth} NNUE ·
				{/if}
				played {formatDateShort(auditSummary.scope.dateFrom)} – {formatDateShort(
					auditSummary.scope.dateTo
				)}.
			</p>
			{#if (result.evalAxes?.movesFromLichess ?? 0) > 0}
				<p class="mt-1 max-w-3xl text-xs text-[var(--color-parchment-500)]">
					Eval provenance: {result.evalAxes!.movesFromLichess.toLocaleString()} adopted from Lichess ·
					{(result.evalAxes!.movesFromLocal ?? 0).toLocaleString()} computed locally at depth {auditSummary
						.scope.evalDepth} NNUE.
				</p>
			{/if}
			<div class="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--color-parchment-500)]">
				<span>Prepared {todayString()}</span>
				<span aria-hidden="true">·</span>
				<span>
					Signal strength:
					<span
						class="ml-1 font-mono {auditSummary.signalStrength === 'strong'
							? 'text-emerald-400'
							: auditSummary.signalStrength === 'moderate'
								? 'text-[var(--color-brass-300)]'
								: 'text-amber-300'}"
					>
						{auditSummary.signalStrength}
					</span>
				</span>
				{#if auditSummary.scope.accounts.length > 0}
					<span aria-hidden="true">·</span>
					<span class="font-mono">{auditSummary.scope.accounts.join(', ')}</span>
				{/if}
			</div>
		</section>
	{:else}
		<div class="eyebrow mb-3">Dossier</div>
		<h1 class="font-serif text-5xl leading-[1.05] tracking-tight">
			A review of how you <em class="text-[var(--color-brass-300)]">play</em>.
		</h1>
		<p class="mt-3 max-w-md text-[var(--color-parchment-400)]">
			A consulting-style report on your patterns and blunders. Run a scan to produce it.
		</p>
	{/if}
	{#if !result}
		<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
			Baseline source: <span class="font-mono">{BASELINE_META.source}</span>
			{#if BASELINE_META.bucketCount > 0}
				· {BASELINE_META.bucketCount} rating bucket{BASELINE_META.bucketCount === 1 ? '' : 's'}
			{:else if BASELINE_META.source === 'empirical'}
				· {BASELINE_META.games} games from {BASELINE_META.sampledFrom?.length ?? 0} players
			{:else}
				· calibrate one from
				<a
					href={resolve('/settings')}
					class="underline decoration-[var(--color-parchment-500)]/60 underline-offset-2 hover:text-[var(--color-parchment-200)]"
					>Settings → Dossier baseline</a
				>
				to replace with numbers measured from your own opponents
			{/if}
			{#if activeBaseline?.bucket}
				· active: <span class="font-mono"
					>{activeBaseline.source} · {activeBaseline.bucket.bucket ?? 'any'}
					{activeBaseline.bucket.ratingMin}–{activeBaseline.bucket.ratingMax}</span
				>
				({activeBaseline.bucket.games} games)
			{/if}
		</p>
	{/if}

	{#if result}
		<p class="no-print mt-4 text-xs text-[var(--color-parchment-500)]">
			Baseline {storedBaselines.length > 0
				? `calibrated from ${storedBaselines.length} bucket${storedBaselines.length === 1 ? '' : 's'}`
				: 'still using eyeballed defaults'} ·
			<a
				href={resolve('/settings#dossier-baseline')}
				class="underline decoration-[var(--color-parchment-500)]/60 underline-offset-2 hover:text-[var(--color-parchment-200)]"
				>manage in Settings</a
			>
		</p>
	{/if}

	{#if reportLoading}
		<div
			class="mt-6 flex items-center gap-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4 text-sm text-[var(--color-parchment-300)]"
			role="status"
			aria-live="polite"
		>
			<span
				class="inline-block size-4 animate-spin rounded-full border-2 border-[var(--color-brass-300)] border-t-transparent"
				aria-hidden="true"
			></span>
			<span>{viewingShared ? 'Loading shared report…' : 'Loading report…'}</span>
		</div>
	{:else if accounts.length === 0 && !viewingShared}
		<div class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-4">
			Add a scan account in <a class="underline" href={resolve('/settings')}>Settings</a> first.
		</div>
	{:else if result && !running}
		<!-- A report is already on file. Offer to regenerate rather than
		     immediately running again (a full scan is expensive). -->
		<div
			class="no-print mt-6 flex flex-col gap-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-3"
		>
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="text-sm">
					<div class="text-[var(--color-parchment-200)]">
						{viewingShared ? 'Shared report (read-only)' : 'Report on file'}
					</div>
					<div class="mt-0.5 text-xs text-[var(--color-parchment-500)]">
						{#if viewingShared}
							{result.classified.length} games · {result.evalAxes?.movesAnalysed ?? 0} moves analysed
						{:else}
							{#if reportSavedAt != null}
								Saved {formatSavedAt(reportSavedAt)} ·
							{/if}
							{result.classified.length} games · {result.evalAxes?.movesAnalysed ?? 0} moves analysed
						{/if}
					</div>
				</div>
				<div class="flex flex-wrap items-center gap-2 text-xs">
					<button
						type="button"
						onclick={openShareDialog}
						class="inline-flex items-center gap-1 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1 hover:border-[var(--color-brass-300)]/40"
					>
						<Share2 class="size-3" />
						Share
					</button>
					<button
						type="button"
						onclick={printReport}
						class="inline-flex items-center gap-1 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-950)] px-2 py-1 hover:border-[var(--color-brass-300)]/40"
						title="Open system print dialog — choose 'Save as PDF' to export"
					>
						<Printer class="size-3" />
						Print / PDF
					</button>
				</div>
			</div>
			{#if !viewingShared}
				<div class="flex flex-wrap items-center gap-3 text-xs">
					<label class="inline-flex items-center gap-2">
						<span class="text-[var(--color-parchment-400)]">Accounts</span>
						<MultiSelect
							options={accountOptions}
							selected={selectedAccountKeys}
							onchange={(next) => (selectedAccountKeys = next)}
							placeholder="All"
							class="w-56"
						>
							{#snippet renderOption(opt)}
								{@const account = accountByValue.get(opt.value)}
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
								<span class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
									{#each chosen as opt (opt.value)}
										{@const account = accountByValue.get(opt.value)}
										{#if account}
											<span
												class="inline-flex items-center gap-1 rounded-[3px] bg-[var(--color-ink-850)] px-1 py-0.5 font-mono text-[11px]"
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
					</label>
					<label class="inline-flex items-center gap-2">
						<span class="text-[var(--color-parchment-400)]">Games/account</span>
						<input
							type="number"
							bind:value={maxGames}
							min="10"
							max="500"
							class="h-10 w-24 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-3 font-sans text-sm text-[var(--color-parchment-100)] transition-colors hover:border-[var(--color-ink-600)] focus:border-[var(--color-brass-300)] focus:ring-[3px] focus:ring-[var(--color-brass-300)]/15 focus:outline-none"
						/>
					</label>
					<label class="inline-flex items-center gap-2">
						<span
							class="text-[var(--color-parchment-400)]"
							title="Higher depth = sharper tactics but slower scan. Leak re-eval always runs at depth 20 regardless."
							>Engine depth</span
						>
						<Select
							value={evalDepth}
							onchange={(v) => {
								if (v != null) evalDepth = v;
							}}
							options={[
								{ value: 14, label: '14 · fast (~2 min)' },
								{ value: 18, label: '18 · balanced (~8 min)' },
								{ value: 22, label: '22 · deep (~30 min)' }
							]}
							class="w-52"
						/>
					</label>
				</div>
				<div class="flex flex-wrap items-center gap-3 text-xs">
					<Button onclick={run}>Generate new report</Button>
					<button
						type="button"
						onclick={discardReport}
						class="text-[var(--color-parchment-400)] underline"
					>
						Discard
					</button>
				</div>
			{/if}
		</div>
	{:else}
		<div class="mt-6 flex flex-wrap items-end gap-3">
			<div class="min-w-[14rem] flex-1">
				<Label for="dossier-accounts">
					<span
						class="cursor-help underline decoration-[var(--color-parchment-500)]/60 decoration-dotted underline-offset-2"
						title="Leave empty to scan every configured account"
					>
						Accounts
					</span>
				</Label>
				<MultiSelect
					id="dossier-accounts"
					options={accountOptions}
					selected={selectedAccountKeys}
					onchange={(next) => (selectedAccountKeys = next)}
					placeholder="All accounts"
				>
					{#snippet renderOption(opt)}
						{@const account = accountByValue.get(opt.value)}
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
								{@const account = accountByValue.get(opt.value)}
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
			<label class="flex flex-col gap-1 text-sm">
				<span
					class="cursor-help text-[var(--color-parchment-400)] underline decoration-[var(--color-parchment-500)]/60 decoration-dotted underline-offset-2"
					title="Per account"
				>
					Games
				</span>
				<input
					type="number"
					bind:value={maxGames}
					min="10"
					max="500"
					class="h-10 w-20 rounded-[4px] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-3 font-sans text-sm text-[var(--color-parchment-100)] transition-colors hover:border-[var(--color-ink-600)] focus:border-[var(--color-brass-300)] focus:ring-[3px] focus:ring-[var(--color-brass-300)]/15 focus:outline-none"
				/>
			</label>
			<label class="flex flex-col gap-1 text-sm">
				<span
					class="text-[var(--color-parchment-400)]"
					title="Higher depth = sharper tactics but slower scan. Leak re-eval always runs at depth 20 regardless."
					>Engine depth</span
				>
				<Select
					value={evalDepth}
					onchange={(v) => {
						if (v != null) evalDepth = v;
					}}
					options={[
						{ value: 14, label: '14 · fast' },
						{ value: 18, label: '18 · balanced' },
						{ value: 22, label: '22 · deep' }
					]}
					class="w-40"
				/>
			</label>
			<div class="flex items-center gap-3 self-end">
				<Button onclick={run} disabled={running}>
					{running ? 'Scanning…' : 'Scan'}
				</Button>
				{#if running}
					<button
						type="button"
						onclick={() => dossierScan.cancel()}
						class="text-xs text-[var(--color-parchment-400)] underline"
					>
						Cancel
					</button>
				{/if}
			</div>
		</div>

		{#if running || scanPhase === 'done'}
			<div
				class="mt-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-3"
			>
				<!-- Stage 1: fetching games -->
				<div class="flex items-baseline justify-between gap-2">
					<div class="flex items-center gap-2 text-xs">
						{#if scanPhase === 'fetching'}
							<span
								class="inline-block size-1.5 animate-pulse rounded-full bg-[var(--color-brass-300)]"
							></span>
							<span class="text-[var(--color-parchment-200)]">Fetching games</span>
						{:else if scanPhase === 'analysing' || scanPhase === 'done'}
							<span class="inline-block size-1.5 rounded-full bg-emerald-400"></span>
							<span class="text-[var(--color-parchment-400)]">Games fetched</span>
						{:else}
							<span class="inline-block size-1.5 rounded-full bg-[var(--color-ink-700)]"></span>
							<span class="text-[var(--color-parchment-500)]">Fetch games</span>
						{/if}
					</div>
					<span class="font-mono text-xs text-[var(--color-parchment-500)]">
						{scanGamesDone} games
					</span>
				</div>
				{#if scanPhase === 'fetching' && progress}
					<p class="mt-1 text-[10px] text-[var(--color-parchment-500)]">{progress}</p>
				{/if}

				<!-- Stage 2: Stockfish analysis -->
				<div class="mt-3 flex items-baseline justify-between gap-2">
					<div class="flex items-center gap-2 text-xs">
						{#if scanPhase === 'analysing'}
							<span
								class="inline-block size-1.5 animate-pulse rounded-full bg-[var(--color-brass-300)]"
							></span>
							<span class="text-[var(--color-parchment-200)]">Analysing with Stockfish</span>
						{:else if scanPhase === 'done'}
							<span class="inline-block size-1.5 rounded-full bg-emerald-400"></span>
							<span class="text-[var(--color-parchment-400)]">Analysis complete</span>
						{:else}
							<span class="inline-block size-1.5 rounded-full bg-[var(--color-ink-700)]"></span>
							<span class="text-[var(--color-parchment-500)]">Analyse with Stockfish</span>
						{/if}
					</div>
					<span class="font-mono text-xs text-[var(--color-parchment-500)]">
						{#if evalTotal > 0}
							{evalDone} / {evalTotal} moves
						{:else}
							—
						{/if}
					</span>
				</div>
				<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-ink-950)]">
					<div
						class="h-full rounded-full bg-[var(--color-brass-300)] transition-[width] duration-150"
						style="width: {scanPhase === 'done' ? 100 : evalTotal > 0 ? evalFraction * 100 : 0}%"
					></div>
				</div>
				{#if scanPhase === 'analysing' && evalTotal > 0}
					<p class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
						{Math.round(evalFraction * 100)}% · depth 14 NNUE
					</p>
				{/if}
			</div>
		{/if}
		{#if error}
			<p class="mt-2 text-sm text-red-400">{error}</p>
		{/if}
	{/if}

	{#if result}
		{@const fp = result.fingerprint}

		<!-- ======== Consulting-paper body ======== -->
		{#if auditSummary}
			<!-- Table of contents -->
			<nav
				class="mt-10 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-6 py-5 print:break-inside-avoid"
				aria-label="Contents"
			>
				<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
					Contents
				</div>
				<ol class="mt-3 grid gap-1 text-sm text-[var(--color-parchment-200)] sm:grid-cols-2">
					<li>
						<a class="hover:text-[var(--color-brass-300)]" href="#section-1">
							<span class="font-mono text-[var(--color-parchment-500)]">1.</span>
							Executive summary
						</a>
					</li>
					<li>
						<a class="hover:text-[var(--color-brass-300)]" href="#section-2">
							<span class="font-mono text-[var(--color-parchment-500)]">2.</span>
							Scope and methodology
						</a>
					</li>
					{#each paperSections as s (s.anchor)}
						<li>
							<a class="hover:text-[var(--color-brass-300)]" href="#{s.anchor}">
								<span class="font-mono text-[var(--color-parchment-500)]">{s.num}.</span>
								{s.title}
							</a>
							{#if s.cards.length > 0}
								<ol class="mt-1 ml-5 grid gap-0.5 text-xs text-[var(--color-parchment-400)]">
									{#each s.cards as c, cIdx (c.slug)}
										<li>
											<a class="hover:text-[var(--color-brass-300)]" href="#{s.anchor}-{cIdx + 1}">
												<span class="font-mono text-[var(--color-parchment-500)]"
													>{s.num}.{cIdx + 1}</span
												>
												{c.title}
											</a>
										</li>
									{/each}
								</ol>
							{/if}
						</li>
					{/each}
					<li>
						<a class="hover:text-[var(--color-brass-300)]" href="#section-7">
							<span class="font-mono text-[var(--color-parchment-500)]">7.</span>
							Priority actions
						</a>
					</li>
					<li>
						<a class="hover:text-[var(--color-brass-300)]" href="#appendices">
							<span class="font-mono text-[var(--color-parchment-500)]">A.</span>
							Appendices (A–J)
						</a>
					</li>
				</ol>
			</nav>

			<!-- §1 Executive summary -->
			<section id="section-1" class="mt-12 scroll-mt-6">
				<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
					Section 1
				</div>
				<h2 class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)]">Executive summary</h2>
				<div
					class="mt-4 max-w-3xl space-y-4 text-[15px] leading-relaxed text-[var(--color-parchment-200)]"
				>
					<p class="font-serif text-lg leading-snug text-[var(--color-parchment-50)]">
						{auditSummary.verdict}
					</p>
					<p>
						The report draws on {auditSummary.scope.games} rated games
						{#if auditSummary.hasEval}
							(with {auditSummary.scope.evalMovesAnalysed.toLocaleString()} moves cross-checked against
							a Stockfish depth-{auditSummary.scope.evalDepth} NNUE reference)
						{/if}
						and classifies its {auditSummary.keyFindings.length +
							auditSummary.counts.observation +
							auditSummary.counts.inconclusive}
						findings by severity. On this sample we recorded
						{auditSummary.counts.critical} critical finding{auditSummary.counts.critical === 1
							? ''
							: 's'},
						{auditSummary.counts.concern} concern{auditSummary.counts.concern === 1 ? '' : 's'},
						{auditSummary.counts.strength} strength{auditSummary.counts.strength === 1 ? '' : 's'},
						and
						{auditSummary.counts.observation} neutral observation{auditSummary.counts
							.observation === 1
							? ''
							: 's'}.
						{#if auditSummary.counts.inconclusive > 0}
							A further {auditSummary.counts.inconclusive} finding{auditSummary.counts
								.inconclusive === 1
								? ''
								: 's'}
							lacked sufficient sample size to rate confidently.
						{/if}
					</p>
				</div>

				<div class="mt-6 grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
					{#each severityCountsView as cv (cv.sev)}
						<div class="rounded border px-3 py-2 {severityTint(cv.sev)}">
							<div class="text-[10px] tracking-wider uppercase opacity-70">{cv.label}</div>
							<div class="mt-1 font-mono text-lg">{cv.n}</div>
						</div>
					{/each}
				</div>

				{#if auditSummary.keyFindings.length > 0}
					<div
						class="mt-6 rounded border-l-2 border-[var(--color-brass-300)] bg-[var(--color-ink-900)] px-5 py-4"
					>
						<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
							Headline findings
						</div>
						<ol class="mt-2 space-y-2 text-sm text-[var(--color-parchment-200)]">
							{#each auditSummary.keyFindings as c, i (c.slug)}
								<li class="flex items-start gap-2">
									<span
										class="mt-0.5 inline-block size-1.5 shrink-0 rounded-full {severityDot(
											c.severity
										)}"
									></span>
									<span>
										<span class="text-[var(--color-parchment-100)]">
											{i + 1}. {c.title}.
										</span>
										<span class="text-[var(--color-parchment-300)]">{c.headline}</span>
									</span>
								</li>
							{/each}
						</ol>
					</div>
				{/if}
			</section>

			<!-- §2 Scope and methodology -->
			<section id="section-2" class="mt-12 scroll-mt-6">
				<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
					Section 2
				</div>
				<h2 class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)]">
					Scope and methodology
				</h2>
				<div
					class="mt-4 max-w-3xl space-y-4 text-[15px] leading-relaxed text-[var(--color-parchment-200)]"
				>
					<p>
						We ingested your most recent rated games from {auditSummary.scope.accounts.length}
						account{auditSummary.scope.accounts.length === 1 ? '' : 's'} and ran every user move through
						a board-feature extractor (piece role, captures, tension, pawn moves, destination file, demand
						heuristics).
						{#if auditSummary.hasEval}
							A Stockfish NNUE pass at depth {auditSummary.scope.evalDepth} scored each user move against
							the engine's preferred line, giving us centipawn-loss, classification (inaccuracy/mistake/blunder),
							and sac tendency.
						{:else}
							No engine pass was run for this report, so any finding that depends on centipawn loss
							has been marked <em>inconclusive</em>. Re-scan with Stockfish enabled to upgrade
							those.
						{/if}
					</p>
					<p>
						Peer benchmarks come from the
						<span class="font-mono text-[var(--color-parchment-100)]"
							>{auditSummary.scope.baselineSource}</span
						>
						baseline
						{#if auditSummary.scope.baselineBucket}
							({auditSummary.scope.baselineBucket})
						{/if}
						— players at your rating band and primary speed. Findings are classified as
						<em>critical</em>, <em>concern</em>, <em>strength</em>, <em>observation</em>, or
						<em>inconclusive</em> using thresholds set on each individual finding (e.g. endgame
						conversion below 50% is <em>critical</em>; prophylaxis neutralise rate above 65% is a
						<em>strength</em>).
					</p>
				</div>

				<dl
					class="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-5 py-4 text-xs sm:grid-cols-3"
				>
					<div>
						<dt class="text-[var(--color-parchment-500)]">Accounts</dt>
						<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
							{auditSummary.scope.accounts.join(', ') || '—'}
						</dd>
					</div>
					<div>
						<dt class="text-[var(--color-parchment-500)]">Games</dt>
						<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
							{auditSummary.scope.games}
						</dd>
					</div>
					<div>
						<dt class="text-[var(--color-parchment-500)]">User moves</dt>
						<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
							{auditSummary.scope.totalUserMoves.toLocaleString()}
						</dd>
					</div>
					<div>
						<dt class="text-[var(--color-parchment-500)]">Engine moves</dt>
						<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
							{auditSummary.scope.evalMovesAnalysed.toLocaleString()}
							{#if auditSummary.hasEval}
								<span class="text-[var(--color-parchment-500)]"
									>· depth {auditSummary.scope.evalDepth}</span
								>
							{/if}
						</dd>
					</div>
					<div>
						<dt class="text-[var(--color-parchment-500)]">Date range</dt>
						<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
							{formatDateShort(auditSummary.scope.dateFrom)} → {formatDateShort(
								auditSummary.scope.dateTo
							)}
						</dd>
					</div>
					<div>
						<dt class="text-[var(--color-parchment-500)]">Peer baseline</dt>
						<dd class="mt-0.5 font-mono text-[var(--color-parchment-100)]">
							{auditSummary.scope.baselineSource}{auditSummary.scope.baselineBucket
								? ` · ${auditSummary.scope.baselineBucket}`
								: ''}
						</dd>
					</div>
				</dl>

				<!-- Move-quality histogram + headline accuracy. Promoted out of the
				     appendix because it's a core summary of *how well you played*.
				     Accuracy uses the Lichess WP-loss sigmoid rather than raw CP
				     loss so a 50cp drop in a balanced position counts very
				     differently from the same drop when already lost. -->
				{#if evalSummary && evalSummary.movesAnalysed > 0}
					<div
						class="mt-5 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-5 py-4"
					>
						<div class="flex flex-wrap items-baseline justify-between gap-3">
							<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
								Move-quality histogram · Lichess-style WP accuracy
							</div>
							<div class="flex flex-wrap gap-2 text-xs">
								<span
									class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-0.5 text-[var(--color-parchment-200)]"
								>
									Accuracy:
									<span class="font-mono text-[var(--color-parchment-100)]">
										{evalSummary.avgAccuracy.toFixed(1)}%
									</span>
								</span>
								<span
									class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-0.5 text-[var(--color-parchment-200)]"
								>
									Tactical moves:
									<span class="font-mono text-[var(--color-parchment-100)]">
										{(evalSummary.tacticalMoveRate * 100).toFixed(1)}%
									</span>
								</span>
							</div>
						</div>

						<div class="mt-3 space-y-1 text-xs">
							{#each evalSummary.histogram as b (b.quality)}
								{@const color =
									b.quality === 'brilliant'
										? 'bg-sky-400/70'
										: b.quality === 'best'
											? 'bg-emerald-500/70'
											: b.quality === 'excellent'
												? 'bg-emerald-400/55'
												: b.quality === 'good'
													? 'bg-[var(--color-brass-300)]/70'
													: b.quality === 'inaccuracy'
														? 'bg-amber-300/70'
														: b.quality === 'mistake'
															? 'bg-amber-500/70'
															: 'bg-red-500/70'}
								<div
									class="grid grid-cols-[minmax(0,5rem)_1fr_3rem_2.5rem] items-center gap-2 sm:grid-cols-[7rem_1fr_3.5rem_3rem]"
								>
									<span class="text-[var(--color-parchment-200)]">
										{MOVE_QUALITY_LABEL[b.quality]}
									</span>
									<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
										<div
											class="h-full rounded {color}"
											style:width="{Math.max(2, b.share * 100).toFixed(1)}%"
										></div>
									</div>
									<span class="text-right font-mono text-[var(--color-parchment-100)]">
										{(b.share * 100).toFixed(1)}%
									</span>
									<span class="text-right font-mono text-[var(--color-parchment-500)]">
										{b.count}
									</span>
								</div>
							{/each}
						</div>

						<div class="mt-3 flex flex-wrap gap-3 text-[10px] text-[var(--color-parchment-500)]">
							<span
								>Avg WP loss: <span class="font-mono">{evalSummary.avgWpLoss.toFixed(2)}pp</span
								></span
							>
							{#if evalSummary.multiPv}
								<span>Multi-PV 3</span>
							{/if}
							{#if evalSummary.usedMastersBook && evalSummary.movesSkippedBook > 0}
								<span>Skipped {evalSummary.movesSkippedBook} book moves</span>
							{/if}
							{#if evalSummary.usedTablebase}
								<span>Syzygy tablebase on for ≤ 7 pieces</span>
							{/if}
						</div>
					</div>
				{/if}
			</section>

			<!-- §3–6 Findings sections -->
			{#each paperSections as s (s.anchor)}
				<section id={s.anchor} class="mt-12 scroll-mt-6">
					<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
						Section {s.num}
					</div>
					<h2 class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)]">{s.title}</h2>
					<p class="mt-4 max-w-3xl text-[15px] leading-relaxed text-[var(--color-parchment-300)]">
						{s.intro}
					</p>

					<!-- §3 Stylistic profile: v1 + v2 style analyses paired, then the
					     structured Profile block. These three sit above the individual
					     findings and give the reader the "what kind of player" framing
					     before the specific preference findings drill into detail. -->
					{#if s.num === 3}
						<div class="mt-6 grid gap-3 md:grid-cols-2">
							{#if highlights.length > 0}
								<div
									class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-5 py-4"
								>
									<div class="flex items-baseline justify-between gap-3">
										<div
											class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase"
										>
											Style signature · v1 board-only axes
										</div>
									</div>
									<p class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
										Axis deviations vs same-rating peers · baseline: {auditSummary.scope
											.baselineSource}
									</p>
									<div class="mt-3 grid gap-1.5 text-xs">
										{#each highlights as h (h.axis)}
											{@const mag = Math.abs(h.delta)}
											<div
												class="grid grid-cols-[minmax(0,5rem)_1fr_1fr_3rem] items-center gap-2 sm:grid-cols-[7rem_1fr_1fr_3.5rem]"
											>
												<span class="truncate text-[var(--color-parchment-200)]"
													>{AXIS_LABEL[h.axis] ?? h.axis}</span
												>
												<div class="flex justify-end">
													<div
														class="h-1.5 rounded bg-amber-500/60"
														style:width={h.direction === 'low' ? barWidth(mag, 0.2) : '0%'}
													></div>
												</div>
												<div>
													<div
														class="h-1.5 rounded bg-emerald-500/60"
														style:width={h.direction === 'high' ? barWidth(mag, 0.2) : '0%'}
													></div>
												</div>
												<span
													class="text-right font-mono {h.direction === 'high'
														? 'text-emerald-300'
														: 'text-amber-300'}"
												>
													{signed(h.delta)}pp
												</span>
											</div>
										{/each}
									</div>
									<p class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
										Amber = axis runs lower than peers; emerald = higher. Bars scaled to ±20pp.
									</p>
								</div>
							{/if}

							{#if evalInterpretation}
								<div
									class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-5 py-4"
								>
									<div class="flex flex-wrap items-baseline justify-between gap-3">
										<div
											class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase"
										>
											Engine read · v2 NNUE depth {auditSummary.scope.evalDepth}
										</div>
									</div>
									<div class="mt-2 flex flex-wrap gap-2 text-xs">
										<span
											class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-0.5 text-[var(--color-parchment-200)] capitalize"
										>
											Tactical: <span class="font-mono text-[var(--color-parchment-100)]"
												>{evalInterpretation.tacticalProfile}</span
											>
										</span>
										<span
											class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-0.5 text-[var(--color-parchment-200)] capitalize"
										>
											Consistency: <span class="font-mono text-[var(--color-parchment-100)]"
												>{evalInterpretation.consistency}</span
											>
										</span>
									</div>
									{#if evalInterpretation.headlines.length > 0}
										<ul
											class="mt-3 space-y-1.5 text-sm leading-relaxed text-[var(--color-parchment-300)]"
										>
											{#each evalInterpretation.headlines as h, i (i)}
												<li class="flex gap-2">
													<span class="text-[var(--color-parchment-500)]">—</span>
													<span>{h}</span>
												</li>
											{/each}
										</ul>
									{/if}
								</div>
							{/if}
						</div>

						{#if styleProfile && (styleProfile.primary || styleProfile.strengths.length > 0 || styleProfile.weaknesses.length > 0 || styleProfile.dna.length > 0)}
							{@const sp = styleProfile}
							<!-- Filter the primary badge out of the strength/weakness lists so
							     it isn't rendered twice (once as the headline card, once here). -->
							{@const otherStrengths =
								sp.primary?.kind === 'strength'
									? sp.strengths.filter((b) => b.key !== sp.primary?.key)
									: sp.strengths}
							{@const otherWeaknesses =
								sp.primary?.kind === 'weakness'
									? sp.weaknesses.filter((b) => b.key !== sp.primary?.key)
									: sp.weaknesses}
							<div
								class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-5 py-4"
							>
								<div class="flex flex-wrap items-baseline justify-between gap-3">
									<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
										Profile · who you are at the board
									</div>
									<span class="text-[10px] text-[var(--color-parchment-500)]">
										Structured badges backed by Stockfish.
									</span>
								</div>

								{#if sp.primary}
									<div
										class="mt-3 rounded border {sp.primary.kind === 'strength'
											? 'border-emerald-500/50 bg-emerald-950/20'
											: 'border-amber-300/50 bg-amber-950/20'} px-4 py-3"
									>
										<div class="flex items-baseline gap-3">
											<span
												class="text-[10px] tracking-wider uppercase {sp.primary.kind === 'strength'
													? 'text-emerald-300'
													: 'text-amber-300'}"
											>
												{sp.primary.kind === 'strength'
													? 'Signature strength'
													: 'Standout weakness'}
											</span>
										</div>
										<div class="mt-1 font-serif text-xl text-[var(--color-parchment-50)]">
											{sp.primary.label}
										</div>
										<p class="mt-1 text-sm text-[var(--color-parchment-300)]">
											{sp.primary.tagline}
										</p>
										<p class="mt-1 font-mono text-[10px] text-[var(--color-parchment-500)]">
											{sp.primary.evidence}
										</p>
									</div>
								{/if}

								<div class="mt-3 grid gap-4 md:grid-cols-2">
									<div>
										<div class="text-[10px] tracking-wider text-emerald-300 uppercase">
											Strengths
										</div>
										{#if otherStrengths.length === 0}
											<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
												Nothing else stands out above peers yet — keep scanning games.
											</p>
										{:else}
											<ul class="mt-2 space-y-2">
												{#each otherStrengths as b (b.key)}
													<li class="rounded border {badgeTint(b.kind)} px-3 py-2">
														<div class="flex items-baseline justify-between gap-2">
															<span class="text-sm font-medium text-[var(--color-parchment-100)]"
																>{b.label}</span
															>
														</div>
														<p class="mt-0.5 text-xs text-[var(--color-parchment-300)]">
															{b.tagline}
														</p>
														<p class="mt-1 font-mono text-[10px] text-[var(--color-parchment-500)]">
															{b.evidence}
														</p>
													</li>
												{/each}
											</ul>
										{/if}
									</div>
									<div>
										<div class="text-[10px] tracking-wider text-amber-300 uppercase">
											Weaknesses
										</div>
										{#if otherWeaknesses.length === 0}
											<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
												No other red flags stand out — look at the scorecard for fine-grained gaps.
											</p>
										{:else}
											<ul class="mt-2 space-y-2">
												{#each otherWeaknesses as b (b.key)}
													<li class="rounded border {badgeTint(b.kind)} px-3 py-2">
														<div class="flex items-baseline justify-between gap-2">
															<span class="text-sm font-medium text-[var(--color-parchment-100)]"
																>{b.label}</span
															>
														</div>
														<p class="mt-0.5 text-xs text-[var(--color-parchment-300)]">
															{b.tagline}
														</p>
														<p class="mt-1 font-mono text-[10px] text-[var(--color-parchment-500)]">
															{b.evidence}
														</p>
													</li>
												{/each}
											</ul>
										{/if}
									</div>
								</div>

								{#if sp.dna.length > 0}
									<div class="mt-4 border-t border-[var(--color-ink-800)] pt-3">
										<div
											class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
										>
											Style DNA
										</div>
										<div class="mt-2 flex flex-wrap gap-1.5">
											{#each sp.dna as t (t.key)}
												<span
													title={t.description}
													class="rounded-full border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2.5 py-0.5 text-xs text-[var(--color-parchment-300)]"
												>
													{t.label}
												</span>
											{/each}
										</div>
									</div>
								{/if}
							</div>
						{/if}
					{/if}

					<div class="mt-6 space-y-5">
						{#each s.cards as c, cIdx (c.slug)}
							<article
								id="{s.anchor}-{cIdx + 1}"
								class="flex scroll-mt-6 flex-col gap-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-5 sm:grid sm:grid-cols-[5rem_1fr] sm:gap-x-5 sm:gap-y-0 sm:px-5"
								class:border-l-red-500={c.severity === 'critical'}
								class:border-l-amber-400={c.severity === 'concern'}
								class:border-l-emerald-500={c.severity === 'strength'}
								style="border-left-width: 3px;"
							>
								<div class="flex flex-wrap items-center gap-2 text-xs sm:block">
									<div class="font-mono text-[var(--color-parchment-500)]">
										{s.num}.{cIdx + 1}
									</div>
									<div
										class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] tracking-wider uppercase sm:mt-1 {severityTint(
											c.severity
										)}"
									>
										<span class="inline-block size-1.5 rounded-full {severityDot(c.severity)}"
										></span>
										{severityLabel(c.severity)}
									</div>
									{#if c.sampleSize != null && c.sampleMin != null && c.sampleSize < c.sampleMin}
										<div
											class="inline-flex items-center gap-1 rounded border border-amber-300/40 bg-amber-950/15 px-1.5 py-0.5 text-[9px] tracking-wider text-amber-300 uppercase sm:mt-1"
											title="Thin sample — finding auto-demoted to inconclusive"
										>
											⚠ {c.sampleSize}/{c.sampleMin}
										</div>
									{/if}
								</div>
								<div class="min-w-0">
									<h3 class="font-serif text-xl leading-snug text-[var(--color-parchment-100)]">
										{c.headline}
									</h3>
									<p class="mt-2 text-sm leading-relaxed text-[var(--color-parchment-300)]">
										<span class="text-[var(--color-parchment-200)]">{c.title}.</span>
										{severityNarrative(c.severity)}.
										{#if c.detail}
											<span class="text-[var(--color-parchment-400)]">{c.detail}</span>
										{/if}
									</p>

									{#if exhibits}
										<figure
											class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-4 py-3"
										>
											<figcaption
												class="flex items-baseline justify-between text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
											>
												<span>Exhibit {s.num}.{cIdx + 1}</span>
												<span class="tracking-normal normal-case">
													{exhibitCaption(c.slug)}
												</span>
											</figcaption>

											<div class="mt-3 text-xs text-[var(--color-parchment-200)]">
												{#if c.slug === 'piece-affinity'}
													{@const pa = exhibits.pieceAffinity}
													{@const m = Math.max(
														pa.trades.bishopForKnight,
														pa.trades.knightForBishop,
														pa.trades.bishopForBishop,
														pa.trades.knightForKnight,
														1
													)}
													<div class="grid gap-1.5">
														<div class="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
															<span class="font-mono">B × N</span>
															<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
																<div
																	class="h-full rounded bg-[var(--color-brass-300)]/70"
																	style:width={barWidth(pa.trades.bishopForKnight, m)}
																></div>
															</div>
															<span class="text-right font-mono">{pa.trades.bishopForKnight}</span>
														</div>
														<div class="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
															<span class="font-mono">N × B</span>
															<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
																<div
																	class="h-full rounded bg-[var(--color-brass-300)]/70"
																	style:width={barWidth(pa.trades.knightForBishop, m)}
																></div>
															</div>
															<span class="text-right font-mono">{pa.trades.knightForBishop}</span>
														</div>
														<div class="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
															<span class="font-mono">B × B</span>
															<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
																<div
																	class="h-full rounded bg-[var(--color-brass-300)]/70"
																	style:width={barWidth(pa.trades.bishopForBishop, m)}
																></div>
															</div>
															<span class="text-right font-mono">{pa.trades.bishopForBishop}</span>
														</div>
														<div class="grid grid-cols-[4rem_1fr_3rem] items-center gap-2">
															<span class="font-mono">N × N</span>
															<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
																<div
																	class="h-full rounded bg-[var(--color-brass-300)]/70"
																	style:width={barWidth(pa.trades.knightForKnight, m)}
																></div>
															</div>
															<span class="text-right font-mono">{pa.trades.knightForKnight}</span>
														</div>
													</div>
													<div class="mt-3 grid grid-cols-3 gap-2 text-[10px]">
														<div>
															<div class="text-[var(--color-parchment-500)]">
																Capturing while ahead
															</div>
															<div class="font-mono text-emerald-300">
																{pctFmt(pa.capturesWhileAhead, 0)}
															</div>
														</div>
														<div>
															<div class="text-[var(--color-parchment-500)]">While equal</div>
															<div class="font-mono">{pctFmt(pa.capturesWhileEqual, 0)}</div>
														</div>
														<div>
															<div class="text-[var(--color-parchment-500)]">While behind</div>
															<div class="font-mono text-amber-300">
																{pctFmt(pa.capturesWhileBehind, 0)}
															</div>
														</div>
													</div>
												{:else if c.slug === 'structure-taste'}
													{@const st = exhibits.structureTaste}
													{@const maxGames = Math.max(...st.byStructure.map((b) => b.games), 1)}
													<div class="grid gap-1">
														{#each st.byStructure.slice(0, 6) as b (b.key)}
															<div
																class="grid grid-cols-[minmax(0,7rem)_1fr_2.5rem_3rem] items-center gap-2 sm:grid-cols-[10rem_1fr_3.5rem_4rem]"
															>
																<span class="truncate">{structureLabel(b.key)}</span>
																<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
																	<div
																		class="h-full rounded bg-[var(--color-brass-300)]/70"
																		style:width={barWidth(b.games, maxGames)}
																	></div>
																</div>
																<span class="text-right font-mono">{b.games}g</span>
																<span
																	class="text-right font-mono {b.winRate - st.overallWinRate > 0.05
																		? 'text-emerald-300'
																		: b.winRate - st.overallWinRate < -0.05
																			? 'text-amber-300'
																			: ''}"
																>
																	{signedPctFmt(b.winRate - st.overallWinRate, 0)}
																</span>
															</div>
														{/each}
													</div>
													<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
														Your overall win rate: {pctFmt(st.overallWinRate)} · avg open files {st.openFileAverage.toFixed(
															2
														)}.
													</div>
												{:else if c.slug === 'exchange-propensity'}
													{@const ep = exhibits.exchangePropensity}
													{@const maxRate = Math.max(
														ep.byState.ahead.pieceTradeRate,
														ep.byState.equal.pieceTradeRate,
														ep.byState.behind.pieceTradeRate,
														0.01
													)}
													<div class="grid grid-cols-3 gap-3">
														{#each ['ahead', 'equal', 'behind'] as const as state (state)}
															{@const b = ep.byState[state]}
															<div
																class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2"
															>
																<div
																	class="text-[10px] text-[var(--color-parchment-500)] capitalize"
																>
																	{state}
																</div>
																<div class="mt-1 font-mono">{pctFmt(b.pieceTradeRate)}</div>
																<div class="mt-1.5 h-1 rounded bg-[var(--color-ink-950)]">
																	<div
																		class="h-full rounded bg-[var(--color-brass-300)]/70"
																		style:width={barWidth(b.pieceTradeRate, maxRate)}
																	></div>
																</div>
																<div class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
																	{b.moves.toLocaleString()} moves
																</div>
															</div>
														{/each}
													</div>
													<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
														Simplify-when-ahead Δ {signedPctFmt(ep.simplifyWhenAheadDelta, 1)} · cling-when-behind
														Δ {signedPctFmt(ep.clingWhenBehindDelta, 1)}
													</div>
												{:else if c.slug === 'plan-taste'}
													{@const pl = exhibits.planTaste}
													{@const pieceTotal =
														pl.pieceAim.queenside + pl.pieceAim.center + pl.pieceAim.kingside || 1}
													{@const stormTotal =
														pl.pawnStorms.queenside +
															pl.pawnStorms.center +
															pl.pawnStorms.kingside || 1}
													<div class="space-y-3">
														<div>
															<div
																class="mb-1 flex justify-between text-[10px] text-[var(--color-parchment-500)]"
															>
																<span>Piece destinations</span>
																<span>{pieceTotal.toLocaleString()} moves</span>
															</div>
															<div class="flex h-2 overflow-hidden rounded">
																<div
																	class="bg-emerald-500/60"
																	style:width="{(
																		(pl.pieceAim.queenside / pieceTotal) *
																		100
																	).toFixed(1)}%"
																></div>
																<div
																	class="bg-[var(--color-parchment-400)]/50"
																	style:width="{((pl.pieceAim.center / pieceTotal) * 100).toFixed(
																		1
																	)}%"
																></div>
																<div
																	class="bg-[var(--color-brass-300)]/70"
																	style:width="{((pl.pieceAim.kingside / pieceTotal) * 100).toFixed(
																		1
																	)}%"
																></div>
															</div>
															<div
																class="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-parchment-400)]"
															>
																<span>Q {pctFmt(pl.pieceAim.queenside / pieceTotal, 0)}</span>
																<span>C {pctFmt(pl.pieceAim.center / pieceTotal, 0)}</span>
																<span>K {pctFmt(pl.pieceAim.kingside / pieceTotal, 0)}</span>
															</div>
														</div>
														<div>
															<div
																class="mb-1 flex justify-between text-[10px] text-[var(--color-parchment-500)]"
															>
																<span>Pawn storms (past 3rd rank)</span>
																<span>{stormTotal.toLocaleString()} pushes</span>
															</div>
															<div class="flex h-2 overflow-hidden rounded">
																<div
																	class="bg-emerald-500/60"
																	style:width="{(
																		(pl.pawnStorms.queenside / stormTotal) *
																		100
																	).toFixed(1)}%"
																></div>
																<div
																	class="bg-[var(--color-parchment-400)]/50"
																	style:width="{((pl.pawnStorms.center / stormTotal) * 100).toFixed(
																		1
																	)}%"
																></div>
																<div
																	class="bg-[var(--color-brass-300)]/70"
																	style:width="{(
																		(pl.pawnStorms.kingside / stormTotal) *
																		100
																	).toFixed(1)}%"
																></div>
															</div>
															<div
																class="mt-1 flex justify-between font-mono text-[10px] text-[var(--color-parchment-400)]"
															>
																<span>Q {pctFmt(pl.pawnStorms.queenside / stormTotal, 0)}</span>
																<span>C {pctFmt(pl.pawnStorms.center / stormTotal, 0)}</span>
																<span>K {pctFmt(pl.pawnStorms.kingside / stormTotal, 0)}</span>
															</div>
														</div>
													</div>
													<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
														Kingside storms in {pl.kingsideStormGames}/{pl.totalGames} games · queenside
														in
														{pl.minorityAttackGames}/{pl.totalGames} · avg {pl.avgPawnPushes.toFixed(
															2
														)} pushes/game.
													</div>
												{:else if c.slug === 'opening-fit'}
													{@const of = exhibits.openingFit}
													<table class="w-full border-collapse font-mono text-[11px]">
														<thead class="text-[var(--color-parchment-500)]">
															<tr>
																<th class="pb-1 text-left font-normal">Family</th>
																<th class="pb-1 text-right font-normal">Games</th>
																<th class="pb-1 text-right font-normal">Win %</th>
																<th class="pb-1 text-right font-normal">Δ win</th>
																<th class="pb-1 text-right font-normal">Δ CP</th>
																<th class="pb-1 text-right font-normal">Verdict</th>
															</tr>
														</thead>
														<tbody class="text-[var(--color-parchment-100)]">
															{#each of.rows.slice(0, 6) as r (r.family)}
																<tr class="border-t border-[var(--color-ink-800)]">
																	<td class="py-1 pr-2 text-[var(--color-parchment-200)]"
																		>{r.family}</td
																	>
																	<td class="py-1 text-right">{r.games}</td>
																	<td class="py-1 text-right">{pctFmt(r.winRate, 0)}</td>
																	<td
																		class="py-1 text-right {r.winRateDelta > 0.03
																			? 'text-emerald-300'
																			: r.winRateDelta < -0.03
																				? 'text-amber-300'
																				: ''}"
																	>
																		{signedPctFmt(r.winRateDelta, 0)}
																	</td>
																	<td
																		class="py-1 text-right {r.avgCpLossDelta > 5
																			? 'text-amber-300'
																			: r.avgCpLossDelta < -5
																				? 'text-emerald-300'
																				: ''}"
																	>
																		{r.avgCpLoss > 0
																			? `${r.avgCpLossDelta >= 0 ? '+' : ''}${r.avgCpLossDelta.toFixed(0)}`
																			: '—'}
																	</td>
																	<td class="py-1 text-right text-[10px]">
																		<span
																			class="rounded border px-1 py-0.5 {r.verdict === 'fit'
																				? 'border-emerald-500/50 text-emerald-300'
																				: r.verdict === 'misfit'
																					? 'border-amber-300/50 text-amber-300'
																					: 'border-[var(--color-ink-700)] text-[var(--color-parchment-500)]'}"
																		>
																			{r.verdict}
																		</span>
																	</td>
																</tr>
															{/each}
														</tbody>
													</table>
													<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
														Baseline: overall win {pctFmt(of.overallWinRate, 0)} · overall CP loss {of.overallCpLoss.toFixed(
															1
														)}.
													</div>
												{:else if c.slug === 'endgame-subtypes'}
													{@const eg = exhibits.endgameSubtypes}
													<div class="grid grid-cols-3 gap-2 text-[10px]">
														<div
															class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2"
														>
															<div class="text-[var(--color-parchment-500)]">Reached</div>
															<div class="mt-0.5 font-mono text-base">{eg.totalWithEndgame}</div>
														</div>
														<div
															class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2"
														>
															<div class="text-[var(--color-parchment-500)]">Conv. rate</div>
															<div class="mt-0.5 font-mono text-base text-emerald-300">
																{pctFmt(eg.overallConversionRate, 0)}
															</div>
														</div>
														<div
															class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2"
														>
															<div class="text-[var(--color-parchment-500)]">Def. rate</div>
															<div class="mt-0.5 font-mono text-base">
																{pctFmt(eg.overallDefenseRate, 0)}
															</div>
														</div>
													</div>
													{#if eg.buckets.length > 0}
														<table class="mt-3 w-full border-collapse font-mono text-[11px]">
															<thead class="text-[var(--color-parchment-500)]">
																<tr>
																	<th class="pb-1 text-left font-normal">Family</th>
																	<th class="pb-1 text-right font-normal">Games</th>
																	<th class="pb-1 text-right font-normal">W/D/L</th>
																	<th class="pb-1 text-right font-normal">Conv</th>
																	<th class="pb-1 text-right font-normal">Def</th>
																</tr>
															</thead>
															<tbody class="text-[var(--color-parchment-100)]">
																{#each eg.buckets.slice(0, 5) as b (b.family)}
																	<tr class="border-t border-[var(--color-ink-800)]">
																		<td class="py-1 pr-2 text-[var(--color-parchment-200)]"
																			>{endgameFamilyLabel(b.family)}</td
																		>
																		<td class="py-1 text-right">{b.games}</td>
																		<td class="py-1 text-right">{b.wins}/{b.draws}/{b.losses}</td>
																		<td class="py-1 text-right"
																			>{b.enteredAhead > 0 ? pctFmt(b.conversionRate, 0) : '—'}</td
																		>
																		<td class="py-1 text-right"
																			>{b.enteredBehind > 0 ? pctFmt(b.defenseRate, 0) : '—'}</td
																		>
																	</tr>
																{/each}
															</tbody>
														</table>
													{/if}
												{:else if c.slug === 'tactical-motifs'}
													{@const tm = exhibits.tacticalMotifs}
													{@const maxCount = Math.max(
														...tm.byMotif
															.filter((x) => x.motif !== 'unclassified')
															.map((x) => x.count),
														1
													)}
													{#if tm.total === 0}
														<p class="text-[var(--color-parchment-500)]">
															No categorised blunders — run an engine-analysed scan.
														</p>
													{:else}
														<div class="grid gap-1">
															{#each tm.byMotif
																.filter((x) => x.motif !== 'unclassified')
																.slice(0, 6) as mi (mi.motif)}
																<div
																	class="grid grid-cols-[minmax(0,6rem)_1fr_2.5rem_3rem] items-center gap-2 sm:grid-cols-[8rem_1fr_3rem_4rem]"
																>
																	<span class="truncate">{motifLabel(mi.motif)}</span>
																	<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
																		<div
																			class="h-full rounded bg-amber-500/60"
																			style:width={barWidth(mi.count, maxCount)}
																		></div>
																	</div>
																	<span class="text-right font-mono">{mi.count}</span>
																	<span
																		class="text-right font-mono text-[var(--color-parchment-500)]"
																		>{mi.avgCpLoss.toFixed(0)}cp</span
																	>
																</div>
															{/each}
														</div>
														<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
															{tm.total} blunder/mistake moves analysed. Moves may match multiple motifs.
														</div>
													{/if}
												{:else if c.slug === 'calculation-depth'}
													{@const cd = exhibits.calculationDepth}
													{@const maxCp = Math.max(
														...cd.byBranching.map((b) => b.avgCpLoss || 0),
														1
													)}
													<div class="grid grid-cols-4 gap-2">
														{#each cd.byBranching as b (b.label)}
															<div class="flex flex-col items-center">
																<div
																	class="mb-1 flex h-20 w-full items-end rounded bg-[var(--color-ink-900)]"
																>
																	<div
																		class="w-full rounded-b bg-[var(--color-brass-300)]/70"
																		style:height="{Math.min(
																			100,
																			((b.avgCpLoss || 0) / maxCp) * 100
																		).toFixed(1)}%"
																	></div>
																</div>
																<div class="text-center text-[10px]">
																	<div class="font-mono">
																		{b.avgCpLoss > 0 ? b.avgCpLoss.toFixed(0) : '—'}
																	</div>
																	<div class="text-[var(--color-parchment-500)]">
																		{b.label.replace(' moves', '')}
																	</div>
																	<div class="text-[var(--color-parchment-500)]">{b.moves}</div>
																</div>
															</div>
														{/each}
													</div>
													<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
														Avg CP loss per branching bucket. Higher bars at right = accuracy drops
														under branching pressure.
													</div>
												{:else if c.slug === 'defensive-resource'}
													{@const dr = exhibits.defensiveResource}
													<div class="grid grid-cols-3 gap-2">
														{#each dr.byDifficulty as b (b.bucket)}
															<div
																class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2"
															>
																<div class="text-[10px] text-[var(--color-parchment-500)]">
																	{difficultyLabel(b.bucket)}
																</div>
																<div class="mt-1 font-mono text-base">
																	{b.games > 0 ? pctFmt(b.defenseRate, 0) : '—'}
																</div>
																<div class="mt-1 flex h-1 overflow-hidden rounded">
																	<div
																		class="bg-emerald-500/70"
																		style:width={b.games > 0
																			? `${((b.flipped / b.games) * 100).toFixed(1)}%`
																			: '0%'}
																	></div>
																	<div
																		class="bg-[var(--color-parchment-400)]/60"
																		style:width={b.games > 0
																			? `${((b.held / b.games) * 100).toFixed(1)}%`
																			: '0%'}
																	></div>
																	<div
																		class="bg-amber-500/60"
																		style:width={b.games > 0
																			? `${((b.lost / b.games) * 100).toFixed(1)}%`
																			: '0%'}
																	></div>
																</div>
																<div
																	class="mt-1 font-mono text-[10px] text-[var(--color-parchment-500)]"
																>
																	{b.flipped}W · {b.held}D · {b.lost}L
																</div>
															</div>
														{/each}
													</div>
													<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
														Overall: {pctFmt(dr.overallDefenseRate, 0)} held or flipped across {dr.totalLosingEntries}
														losing entries · avg {dr.avgLegalMovesAtEntry.toFixed(1)} legal moves at entry.
													</div>
												{:else if c.slug === 'prophylaxis'}
													{@const pr = exhibits.prophylaxis}
													<div class="grid grid-cols-3 gap-2 text-[10px]">
														<div
															class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2"
														>
															<div class="text-[var(--color-parchment-500)]">Threats faced</div>
															<div class="mt-0.5 font-mono text-base">{pr.opportunities}</div>
														</div>
														<div
															class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2"
														>
															<div class="text-[var(--color-parchment-500)]">Neutralised</div>
															<div class="mt-0.5 font-mono text-base text-emerald-300">
																{pr.neutralized}
															</div>
														</div>
														<div
															class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2"
														>
															<div class="text-[var(--color-parchment-500)]">Compounded</div>
															<div class="mt-0.5 font-mono text-base text-amber-300">
																{pr.compounded}
															</div>
														</div>
													</div>
													{#if pr.opportunities > 0}
														<div class="mt-3 flex h-2 overflow-hidden rounded">
															<div
																class="bg-emerald-500/70"
																style:width="{((pr.neutralized / pr.opportunities) * 100).toFixed(
																	1
																)}%"
															></div>
															<div
																class="bg-amber-500/60"
																style:width="{((pr.compounded / pr.opportunities) * 100).toFixed(
																	1
																)}%"
															></div>
														</div>
														<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
															Neutralise rate: <span
																class="font-mono text-[var(--color-parchment-200)]"
																>{pctFmt(pr.neutralizeRate, 0)}</span
															>
															· opening {pr.byPhase[0].opportunities > 0
																? pctFmt(pr.byPhase[0].neutralized / pr.byPhase[0].opportunities, 0)
																: '—'}, middle {pr.byPhase[1].opportunities > 0
																? pctFmt(pr.byPhase[1].neutralized / pr.byPhase[1].opportunities, 0)
																: '—'}, end {pr.byPhase[2].opportunities > 0
																? pctFmt(pr.byPhase[2].neutralized / pr.byPhase[2].opportunities, 0)
																: '—'}.
														</div>
													{/if}
												{:else if c.slug === 'blunder-timing'}
													{@const bt = exhibits.blunderTiming}
													{@const maxRate = Math.max(...bt.buckets.map((b) => b.rate), 0.01)}
													<div class="grid gap-1">
														{#each bt.buckets as b (b.label)}
															<div
																class="grid grid-cols-[minmax(0,4.5rem)_1fr_3rem_2.5rem] items-center gap-2 sm:grid-cols-[6rem_1fr_3.5rem_3rem]"
															>
																<span class="truncate">{b.label}</span>
																<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
																	<div
																		class="h-full rounded bg-amber-500/60"
																		style:width={barWidth(b.rate, maxRate)}
																	></div>
																</div>
																<span class="text-right font-mono"
																	>{b.moves > 0 ? pctFmt(b.rate, 1) : '—'}</span
																>
																<span class="text-right font-mono text-[var(--color-parchment-500)]"
																	>{b.moves}</span
																>
															</div>
														{/each}
													</div>
													<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
														{bt.totalBlunders} blunders / {bt.totalMoves.toLocaleString()} analysed moves.
													</div>
												{:else if c.slug === 'time-of-day'}
													{@const td = exhibits.timeOfDay}
													{@const maxG = Math.max(...td.byHour.map((h) => h.games), 1)}
													<div>
														<div class="mb-1 text-[10px] text-[var(--color-parchment-500)]">
															Hour (local tz) — bar height = games, color = win rate
														</div>
														<div class="flex items-end gap-px">
															{#each td.byHour as h (h.hour)}
																<div
																	class="relative flex-1 {h.games > 0
																		? hourHeat(h.winRate)
																		: 'bg-[var(--color-ink-900)]'}"
																	style:height="{Math.max(6, (h.games / maxG) * 32).toFixed(1)}px"
																	title="{h.hour}:00 · {h.games} games · {pctFmt(h.winRate, 0)}"
																></div>
															{/each}
														</div>
														<div
															class="mt-0.5 flex justify-between font-mono text-[10px] text-[var(--color-parchment-500)]"
														>
															<span>00</span>
															<span>06</span>
															<span>12</span>
															<span>18</span>
															<span>23</span>
														</div>
													</div>
													<div class="mt-3 grid grid-cols-7 gap-1 text-[10px]">
														{#each td.byDay as d (d.day)}
															<div
																class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-1 text-center"
															>
																<div class="text-[var(--color-parchment-500)]">
																	{dayLabel(d.day)}
																</div>
																<div
																	class="mt-0.5 font-mono {d.games === 0
																		? 'text-[var(--color-parchment-600)]'
																		: ''}"
																>
																	{d.games > 0 ? pctFmt(d.winRate, 0) : '—'}
																</div>
																<div class="text-[9px] text-[var(--color-parchment-500)]">
																	{d.games}g
																</div>
															</div>
														{/each}
													</div>
												{:else if c.slug === 'session-decay'}
													{@const sd = exhibits.sessionDecay}
													{#if !sd || sd.rows.length === 0}
														<p class="text-[var(--color-parchment-500)]">
															Not enough multi-game sessions yet.
														</p>
													{:else}
														<table class="w-full border-collapse font-mono text-[11px]">
															<thead class="text-[var(--color-parchment-500)]">
																<tr>
																	<th class="pb-1 text-left font-normal">Game #</th>
																	<th class="pb-1 text-right font-normal">Games</th>
																	<th class="pb-1 text-right font-normal">Overall</th>
																	<th class="pb-1 text-right font-normal">Opening</th>
																	<th class="pb-1 text-right font-normal">Middle</th>
																	<th class="pb-1 text-right font-normal">End</th>
																</tr>
															</thead>
															<tbody class="text-[var(--color-parchment-100)]">
																{#each sd.rows as r (r.index)}
																	<tr class="border-t border-[var(--color-ink-800)]">
																		<td class="py-1">{r.index === 5 ? '6+' : r.index + 1}</td>
																		<td class="py-1 text-right">{r.games}</td>
																		<td class="py-1 text-right"
																			>{r.overall.avgCpLoss != null
																				? r.overall.avgCpLoss.toFixed(1)
																				: '—'}</td
																		>
																		<td class="py-1 text-right"
																			>{r.byPhase.opening.avgCpLoss != null
																				? r.byPhase.opening.avgCpLoss.toFixed(1)
																				: '—'}</td
																		>
																		<td class="py-1 text-right"
																			>{r.byPhase.middle.avgCpLoss != null
																				? r.byPhase.middle.avgCpLoss.toFixed(1)
																				: '—'}</td
																		>
																		<td class="py-1 text-right"
																			>{r.byPhase.end.avgCpLoss != null
																				? r.byPhase.end.avgCpLoss.toFixed(1)
																				: '—'}</td
																		>
																	</tr>
																{/each}
															</tbody>
														</table>
														<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
															{sd.multiGameSessions} multi-game sessions across {sd.sessions} total.
														</div>
													{/if}
												{:else if c.slug === 'repeat-offenders'}
													{@const ro = exhibits.repeatOffenders}
													{@const maxCount = Math.max(...ro.rows.map((r) => r.count), 1)}
													{#if ro.rows.length === 0}
														<p class="text-[var(--color-parchment-500)]">
															{#if !result?.evalAxes}
																Requires engine analysis — re-run the scan with Stockfish enabled to
																categorise blunders.
															{:else}
																Not enough categorised blunders.
															{/if}
														</p>
													{:else}
														<div class="grid gap-1">
															{#each ro.rows.slice(0, 6) as r, i (i)}
																<div
																	class="grid grid-cols-[minmax(0,7rem)_1fr_2rem_3rem] items-center gap-2 sm:grid-cols-[12rem_1fr_2.5rem_3.5rem]"
																>
																	<span class="truncate">{offenderHeading(r)}</span>
																	<div class="h-1.5 rounded bg-[var(--color-ink-900)]">
																		<div
																			class="h-full rounded bg-amber-500/60"
																			style:width={barWidth(r.count, maxCount)}
																		></div>
																	</div>
																	<span class="text-right font-mono">{r.count}×</span>
																	<span
																		class="text-right font-mono text-[var(--color-parchment-500)]"
																		>{r.avgCpLoss.toFixed(0)}cp</span
																	>
																</div>
															{/each}
														</div>
														{#if ro.longestStreak && ro.longestStreak.length >= 2}
															<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
																Longest streak: {ro.longestStreak.length}× {motifLabel(
																	ro.longestStreak.motif
																)} in a row.
															</div>
														{/if}
													{/if}
												{:else if c.slug === 'recovery-arc'}
													{@const ra = exhibits.recoveryArc}
													{@const maxCp = Math.max(...ra.points.map((p) => p.avgCpLoss), 1)}
													<div class="grid grid-cols-6 gap-2">
														{#each ra.points as p (p.offset)}
															<div class="flex flex-col items-center">
																<div
																	class="mb-1 flex h-16 w-full items-end rounded bg-[var(--color-ink-900)]"
																>
																	<div
																		class="w-full rounded-b {p.offset === 0
																			? 'bg-red-500/70'
																			: 'bg-amber-500/60'}"
																		style:height="{Math.min(
																			100,
																			(p.avgCpLoss / maxCp) * 100
																		).toFixed(1)}%"
																	></div>
																</div>
																<div class="text-center text-[10px]">
																	<div class="font-mono">{p.avgCpLoss.toFixed(0)}</div>
																	<div class="text-[var(--color-parchment-500)]">
																		{p.offset === 0 ? 'blunder' : `+${p.offset}`}
																	</div>
																</div>
															</div>
														{/each}
													</div>
													<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
														Cascade rate <span class="font-mono text-amber-300"
															>{pctFmt(ra.cascadeRate, 0)}</span
														>
														· steady rate
														<span class="font-mono text-emerald-300"
															>{pctFmt(ra.steadyRate, 0)}</span
														>
														·
														{ra.totalBlunders} blunders.
													</div>
												{:else if c.slug === 'opponent-strength'}
													{@const os = exhibits.opponentStrength}
													{@const maxCp = Math.max(...os.buckets.map((b) => b.avgCpLoss ?? 0), 1)}
													{@const maxGames = Math.max(...os.buckets.map((b) => b.games), 1)}
													{@const hasCp = os.buckets.some((b) => b.avgCpLoss != null)}
													{@const totalGames = os.buckets.reduce((n, b) => n + b.games, 0)}
													{#if totalGames === 0}
														<p class="text-[var(--color-parchment-500)]">
															No opponent-rating data — the scan produced no games with both ratings
															populated.
														</p>
													{:else}
														<div class="grid grid-cols-5 gap-2">
															{#each os.buckets as b (b.key)}
																<div class="flex flex-col items-center">
																	<div
																		class="mb-1 flex h-16 w-full items-end rounded bg-[var(--color-ink-900)]"
																	>
																		{#if hasCp && b.avgCpLoss != null}
																			<div
																				class="w-full rounded-b bg-[var(--color-brass-300)]/70"
																				style:height="{Math.min(
																					100,
																					(b.avgCpLoss / maxCp) * 100
																				).toFixed(1)}%"
																			></div>
																		{:else if !hasCp && b.games > 0}
																			<div
																				class="w-full rounded-b bg-[var(--color-parchment-400)]/40"
																				style:height="{Math.min(
																					100,
																					(b.games / maxGames) * 100
																				).toFixed(1)}%"
																			></div>
																		{/if}
																	</div>
																	<div class="text-center text-[10px]">
																		<div class="font-mono">
																			{hasCp
																				? b.avgCpLoss != null
																					? b.avgCpLoss.toFixed(0)
																					: '—'
																				: `${b.games}g`}
																		</div>
																		<div class="leading-tight text-[var(--color-parchment-500)]">
																			{b.label.split(' ')[0]}
																		</div>
																		<div class="text-[9px] text-[var(--color-parchment-500)]">
																			{hasCp
																				? `${b.games}g · ${pctFmt(b.winRate, 0)}`
																				: pctFmt(b.winRate, 0)}
																		</div>
																	</div>
																</div>
															{/each}
														</div>
														{#if !hasCp}
															<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
																Bars show games per bucket (no engine data). Run with Stockfish for
																avg CP-loss per rating gap.
															</div>
														{/if}
													{/if}
												{:else if c.slug === 'narrative'}
													<blockquote
														class="border-l-2 border-[var(--color-brass-300)] pl-4 font-serif text-[15px] leading-relaxed text-[var(--color-parchment-200)] italic"
													>
														{c.detail ?? c.headline}
													</blockquote>
													<div class="mt-3 text-[10px] text-[var(--color-parchment-500)]">
														Full three-paragraph profile on the narrative detail page.
													</div>
												{:else if c.slug === 'level-up'}
													{@const lu = exhibits.levelUp}
													{@const maxMag = Math.max(...lu.diffs.map((d) => d.magnitude), 0.01)}
													<div class="grid gap-1">
														{#each lu.diffs as d (d.axis)}
															<div
																class="grid grid-cols-[minmax(0,5rem)_1fr_1fr_3rem] items-center gap-2 sm:grid-cols-[7rem_1fr_1fr_3.5rem]"
															>
																<span class="truncate">{LEVELUP_AXIS_LABEL[d.axis]}</span>
																<div class="flex justify-end">
																	<div
																		class="h-1.5 rounded bg-amber-500/60"
																		style:width={barWidth(d.delta < 0 ? d.magnitude : 0, maxMag)}
																	></div>
																</div>
																<div>
																	<div
																		class="h-1.5 rounded bg-emerald-500/60"
																		style:width={barWidth(d.delta > 0 ? d.magnitude : 0, maxMag)}
																	></div>
																</div>
																<span
																	class="text-right font-mono {d.magnitude > 0.02
																		? d.delta > 0
																			? 'text-emerald-300'
																			: 'text-amber-300'
																		: ''}"
																>
																	{signedPctFmt(d.delta, 1)}
																</span>
															</div>
														{/each}
													</div>
													<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
														You {lu.sourceRating?.toFixed(0) ?? '—'} → target {lu.targetRating ||
															'baseline'}
														({lu.targetSource}). Amber = you run the axis lower than the target
														band; emerald = higher.
													</div>
												{:else if c.slug === 'exemplars'}
													{@const ex = exhibits.exemplars}
													{#if ex.representative.length === 0}
														<p class="text-[var(--color-parchment-500)]">
															Not enough games with ≥15 user moves.
														</p>
													{:else}
														<div class="grid gap-2 sm:grid-cols-2">
															<div>
																<div
																	class="mb-1 text-[10px] tracking-wider text-emerald-300 uppercase"
																>
																	Representative
																</div>
																<ul class="grid gap-1">
																	{#each ex.representative as g (g.gameId)}
																		<li
																			class="rounded border border-emerald-500/30 bg-emerald-950/10 px-2 py-1 font-mono text-[11px]"
																		>
																			<a
																				href="https://lichess.org/{g.gameId}"
																				target="_blank"
																				rel="noopener"
																				class="hover:underline"
																			>
																				#{g.gameId.slice(0, 6)} · {g.result[0].toUpperCase()} · {g
																					.color[0]}
																			</a>
																			<span
																				class="ml-1 text-[10px] text-[var(--color-parchment-500)]"
																				>{g.eco ?? '?'} · d{g.distance.toFixed(2)}</span
																			>
																		</li>
																	{/each}
																</ul>
															</div>
															<div>
																<div
																	class="mb-1 text-[10px] tracking-wider text-amber-300 uppercase"
																>
																	Contradictory
																</div>
																<ul class="grid gap-1">
																	{#each ex.contradictory as g (g.gameId)}
																		<li
																			class="rounded border border-amber-300/30 bg-amber-950/10 px-2 py-1 font-mono text-[11px]"
																		>
																			<a
																				href="https://lichess.org/{g.gameId}"
																				target="_blank"
																				rel="noopener"
																				class="hover:underline"
																			>
																				#{g.gameId.slice(0, 6)} · {g.result[0].toUpperCase()} · {g
																					.color[0]}
																			</a>
																			<span
																				class="ml-1 text-[10px] text-[var(--color-parchment-500)]"
																				>{g.eco ?? '?'} · d{g.distance.toFixed(2)}</span
																			>
																		</li>
																	{/each}
																</ul>
															</div>
														</div>
													{/if}
												{:else if c.slug === 'progression'}
													{@const pg = exhibits.progression}
													{#if pg.months.length < 2}
														<p class="text-[var(--color-parchment-500)]">
															Not enough monthly spread yet.
														</p>
													{:else}
														{@const maxCp = Math.max(...pg.months.map((m) => m.avgCpLoss ?? 0), 1)}
														<div class="grid auto-cols-fr grid-flow-col gap-1">
															{#each pg.months as m (m.monthKey)}
																<div class="flex flex-col items-center">
																	<div
																		class="mb-1 flex h-16 w-full items-end rounded bg-[var(--color-ink-900)]"
																	>
																		{#if m.avgCpLoss != null}
																			<div
																				class="w-full rounded-b bg-[var(--color-brass-300)]/70"
																				style:height="{Math.min(
																					100,
																					(m.avgCpLoss / maxCp) * 100
																				).toFixed(1)}%"
																			></div>
																		{/if}
																	</div>
																	<div class="text-center text-[10px]">
																		<div class="font-mono">
																			{m.avgCpLoss != null ? m.avgCpLoss.toFixed(0) : '—'}
																		</div>
																		<div class="leading-tight text-[var(--color-parchment-500)]">
																			{m.label}
																		</div>
																		<div class="text-[9px] text-[var(--color-parchment-500)]">
																			{m.games}g · {pctFmt(m.winRate, 0)}
																		</div>
																	</div>
																</div>
															{/each}
														</div>
														<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
															Direction: <span class="font-mono text-[var(--color-parchment-200)]"
																>{pg.direction ?? '—'}</span
															>
															· rating Δ {pg.deltaRating != null
																? `${pg.deltaRating >= 0 ? '+' : ''}${pg.deltaRating.toFixed(0)}`
																: '—'}
															· CP Δ {pg.deltaCpLoss != null
																? `${pg.deltaCpLoss >= 0 ? '+' : ''}${pg.deltaCpLoss.toFixed(1)}`
																: '—'}.
														</div>
													{/if}
												{:else}
													<p class="text-[var(--color-parchment-500)]">—</p>
												{/if}
											</div>
										</figure>
									{/if}

									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										class="mt-3 inline-block text-xs text-[var(--color-brass-300)] hover:underline"
										href="{base}/dossier/{c.slug}"
									>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
										Open the {c.title.toLowerCase()} detail →
									</a>
								</div>
							</article>
						{/each}

						<!-- 3.6 Tension management — promoted from Appendix F. Pawn-contact
						     release + creation rates vs peers, with the "you are this kind
						     of player" read the interpreter derives from the deltas. -->
						{#if s.num === 3 && activeBaseline && tensionDelta && fp.tension.tensionedMoves > 0}
							{@const tensionRead =
								tensionDelta.release < -0.025 && tensionDelta.create < -0.015
									? 'Avoids structural change — leaves the pawn skeleton alone.'
									: tensionDelta.release > 0.025 && tensionDelta.create > 0.015
										? 'Active trader — initiates and resolves contact.'
										: tensionDelta.release > 0.025
											? 'Simplifier — resolves tension when it appears.'
											: tensionDelta.create > 0.015
												? 'Aggressor — creates contact, lets it sit.'
												: tensionDelta.release < -0.025
													? 'Patient — keeps tension on the board.'
													: 'Balanced across both tension axes.'}
							{@const tensionSeverity: Severity =
								tensionRead.startsWith('Balanced')
									? 'observation'
									: 'observation'}
							{@const tensionCardIdx = s.cards.length + 1}
							<article
								id="{s.anchor}-{tensionCardIdx}"
								class="flex scroll-mt-6 flex-col gap-3 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-5 sm:grid sm:grid-cols-[5rem_1fr] sm:gap-x-5 sm:gap-y-0 sm:px-5"
								style="border-left-width: 3px;"
							>
								<div class="flex flex-wrap items-center gap-2 text-xs sm:block">
									<div class="font-mono text-[var(--color-parchment-500)]">
										{s.num}.{tensionCardIdx}
									</div>
									<div
										class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] tracking-wider uppercase sm:mt-1 {severityTint(
											tensionSeverity
										)}"
									>
										<span class="inline-block size-1.5 rounded-full {severityDot(tensionSeverity)}"
										></span>
										{severityLabel(tensionSeverity)}
									</div>
								</div>
								<div class="min-w-0">
									<h3 class="font-serif text-xl leading-snug text-[var(--color-parchment-100)]">
										{tensionRead}
									</h3>
									<p class="mt-2 text-sm leading-relaxed text-[var(--color-parchment-300)]">
										<span class="text-[var(--color-parchment-200)]">Tension management.</span>
										Counts pawn–pawn contact pairs and how you treat them: release rate is how often you
										resolve tension when it's on the board; creation rate is how often you introduce new
										contact yourself. Both compared against your same-rating peer baseline.
									</p>

									<figure
										class="mt-4 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-4 py-3"
									>
										<figcaption
											class="flex items-baseline justify-between text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase"
										>
											<span>Exhibit {s.num}.{tensionCardIdx}</span>
											<span class="tracking-normal normal-case">
												Release + creation rate vs peer baseline
											</span>
										</figcaption>
										<div class="mt-3 grid grid-cols-2 gap-3 text-xs">
											<div
												class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2"
											>
												<div class="text-[10px] text-[var(--color-parchment-500)]">
													Release rate
												</div>
												<div class="mt-1 font-mono text-base">{pct(fp.tension.releaseRate)}</div>
												<div class="mt-1 flex h-1 rounded bg-[var(--color-ink-950)]">
													<div
														class="h-full rounded bg-[var(--color-brass-300)]/70"
														style:width={barWidth(fp.tension.releaseRate, 1)}
													></div>
												</div>
												<div
													class="mt-1 flex items-baseline justify-between text-[10px] text-[var(--color-parchment-500)]"
												>
													<span>peer {pct(activeBaseline.tension.releaseRate)}</span>
													<span
														class="font-mono {tensionDelta.release > 0.025
															? 'text-emerald-300'
															: tensionDelta.release < -0.025
																? 'text-amber-300'
																: ''}"
													>
														{signedPctFmt(tensionDelta.release, 1)}
													</span>
												</div>
											</div>
											<div
												class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] p-2"
											>
												<div class="text-[10px] text-[var(--color-parchment-500)]">
													Creation rate
												</div>
												<div class="mt-1 font-mono text-base">{pct(fp.tension.creationRate)}</div>
												<div class="mt-1 flex h-1 rounded bg-[var(--color-ink-950)]">
													<div
														class="h-full rounded bg-[var(--color-brass-300)]/70"
														style:width={barWidth(fp.tension.creationRate, 0.3)}
													></div>
												</div>
												<div
													class="mt-1 flex items-baseline justify-between text-[10px] text-[var(--color-parchment-500)]"
												>
													<span>peer {pct(activeBaseline.tension.creationRate)}</span>
													<span
														class="font-mono {tensionDelta.create > 0.015
															? 'text-emerald-300'
															: tensionDelta.create < -0.015
																? 'text-amber-300'
																: ''}"
													>
														{signedPctFmt(tensionDelta.create, 1)}
													</span>
												</div>
											</div>
										</div>
										<div class="mt-2 text-[10px] text-[var(--color-parchment-500)]">
											{fp.tension.tensionedMoves.toLocaleString()} moves with pawn contact on the board.
										</div>
									</figure>
								</div>
							</article>
						{/if}
					</div>
				</section>
			{/each}

			<!-- §7 Priority actions -->
			<section id="section-7" class="mt-12 scroll-mt-6">
				<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
					Section 7
				</div>
				<h2 class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)]">Priority actions</h2>
				<p class="mt-4 max-w-3xl text-[15px] leading-relaxed text-[var(--color-parchment-300)]">
					{#if auditRecommendations.length > 0}
						The items below are ranked by frequency × fixability × rating impact. Starting at R-01
						and working down gives the fastest expected return on study time. Full rationale and
						drill-creation tools live on the
						<a
							class="text-[var(--color-brass-300)] hover:underline"
							href={resolve('/dossier/fix-first')}>Fix this first</a
						>
						page.
					{:else}
						Not enough signal to prioritise an action list yet. Scan more rated games, ideally with
						Stockfish enabled, and regenerate the report.
					{/if}
				</p>

				{#if auditRecommendations.length > 0}
					<ol
						class="mt-6 divide-y divide-[var(--color-ink-800)] border-y border-[var(--color-ink-800)]"
					>
						{#each auditRecommendations as r (r.rank)}
							<li
								class="flex flex-col gap-2 py-5 sm:grid sm:grid-cols-[5rem_1fr] sm:gap-x-5 sm:gap-y-0"
							>
								<div class="font-mono text-xs text-[var(--color-brass-300)]">
									R-{r.rank.toString().padStart(2, '0')}
								</div>
								<div>
									<h3 class="font-serif text-lg text-[var(--color-parchment-100)]">
										{r.title}
									</h3>
									<p class="mt-1 text-sm leading-relaxed text-[var(--color-parchment-300)]">
										{r.action}
									</p>
									<p class="mt-1 text-[10px] text-[var(--color-parchment-500)]">
										{r.frequency} occurrences · avg {r.avgCpLoss.toFixed(0)}cp · score
										{r.score.toFixed(2)}
									</p>
								</div>
							</li>
						{/each}
					</ol>
				{/if}
			</section>

			<!-- Appendix header -->
			<section
				id="appendices"
				class="mt-16 scroll-mt-6 border-t border-[var(--color-ink-800)] pt-8"
			>
				<div class="text-[10px] tracking-[0.2em] text-[var(--color-brass-300)] uppercase">
					Appendices
				</div>
				<h2 class="mt-1 font-serif text-3xl text-[var(--color-parchment-50)]">
					Supporting evidence
				</h2>
				<p class="mt-4 max-w-3xl text-[15px] leading-relaxed text-[var(--color-parchment-300)]">
					Raw data and the interactive tools used to derive the findings above. Each appendix stands
					alone and can be referenced from the body of the report.
				</p>
				<ul
					class="mt-4 grid grid-cols-2 gap-1 text-xs text-[var(--color-parchment-400)] sm:grid-cols-3"
				>
					<li>A. Scorecard</li>
					<li>B. Critical moments</li>
					<li>C. Time signature</li>
					<li>D. Blunder atlas</li>
					<li>E. Session profile</li>
					<li>H. Leak detector</li>
					<li>J. Eval-based axes</li>
				</ul>
				<p class="mt-3 text-[10px] text-[var(--color-parchment-500)]">
					Style-axis breakdowns (by phase / color / speed / result / opening family / clock) live on
					their respective finding subpages in §3–§5. Drift and consensus alignment are promoted to
					findings in §5 Behavioural tendencies.
				</p>
			</section>
		{/if}

		<!-- ======== Appendix A: Scorecard ======== -->
		<section
			class="mt-4 rounded border border-[var(--color-brass-300)]/40 bg-[var(--color-ink-900)] px-4 py-4"
		>
			{#if scorecard}
				<!-- Hero: overall CP/move with peer delta. Single number
				     the user should walk away with. -->
				<div class="flex flex-wrap items-end justify-between gap-4">
					<div>
						<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
							Appendix A · Scorecard
						</div>
						<div class="mt-0.5 text-xs tracking-wider text-[var(--color-brass-300)] uppercase">
							Average CP loss per move
						</div>
						{#if scorecard.overall.sparse}
							<div class="mt-1 font-mono text-sm text-[var(--color-parchment-500)]">
								Not enough analysed moves — scan more games.
							</div>
						{:else}
							<div class="mt-1 flex items-baseline gap-3">
								<span class="font-serif text-5xl text-[var(--color-parchment-50)]">
									{Math.round(scorecard.overall.cpLoss)}
								</span>
								<span class="text-sm text-[var(--color-parchment-400)]">cp/move</span>
								{#if scorecard.overall.peerDelta != null}
									<span
										class="text-xs {scorecard.overall.verdict === 'weak'
											? 'text-amber-300'
											: scorecard.overall.verdict === 'strong'
												? 'text-emerald-400'
												: 'text-[var(--color-parchment-500)]'}"
									>
										{scorecard.overall.peerDelta >= 0 ? '+' : ''}{Math.round(
											scorecard.overall.peerDelta
										)} vs peers
									</span>
								{/if}
							</div>
							<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
								{scorecard.overall.moves} user moves · blunder rate {Math.round(
									scorecard.overall.blunderRate * 100
								)}%
							</div>
						{/if}
					</div>
					<div class="text-right text-xs text-[var(--color-parchment-500)]">
						<div>Lower is better.</div>
						<div class="mt-0.5">Peer = same rating + speed.</div>
					</div>
				</div>

				<!-- Matrix: phase columns × colour rows. -->
				{@const phaseKeys = ['opening', 'middle', 'end'] as const}
				{@const colorKeys = ['white', 'black'] as const}
				{@const tileAt = (p: (typeof phaseKeys)[number], c: (typeof colorKeys)[number]) =>
					scorecard.tiles.find((t) => t.phase === p && t.color === c)}
				<div class="mt-5">
					<div
						class="grid items-center gap-2 text-xs tracking-wider text-[var(--color-parchment-500)] uppercase"
						style="grid-template-columns: 80px repeat(3, minmax(0, 1fr));"
					>
						<div></div>
						{#each phaseKeys as p (p)}
							<div class="text-center">{phaseLabel(p)}</div>
						{/each}
						{#each colorKeys as c (c)}
							<div class="text-[var(--color-parchment-300)]">
								{c === 'white' ? 'As White' : 'As Black'}
							</div>
							{#each phaseKeys as p (p)}
								{@const t = tileAt(p, c)}
								{#if t}
									{@const isWeakest = scorecard.weakest === t}
									{@const isStrongest = scorecard.strongest === t}
									<div
										class="rounded border px-3 py-2 {isWeakest
											? 'border-amber-300/60 bg-amber-950/20'
											: isStrongest
												? 'border-emerald-500/60 bg-emerald-950/20'
												: t.verdict === 'weak'
													? 'border-amber-300/20 bg-[var(--color-ink-950)]'
													: t.verdict === 'strong'
														? 'border-emerald-500/20 bg-[var(--color-ink-950)]'
														: 'border-[var(--color-ink-800)] bg-[var(--color-ink-950)]'}"
									>
										{#if t.sparse}
											<div class="font-mono text-xs text-[var(--color-parchment-500)]">
												— / too few
											</div>
										{:else}
											<div class="flex items-baseline justify-between gap-2">
												<span class="font-serif text-2xl text-[var(--color-parchment-50)]">
													{Math.round(t.cpLoss)}
												</span>
												<span class="font-mono text-[10px] text-[var(--color-parchment-500)]">
													{t.moves}m
												</span>
											</div>
											{#if t.peerDelta != null}
												<div
													class="mt-0.5 text-[11px] {t.verdict === 'weak'
														? 'text-amber-300'
														: t.verdict === 'strong'
															? 'text-emerald-400'
															: 'text-[var(--color-parchment-500)]'}"
												>
													{t.peerDelta >= 0 ? '+' : ''}{Math.round(t.peerDelta)} vs peers
												</div>
											{/if}
										{/if}
									</div>
								{/if}
							{/each}
						{/each}
					</div>
				</div>

				{#if scorecard.headline}
					<p class="mt-4 text-sm text-[var(--color-parchment-200)]">{scorecard.headline}</p>
				{/if}
			{:else}
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">Scorecard</h2>
				</div>
				<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
					Scan to populate the scorecard.
				</p>
			{/if}
		</section>

		<!-- ======== Critical moments ======== -->
		<section
			class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
		>
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
					Appendix B
				</div>
				<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">Critical moments</h2>
				<span class="text-xs text-[var(--color-parchment-500)]">
					Where your rating actually gets decided — conversion, defense, and equality.
				</span>
			</div>
			{#if criticalMoments && evalSummary}
				{@const cm = criticalMoments}
				<div class="mt-4 grid gap-3 sm:grid-cols-3">
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
					>
						<div class="text-xs tracking-wider text-[var(--color-parchment-400)] uppercase">
							Conversion
						</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)]">
							{Math.round(cm.conversion.rate * 100)}%
						</div>
						<div class="mt-1 text-xs text-[var(--color-parchment-400)]">
							{cm.conversion.wins}/{cm.conversion.games} wins from ≥+1.5
						</div>
						{#if cm.conversion.peerRate != null}
							<div
								class="mt-1 text-xs {cm.conversion.rate < cm.conversion.peerRate - 0.05
									? 'text-amber-300'
									: cm.conversion.rate > cm.conversion.peerRate + 0.05
										? 'text-emerald-400'
										: 'text-[var(--color-parchment-500)]'}"
							>
								Peers: {Math.round(cm.conversion.peerRate * 100)}%
							</div>
						{/if}
					</div>
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
					>
						<div class="text-xs tracking-wider text-[var(--color-parchment-400)] uppercase">
							Defense
						</div>
						<div class="mt-1 font-serif text-2xl text-[var(--color-parchment-50)]">
							{Math.round(cm.defense.rate * 100)}%
						</div>
						<div class="mt-1 text-xs text-[var(--color-parchment-400)]">
							{cm.defense.saves}/{cm.defense.games} saved from ≤−1.5
						</div>
						{#if cm.defense.peerRate != null}
							<div
								class="mt-1 text-xs {cm.defense.rate < cm.defense.peerRate - 0.05
									? 'text-amber-300'
									: cm.defense.rate > cm.defense.peerRate + 0.05
										? 'text-emerald-400'
										: 'text-[var(--color-parchment-500)]'}"
							>
								Peers: {Math.round(cm.defense.peerRate * 100)}%
							</div>
						{/if}
					</div>
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
					>
						<div class="text-xs tracking-wider text-[var(--color-parchment-400)] uppercase">
							From equality
						</div>
						<div class="mt-1 flex items-baseline gap-2">
							<span class="font-serif text-xl text-emerald-400">
								{Math.round(cm.equality.winRate * 100)}%
							</span>
							<span class="text-xs text-[var(--color-parchment-500)]">win</span>
							<span class="font-serif text-xl text-amber-300">
								{Math.round(cm.equality.lossRate * 100)}%
							</span>
							<span class="text-xs text-[var(--color-parchment-500)]">loss</span>
						</div>
						<div class="mt-1 text-xs text-[var(--color-parchment-400)]">
							{cm.equality.games} balanced openings
						</div>
						{#if cm.equality.peerWinRate != null && cm.equality.peerLossRate != null}
							<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
								Peers: {Math.round(cm.equality.peerWinRate * 100)}% W · {Math.round(
									cm.equality.peerLossRate * 100
								)}% L
							</div>
						{/if}
					</div>
				</div>
				{#if cm.sampledGames === 0}
					<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
						No games had enough evaluated moves — scan more games and re-run v2.
					</p>
				{/if}
			{:else}
				<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
					Needs v2 eval data. Re-scan with <em>Include v2 eval axes</em> on.
				</p>
			{/if}
		</section>

		<!-- ======== Time signature ======== -->
		{#if clockSpendReport && clockSpendReport.secondsSpent > 0}
			{@const cs = clockSpendReport}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
						Appendix C
					</div>
					<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">Time signature</h2>
					<span class="text-xs text-[var(--color-parchment-500)]">
						Where your clock goes vs. where your blunders land.
					</span>
				</div>
				<div class="mt-4 space-y-3">
					<div>
						<div
							class="flex items-baseline justify-between text-xs text-[var(--color-parchment-400)]"
						>
							<span>Clock spent</span>
							<span class="font-mono"
								>{fmtSec(cs.secondsSpent)} across {cs.gamesWithClock} games</span
							>
						</div>
						<div
							class="mt-1 flex h-6 overflow-hidden rounded border border-[var(--color-ink-800)] text-xs"
						>
							<div
								class="flex items-center justify-center bg-emerald-900/40 text-emerald-200"
								style="width: {cs.alloc.opening * 100}%"
							>
								{cs.alloc.opening > 0.08 ? `${Math.round(cs.alloc.opening * 100)}%` : ''}
							</div>
							<div
								class="flex items-center justify-center bg-amber-900/40 text-amber-200"
								style="width: {cs.alloc.middle * 100}%"
							>
								{cs.alloc.middle > 0.08 ? `${Math.round(cs.alloc.middle * 100)}%` : ''}
							</div>
							<div
								class="bg-oxblood-900/40 flex items-center justify-center bg-red-950/40 text-red-200"
								style="width: {cs.alloc.end * 100}%"
							>
								{cs.alloc.end > 0.08 ? `${Math.round(cs.alloc.end * 100)}%` : ''}
							</div>
						</div>
					</div>
					{#if cs.blunderCount > 0}
						<div>
							<div
								class="flex items-baseline justify-between text-xs text-[var(--color-parchment-400)]"
							>
								<span>Blunders</span>
								<span class="font-mono">{cs.blunderCount} blunders from v2 eval</span>
							</div>
							<div
								class="mt-1 flex h-6 overflow-hidden rounded border border-[var(--color-ink-800)] text-xs"
							>
								<div
									class="flex items-center justify-center bg-emerald-900/20 text-emerald-200"
									style="width: {cs.blunders.opening * 100}%"
								>
									{cs.blunders.opening > 0.08 ? `${Math.round(cs.blunders.opening * 100)}%` : ''}
								</div>
								<div
									class="flex items-center justify-center bg-amber-900/20 text-amber-200"
									style="width: {cs.blunders.middle * 100}%"
								>
									{cs.blunders.middle > 0.08 ? `${Math.round(cs.blunders.middle * 100)}%` : ''}
								</div>
								<div
									class="flex items-center justify-center bg-red-950/20 text-red-200"
									style="width: {cs.blunders.end * 100}%"
								>
									{cs.blunders.end > 0.08 ? `${Math.round(cs.blunders.end * 100)}%` : ''}
								</div>
							</div>
						</div>
					{/if}
					<div class="flex gap-3 text-[10px] text-[var(--color-parchment-500)]">
						<span class="flex items-center gap-1"
							><span class="inline-block h-2 w-2 rounded-sm bg-emerald-900/60"></span>Opening</span
						>
						<span class="flex items-center gap-1"
							><span class="inline-block h-2 w-2 rounded-sm bg-amber-900/60"></span>Middlegame</span
						>
						<span class="flex items-center gap-1"
							><span class="inline-block h-2 w-2 rounded-sm bg-red-950/60"></span>Endgame</span
						>
					</div>
				</div>
				{#if cs.mismatchHeadline}
					<p class="mt-3 text-sm text-[var(--color-parchment-200)]">{cs.mismatchHeadline}</p>
				{/if}
				{#if cs.peerAlloc}
					<p class="mt-2 text-xs text-[var(--color-parchment-500)]">
						Peer clock allocation: {Math.round(cs.peerAlloc.opening * 100)}% / {Math.round(
							cs.peerAlloc.middle * 100
						)}% / {Math.round(cs.peerAlloc.end * 100)}%
					</p>
				{/if}
			</section>
		{/if}

		<!-- ======== Blunder atlas ======== -->
		{#if blunderAtlas && blunderAtlas.clusters.length > 0}
			{@const atlas = blunderAtlas}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
						Appendix D
					</div>
					<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">Blunder atlas</h2>
					<span class="text-xs text-[var(--color-parchment-500)]">
						{atlas.total} worst moves clustered by what went wrong.
					</span>
				</div>
				<div class="mt-4 space-y-2">
					{#each atlas.clusters as c (c.bucket)}
						<div
							class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2"
						>
							<div class="flex flex-wrap items-baseline justify-between gap-2">
								<div>
									<span class="font-serif text-lg text-[var(--color-parchment-100)]">{c.title}</span
									>
									<span class="ml-2 font-mono text-xs text-[var(--color-brass-300)]">{c.count}</span
									>
								</div>
								<button
									type="button"
									onclick={() => saveClusterAsDrills(c)}
									disabled={!drillRepId || c.items.length === 0}
									class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1 text-xs hover:border-[var(--color-brass-300)]/40 disabled:opacity-50"
								>
									Drill these
								</button>
							</div>
							<p class="mt-1 text-xs text-[var(--color-parchment-400)]">{c.summary}</p>
							<p class="mt-1 text-xs text-[var(--color-parchment-500)] italic">{c.drillHint}</p>
							{#if atlasStatusByBucket[c.bucket]}
								<p class="mt-1 text-xs text-emerald-400">{atlasStatusByBucket[c.bucket]}</p>
							{/if}
							{#if c.items.length > 0}
								<ul class="mt-2 space-y-1 font-mono text-xs text-[var(--color-parchment-400)]">
									{#each c.items.slice(0, 3) as it, i (i)}
										<li class="flex flex-wrap items-baseline justify-between gap-2">
											<span
												>ply {it.move.ply} ·
												<span class="text-[var(--color-parchment-200)]">{it.move.san}</span>
												· −{Math.round(it.move.cpLoss)} cp</span
											>
											<!-- eslint-disable svelte/no-navigation-without-resolve -->
											<a
												href={lichessAnalysisUrl(it.move.fenBefore)}
												target="_blank"
												rel="noopener"
												class="text-[var(--color-brass-300)] underline"
											>
												<!-- eslint-enable svelte/no-navigation-without-resolve -->
												Open
											</a>
										</li>
									{/each}
									{#if c.items.length > 3}
										<li class="text-[var(--color-parchment-500)]">+{c.items.length - 3} more</li>
									{/if}
								</ul>
							{/if}
						</div>
					{/each}
				</div>
				{#if !drillRepId}
					<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
						Pick a repertoire further down (in the <em>Drills</em> card) to enable "Drill these".
					</p>
				{/if}
			</section>
		{/if}

		<!-- ======== Session profile ======== -->
		{#if sessionProfile && sessionProfile.multiGameSessions > 0}
			{@const sp = sessionProfile}
			<section
				class="mt-6 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-4 py-4"
			>
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
						Appendix E
					</div>
					<h2 class="font-serif text-xl text-[var(--color-parchment-50)]">Session profile</h2>
					<span class="text-xs text-[var(--color-parchment-500)]">
						{sp.sessions} sessions · {sp.multiGameSessions} multi-game
					</span>
				</div>
				{#if sp.byIndex.length > 0}
					<div class="mt-3 grid gap-2 sm:grid-cols-6">
						{#each sp.byIndex as b (b.index)}
							<div
								class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-2 py-2 text-xs"
							>
								<div class="text-[var(--color-parchment-500)]">Game #{b.index + 1}</div>
								<div class="mt-1 font-mono text-[var(--color-parchment-200)]">
									{b.avgCpLoss != null ? `${Math.round(b.avgCpLoss)} cp` : '—'}
								</div>
								<div class="text-[var(--color-parchment-500)]">
									{b.games}g · {Math.round(b.winRate * 100)}% W
								</div>
							</div>
						{/each}
					</div>
				{/if}
				<div class="mt-3 grid gap-2 sm:grid-cols-2">
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2 text-xs"
					>
						<div class="text-[var(--color-parchment-400)]">After a loss, same session</div>
						<div class="mt-1 font-mono text-[var(--color-parchment-200)]">
							{sp.postLoss.avgCpLoss != null ? `${Math.round(sp.postLoss.avgCpLoss)} cp` : '—'}
							{#if sp.postLoss.delta != null}
								<span
									class={sp.postLoss.delta >= 15
										? 'text-amber-300'
										: 'text-[var(--color-parchment-500)]'}
								>
									({sp.postLoss.delta >= 0 ? '+' : ''}{Math.round(sp.postLoss.delta)} vs prior game)
								</span>
							{/if}
						</div>
						<div class="text-[var(--color-parchment-500)]">{sp.postLoss.games} samples</div>
					</div>
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-950)] px-3 py-2 text-xs"
					>
						<div class="text-[var(--color-parchment-400)]">After a win, same session</div>
						<div class="mt-1 font-mono text-[var(--color-parchment-200)]">
							{sp.postWin.avgCpLoss != null ? `${Math.round(sp.postWin.avgCpLoss)} cp` : '—'}
							{#if sp.postWin.delta != null}
								<span
									class={sp.postWin.delta <= -10
										? 'text-emerald-400'
										: 'text-[var(--color-parchment-500)]'}
								>
									({sp.postWin.delta >= 0 ? '+' : ''}{Math.round(sp.postWin.delta)} vs prior game)
								</span>
							{/if}
						</div>
						<div class="text-[var(--color-parchment-500)]">{sp.postWin.games} samples</div>
					</div>
				</div>
				{#if sp.headline}
					<p class="mt-3 text-sm text-[var(--color-parchment-200)]">{sp.headline}</p>
				{/if}
			</section>
		{/if}

		{#if result}
			{@const leaks = result.leaks}
			<section class="mt-8">
				<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
					Appendix H
				</div>
				<h2 class="font-serif text-xl">Leak detector</h2>
				<p class="text-xs text-[var(--color-parchment-500)]">
					Positions where your habitual response didn't match what the position asked for. v1:
					board-only heuristics, no engine — false negatives expected, false positives kept low.
				</p>
				<div class="mt-3 grid gap-3 sm:grid-cols-3">
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
					>
						<div class="text-xs text-[var(--color-parchment-500)]">Missed captures</div>
						<div class="mt-1 font-mono text-lg">
							{leaks.counts.missed_capture}
							<span class="text-xs text-[var(--color-parchment-500)]"
								>({pct(leaks.rates.missed_capture)} of moves)</span
							>
						</div>
						<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
							op {leaks.byPhase.opening.missed_capture} · mid {leaks.byPhase.middle.missed_capture} ·
							end {leaks.byPhase.end.missed_capture}
						</div>
					</div>
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
					>
						<div class="text-xs text-[var(--color-parchment-500)]">Impatient forcing</div>
						<div class="mt-1 font-mono text-lg">
							{leaks.counts.impatient_forcing}
							<span class="text-xs text-[var(--color-parchment-500)]"
								>({pct(leaks.rates.impatient_forcing)} of moves)</span
							>
						</div>
						<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
							op {leaks.byPhase.opening.impatient_forcing} · mid {leaks.byPhase.middle
								.impatient_forcing} · end {leaks.byPhase.end.impatient_forcing}
						</div>
					</div>
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
					>
						<div class="text-xs text-[var(--color-parchment-500)]">Missed attacks</div>
						<div class="mt-1 font-mono text-lg">
							{leaks.counts.missed_attack}
							<span class="text-xs text-[var(--color-parchment-500)]"
								>({pct(leaks.rates.missed_attack)} of moves)</span
							>
						</div>
						<div class="mt-1 text-xs text-[var(--color-parchment-500)]">
							op {leaks.byPhase.opening.missed_attack} · mid {leaks.byPhase.middle.missed_attack} · end
							{leaks.byPhase.end.missed_attack}
						</div>
					</div>
				</div>

				{#if leaks.worst.length > 0}
					<div class="mt-5 flex flex-wrap items-end gap-2">
						<button
							type="button"
							onclick={deepAnalyseLeaks}
							disabled={analysing}
							class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1 text-xs hover:border-[var(--color-brass-300)]/40 disabled:opacity-50"
						>
							{analysing ? `Analysing ${analyseProgress}…` : 'Deep-analyse worst leaks (Stockfish)'}
						</button>
						{#if analyseError}
							<span class="text-xs text-red-400">{analyseError}</span>
						{/if}
					</div>
					{#if analysedAvg}
						<div class="mt-3 grid gap-2 text-xs sm:grid-cols-3">
							{#each Object.entries(analysedAvg) as [type, cp] (type)}
								<div
									class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
								>
									<div class="text-[var(--color-parchment-500)]">
										avg CP loss · {LEAK_LABEL[type as keyof typeof LEAK_LABEL] ?? type}
									</div>
									<div class="mt-1 font-mono text-base">{(cp / 100).toFixed(2)} pawns</div>
								</div>
							{/each}
						</div>
					{/if}

					<div class="mt-5 flex flex-wrap items-end justify-between gap-3">
						<h3 class="font-serif text-lg">Worst offenders</h3>
						{#if repertoires.length > 0}
							<div class="flex flex-wrap items-end gap-2 text-xs">
								<label class="flex flex-col gap-1">
									<span class="text-[var(--color-parchment-500)]">Save drills under</span>
									<select
										bind:value={drillRepId}
										class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1"
									>
										{#each repertoires as r (r.id)}
											<option value={r.id}>{r.name}</option>
										{/each}
									</select>
								</label>
								<button
									type="button"
									onclick={saveAllWorstLeaks}
									disabled={!drillRepId}
									class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1 hover:border-[var(--color-brass-300)]/40 disabled:opacity-50"
								>
									Save all worst as drills
								</button>
							</div>
						{:else}
							<p class="text-xs text-[var(--color-parchment-500)]">
								Create a repertoire to save leaks as drills.
							</p>
						{/if}
					</div>
					{#if saveAllStatus}
						<p class="mt-2 text-xs text-[var(--color-parchment-400)]">{saveAllStatus}</p>
					{/if}
					<ol class="mt-2 space-y-1 text-sm">
						{#each leaks.worst as l (l.gameId + l.ply)}
							{@const saved = savedLeakIds.has(leakRowId(l))}
							{@const cp = cpLossByLeakRow.get(leakRowId(l))}
							<li
								class="flex flex-wrap items-baseline justify-between gap-2 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
							>
								<div>
									<span class="font-mono">{l.san}</span>
									<span class="ml-2 text-xs text-[var(--color-parchment-500)]"
										>{LEAK_LABEL[l.type]} · {l.phase} · ply {l.ply}{l.bestCaptureGain
											? ` · missed +${l.bestCaptureGain}`
											: ''}</span
									>
									{#if cp != null}
										<span
											class="ml-2 rounded bg-[var(--color-ink-950)] px-1.5 py-0.5 font-mono text-xs"
											class:text-amber-300={cp >= 100}
											class:text-emerald-400={cp < 30}
										>
											−{(cp / 100).toFixed(2)} pawns
										</span>
									{/if}
								</div>
								<div class="flex items-center gap-3 text-xs">
									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										href={lichessAnalysisUrl(l.fenBefore)}
										target="_blank"
										rel="noopener"
										class="text-[var(--color-brass-300)] underline"
									>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
										Open on Lichess
									</a>
									{#if drillRepId}
										{#if saved}
											<span class="text-[var(--color-parchment-500)]">Saved ✓</span>
										{:else}
											<button
												type="button"
												onclick={() => saveLeakAsDrill(l)}
												class="rounded border border-[var(--color-ink-700)] px-2 py-0.5 hover:border-[var(--color-brass-300)]/40"
											>
												Save as drill
											</button>
										{/if}
									{/if}
								</div>
							</li>
						{/each}
					</ol>
					{#if drillRepId}
						<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
							Saved drills appear in <a class="underline" href={resolve('/mistakes')}>Mistakes</a> under
							the chosen repertoire.
						</p>
					{/if}
				{/if}
			</section>
		{/if}

		{#if result.evalError}
			<p class="mt-3 text-xs text-[var(--color-oxblood-300)]">
				v2 eval pass during scan errored: {result.evalError}
			</p>
		{/if}

		<section class="mt-8">
			<div class="text-[10px] tracking-wider text-[var(--color-parchment-500)] uppercase">
				Appendix J
			</div>
			<h2 class="font-serif text-xl">Eval-based axes (Stockfish)</h2>
			<p class="text-xs text-[var(--color-parchment-500)]">
				Runs the local engine over every move of the most-recent N games. Adds CP loss,
				blunder/inaccuracy rates per phase, and a sac-tendency axis (material-loss moves the engine
				endorses). Heavy: ~12s per game at depth 14, fully local.
			</p>

			<div class="mt-3 flex flex-wrap items-end gap-3 text-xs">
				<label class="flex flex-col gap-1">
					<span class="text-[var(--color-parchment-500)]">Recent games</span>
					<input
						type="number"
						bind:value={evalGameCap}
						min="1"
						max="40"
						class="w-24 rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1"
					/>
				</label>
				<button
					type="button"
					onclick={runEvalAxes}
					disabled={evalRunning}
					class="rounded border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] px-2 py-1 hover:border-[var(--color-brass-300)]/40 disabled:opacity-50"
				>
					{evalRunning ? `Analysing ${evalProgress}…` : 'Run eval-based analysis'}
				</button>
				{#if evalRunning}
					<button
						type="button"
						onclick={() => evalController?.abort()}
						class="text-[var(--color-parchment-400)] underline"
					>
						Cancel
					</button>
				{/if}
				{#if evalError}
					<span class="text-red-400">{evalError}</span>
				{/if}
			</div>

			{#if evalSummary}
				{@const skipped =
					evalSummary.movesSkippedSan +
					evalSummary.movesSkippedEngine +
					evalSummary.movesSkippedNoScore}
				{#if skipped > 0}
					<div
						class="mt-3 rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200"
					>
						Skipped {skipped} of {evalSummary.movesAnalysed + skipped} moves —
						{evalSummary.movesSkippedSan} SAN-parse, {evalSummary.movesSkippedEngine} engine reject, {evalSummary.movesSkippedNoScore}
						no-score.
						{#if evalSummary.firstError}
							<span class="block font-mono text-[11px] opacity-80">{evalSummary.firstError}</span>
						{/if}
					</div>
				{/if}
				<div class="mt-4 grid gap-3 sm:grid-cols-4">
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
					>
						<div class="text-xs text-[var(--color-parchment-500)]">Avg CP loss</div>
						<div class="mt-1 font-mono text-lg">
							{(evalSummary.avgCpLoss / 100).toFixed(2)}
							<span class="text-xs text-[var(--color-parchment-500)]">pawns</span>
						</div>
						<div class="text-xs text-[var(--color-parchment-500)]">
							across {evalSummary.movesAnalysed} moves
						</div>
					</div>
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
					>
						<div class="text-xs text-[var(--color-parchment-500)]">Blunder rate</div>
						<div class="mt-1 font-mono text-lg">{pct(evalSummary.blunderRate)}</div>
						<div class="text-xs text-[var(--color-parchment-500)]">≥2 pawns lost</div>
					</div>
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
					>
						<div class="text-xs text-[var(--color-parchment-500)]">Inaccuracy rate</div>
						<div class="mt-1 font-mono text-lg">{pct(evalSummary.inaccuracyRate)}</div>
						<div class="text-xs text-[var(--color-parchment-500)]">0.5–2 pawns lost</div>
					</div>
					<div
						class="rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
					>
						<div class="text-xs text-[var(--color-parchment-500)]">Sac tendency</div>
						<div class="mt-1 font-mono text-lg">{pct(evalSummary.sacTendency)}</div>
						<div class="text-xs text-[var(--color-parchment-500)]">
							material loss the engine endorses
						</div>
					</div>
				</div>

				<h3 class="mt-5 font-serif text-lg">By phase</h3>
				<div class="mt-2 overflow-x-auto">
					<table class="w-full border-collapse text-sm">
						<thead class="text-left text-xs text-[var(--color-parchment-500)]">
							<tr>
								<th class="py-2 pr-4">Phase</th>
								<th class="py-2 pr-4">Moves</th>
								<th class="py-2 pr-4">Avg CP loss</th>
								<th class="py-2 pr-4">Blunder</th>
								<th class="py-2 pr-4">Inaccuracy</th>
							</tr>
						</thead>
						<tbody>
							{#each ['opening', 'middle', 'end'] as const as phase (phase)}
								{@const p = evalSummary.byPhase[phase]}
								<tr class="border-t border-[var(--color-ink-800)]">
									<td class="py-2 pr-4 font-medium">{PHASE_LABEL[phase]}</td>
									<td class="py-2 pr-4 font-mono">{p.moves}</td>
									<td class="py-2 pr-4 font-mono">{(p.avgCpLoss / 100).toFixed(2)}</td>
									<td class="py-2 pr-4 font-mono">{pct(p.blunderRate)}</td>
									<td class="py-2 pr-4 font-mono">{pct(p.inaccuracyRate)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				{#if evalSummary.worst.length > 0}
					<h3 class="mt-5 font-serif text-lg">Worst CP-loss moves</h3>
					<ol class="mt-2 space-y-1 text-sm">
						{#each evalSummary.worst as w (w.gameId + w.ply)}
							<li
								class="flex flex-wrap items-baseline justify-between gap-2 rounded border border-[var(--color-ink-800)] bg-[var(--color-ink-900)] px-3 py-2"
							>
								<div>
									<span class="font-mono">{w.san}</span>
									<span class="ml-2 text-xs text-[var(--color-parchment-500)]">
										{w.classification} · {w.phase} · ply {w.ply}
									</span>
									<span
										class="ml-2 rounded bg-[var(--color-ink-950)] px-1.5 py-0.5 font-mono text-xs"
										class:text-amber-300={w.cpLoss >= 200}
										class:text-emerald-400={w.intentionalSac}
									>
										−{(w.cpLoss / 100).toFixed(2)} pawns{w.intentionalSac ? ' (sac)' : ''}
									</span>
								</div>
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href={lichessAnalysisUrl(w.fenBefore)}
									target="_blank"
									rel="noopener"
									class="text-xs text-[var(--color-brass-300)] underline"
								>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
									Open on Lichess
								</a>
							</li>
						{/each}
					</ol>
				{/if}
			{/if}
		</section>

		<section class="mt-8">
			<h2 class="font-serif text-xl">Per-account</h2>
			<ul class="mt-3 space-y-1 text-sm">
				{#each result.perAccount as a (a.account.source + a.account.username)}
					<li class="font-mono">
						{a.account.source}/{a.account.username}: {a.scanned} games{a.error
							? ` — error: ${a.error}`
							: ''}
					</li>
				{/each}
			</ul>
		</section>

		<details class="mt-6 text-xs text-[var(--color-parchment-500)]">
			<summary class="cursor-pointer">Baseline used</summary>
			<pre class="mt-2 whitespace-pre-wrap">{JSON.stringify(DOSSIER_BASELINE, null, 2)}</pre>
		</details>
	{/if}
</div>

<style>
	/* Print stylesheet. Triggered when the user hits Print/PDF (or Ctrl/Cmd+P):
	   hides the app chrome (nav, scan controls, share dialog), forces every
	   details to expand, neutralises the dark theme so ink reads on paper,
	   and adds page-break hints so each section starts on a fresh page where
	   possible. Designed for A4 / Letter at default margins. */
	@media print {
		/* Hide everything outside the style report — global nav, header links. */
		:global(header),
		:global(footer),
		:global(nav[aria-label='Main']),
		:global(nav[aria-label='Mobile']),
		:global(.print\\:hidden) {
			display: none !important;
		}

		/* Neutralise the dark theme so print ink reads. The app ships a dark
		   parchment/ink palette — we remap the key tokens to near-black on
		   white so every bordered panel stays legible. */
		:global(:root) {
			--color-ink-950: #ffffff !important;
			--color-ink-900: #ffffff !important;
			--color-ink-800: #cccccc !important;
			--color-ink-700: #999999 !important;
			--color-parchment-50: #000000 !important;
			--color-parchment-100: #000000 !important;
			--color-parchment-200: #111111 !important;
			--color-parchment-300: #222222 !important;
			--color-parchment-400: #444444 !important;
			--color-parchment-500: #555555 !important;
			--color-brass-300: #6b4f00 !important;
		}

		:global(body) {
			background: white !important;
			color: black !important;
		}

		/* Remove backdrops / dialogs that would print as overlays. */
		[role='dialog'] {
			display: none !important;
		}

		/* Expand any details on print so nothing is hidden. */
		details {
			break-inside: avoid;
		}
		details > summary {
			list-style: none;
		}
		details[open] > * {
			display: block !important;
		}

		/* Section breaks: each top-level section in the paper starts on a
		   fresh page where possible, so the reader can tear them apart. */
		section {
			break-inside: avoid-page;
		}
		section[id^='section-'] {
			break-before: page;
		}
		#section-1 {
			break-before: avoid;
		}

		/* Hide interactive scan / share / print controls themselves. */
		.no-print {
			display: none !important;
		}
	}
</style>
