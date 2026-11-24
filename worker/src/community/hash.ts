/**
 * 53-bit hash of an EPD fen key (cyrb53). Small enough to store as a SQLite
 * INTEGER and to round-trip exactly through a JS number. With a few million
 * indexed positions the chance of any collision stays around 1 in 10,000, and
 * a collision only merges two positions' community move counts.
 */
export function positionHash(fenKey: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < fenKey.length; i++) {
		const ch = fenKey.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
