/**
 * Share-a-repertoire URL codec.
 *
 * Encodes a single repertoire (metadata + every node + move cards +
 * idea cards) into a compressed base64 payload suitable for a URL
 * fragment. The receiving side decodes the fragment and imports the
 * rep under a fresh UUID so multiple shares don't collide.
 *
 * No server round-trip — the entire blob rides along in the `#data=…`
 * fragment. Fits easily for typical repertoires; a 2000-node tree
 * compresses to ~20 KB base64.
 */
import { createEmptyCard } from 'ts-fsrs';
import { getDB } from './db';
import { listCards } from './cards';
import { listIdeaCards } from './ideaCards';
import { listNodes } from './nodes';
import { getRepertoire } from './repertoires';
import { fenKeyFromFen } from '$lib/chess/fen';
import type { Card, IdeaCard, Repertoire, RepertoireNode } from '$lib/types';

export interface ShareBundle {
	version: 1;
	repertoire: Repertoire;
	nodes: RepertoireNode[];
	cards: Card[];
	ideaCards: IdeaCard[];
}

export async function buildShareBundle(repertoireId: string): Promise<ShareBundle | null> {
	const rep = await getRepertoire(repertoireId);
	if (!rep) return null;
	const [nodes, cards, ideaCards] = await Promise.all([
		listNodes(repertoireId),
		listCards(repertoireId),
		listIdeaCards(repertoireId)
	]);
	return {
		version: 1,
		repertoire: JSON.parse(JSON.stringify(rep)) as Repertoire,
		nodes: JSON.parse(JSON.stringify(nodes)) as RepertoireNode[],
		cards: JSON.parse(JSON.stringify(cards)) as Card[],
		ideaCards: JSON.parse(JSON.stringify(ideaCards)) as IdeaCard[]
	};
}

export async function encodeShare(bundle: ShareBundle): Promise<string> {
	const json = JSON.stringify(bundle);
	const bytes = new TextEncoder().encode(json);
	const gz = await gzip(bytes);
	return bytesToBase64Url(gz);
}

export async function decodeShare(encoded: string): Promise<ShareBundle> {
	const bytes = base64UrlToBytes(encoded);
	const raw = await gunzip(bytes);
	const json = new TextDecoder().decode(raw);
	const parsed = JSON.parse(json) as ShareBundle;
	if (parsed.version !== 1) throw new Error(`Unsupported share version: ${parsed.version}`);
	return parsed;
}

/**
 * Import a decoded bundle as a brand-new repertoire. Remaps the rep id
 * (and every nodes/cards row's `repertoireId`) so an import never
 * overwrites an existing local rep. FSRS state on cards is reset: a
 * re-shared tree is new material to the recipient, not prepared prep.
 */
export async function importShareBundle(bundle: ShareBundle): Promise<Repertoire> {
	const newId = crypto.randomUUID();
	const now = Date.now();
	const rep: Repertoire = {
		...bundle.repertoire,
		id: newId,
		createdAt: now,
		updatedAt: now,
		coverageSnapshot: null
	};
	// Defensive: regenerate rootFenKey so we don't inherit a malformed
	// one from an older version of the encoder.
	try {
		rep.rootFenKey = fenKeyFromFen(rep.rootFen);
	} catch {
		/* fall back to whatever was in the bundle */
	}
	const db = await getDB();
	const tx = db.transaction(['repertoires', 'nodes', 'cards', 'idea_cards'], 'readwrite');
	await tx.objectStore('repertoires').put(rep);
	for (const n of bundle.nodes) {
		await tx.objectStore('nodes').put({ ...n, repertoireId: newId });
	}
	for (const c of bundle.cards) {
		await tx.objectStore('cards').put({
			...c,
			repertoireId: newId,
			fsrs: createEmptyCard(new Date(now)),
			dueAt: now,
			lastReview: undefined
		});
	}
	for (const ic of bundle.ideaCards) {
		await tx.objectStore('idea_cards').put({
			...ic,
			repertoireId: newId,
			fsrs: createEmptyCard(new Date(now)),
			dueAt: now,
			lastReview: undefined
		});
	}
	await tx.done;
	return rep;
}

// --- Compression + base64url helpers -------------------------------------

async function gzip(data: Uint8Array): Promise<Uint8Array> {
	const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'));
	const out = await new Response(stream).arrayBuffer();
	return new Uint8Array(out);
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
	const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
	const out = await new Response(stream).arrayBuffer();
	return new Uint8Array(out);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
	const pad = '='.repeat((4 - (s.length % 4)) % 4);
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
