/**
 * Parse Lichess `[%eval X]` annotations out of a PGN string.
 *
 * When the games API is called with `evals=true`, Lichess inlines an eval
 * comment for every ply whose position Fishnet has analysed — e.g.
 *
 *     1. e4 { [%eval 0.34] [%clk 0:01:00] } e5 { [%eval 0.31] } ...
 *
 * The eval is given in pawns (positive = White is better) or as `#N`
 * meaning mate in N plies (positive = White mates, negative = Black).
 * The starting position has no tag — so for a user playing White, the
 * eval "before" their very first move is unavailable and callers should
 * fall back to `cp = 0` or drop the move.
 *
 * This module is intentionally standalone: it does not walk the full PGN
 * AST via chessops. We only need a linear, ply-indexed list of evals, and
 * the game-stream endpoint always emits move text in standard SAN order,
 * so a regex sweep is faster and has no dependency on chessops internals.
 */

export interface PlyEval {
	/** Centipawns from White's perspective. Present unless mate. */
	cp?: number;
	/** Mate-in-N from White's perspective. Positive = White mates; negative = Black mates. */
	mate?: number;
}

/**
 * Return an array indexed by ply (0 = after White's 1st move, 1 = after
 * Black's 1st, …). Entries are `null` when the ply has no `[%eval]` tag
 * (either because the game isn't fully analysed, or it's a variant with
 * partial coverage). The array length equals the number of mainline
 * moves the regex sees.
 */
export function parseEvalComments(pgn: string): Array<PlyEval | null> {
	// Grab only the movetext body — headers can contain braces in tag
	// values that would confuse the brace scanner. PGN separates the two
	// by a blank line, so everything after the first blank line.
	const bodyStart = findMovetextStart(pgn);
	const body = pgn.slice(bodyStart);

	const out: Array<PlyEval | null> = [];
	// Cursor walks the body left-to-right. At each step we look for the
	// next move token (SAN-ish) and any comment braces that follow it
	// *before* the next move token. Evals attached after a move apply to
	// the position AFTER that ply, which is Lichess's convention.
	let i = 0;
	while (i < body.length) {
		const moveStart = nextMoveToken(body, i);
		if (moveStart == null) break;
		// Consume the SAN itself (read through the first whitespace or
		// brace). We don't actually need the SAN value, just the end index.
		let j = moveStart;
		while (j < body.length && !isWhitespace(body[j]) && body[j] !== '{' && body[j] !== '(') {
			j += 1;
		}
		// Look ahead for the first `{...}` block attached to this ply,
		// stopping if we hit another move token first.
		let evalForPly: PlyEval | null = null;
		let k = j;
		while (k < body.length) {
			const ch = body[k];
			if (ch === '{') {
				const end = body.indexOf('}', k + 1);
				if (end === -1) break;
				const comment = body.slice(k + 1, end);
				evalForPly = extractEvalFromComment(comment) ?? evalForPly;
				k = end + 1;
				continue;
			}
			if (ch === '(') {
				// Skip variations — we track mainline only.
				k = skipVariation(body, k);
				continue;
			}
			if (isWhitespace(ch)) {
				k += 1;
				continue;
			}
			// Non-whitespace non-comment = start of the next move token.
			break;
		}
		out.push(evalForPly);
		i = k;
	}
	return out;
}

/**
 * Extract the first `[%eval …]` expression from a PGN comment. Returns
 * null if none is present or the value can't be parsed.
 */
function extractEvalFromComment(comment: string): PlyEval | null {
	const m = comment.match(/\[%eval\s+([^\]]+)\]/);
	if (!m) return null;
	const raw = m[1].trim();
	if (raw.startsWith('#')) {
		// Mate. `#3` or `#-2`.
		const n = Number(raw.slice(1));
		if (!Number.isFinite(n)) return null;
		return { mate: n };
	}
	const pawns = Number(raw);
	if (!Number.isFinite(pawns)) return null;
	return { cp: Math.round(pawns * 100) };
}

function findMovetextStart(pgn: string): number {
	// Headers end at the first blank line. If there are no headers, start
	// at zero.
	let i = 0;
	while (i < pgn.length) {
		if (pgn[i] === '[') {
			// Walk to end of this header line.
			while (i < pgn.length && pgn[i] !== '\n') i += 1;
			i += 1;
			// If next line is blank, movetext starts after it.
			if (pgn[i] === '\r') i += 1;
			if (pgn[i] === '\n') return i + 1;
			continue;
		}
		return i;
	}
	return i;
}

function nextMoveToken(body: string, from: number): number | null {
	let i = from;
	while (i < body.length) {
		const ch = body[i];
		if (isWhitespace(ch) || ch === '.' || ch === '{' || ch === '(' || ch === ')') {
			i += 1;
			continue;
		}
		// Move numbers look like `1.` or `24...`. Skip digits-then-dots.
		if (ch >= '0' && ch <= '9') {
			let j = i;
			while (j < body.length && body[j] >= '0' && body[j] <= '9') j += 1;
			if (j < body.length && body[j] === '.') {
				while (j < body.length && body[j] === '.') j += 1;
				i = j;
				continue;
			}
			// A standalone numeric token — probably the game result "1-0",
			// "0-1", "1/2-1/2", or "*". Any of these end the movetext.
			return null;
		}
		if (ch === '*') return null;
		// Looks like the start of SAN.
		return i;
	}
	return null;
}

function skipVariation(body: string, openParenIdx: number): number {
	let depth = 1;
	let i = openParenIdx + 1;
	while (i < body.length && depth > 0) {
		const ch = body[i];
		if (ch === '(') depth += 1;
		else if (ch === ')') depth -= 1;
		else if (ch === '{') {
			const end = body.indexOf('}', i + 1);
			if (end === -1) return body.length;
			i = end;
		}
		i += 1;
	}
	return i;
}

function isWhitespace(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}
