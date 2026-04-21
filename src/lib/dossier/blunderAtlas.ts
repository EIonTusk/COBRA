/**
 * Blunder atlas. Cluster the user's worst moves from the v2 eval pass
 * into five context buckets so the page can say *what kind* of mistake
 * the player keeps making — and route each cluster straight to the
 * existing Mistakes drill pipeline via `blunderAtlasItemToStoredMistake`.
 *
 * A single move can qualify for more than one bucket (e.g. a hanging
 * piece in the endgame with a time pressure flag); we put it into the
 * first matching bucket in priority order so the atlas headline isn't
 * double-counted.
 */
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';
import { tryFenKey } from '$lib/chess/fen';
import { pieceOnSquareIsHanging } from './demand';
import type { EvalMoveResult } from './evalAxes';
import type { Repertoire, StoredMistake } from '$lib/types';

export type AtlasBucket =
	| 'hanging_material'
	| 'missed_forcing_win'
	| 'time_pressure'
	| 'winning_to_lost'
	| 'endgame_slip';

export interface BlunderAtlasItem {
	move: EvalMoveResult;
	bucket: AtlasBucket;
	hint: string;
}

export interface BlunderCluster {
	bucket: AtlasBucket;
	title: string;
	summary: string;
	drillHint: string;
	items: BlunderAtlasItem[];
	count: number;
}

export interface BlunderAtlas {
	clusters: BlunderCluster[];
	total: number;
	unbucketed: number;
}

const META: Record<
	AtlasBucket,
	{ title: string; summary: string; drillHint: string; hint: string }
> = {
	hanging_material: {
		title: 'Hanging material',
		summary: 'Moves that left a piece undefended.',
		drillHint: 'Drill these positions — train to double-check every square your piece moves to.',
		hint: '(piece left hanging)'
	},
	missed_forcing_win: {
		title: 'Forcing-move blunders',
		summary: 'You played a check or capture and it backfired — the refutation cost material.',
		drillHint:
			'Drill calculation of forcing sequences — follow each check/capture to its real end.',
		hint: '(forcing move backfired)'
	},
	time_pressure: {
		title: 'Time-pressure collapse',
		summary: 'Blunders on moves played with under 10 seconds on your clock.',
		drillHint:
			'Budget more time in the opening and middlegame — arrive at late moves with reserves.',
		hint: '(low clock)'
	},
	winning_to_lost: {
		title: 'Winning → lost',
		summary: 'You had a clear advantage (≥ +1) and turned it negative in one move.',
		drillHint:
			'Drill conversion technique — simplify, trade into a better endgame, avoid counterplay.',
		hint: '(winning → losing)'
	},
	endgame_slip: {
		title: 'Endgame slips',
		summary: 'Blunders in the endgame when you had something to play for.',
		drillHint: 'Endgame fundamentals — king activity, pawn races, opposite-coloured bishops.',
		hint: '(endgame blunder)'
	}
};

const SOURCE_PREFIX = 'atlas';

export function buildBlunderAtlas(moves: EvalMoveResult[]): BlunderAtlas {
	const blunders = moves.filter((m) => m.classification === 'blunder' || m.cpLoss >= 150);
	blunders.sort((a, b) => b.cpLoss - a.cpLoss);

	const byBucket: Record<AtlasBucket, BlunderAtlasItem[]> = {
		hanging_material: [],
		missed_forcing_win: [],
		time_pressure: [],
		winning_to_lost: [],
		endgame_slip: []
	};
	let unbucketed = 0;

	for (const m of blunders) {
		const bucket = classifyBucket(m);
		if (!bucket) {
			unbucketed += 1;
			continue;
		}
		byBucket[bucket].push({ move: m, bucket, hint: META[bucket].hint });
	}

	const clusters: BlunderCluster[] = [];
	for (const bucket of [
		'hanging_material',
		'missed_forcing_win',
		'time_pressure',
		'winning_to_lost',
		'endgame_slip'
	] as AtlasBucket[]) {
		const items = byBucket[bucket];
		if (items.length === 0) continue;
		const meta = META[bucket];
		clusters.push({
			bucket,
			title: meta.title,
			summary: meta.summary,
			drillHint: meta.drillHint,
			items,
			count: items.length
		});
	}
	clusters.sort((a, b) => b.count - a.count);

	// `total` reflects clustered items — the headline "N moves clustered"
	// shouldn't include moves we couldn't bucket. `unbucketed` is still
	// exposed separately for debugging.
	const total = clusters.reduce((s, c) => s + c.count, 0);
	return { clusters, total, unbucketed };
}

