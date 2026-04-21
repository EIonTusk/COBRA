#!/usr/bin/env node
// Verifies that the version strings in package.json, src-tauri/tauri.conf.json,
// and src-tauri/Cargo.toml all match. Exits non-zero on mismatch.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const tauri = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;

const cargoText = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
const cargoMatch = cargoText.match(/^\s*version\s*=\s*"([^"]+)"/m);
const cargo = cargoMatch ? cargoMatch[1] : null;

const entries = { 'package.json': pkg, 'tauri.conf.json': tauri, 'Cargo.toml': cargo };
const distinct = new Set(Object.values(entries));

if (distinct.size !== 1 || !cargo) {
	console.error('Version mismatch:');
	for (const [k, v] of Object.entries(entries)) console.error(`  ${k}: ${v}`);
	process.exit(1);
}

console.log(`All versions aligned at ${pkg}`);
