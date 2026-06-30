// Integration test for the tier-split rep bundles (issue #68): a repertoire
// syncs as two independently-revisioned scopes — `rep-core` (authored tree)
// and `rep-telemetry` (derived scan data). Runs against a real IndexedDB via
// fake-indexeddb so it exercises the actual store reads/writes.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDB } from '$lib/storage/db';
import {
	applyRepBundleMerge,
	applyRepCoreBundleMerge,
	applyRepTelemetryBundleMerge,
	buildRepCoreBundle,
	buildRepTelemetryBundle,
	BUNDLE_VERSION,
	decodeBundle,
	encodeBundle
} from './bundle';
import type { RepertoireNode } from '$lib/types';

const REP = 'rep-1';

async function seed(): Promise<void> {
	const db = await getDB();
	await db.put('repertoires', { id: REP, name: 'Test', updatedAt: 1000 } as never);
	await db.put('nodes', {
		repertoireId: REP,
		fenKey: 'root',
		children: [{ san: 'e4', uci: 'e2e4', toFenKey: 'after-e4' }]
	} as never);
	await db.put('cards', {
		repertoireId: REP,
		fenKey: 'root',
		expectedSan: 'e4',
		dueAt: 0
	} as never);
	await db.put('idea_cards', { repertoireId: REP, fenKey: 'root', dueAt: 0 } as never);
	// Telemetry rows.
	await db.put('mistakes', { id: 'm1', repertoireId: REP } as never);
	await db.put('empirical_gaps', { id: 'g1', repertoireId: REP } as never);
	await db.put('spar_games', { id: 's1', repertoireId: REP } as never);
	await db.put('position_wdl', { id: 'w1', repertoireId: REP, fenKey: 'root' } as never);
}

async function clearAll(): Promise<void> {
	const db = await getDB();
	for (const s of [
		'repertoires',
		'nodes',
		'cards',
		'idea_cards',
		'mistakes',
		'empirical_gaps',
		'spar_games',
		'position_wdl'
	] as const) {
		await db.clear(s);
	}
}

/** Replace this rep's node set wholesale (used to stage per-device state). */
async function setNodes(nodes: RepertoireNode[]): Promise<void> {
	const db = await getDB();
	const tx = db.transaction('nodes', 'readwrite');
	for (const key of await tx.store.index('by-repertoire').getAllKeys(REP))
		await tx.store.delete(key);
	for (const n of nodes) await tx.store.put(n);
	await tx.done;
}

/** Order-independent snapshot of this rep's nodes for convergence comparison. */
async function snapshotNodes(): Promise<unknown[]> {
	const db = await getDB();
	const all = (await db.getAllFromIndex('nodes', 'by-repertoire', REP)) as RepertoireNode[];
	return all
		.map((n) => ({
			fenKey: n.fenKey,
			updatedAt: n.updatedAt,
			children: [...n.children]
				.sort((a, b) => a.toFenKey.localeCompare(b.toFenKey))
				.map((e) => ({ ...e })),
			deletedChildren: [...(n.deletedChildren ?? [])].sort((a, b) =>
				a.toFenKey.localeCompare(b.toFenKey)
			)
		}))
		.sort((a, b) => a.fenKey.localeCompare(b.fenKey));
}

beforeEach(clearAll);

