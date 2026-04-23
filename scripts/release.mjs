#!/usr/bin/env node
// Bump version across package.json / tauri.conf.json / Cargo.toml, commit, tag, push.
// Usage: npm run release -- <version> [--skip-checks]
//   --skip-checks  bypass the pre-commit hook (for CI where gates already ran)

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const skipChecks = args.includes('--skip-checks');
const version = args.find((a) => !a.startsWith('--'));

if (!version) {
	console.error('Usage: npm run release -- <version> [--skip-checks]');
	process.exit(1);
}
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
	console.error(`"${version}" is not a valid semver (MAJOR.MINOR.PATCH[-pre]).`);
	process.exit(1);
}

function sh(cmd, opts = {}) {
	return execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}
function shOut(cmd) {
	return execSync(cmd, { cwd: root }).toString().trim();
}

// Refuse if working tree is dirty (except for the three files we're about to touch).
const dirty = shOut('git status --porcelain')
	.split('\n')
	.filter(Boolean)
	.filter((line) => {
		const path = line.slice(3);
		return (
			path !== 'package.json' &&
			path !== 'src-tauri/tauri.conf.json' &&
			path !== 'src-tauri/Cargo.toml'
		);
	});
if (dirty.length) {
	console.error('Working tree has uncommitted changes. Commit or stash them first:');
	for (const line of dirty) console.error('  ' + line);
	process.exit(1);
}

// Refuse if the tag already exists (local or remote).
const tag = `v${version}`;
try {
	execSync(`git rev-parse ${tag}`, { cwd: root, stdio: 'ignore' });
	console.error(`Tag ${tag} already exists locally.`);
	process.exit(1);
} catch {
	/* good — doesn't exist */
}

// --- Bump versions ---

function bumpJson(path, version) {
	const abs = resolve(root, path);
	const text = readFileSync(abs, 'utf8');
	const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
	if (updated === text) {
		console.error(`Did not find a "version" field in ${path}.`);
		process.exit(1);
	}
	writeFileSync(abs, updated);
}

function bumpCargo(path, version) {
	const abs = resolve(root, path);
	const text = readFileSync(abs, 'utf8');
	// Only replace the first `version = "..."` in the [package] section.
	const updated = text.replace(/^(\s*version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
	if (updated === text) {
		console.error(`Did not find a version in ${path}.`);
		process.exit(1);
	}
	writeFileSync(abs, updated);
}

bumpJson('package.json', version);
bumpJson('src-tauri/tauri.conf.json', version);
bumpCargo('src-tauri/Cargo.toml', version);

// --- Verify + commit + tag + push ---

sh('node scripts/check-versions.mjs');
sh('git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml');
sh(`git commit ${skipChecks ? '--no-verify ' : ''}-m "release ${version}"`);
sh(`git tag -a ${tag} -m "release ${version}"`);
sh('git push origin HEAD');
sh(`git push origin ${tag}`);

console.log(`\nReleased ${tag}. CI will build desktop / mobile / web artifacts.`);
