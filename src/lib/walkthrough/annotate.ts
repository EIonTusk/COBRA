import { colorToMove } from '$lib/chess/fen';
import { disabledLineFenKeys } from '$lib/tree/traversal';
import { liveMoves } from '$lib/tree/liveMoves';
import type { Color, RepertoireNode } from '$lib/types';

/**
 * How a game ply relates to the selected repertoire:
 * - `match`: a live prepared move;
 * - `deviation`: off-book where the repertoire has a live move (`expectedSan`);
 * - `disabled`: a move the user disabled, or any of their moves inside a
 *   disabled line (issues #99, #108) — saved prep, not active prep;
 * - `past-tree`: no prepared move here;
 * - `opponent`: the other side's move.
 */
export type Annotation = 'match' | 'deviation' | 'disabled' | 'past-tree' | 'opponent';

export interface AnnotatedPly {
	annotation: Annotation;
	expectedSan?: string;
}

/**
 * Grade every ply of a game against a repertoire. Only live (non-disabled)
 * moves count as the repertoire: a position reached only through a disabled
 * move is still in the tree but not in play, so its moves read as `disabled`
 * rather than `match`.
 */
export function annotatePlies(
	plies: Array<{ san: string; fenKeyBefore: string }>,
	rep: { color: Color; rootFenKey: string; nodes: Map<string, RepertoireNode> } | null
): AnnotatedPly[] {
	const shelved = rep ? disabledLineFenKeys(rep.nodes, rep.rootFenKey) : new Set<string>();
	return plies.map((p) => {
		if (!rep || colorToMove(p.fenKeyBefore) !== rep.color) return { annotation: 'opponent' };
		const node = rep.nodes.get(p.fenKeyBefore);
		if (!node || node.children.length === 0) return { annotation: 'past-tree' };
		if (shelved.has(p.fenKeyBefore)) return { annotation: 'disabled' };
		const active = liveMoves(node);
		if (active.some((e) => e.san === p.san)) return { annotation: 'match', expectedSan: p.san };
		const expectedSan = active[0]?.san;
		if (node.children.some((e) => e.disabled && e.san === p.san)) {
			return { annotation: 'disabled', expectedSan };
		}
		if (!expectedSan) return { annotation: 'past-tree' };
		return { annotation: 'deviation', expectedSan };
	});
}
