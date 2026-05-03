/**
 * Map ECO codes to coarse opening families. The ECO range alone (A/B/C/D/E
 * letter + 2 digits) is enough to bucket games into named families that
 * mean something to a human — "Sicilian" vs "Caro-Kann" vs "Queen's Gambit"
 * vs "King's Indian" — without needing to recognise every sub-line.
 *
 * Source: standard ECO classification (Chess Informant). Ranges are
 * intentionally coarse so a 100-game sample doesn't fragment across 30
 * obscure variations.
 */

export type OpeningFamily =
	| 'Flank (A00-A09)'
	| 'English'
	| "Queen's Pawn (1.d4 unsorted)"
	| 'Trompowsky / 1.d4 Nf6 sidelines'
	| 'Benoni / Benko'
	| 'Dutch'
	| 'Uncommon 1.e4'
	| 'Scandinavian'
	| 'Alekhine'
	| 'Pirc / Modern'
	| 'Caro-Kann'
	| 'Sicilian'
	| 'French'
	| "1.e4 e5 sidelines / King's Gambit"
	| 'Petroff / Scotch / Four Knights'
	| 'Italian / Two Knights'
	| 'Spanish (Ruy Lopez)'
	| '1.d4 d5 sidelines'
	| 'Slav'
	| "Queen's Gambit"
	| 'Grünfeld'
	| 'Catalan'
	| "Bogo / Queen's Indian"
	| 'Nimzo-Indian'
	| "King's Indian"
	| 'Unknown';

/**
 * Which side *chooses* to enter this family — i.e., whose opening choice
 * defines it. The Caro-Kann only appears when Black plays 1...c6; the
 * Spanish only when White plays 3.Bb5. Knowing the chooser lets the UI
 * say "you faced the Caro-Kann (as White)" instead of the meaningless
 * "Caro-Kann as White".
 *
 * 'either' marks buckets that genuinely mix both sides' opening choices
 * (e.g. the 1.d4 d5 sidelines catch-all) — the UI falls back to a
 * neutral "as {color}" label there.
 */
export function familyChooser(family: OpeningFamily): 'white' | 'black' | 'either' {
	switch (family) {
		case 'Flank (A00-A09)':
		case 'English':
		case "Queen's Pawn (1.d4 unsorted)":
		case 'Trompowsky / 1.d4 Nf6 sidelines':
		case 'Uncommon 1.e4':
		case 'Spanish (Ruy Lopez)':
		case 'Catalan':
			return 'white';
		case 'Benoni / Benko':
		case 'Dutch':
		case 'Scandinavian':
		case 'Alekhine':
		case 'Pirc / Modern':
		case 'Caro-Kann':
		case 'Sicilian':
		case 'French':
		case 'Slav':
		case 'Grünfeld':
		case "Bogo / Queen's Indian":
		case 'Nimzo-Indian':
		case "King's Indian":
			return 'black';
		case "1.e4 e5 sidelines / King's Gambit":
		case 'Petroff / Scotch / Four Knights':
		case 'Italian / Two Knights':
		case '1.d4 d5 sidelines':
		case "Queen's Gambit":
		case 'Unknown':
			return 'either';
	}
}

/**
 * Derive the chooser side directly from a parsed PGN family-name
 * (e.g. `"Caro-Kann Defense"`, `"Queen's Gambit Declined"`, `"Ruy
 * Lopez"`). This is more reliable than `familyChooser(ecoFamily(eco))`
 * because:
 *  1. The ECO fallback loses distinctions — QGA/QGD both map to the
 *     coarse "Queen's Gambit" bucket, whose chooser is 'either'.
 *  2. Games without an ECO header can't be resolved at all.
 *
 * Order of precedence: hardcoded name lists, then suffix/keyword
 * heuristics, then the ECO fallback. Used by openingProfile.ts to
 * decide whether a row is "Played" or "Faced".
 */
