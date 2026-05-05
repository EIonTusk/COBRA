#!/usr/bin/env node
/**
 * Copies Stockfish browser engines into static/stockfish/ and downloads the
 * NNUE net the threaded build needs from the Stockfish test server.
 * Idempotent — skips files already present.
 *
 * Two engines side by side:
 *
 *   * `sf16-7.js` + `sf16-7.wasm` (lila-stockfish-web, threaded) — the
 *     fast path. Needs SharedArrayBuffer / cross-origin isolation to
 *     load. Used on Chrome desktop, Tauri desktop, and the GH Pages
 *     web build under Chrome (where the SW grafts on COOP/COEP).
 *
 *   * `stockfish-18-lite-single.js` + `stockfish-18-lite-single.wasm`
 *     (nmrugg/stockfish.js, single-threaded) — the floor. Runs in any
 *     browser without COI: Tauri Android (single-process WebView),
 *     Firefox Android (no Fission for COI), in-app browsers, etc.
 *     ~½ the strength of the threaded build at the same depth, but
 *     keeps engine-dependent features alive on those platforms. NNUE
 *     is embedded in the .wasm — no separate net file to download.
 */
import { cp, mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const ROOT = process.cwd();
const LILA_SRC = path.join(ROOT, 'node_modules', 'lila-stockfish-web');
const NMRUGG_SRC = path.join(ROOT, 'node_modules', 'stockfish', 'bin');
const DST = path.join(ROOT, 'static', 'stockfish');

// sf16-7 is the Stockfish 16 Linrock build with a single NNUE (nn-ecb35f70ff2a.nnue).
// It's smaller and simpler than sf171-79's dual-net configuration.
const THREADED_FILES = ['sf16-7.js', 'sf16-7.wasm'];
const NNUE_FILE = 'nn-ecb35f70ff2a.nnue';
const NNUE_URL = `https://tests.stockfishchess.org/api/nn/${NNUE_FILE}`;
const SINGLE_THREAD_FILES = ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm'];

async function exists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

await mkdir(DST, { recursive: true });

async function copyFrom(srcDir, files, label) {
	for (const f of files) {
		const src = path.join(srcDir, f);
		const dst = path.join(DST, f);
		if (!(await exists(src))) {
			console.error(`missing: ${src} — is ${label} installed?`);
			process.exit(1);
		}
		await cp(src, dst);
		console.log(`copied ${f}`);
	}
}

await copyFrom(LILA_SRC, THREADED_FILES, 'lila-stockfish-web');
await copyFrom(NMRUGG_SRC, SINGLE_THREAD_FILES, 'stockfish (nmrugg)');

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