function classifyBucket(m: EvalMoveResult): AtlasBucket | null {
	// Order matters: the first match wins so atlas counts aren't
	// double-attributed. Hanging material is the clearest teaching signal
	// and goes first; time pressure gets priority over slow-burn drift.
	if (leftPieceHanging(m)) return 'hanging_material';
	if (m.clockBucket === 'low' && m.cpLoss >= 200) return 'time_pressure';
	if (m.bestWasForcing && m.cpLoss >= 100) return 'missed_forcing_win';
	if (m.userEvalBeforeCp >= 100 && m.userEvalAfterCp <= 0) return 'winning_to_lost';
	if (m.phase === 'end' && m.userEvalBeforeCp >= 50 && m.cpLoss >= 150) return 'endgame_slip';
	return null;
}

/**
 * Replays the SAN on the before-FEN and checks if the user's own piece
 * on the destination square is now en prise. Reuses the SEE helper from
 * demand.ts. Returns false on any parse failure — we'd rather under-
 * cluster than mis-label.
 */
function leftPieceHanging(m: EvalMoveResult): boolean {
	try {
		const setupR = parseFen(m.fenBefore);
		if (setupR.isErr) return false;
		const beforeR = Chess.fromSetup(setupR.value);
		if (beforeR.isErr) return false;
		const before = beforeR.value;
		const parsed = parseSan(before, m.san);
		if (!parsed || !('to' in parsed)) return false;
		const afterSetupR = parseFen(m.fenAfter);
		if (afterSetupR.isErr) return false;
		const afterR = Chess.fromSetup(afterSetupR.value);
		if (afterR.isErr) return false;
		return pieceOnSquareIsHanging(afterR.value, parsed.to) >= 1;
	} catch {
		return false;
	}
}

/**
 * Mint a `StoredMistake` row from an atlas item so the "Drill these"
 * button on a cluster can seed `/mistakes`. Mirrors
 * `leakDrills.leakToStoredMistake` — same FEN key derivation, same
 * composite-id dedup scheme (prefixed with `atlas:` so it never collides
 * with real off-tree mistakes or leak entries).
 */
export function blunderAtlasItemToStoredMistake(
	item: BlunderAtlasItem,
	rep: Pick<Repertoire, 'id' | 'name'>
): StoredMistake | null {
	const m = item.move;
	const fenKey = tryFenKey(m.fenBefore);
	if (!fenKey) return null;
	return {
		id: `${SOURCE_PREFIX}:${item.bucket}:${m.gameId}:${rep.id}:${fenKey}`,
		gameId: m.gameId,
		gameUrl: gameUrlFromId(m.gameId),
		playedAt: m.playedAt,
		detectedAt: Date.now(),
		speed: 'unknown',
		opponent: '',
		color: m.userColor,
		repertoireId: rep.id,
		repertoireName: rep.name,
		fenKey,
		fen: m.fenBefore,
		playedSan: m.san,
		expectedSan: item.hint,
		plyOffTree: m.ply,
		status: 'pending',
		correctCount: 0
	};
}

function gameUrlFromId(gameId: string): string {
	if (gameId.startsWith('cc-')) {
		const numeric = gameId.slice(3);
		return `https://www.chess.com/game/live/${numeric}`;
	}
	return `https://lichess.org/${gameId}`;
}
