// Integration test for the tier-split rep bundles (issue #68): a repertoire
// syncs as two independently-revisioned scopes — `rep-core` (authored tree)
// and `rep-telemetry` (derived scan data). Runs against a real IndexedDB via
// fake-indexeddb so it exercises the actual store reads/writes.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDB } from '$lib/storage/db';
import {
	applyRepCoreBundleMerge,
	applyRepTelemetryBundleMerge,
	buildRepCoreBundle,
	buildRepTelemetryBundle,
	decodeBundle,
	encodeBundle
} from './bundle';

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
});
