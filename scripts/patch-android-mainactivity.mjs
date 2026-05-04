#!/usr/bin/env node
// Patches the auto-generated MainActivity.kt to override `onNewIntent`
// with a version that skips tao's broken JNI handler.
//
// Why: tao 0.35.x's `handle_intent` (src/platform_impl/android/ndk_glue.rs)
// calls `env.get_string(intent_type).unwrap()` after retrieving the intent's
// MIME type via `Intent.getType()`. For custom-scheme VIEW intents — exactly
// what Chrome / Samsung Internet send for deep-links like
// `io.github.eiontusk.cobra://auth/lichess/callback?...` — getType() returns
// `null`, the unwrap panics, and because we're across a JNI boundary it's
// `panic_cannot_unwind` → SIGABRT. The whole app dies the moment the OAuth
// callback intent arrives.
//
// The deep-link plugin (`DeepLinkPlugin.kt`) has its own independent
// onNewIntent handler dispatched via `PluginManager.onNewIntent(intent)` —
// that path doesn't touch tao at all and reads `intent.data` safely. So
// the workaround is to override `MainActivity.onNewIntent` to:
//   1. NOT call `super.onNewIntent(intent)` (which goes through
//      TauriActivity → WryActivity → Rust.onNewIntent → tao panic).
//   2. Call `setIntent(newIntent)` ourselves, which is the only thing
//      `Activity.onNewIntent` does in the Android base class.
//   3. Call `PluginManager.onNewIntent(intent)` so the deep-link plugin
//      still receives the URL.
//
// Idempotent: a marker comment guards re-runs.
//
// Usage: node scripts/patch-android-mainactivity.mjs
//   Optionally set COBRA_ANDROID_MAINACTIVITY to override the path.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const defaultPath =
	'src-tauri/gen/android/app/src/main/java/io/github/eiontusk/cobra/MainActivity.kt';
const filePath = resolve(process.env.COBRA_ANDROID_MAINACTIVITY ?? defaultPath);

if (!existsSync(filePath)) {
	console.error(`[patch-android-mainactivity] not found: ${filePath}`);
	process.exit(1);
}

const marker = '// cobra:onNewIntent-tao-panic-workaround';
const original = readFileSync(filePath, 'utf8');

if (original.includes(marker)) {
	console.log('[patch-android-mainactivity] already patched, skipping');
	process.exit(0);
}

// Pull the package line verbatim so the patched file matches Tauri's
// case-escaped package path. The template emits something like
// `package io.github.eiontusk.cobra` — keep it identical.
const packageMatch = original.match(/^package\s+([^\s\n]+)/m);
if (!packageMatch) {
	console.error("[patch-android-mainactivity] couldn't locate `package` line");
	process.exit(1);
}

const patched = `package ${packageMatch[1]}

${marker} — see scripts/patch-android-mainactivity.mjs for the why.

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import app.tauri.plugin.PluginManager

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Workaround for tao 0.35.x panic in Java_..._Rust_onNewIntent on
  // custom-scheme VIEW intents (null getType()). We replicate what the
  // TauriActivity override does, minus the super.onNewIntent chain that
  // routes through wry → tao and SIGABRTs.
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    PluginManager.onNewIntent(intent)
  }
}
`;

writeFileSync(filePath, patched);
console.log(`[patch-android-mainactivity] patched ${filePath}`);
