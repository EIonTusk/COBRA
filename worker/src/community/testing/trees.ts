/** Build CommunityTreeV1 fixtures from SAN lines, the way the app would. */
import { Chess } from 'chessops/chess';
import { makeFen, parseFen } from 'chessops/fen';
import { parseSan } from 'chessops/san';
import { makeUci } from 'chessops/util';
import type { CommunityNode, CommunityTreeV1 } from '../types';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function keyOf(pos: Chess): string {
	return makeFen(pos.toSetup(), { epd: true });
}

export function treeFromLines(
	color: 'white' | 'black',
	lines: string[],
	opts: { rootFen?: string; comments?: Record<string, string> } = {}
): CommunityTreeV1 {
	const rootFen = opts.rootFen ?? START_FEN;
	const root = Chess.fromSetup(parseFen(rootFen).unwrap()).unwrap();
	const nodes = new Map<string, CommunityNode>();
	const ensure = (k: string) => {
		let n = nodes.get(k);
		if (!n) {
			n = { fenKey: k, children: [] };
			nodes.set(k, n);
		}
		return n;
	};
	ensure(keyOf(root));
	for (const line of lines) {
		const pos = root.clone();
		for (const san of line.split(/\s+/).filter(Boolean)) {
			const from = keyOf(pos);
			const move = parseSan(pos, san);
			if (!move) throw new Error(`bad ${san} in ${line}`);
			pos.play(move);
			const to = keyOf(pos);
			const node = ensure(from);
			if (!node.children.some((e) => e.toFenKey === to)) {
				node.children.push({ san, uci: makeUci(move), toFenKey: to });
			}
			ensure(to);
			const c = opts.comments?.[san];
			if (c) nodes.get(to)!.comment = c;
		}
	}
	return { version: 1, color, rootFen, nodes: [...nodes.values()], ideaCards: [] };
}

/** Position key after playing `sans` from the start. */
export function keyAfter(sans: string): string {
	const pos = Chess.default();
	for (const san of sans.split(/\s+/).filter(Boolean)) pos.play(parseSan(pos, san)!);
	return keyOf(pos);
}