describe('tier-split rep bundles', () => {
	it('buildRepCoreBundle reads only the authored-tree stores', async () => {
		await seed();
		const core = await buildRepCoreBundle(REP);
		expect(core).not.toBeNull();
		expect(core!.kind).toBe('rep-core');
		expect(core!.repertoireId).toBe(REP);
		expect(core!.nodes).toHaveLength(1);
		expect(core!.cards).toHaveLength(1);
		expect(core!.ideaCards).toHaveLength(1);
		// No telemetry keys exist on the core bundle at all.
		expect(core as unknown as Record<string, unknown>).not.toHaveProperty('mistakes');
		expect(core as unknown as Record<string, unknown>).not.toHaveProperty('positionWdl');
	});

	it('buildRepTelemetryBundle reads only the derived-scan stores', async () => {
		await seed();
		const tel = await buildRepTelemetryBundle(REP);
		expect(tel).not.toBeNull();
		expect(tel!.kind).toBe('rep-telemetry');
		expect(tel!.mistakes).toHaveLength(1);
		expect(tel!.empiricalGaps).toHaveLength(1);
		expect(tel!.sparGames).toHaveLength(1);
		expect(tel!.positionWdl).toHaveLength(1);
		expect(tel as unknown as Record<string, unknown>).not.toHaveProperty('nodes');
	});

	it('returns null when the rep is gone', async () => {
		expect(await buildRepCoreBundle('missing')).toBeNull();
		expect(await buildRepTelemetryBundle('missing')).toBeNull();
	});

	it('encode/decode round-trips each tier preserving kind', async () => {
		await seed();
		const core = await buildRepCoreBundle(REP);
		const tel = await buildRepTelemetryBundle(REP);
		const decodedCore = await decodeBundle(await encodeBundle(core!));
		const decodedTel = await decodeBundle(await encodeBundle(tel!));
		expect(decodedCore.kind).toBe('rep-core');
		expect(decodedTel.kind).toBe('rep-telemetry');
		expect(JSON.parse(JSON.stringify(decodedCore))).toEqual(JSON.parse(JSON.stringify(core)));
		expect(JSON.parse(JSON.stringify(decodedTel))).toEqual(JSON.parse(JSON.stringify(tel)));
	});

	it('applying a core bundle into a fresh DB lands only core stores', async () => {
		await seed();
		const core = await buildRepCoreBundle(REP);
		await clearAll();
		const stats = await applyRepCoreBundleMerge(core!);

		const db = await getDB();
		expect(await db.getAllKeys('nodes')).toHaveLength(1);
		expect(await db.getAllKeys('cards')).toHaveLength(1);
		expect(await db.getAllKeys('idea_cards')).toHaveLength(1);
		// Telemetry stores must be untouched by a core apply.
		expect(await db.getAllKeys('mistakes')).toHaveLength(0);
		expect(await db.getAllKeys('position_wdl')).toHaveLength(0);
		expect(stats.repertoireUpdated).toBe(1);
		expect(stats.nodes).toBe(1);
	});

	it('applying a telemetry bundle into a fresh DB lands only telemetry stores', async () => {
		await seed();
		const tel = await buildRepTelemetryBundle(REP);
		await clearAll();
		const stats = await applyRepTelemetryBundleMerge(tel!);

		const db = await getDB();
		expect(await db.getAllKeys('mistakes')).toHaveLength(1);
		expect(await db.getAllKeys('empirical_gaps')).toHaveLength(1);
		expect(await db.getAllKeys('spar_games')).toHaveLength(1);
		expect(await db.getAllKeys('position_wdl')).toHaveLength(1);
		// Core stores must be untouched by a telemetry apply.
		expect(await db.getAllKeys('nodes')).toHaveLength(0);
		expect(await db.getAllKeys('repertoires')).toHaveLength(0);
		expect(stats.mistakes).toBe(1);
	});

	it('a synced-in edge deletion removes the variation and prunes its orphaned cards', async () => {
		// Regression for issue #72: deleting a variation on one device must
		// stay deleted on the others instead of being resurrected by the
		// adds-win edge union.
		const db = await getDB();
		// Recent wall-clock timestamps so the tombstone isn't GC'd as stale.
		const deletedAt = Date.now();
		const edgeStamp = deletedAt - 60_000;
		// This device still holds the full line root -e4-> A, with a drill
		// card sitting on A.
		await db.put('repertoires', {
			id: REP,
			name: 'Test',
			rootFenKey: 'root',
			updatedAt: 1000
		} as never);
		await db.put('nodes', {
			repertoireId: REP,
			fenKey: 'root',
			children: [{ san: 'e4', uci: 'e2e4', toFenKey: 'A', updatedAt: edgeStamp }],
			updatedAt: edgeStamp
		} as never);
		await db.put('nodes', {
			repertoireId: REP,
			fenKey: 'A',
			children: [],
			updatedAt: edgeStamp
		} as never);
		await db.put('cards', { repertoireId: REP, fenKey: 'A', expectedSan: 'e4', dueAt: 0 } as never);

		// The other device deleted the e4 edge and pushed: its bundle's root
		// node carries a tombstone and no longer references A.
		const bundle = {
			kind: 'rep-core' as const,
			version: BUNDLE_VERSION,
			repertoireId: REP,
			exportedAt: deletedAt,
			repertoire: { id: REP, name: 'Test', rootFenKey: 'root', updatedAt: 1000 },
			nodes: [
				{
					repertoireId: REP,
					fenKey: 'root',
					children: [],
					updatedAt: deletedAt,
					deletedChildren: [{ toFenKey: 'A', deletedAt }]
				}
			],
			cards: [],
			ideaCards: []
		};

		await applyRepCoreBundleMerge(bundle as never);

		const root = (await db.get('nodes', [REP, 'root'])) as {
			children: unknown[];
			deletedChildren: unknown[];
		};
		expect(root.children).toEqual([]);
		expect(root.deletedChildren).toEqual([{ toFenKey: 'A', deletedAt }]);
		// Orphaned node A and the drill card hanging off it are swept.
		expect(await db.get('nodes', [REP, 'A'])).toBeUndefined();
		expect(await db.get('cards', [REP, 'A'])).toBeUndefined();
	});

	it('a synced-in deletion keeps a position still reachable via a transposition', async () => {
		// Graph, not tree: root -e4-> A -> shared and root -d4-> B -> shared.
		// The other device deleted the e4 edge; on merge, A is orphaned and
		// pruned, but `shared` must survive because B still reaches it.
		const db = await getDB();
		const deletedAt = Date.now();
		const stamp = deletedAt - 60_000;
		await db.put('repertoires', {
			id: REP,
			name: 'Test',
			rootFenKey: 'root',
			updatedAt: 1000
		} as never);
		await db.put('nodes', {
			repertoireId: REP,
			fenKey: 'root',
			children: [
				{ san: 'e4', uci: 'e2e4', toFenKey: 'A', updatedAt: stamp },
				{ san: 'd4', uci: 'd2d4', toFenKey: 'B', updatedAt: stamp }
			],
			updatedAt: stamp
		} as never);
		await db.put('nodes', {
			repertoireId: REP,
			fenKey: 'A',
			children: [{ san: 'm1', uci: 'm1m1', toFenKey: 'shared', updatedAt: stamp }],
			updatedAt: stamp
		} as never);
		await db.put('nodes', {
			repertoireId: REP,
			fenKey: 'B',
			children: [{ san: 'm2', uci: 'm2m2', toFenKey: 'shared', updatedAt: stamp }],
			updatedAt: stamp
		} as never);
		await db.put('nodes', {
			repertoireId: REP,
			fenKey: 'shared',
			children: [],
			updatedAt: stamp
		} as never);
		await db.put('cards', {
			repertoireId: REP,
			fenKey: 'shared',
			expectedSan: 'm1',
			dueAt: 0
		} as never);

		const bundle = {
			kind: 'rep-core' as const,
			version: BUNDLE_VERSION,
			repertoireId: REP,
			exportedAt: deletedAt,
			repertoire: { id: REP, name: 'Test', rootFenKey: 'root', updatedAt: 1000 },
			nodes: [
				{
					repertoireId: REP,
					fenKey: 'root',
					children: [{ san: 'd4', uci: 'd2d4', toFenKey: 'B', updatedAt: stamp }],
					updatedAt: deletedAt,
					deletedChildren: [{ toFenKey: 'A', deletedAt }]
				}
			],
			cards: [],
			ideaCards: []
		};

		await applyRepCoreBundleMerge(bundle as never);

		const keys = (await db.getAllKeysFromIndex('nodes', 'by-repertoire', REP)) as Array<
			[string, string]
		>;
		expect(keys.map(([, fk]) => fk).sort()).toEqual(['B', 'root', 'shared']);
		// The card on the transposition target is untouched.
		expect(await db.get('cards', [REP, 'shared'])).toBeDefined();
	});

	it('the legacy combined RepBundle merge also propagates a deletion and prunes', async () => {
		// Pre-tier-split devices push a combined `rep` bundle; the same edge
		// tombstone path must apply there too.
		const db = await getDB();
		const deletedAt = Date.now();
		const stamp = deletedAt - 60_000;
		await db.put('repertoires', {
			id: REP,
			name: 'Test',
			rootFenKey: 'root',
			updatedAt: 1000
		} as never);
		await db.put('nodes', {
			repertoireId: REP,
			fenKey: 'root',
			children: [{ san: 'e4', uci: 'e2e4', toFenKey: 'A', updatedAt: stamp }],
			updatedAt: stamp
		} as never);
		await db.put('nodes', {
			repertoireId: REP,
			fenKey: 'A',
			children: [],
			updatedAt: stamp
		} as never);
		await db.put('cards', { repertoireId: REP, fenKey: 'A', expectedSan: 'e4', dueAt: 0 } as never);

		const bundle = {
			kind: 'rep' as const,
			version: BUNDLE_VERSION,
			repertoireId: REP,
			exportedAt: deletedAt,
			repertoire: { id: REP, name: 'Test', rootFenKey: 'root', updatedAt: 1000 },
			nodes: [
				{
					repertoireId: REP,
					fenKey: 'root',
					children: [],
					updatedAt: deletedAt,
					deletedChildren: [{ toFenKey: 'A', deletedAt }]
				}
			],
			cards: [],
			ideaCards: [],
			mistakes: [],
			empiricalGaps: [],
			sparGames: [],
			positionWdl: []
		};

		await applyRepBundleMerge(bundle as never);

		expect(await db.get('nodes', [REP, 'A'])).toBeUndefined();
		expect(await db.get('cards', [REP, 'A'])).toBeUndefined();
		const root = (await db.get('nodes', [REP, 'root'])) as { deletedChildren: unknown[] };
		expect(root.deletedChildren).toEqual([{ toFenKey: 'A', deletedAt }]);
	});

	it('two devices converge after exchanging bundles in both directions', async () => {
		const t1 = Date.now(); // device A's deletion time
		const t2 = t1 + 1000; // device B's add time
		const base = t1 - 60_000; // original edge timestamps
		const rep = { id: REP, name: 'Test', rootFenKey: 'root', updatedAt: 1000 };

		// Device A: started from root -e4-> X and root -d4-> Y, then deleted the
		// e4 edge (X pruned, tombstone left on root).
		const stateA: RepertoireNode[] = [
			{
				repertoireId: REP,
				fenKey: 'root',
				children: [{ san: 'd4', uci: 'd2d4', toFenKey: 'Y', updatedAt: base }],
				updatedAt: t1,
				deletedChildren: [{ toFenKey: 'X', deletedAt: t1 }]
			},
			{ repertoireId: REP, fenKey: 'Y', children: [], updatedAt: base }
		];
		// Device B: still has both edges, and independently added Y -> Z.
		const stateB: RepertoireNode[] = [
			{
				repertoireId: REP,
				fenKey: 'root',
				children: [
					{ san: 'e4', uci: 'e2e4', toFenKey: 'X', updatedAt: base },
					{ san: 'd4', uci: 'd2d4', toFenKey: 'Y', updatedAt: base }
				],
				updatedAt: base
			},
			{ repertoireId: REP, fenKey: 'X', children: [], updatedAt: base },
			{
				repertoireId: REP,
				fenKey: 'Y',
				children: [{ san: 'Nf3', uci: 'g1f3', toFenKey: 'Z', updatedAt: t2 }],
				updatedAt: t2
			},
			{ repertoireId: REP, fenKey: 'Z', children: [], updatedAt: t2 }
		];

		const db = await getDB();
		await db.put('repertoires', rep as never);

		// Build each device's outgoing core bundle from its own state.
		await setNodes(stateA);
		const bundleA = await buildRepCoreBundle(REP);
		await setNodes(stateB);
		const bundleB = await buildRepCoreBundle(REP);

		// Device B pulls A (DB currently holds B's state).
		await applyRepCoreBundleMerge(bundleA!);
		const snapB = await snapshotNodes();

		// Device A pulls B (reset DB to A's state first).
		await setNodes(stateA);
		await applyRepCoreBundleMerge(bundleB!);
		const snapA = await snapshotNodes();

		// Both devices land on the same tree: X gone (deletion won), Z kept
		// (B's add won), tombstone present on root.
		expect(snapA).toEqual(snapB);
		expect(snapA.map((n) => (n as { fenKey: string }).fenKey)).toEqual(['root', 'Y', 'Z']);
	});
});
