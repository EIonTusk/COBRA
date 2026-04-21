import { getDB } from './db';
import { getSettings, saveSettings, defaultSettings } from './settings';
import type { AppSettings, Card, IdeaCard, Repertoire, RepertoireNode } from '$lib/types';

export interface LibraryExport {
	version: 1 | 2;
	exportedAt: number;
	repertoires: Repertoire[];
	nodes: RepertoireNode[];
	cards: Card[];
	/** Optional for backwards-compat with v1 exports. */
	ideaCards?: IdeaCard[];
	settings: AppSettings | null;
}

export async function exportAll(): Promise<LibraryExport> {
	const db = await getDB();
	const [repertoires, nodes, cards, ideaCards] = await Promise.all([
		db.getAll('repertoires'),
		db.getAll('nodes'),
		db.getAll('cards'),
		db.getAll('idea_cards')
	]);
	const settings = await getSettings();
	return {
		version: 2,
		exportedAt: Date.now(),
		repertoires,
		nodes,
		cards,
		ideaCards,
		settings
	};
}

function validateExport(data: LibraryExport): void {
	if (!data || (data.version !== 1 && data.version !== 2)) {
		throw new Error('Unsupported library export version.');
	}
	if (
		!Array.isArray(data.repertoires) ||
		!Array.isArray(data.nodes) ||
		!Array.isArray(data.cards)
	) {
		throw new Error('Library export is missing required arrays.');
	}
	if (data.ideaCards !== undefined && !Array.isArray(data.ideaCards)) {
		throw new Error('Library export has a malformed ideaCards field.');
	}
}

export async function importAll(
	data: LibraryExport,
	opts: { includeSettings?: boolean } = {}
): Promise<void> {
	// Validate up front so we never start destroying data on the basis of a
	// bad file. Any thrown error here leaves the user's existing library
	// untouched.
	validateExport(data);

	// Do the wipe + re-populate inside a single IDB transaction so the
	// import is atomic: either the user's library ends up fully replaced,
	// or — if any put fails — IDB rolls the transaction back and the old
	// data is still there. The previous implementation wiped in one
	// transaction and repopulated in another, so a failure midway through
	// the second transaction left the user with an empty library.
	const db = await getDB();
	const tx = db.transaction(['repertoires', 'nodes', 'cards', 'idea_cards'], 'readwrite');
	await tx.objectStore('repertoires').clear();
	await tx.objectStore('nodes').clear();
	await tx.objectStore('cards').clear();
	await tx.objectStore('idea_cards').clear();
	for (const r of data.repertoires) await tx.objectStore('repertoires').put(r);
	for (const n of data.nodes) await tx.objectStore('nodes').put(n);
	for (const c of data.cards) await tx.objectStore('cards').put(c);
	if (Array.isArray(data.ideaCards)) {
		for (const ic of data.ideaCards) await tx.objectStore('idea_cards').put(ic);
	}
	await tx.done;

	if (opts.includeSettings && data.settings) {
		await saveSettings({ ...defaultSettings(), ...data.settings, key: 'root' });
	}
}
