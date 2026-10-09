import type { Edge, RepertoireNode } from '$lib/types';

/**
 * A position's prepared moves that are in play: every child edge that isn't
 * soft-disabled (issues #80, #91). The answer at a user-to-move position is
 * any of these.
 */
export function liveMoves(node: RepertoireNode | undefined): Edge[] {
	return node ? node.children.filter((e) => !e.disabled) : [];
}

/**
 * The move a trainer expects at a position whose card was created for
 * `cardSan` (issue #102). A card keeps the SAN of the first move saved at its
 * position, so when that move is disabled and another prepared move isn't,
 * the live one is the answer. `cardSan` wins while it's live; otherwise the
 * first live move; `null` when every prepared move here is disabled. A
 * position with no saved moves at all keeps `cardSan`.
 */
export function answerSan(node: RepertoireNode | undefined, cardSan: string): string | null {
	if (!node || node.children.length === 0) return cardSan;
	const live = liveMoves(node);
	if (live.some((e) => e.san === cardSan)) return cardSan;
	return live[0]?.san ?? null;
}

/**
 * Live moves with the card's answer first, so a hint arrow or a "the move was"
 * line shows the move the card is about.
 */
export function liveMovesAnswerFirst(node: RepertoireNode | undefined, cardSan: string): Edge[] {
	const live = liveMoves(node);
	const answer = answerSan(node, cardSan);
	return [...live.filter((e) => e.san === answer), ...live.filter((e) => e.san !== answer)];
}
