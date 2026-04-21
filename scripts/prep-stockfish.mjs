#!/usr/bin/env node
/**
 * Copies lila-stockfish-web WASM + JS into static/stockfish/ and downloads the
 * recommended NNUE net from the Stockfish test server. Idempotent — skips
 * files already present.
 */
import { cp, mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'node_modules', 'lila-stockfish-web');
const DST = path.join(ROOT, 'static', 'stockfish');

// sf16-7 is the Stockfish 16 Linrock build with a single NNUE (nn-ecb35f70ff2a.nnue).
// It's smaller and simpler than sf171-79's dual-net configuration.
const ENGINE_FILES = ['sf16-7.js', 'sf16-7.wasm'];
const NNUE_FILE = 'nn-ecb35f70ff2a.nnue';
const NNUE_URL = `https://tests.stockfishchess.org/api/nn/${NNUE_FILE}`;

async function exists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

await mkdir(DST, { recursive: true });

for (const f of ENGINE_FILES) {
	const src = path.join(SRC, f);
	const dst = path.join(DST, f);
	if (!(await exists(src))) {
		console.error(`missing: ${src} — is lila-stockfish-web installed?`);
		process.exit(1);
	}
	await cp(src, dst);
	console.log(`copied ${f}`);
}

const nnueDst = path.join(DST, NNUE_FILE);
if (await exists(nnueDst)) {
	console.log(`nnue present: ${NNUE_FILE}`);
} else {
	console.log(`downloading ${NNUE_URL}`);
	const res = await fetch(NNUE_URL);
	if (!res.ok || !res.body) {
		console.error(`download failed: HTTP ${res.status}`);
		process.exit(1);
	}
	await pipeline(Readable.fromWeb(res.body), createWriteStream(nnueDst));
	console.log(`downloaded ${NNUE_FILE}`);
}

console.log('stockfish assets ready at static/stockfish/');
