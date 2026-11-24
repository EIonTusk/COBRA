/**
 * Opening names for the positions of a published tree, from the bundled
 * lichess chess-openings table (see openings.data.ts). Naming every position,
 * not just the root, lets a search for "Najdorf" find a 1.e4 repertoire that
 * contains the Najdorf.
 */
import { OPENINGS_TSV } from './openings.data';
import type { CommunityTreeV1 } from './types';

let table: Map<string, [string, string]> | null = null;

function openingsTable(): Map<string, [string, string]> {
	if (!table) {
		table = new Map();
		for (const line of OPENINGS_TSV.split('\n')) {
			const [key, eco, name] = line.split('\t');
			if (key && eco && name) table.set(key, [eco, name]);
		}
	}
	return table;
}

export function openingAt(fenKey: string): [string, string] | null {
	return openingsTable().get(fenKey) ?? null;
}

/**
 * Distinct [eco, name] pairs the tree reaches, in breadth-first order from the
 * root (so the broadest names come first), capped to keep rows small.
 */
export function treeOpenings(tree: CommunityTreeV1, max = 60): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	const seen = new Set<string>();
	for (const n of tree.nodes) {
		const o = openingAt(n.fenKey);
		if (!o) continue;
		const id = `${o[0]}|${o[1]}`;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(o);
		if (out.length >= max) break;
	}
	return out;
}
