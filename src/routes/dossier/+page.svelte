<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { onMount } from 'svelte';
	import { base, resolve } from '$app/paths';
	import { ArrowLeft, Printer, Share2 } from 'lucide-svelte';

	import { DashboardBacklink } from '$lib/ui';
	import PerAccountSection from './PerAccountSection.svelte';
	import BaselineFooter from './BaselineFooter.svelte';
	import EvalAxesAppendix from './EvalAxesAppendix.svelte';
	import ScorecardSection from './ScorecardSection.svelte';
	import CriticalMomentsSection from './CriticalMomentsSection.svelte';
	import TimeSignatureSection from './TimeSignatureSection.svelte';
	import BlunderAtlasSection from './BlunderAtlasSection.svelte';
	import SessionProfileSection from './SessionProfileSection.svelte';
	import LeakDetectorSection from './LeakDetectorSection.svelte';
	import ExecutiveSummarySection from './ExecutiveSummarySection.svelte';
	import ScopeMethodologySection from './ScopeMethodologySection.svelte';
	import PriorityActionsSection from './PriorityActionsSection.svelte';
	import DossierHero from './DossierHero.svelte';
	import DossierTOC from './DossierTOC.svelte';
	import ShareDialog from './ShareDialog.svelte';
	import DossierScanProgress from './DossierScanProgress.svelte';
	import DossierScanControlsRow from './DossierScanControlsRow.svelte';
	import StylisticProfilePrelude from './StylisticProfilePrelude.svelte';
	import FindingCard from './FindingCard.svelte';
	import TensionManagementCard from './TensionManagementCard.svelte';
	import FindingExhibits from './FindingExhibits.svelte';
	import StudyPlanSection from './StudyPlanSection.svelte';
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
	import { buildDossierProfile } from '$lib/dossier/profile';
	import { buildOpeningProfile } from '$lib/dossier/openingProfile';
	import { buildOpeningProfileByRepertoire } from '$lib/dossier/openingProfileByRepertoire';
	import { listStoredBaselines, type StoredBaselineBucket } from '$lib/storage/baselines';
	import { collectAccountsFromSettings } from '$lib/lichess/mistakeScan';
	import { type DossierScanResult } from '$lib/dossier/scan';
	import { dossierScan } from '$lib/dossier/scanStore.svelte';
	import {
		highlightAxes,
		BASELINE_META,
		pickBaseline,
		primarySpeed,
		setRuntimeBaselines,
		fingerprintFromGames
	} from '$lib/dossier/fingerprint';
	import { loadMastersBaseline, type LoadedMastersBaseline } from '$lib/storage/mastersBaseline';
	// The v1 archetype module is still used by the library page, but /dossier
	// now derives its own profile from v2 data via buildDossierProfile below.
	import { leakToStoredMistake } from '$lib/dossier/leakDrills';
	import { analyseLeaks, avgCpLossByType, type AnalysedLeak } from '$lib/dossier/leakEval';
	import {
		buildDeepInsightCards,
		auditAreaLabel,
		severityRank,
		type InsightCard,
		type InsightGroup
	} from '$lib/dossier/deepInsights';
	import { buildAuditSummary } from '$lib/dossier/auditSummary';
	import { buildFixFirst } from '$lib/dossier/fixFirst';
	import { buildStudyPlan } from '$lib/dossier/studyPlan';
	import {
		buildDossierShareBundle,
		encodeDossierShare,
		estimateShareSize
	} from '$lib/storage/shareDossierReport';
	import { buildExhibits } from '$lib/dossier/buildExhibits';
	import { listRepertoires } from '$lib/storage/repertoires';
	import { listNodes } from '$lib/storage/nodes';
	import { listCards } from '$lib/storage/cards';
	import { buildFsrsFailures, type FsrsFailureRow } from '$lib/dossier/fsrsFeedback';
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
	/** Per-repertoire FEN-keyed node bundle. Populated alongside listRepertoires
	 *  so the forgotten-prep card can cross-reference leak FENs against prep. */
	let repertoiresWithNodes = $state<
		Array<{ repertoire: Repertoire; nodes: Awaited<ReturnType<typeof listNodes>> }>
	>([]);
	/** FSRS retention leaks: drill cards failed N+ times. Distinct from in-game
	 *  blunders — these are positions the user can't internalise even when
	 *  drilled in isolation. Surfaces via the "Knowledge retention" card. */
	let fsrsFailures = $state<FsrsFailureRow[]>([]);
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

	// Cached masters baseline. Loaded silently on mount; if the user
	// hasn't fetched one yet, this stays null and downstream cards
	// (tension, etc.) just hide their "vs masters" overlays. The fetch
	// UI lives on dossier subpages where it's contextually relevant.
	let mastersBaseline = $state<LoadedMastersBaseline | null>(null);

	onMount(async () => {
		settings = await getSettings();
		accounts = collectAccountsFromSettings(settings);
		repertoires = await listRepertoires();
		if (repertoires.length > 0 && !drillRepId) drillRepId = repertoires[0].id;
		// Fan out nodes for the forgotten-prep cross-reference. Cheap —
		// each repertoire's nodes live under one index query, and we only
		// need them for the card's FEN join.
		repertoiresWithNodes = await Promise.all(
			repertoires.map(async (r) => ({ repertoire: r, nodes: await listNodes(r.id) }))
		);
		const allCards = (await Promise.all(repertoires.map((r) => listCards(r.id)))).flat();
		fsrsFailures = buildFsrsFailures(allCards, repertoires);
		// Load any user-calibrated baselines and inject them into the
		// runtime cache so pickBaseline() picks them on first render.
		storedBaselines = await listStoredBaselines();
		setRuntimeBaselines(storedBaselines);

		mastersBaseline = await loadMastersBaseline();

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

	// formatMethodology + severityNarrative now live in FindingCard.svelte.

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

	const repertoireFitProfile = $derived.by(() => {
		if (!result) return null;
		return buildOpeningProfile(result.classified, evalSummary?.allMoves ?? null);
	});

	const repertoireFit = $derived.by(() => {
		if (!result) return null;
		return buildOpeningProfileByRepertoire(
			result.classified,
			evalSummary?.allMoves ?? null,
			repertoiresWithNodes
		);
	});

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

	// Masters tension benchmark — null until the user fetches a masters
	// baseline from one of the subpages. Recomputed from the cached
	// ClassifiedGame[] so we get the same release/creation accounting
	// as the user's own fingerprint without a custom aggregator.
	const mastersTension = $derived.by(() => {
		if (!mastersBaseline?.games.length) return null;
		const fp = fingerprintFromGames(mastersBaseline.games);
		if (fp.tension.tensionedMoves < 25) return null;
		return {
			releaseRate: fp.tension.releaseRate,
			creationRate: fp.tension.creationRate,
			tensionedMoves: fp.tension.tensionedMoves,
			totalMoves: fp.totalUserMoves,
			games: mastersBaseline.games.length
		};
	});

	// PHASE_LABEL, pct, lichessAnalysisUrl, AXIS_LABEL, barWidth all live in
	// $lib/dossier/format so extracted section components can import directly.

	const auditSummary = $derived(result ? buildAuditSummary(result) : null);
	const deepInsightCards = $derived(
		result
			? buildDeepInsightCards(result, {
					repertoires: repertoiresWithNodes,
					fsrsFailures
				})
			: []
	);
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
	const studyPlan = $derived(result ? buildStudyPlan(result, activeBaseline) : null);

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
	const exhibits = $derived(result ? buildExhibits(result) : null);

	/** Slugs that have a dedicated /dossier/<slug> detail page. Findings
	 * whose slug is not in this set render inline-only with no broken link. */
	const DETAIL_ROUTES = new Set<string>([
		'blunder-causality',
		'blunder-timing',
		'calculation-depth',
		'consensus-alignment',
		'decision-difficulty',
		'defensive-resource',
		'drift',
		'endgame-subtypes',
		'exchange-propensity',
		'exemplars',
		'fix-first',
		'fsrs-retention',
		'level-up',
		'narrative',
		'opening-fit',
		'opponent-strength',
		'space-control',
		'piece-affinity',
		'plan-taste',
		'progression',
		'prophylaxis',
		'recovery-arc',
		'repeat-offenders',
		'repertoire-fit',
		'repertoire-lint',
		'session-decay',
		'structure-taste',
		'tactical-motifs',
		'time-of-day'
	]);

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
			case 'space-control':
				return 'Per-square attacker diff vs opponents at this rating band';
			case 'repertoire-fit':
				return 'Scan corpus split across your repertoires · W/D/L per rep';
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

	// severityTint, severityDot, formatDateShort lifted to $lib/dossier/format.
	// severityNarrative + formatMethodology + DETAIL_ROUTES live in FindingCard.
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

	<ShareDialog
		open={shareOpen}
		encoding={shareEncoding}
		error={shareError}
		url={shareUrl}
		size={shareSize}
		copyStatus={shareCopyStatus}
		onClose={closeShareDialog}
		onCopy={copyShareUrl}
		onDownload={downloadShareFile}
	/>

	{#if result && auditSummary}
		<DossierHero audit={auditSummary} evalAxes={result.evalAxes} {reportUsername} />
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
		{#if BASELINE_META.bucketCount === 0 && storedBaselines.length === 0 && BASELINE_META.source !== 'empirical'}
			<div
				class="mt-4 flex flex-wrap items-start gap-3 rounded border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-[var(--color-parchment-100)]"
				role="note"
			>
				<span
					class="mt-0.5 inline-block size-1.5 shrink-0 rounded-full bg-amber-400"
					aria-hidden="true"
				></span>
				<div class="min-w-0 flex-1">
					<div class="font-medium">No peer baseline calibrated yet.</div>
					<p class="mt-1 text-xs text-[var(--color-parchment-300)]">
						Findings will compare against eyeballed defaults rather than numbers measured from real
						players at your rating. Calibrate once from
						<a
							href={resolve('/settings#dossier-baseline')}
							class="underline decoration-amber-300/60 underline-offset-2 hover:text-[var(--color-parchment-50)]"
							>Settings → Dossier baseline</a
						>
						for a more faithful report.
					</p>
				</div>
			</div>
		{:else}
			<p class="mt-3 text-xs text-[var(--color-parchment-500)]">
				Baseline source: <span class="font-mono"
					>{storedBaselines.length > 0 ? 'self-calibrated' : BASELINE_META.source}</span
				>
				{#if storedBaselines.length > 0}
					· {storedBaselines.length} self-calibrated bucket{storedBaselines.length === 1 ? '' : 's'}
				{:else if BASELINE_META.bucketCount > 0}
					· {BASELINE_META.bucketCount} rating bucket{BASELINE_META.bucketCount === 1 ? '' : 's'}
				{:else if BASELINE_META.source === 'empirical'}
					· {BASELINE_META.games} games from {BASELINE_META.sampledFrom?.length ?? 0} players
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
				<DossierScanControlsRow
					mode="compact"
					{accountOptions}
					{selectedAccountKeys}
					{accountByValue}
					{maxGames}
					{evalDepth}
					{running}
					onSelectAccounts={(next) => (selectedAccountKeys = next)}
					onMaxGamesChange={(n) => (maxGames = n)}
					onDepthChange={(d) => (evalDepth = d)}
					onRun={run}
					onSecondary={discardReport}
					primaryLabel="Generate new report"
					secondaryLabel="Discard"
				/>
			{/if}
		</div>
	{:else}
		<DossierScanControlsRow
			mode="fresh"
			{accountOptions}
			{selectedAccountKeys}
			{accountByValue}
			{maxGames}
			{evalDepth}
			{running}
			onSelectAccounts={(next) => (selectedAccountKeys = next)}
			onMaxGamesChange={(n) => (maxGames = n)}
			onDepthChange={(d) => (evalDepth = d)}
			onRun={run}
			onSecondary={() => dossierScan.cancel()}
			primaryLabel="Scan"
			secondaryLabel="Cancel"
		/>

		{#if running || scanPhase === 'done'}
			<DossierScanProgress
				phase={scanPhase}
				gamesDone={scanGamesDone}
				progressText={progress}
				{evalTotal}
				{evalDone}
				{evalFraction}
			/>
		{/if}
		{#if error}
			<p class="mt-2 text-sm text-red-400">{error}</p>
		{/if}
	{/if}

	{#if result}
		{@const fp = result.fingerprint}

		<!-- ======== Consulting-paper body ======== -->
		{#if auditSummary}
			<DossierTOC sections={paperSections} />

			<!-- §1 Executive summary -->
			<ExecutiveSummarySection audit={auditSummary} />

			<!-- §2 Scope and methodology -->
			<ScopeMethodologySection audit={auditSummary} {evalSummary} />

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

					{#if s.num === 3}
						<StylisticProfilePrelude
							{highlights}
							{evalInterpretation}
							profile={styleProfile}
							evalDepth={auditSummary.scope.evalDepth}
							baselineSource={auditSummary.scope.baselineSource}
						/>
					{/if}

					<div class="mt-6 space-y-5">
						{#each s.cards as c, cIdx (c.slug)}
							<FindingCard
								card={c}
								sectionNum={s.num}
								cardIdx={cIdx}
								anchor={s.anchor}
								exhibitCaption={exhibits ? exhibitCaption(c.slug) || null : null}
								hasDetailRoute={DETAIL_ROUTES.has(c.slug)}
							>
								{#if exhibits}
									<FindingExhibits
										{exhibits}
										card={c}
										slug={c.slug}
										hasEvalData={result?.evalAxes != null}
										byRepertoire={repertoireFit}
										repertoireFitBaseline={repertoireFitProfile}
									/>
								{/if}
							</FindingCard>
						{/each}

						<!-- 3.6 Tension management — promoted from Appendix F. Pawn-contact
						     release + creation rates vs peers, with the "you are this kind
						     of player" read the interpreter derives from the deltas. -->
						{#if s.num === 3 && activeBaseline && tensionDelta && fp.tension.tensionedMoves > 0}
							<TensionManagementCard
								fingerprint={fp}
								{activeBaseline}
								{tensionDelta}
								{mastersTension}
								anchor={s.anchor}
								sectionNum={s.num}
								cardIdx={s.cards.length + 1}
							/>
						{/if}
					</div>
				</section>
			{/each}

			<!-- §7 Priority actions -->
			<PriorityActionsSection recommendations={auditRecommendations} />

			<!-- §8 Study plan — rating-bucket-aware recommendations. Lives
			     after Priority actions because it cites peer numbers and
			     should be read in conversation with §1's verdict. -->
			<StudyPlanSection plan={studyPlan} />

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
		<ScorecardSection {scorecard} />

		<!-- ======== Critical moments ======== -->
		<CriticalMomentsSection critical={criticalMoments} hasEvalData={evalSummary != null} />

		<!-- ======== Time signature ======== -->
		<TimeSignatureSection clockSpend={clockSpendReport} />

		<!-- ======== Blunder atlas ======== -->
		<BlunderAtlasSection
			atlas={blunderAtlas}
			{drillRepId}
			statusByBucket={atlasStatusByBucket}
			onSaveAsDrills={saveClusterAsDrills}
		/>

		<!-- ======== Session profile ======== -->
		<SessionProfileSection profile={sessionProfile} />

		{#if result}
			<LeakDetectorSection
				leaks={result.leaks}
				{repertoires}
				bind:drillRepId
				{savedLeakIds}
				{cpLossByLeakRow}
				{analysedAvg}
				{analysing}
				{analyseProgress}
				{analyseError}
				{saveAllStatus}
				onDeepAnalyse={deepAnalyseLeaks}
				onSaveAll={saveAllWorstLeaks}
				onSaveLeak={saveLeakAsDrill}
			/>
		{/if}

		{#if result.evalError}
			<p class="mt-3 text-xs text-[var(--color-oxblood-300)]">
				v2 eval pass during scan errored: {result.evalError}
			</p>
		{/if}

		<EvalAxesAppendix
			bind:gameCap={evalGameCap}
			running={evalRunning}
			progress={evalProgress}
			error={evalError}
			summary={evalSummary}
			onRun={runEvalAxes}
			onAbort={() => evalController?.abort()}
		/>

		<PerAccountSection perAccount={result.perAccount} />

		<BaselineFooter {activeBaseline} />
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

		/* Remove backdrops / dialogs that would print as overlays. `:global`
		   because the share dialog now lives in an extracted child component. */
		:global([role='dialog']) {
			display: none !important;
		}

		/* Expand any details on print so nothing is hidden. `:global` because
		   some `<details>` elements now live in extracted child components. */
		:global(details) {
			break-inside: avoid;
		}
		:global(details > summary) {
			list-style: none;
		}
		:global(details[open] > *) {
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