export function chooserForOpeningName(
	familyName: string,
	eco: string | null | undefined
): 'white' | 'black' | 'either' {
	const name = familyName.toLowerCase();
	if (!name) return familyChooser(ecoFamily(eco));

	// Hardcoded black-side families (most-specific match first).
	const blackNames = [
		'caro-kann',
		'sicilian',
		'french defense',
		'french defence',
		'scandinavian',
		'alekhine',
		'pirc',
		'modern defense',
		'modern defence',
		'nimzovich defense',
		'slav',
		'semi-slav',
		'grünfeld',
		'grunfeld',
		"king's indian defense",
		"king's indian defence",
		"queen's indian",
		'nimzo-indian',
		'bogo-indian',
		'old indian',
		'budapest',
		'englund',
		'albin',
		'dutch defense',
		'dutch defence',
		'benoni',
		'benko',
		"petrov's defense",
		"petrov's defence",
		'petroff',
		'russian game',
		'philidor'
	];
	for (const p of blackNames) if (name.includes(p)) return 'black';

	// Hardcoded white-side families.
	const whiteNames = [
		'english opening',
		'ruy lopez',
		'spanish',
		'catalan',
		'london system',
		'colle',
		'trompowsky',
		'torre attack',
		'bird',
		'réti',
		'reti opening',
		'larsen',
		'nimzowitsch-larsen',
		'sokolsky',
		'van geet',
		'zukertort',
		'polish opening',
		"king's gambit",
		'italian game',
		'giuoco',
		'evans gambit',
		'scotch game',
		'four knights',
		'vienna game',
		'danish gambit',
		'center game',
		'ponziani',
		"king's indian attack"
	];
	for (const p of whiteNames) if (name.includes(p)) return 'white';

	// Suffix / keyword heuristics — suffixes like "Declined", "Accepted",
	// "Defense" always signal Black's choice; "Attack" / "System" /
	// "Opening" (standalone) signal White's.
	if (/\bdeclined\b/.test(name)) return 'black';
	if (/\baccepted\b/.test(name)) return 'black';
	if (/\bdefen[sc]e\b/.test(name)) return 'black';
	if (/\bcounter\s?gambit\b/.test(name)) return 'black';
	if (/\battack\b/.test(name)) return 'white';
	if (/\bsystem\b/.test(name)) return 'white';

	// Fallback — coarse ECO-derived chooser.
	return familyChooser(ecoFamily(eco));
}

/**
 * Split a PGN `[Opening]` tag into family root + full "Family: Main
 * variation" label. Lichess / chess.com both populate this header with
 * their canonical naming (e.g. `"Sicilian Defense: Najdorf Variation,
 * English Attack"`), which is our ground truth for distinguishing
 * QGA/QGD/Slav etc. — finer than `ecoFamily()`, which collapses all of
 * D20-D69 into a single "Queen's Gambit" bucket.
 *
 * The family root is everything before the first `:` — the primary
 * grouping key, so all Najdorf sub-lines stay together under "Sicilian
 * Defense". The label keeps the main variation (before the first comma
 * of the post-colon segment) so callers can break a row down by its
 * top variations. When the header is missing we fall back to the
 * coarse ECO family and no variation. The fallback is a string so the
 * return type is uniform across both code paths.
 */
export function parseOpeningName(
	openingName: string | null | undefined,
	eco: string | null | undefined
): { family: string; label: string } {
	if (openingName && openingName.trim().length > 0) {
		const name = openingName.trim();
		const colonIdx = name.indexOf(':');
		if (colonIdx < 0) return { family: name, label: name };
		const family = name.slice(0, colonIdx).trim();
		const detail = name.slice(colonIdx + 1).trim();
		const mainVariation = detail.split(',')[0].trim();
		return {
			family,
			label: mainVariation ? `${family}: ${mainVariation}` : family
		};
	}
	const coarse = ecoFamily(eco);
	return { family: coarse, label: coarse };
}

/** Map ECO code to family. Returns 'Unknown' for missing/malformed input. */
export function ecoFamily(eco: string | null | undefined): OpeningFamily {
	if (!eco) return 'Unknown';
	const m = eco
		.trim()
		.toUpperCase()
		.match(/^([A-E])(\d{2})$/);
	if (!m) return 'Unknown';
	const letter = m[1];
	const num = Number(m[2]);

	switch (letter) {
		case 'A':
			if (num <= 9) return 'Flank (A00-A09)';
			if (num <= 39) return 'English';
			if (num <= 44) return "Queen's Pawn (1.d4 unsorted)";
			if (num <= 49) return 'Trompowsky / 1.d4 Nf6 sidelines';
			if (num <= 79) return 'Benoni / Benko';
			return 'Dutch'; // A80-A99
		case 'B':
			if (num === 0) return 'Uncommon 1.e4';
			if (num === 1) return 'Scandinavian';
			if (num <= 5) return 'Alekhine';
			if (num <= 9) return 'Pirc / Modern';
			if (num <= 19) return 'Caro-Kann';
			return 'Sicilian'; // B20-B99
		case 'C':
			if (num <= 19) return 'French';
			if (num <= 39) return "1.e4 e5 sidelines / King's Gambit";
			if (num <= 49) return 'Petroff / Scotch / Four Knights';
			if (num <= 59) return 'Italian / Two Knights';
			return 'Spanish (Ruy Lopez)'; // C60-C99
		case 'D':
			if (num <= 5) return '1.d4 d5 sidelines';
			if (num <= 19) return 'Slav';
			if (num <= 69) return "Queen's Gambit";
			return 'Grünfeld'; // D70-D99
		case 'E':
			if (num <= 9) return 'Catalan';
			if (num <= 19) return "Bogo / Queen's Indian";
			if (num <= 59) return 'Nimzo-Indian';
			return "King's Indian"; // E60-E99
	}
	return 'Unknown';
}
