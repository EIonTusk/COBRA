#!/usr/bin/env node
/**
 * Generates Tauri's platform-specific app icons from `static/icon.svg`
 * (the same source used as the web favicon) so a fresh checkout can
 * `tauri dev` / `tauri android build` without the CI's icon job.
 *
 * Mirrors the steps from `.github/workflows/release.yml` (the `icons`
 * job): rasterise the SVG to a 1024×1024 PNG with rsvg-convert, then
 * hand it to `tauri icon` to fan out into all the per-platform sizes.
 *
 * Idempotent — skips work if `src-tauri/icons/source.png` already
 * matches the current SVG's mtime; pass `--force` to regenerate.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SVG = path.join(ROOT, 'static', 'icon.svg');
const ICON_DIR = path.join(ROOT, 'src-tauri', 'icons');
const SOURCE_PNG = path.join(ICON_DIR, 'source.png');
const ANDROID_GEN = path.join(ROOT, 'src-tauri', 'gen', 'android');
const IOS_GEN = path.join(ROOT, 'src-tauri', 'gen', 'apple');
const SENTINEL_FILES = ['32x32.png', '128x128.png', 'icon.icns', 'icon.ico'];

const force = process.argv.includes('--force');

function fail(msg) {
	console.error(`\n[prep-icons] ${msg}\n`);
	process.exit(1);
}

if (!existsSync(SVG)) fail(`Source SVG not found: ${SVG}`);

function mtime(p) {
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

const svgMtime = mtime(SVG);
const allPresent = SENTINEL_FILES.every((f) => existsSync(path.join(ICON_DIR, f)));
const sourceFresh = mtime(SOURCE_PNG) >= svgMtime;
// `tauri icon` writes mobile icons directly into gen/<platform>/ when
// those projects exist — so once init has run, we *must* re-run on every
// invocation to keep the launcher icons in sync. Skip the cache only
// when no mobile project has been generated yet.
const hasMobileGen = existsSync(ANDROID_GEN) || existsSync(IOS_GEN);
if (!force && allPresent && sourceFresh && !hasMobileGen) {
	console.log('[prep-icons] icons up to date — skipping (pass --force to regenerate)');
	process.exit(0);
}

mkdirSync(ICON_DIR, { recursive: true });

function run(cmd, args) {
	const r = spawnSync(cmd, args, { stdio: 'inherit' });
	if (r.error && r.error.code === 'ENOENT') {
		fail(
			`\`${cmd}\` not found on PATH. ` +
				(cmd === 'rsvg-convert'
					? 'Install librsvg (apt: librsvg2-bin, brew: librsvg).'
					: 'Make sure your dev tooling is set up.')
		);
	}
	if (r.status !== 0) fail(`\`${cmd} ${args.join(' ')}\` exited with status ${r.status}`);
}

console.log('[prep-icons] rasterising static/icon.svg → src-tauri/icons/source.png (1024×1024)');
run('rsvg-convert', ['-w', '1024', '-h', '1024', SVG, '-o', SOURCE_PNG]);

console.log('[prep-icons] generating platform icons via `tauri icon`');
run('npx', ['--yes', 'tauri', 'icon', SOURCE_PNG, '--output', ICON_DIR]);

console.log('[prep-icons] done — icons in src-tauri/icons/');
