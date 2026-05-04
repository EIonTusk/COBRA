#!/usr/bin/env node
// Patches the auto-generated RustWebViewClient.kt so every asset response
// served by Android's built-in WebViewAssetLoader carries the COOP/COEP/CORP
// headers needed for `crossOriginIsolated`.
//
// Why: on Android, wry's RustWebViewClient.shouldInterceptRequest takes
// one of two paths:
//
//   if (Rust.withAssetLoader(view.id)) {
//     assetLoader.shouldInterceptRequest(...)   ← Android's WebViewAssetLoader
//                                                  — ignores Tauri config.
//   } else {
//     Rust.handleRequest(...)                   ← Tauri protocol handler that
//                                                  applies app.security.headers.
//   }
//
// A production Tauri Android build always takes the WebViewAssetLoader path
// for SvelteKit assets, so `tauri.conf.json`'s `app.security.headers` never
// reaches the WebView. `crossOriginIsolated` stays false, `SharedArrayBuffer`
// is undefined, and threaded Stockfish refuses to load
// (`StockfishUnavailable: SharedArrayBuffer unavailable — check COOP/COEP
// headers.`).
//
// We graft the headers onto the response post-hoc, keeping the
// WebViewAssetLoader fast-path intact:
//
//   val response = assetLoader.shouldInterceptRequest(request.url)
//   if (response != null) {
//     val headers = response.responseHeaders?.toMutableMap() ?: mutableMapOf()
//     headers["Cross-Origin-Opener-Policy"] = "same-origin"
//     headers["Cross-Origin-Embedder-Policy"] = "credentialless"
//     headers["Cross-Origin-Resource-Policy"] = "cross-origin"
//     response.responseHeaders = headers
//   }
//   response
//
// Idempotent via a marker comment.
//
// Usage: node scripts/patch-android-isolation-headers.mjs
//   Optionally set COBRA_ANDROID_WVCLIENT to override the path.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const defaultPath =
	'src-tauri/gen/android/app/src/main/java/io/github/eiontusk/cobra/RustWebViewClient.kt';
const filePath = resolve(process.env.COBRA_ANDROID_WVCLIENT ?? defaultPath);

if (!existsSync(filePath)) {
	console.error(`[patch-android-isolation-headers] not found: ${filePath}`);
	process.exit(1);
}

const marker = '// cobra:isolation-headers';
const original = readFileSync(filePath, 'utf8');

if (original.includes(marker)) {
	console.log('[patch-android-isolation-headers] already patched, skipping');
	process.exit(0);
}

// Replace the bare WebViewAssetLoader call with a wrapping block. Match the
// exact line as wry-v0.55 emits it; bail if the template diverges so we don't
// silently produce a broken file.
const needle = 'assetLoader.shouldInterceptRequest(request.url)';
const replacement = `run {
            ${marker} — see scripts/patch-android-isolation-headers.mjs
            val response = assetLoader.shouldInterceptRequest(request.url)
            if (response != null) {
                val headers = response.responseHeaders?.toMutableMap() ?: mutableMapOf()
                headers["Cross-Origin-Opener-Policy"] = "same-origin"
                headers["Cross-Origin-Embedder-Policy"] = "credentialless"
                headers["Cross-Origin-Resource-Policy"] = "cross-origin"
                response.responseHeaders = headers
            }
            response
        }`;

if (!original.includes(needle)) {
	console.error(
		`[patch-android-isolation-headers] couldn't find expected line "${needle}". Has the wry template changed?`
	);
	process.exit(1);
}

const patched = original.replace(needle, replacement);
writeFileSync(filePath, patched);
console.log(`[patch-android-isolation-headers] patched ${filePath}`);
