# Why threaded Stockfish doesn't run inside the Tauri Android WebView

Captured 2026-05-05 after a long debugging session. Goal: don't repeat
the same investigation when this comes up again.

## Symptom

On a packaged Android build (Tauri 2.11 / wry 0.55 / tao 0.35), opening
any page that initialises the engine surfaces:

```
StockfishUnavailable: SharedArrayBuffer unavailable — check COOP/COEP headers.
```

Diagnostic overlay (`__cobraDiag`) shows:

```
trace: coi=false sab=false origin=https://tauri.localhost
trace: headers: COOP=same-origin COEP=credentialless CORP=cross-origin
```

i.e. the headers _do_ reach the WebView; `crossOriginIsolated` is still
`false`.

## Why — the requirement chain

`lila-stockfish-web` runs the search in multiple Web Workers that
co-ordinate through a single `SharedArrayBuffer` (the transposition
table, search state, etc). Without SAB the module won't even
instantiate.

Browsers gate `SharedArrayBuffer` on **cross-origin isolation**, which
needs both:

1. The document sends `Cross-Origin-Opener-Policy: same-origin` +
   `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`).
2. The browser places the document in its **own OS process**,
   isolated from any other origin's memory. That's the
   `window.crossOriginIsolated === true` half.

Both must hold. We control (1); we don't control (2).

## The Android WebView constraint

Android System WebView is **single-process by design** — every
`WebView` in the app shares one renderer process to keep the embedded-
component footprint small. The WebView _physically cannot_ isolate
origins into separate OS processes, so `crossOriginIsolated` is
permanently `false` regardless of the headers the page sends. SAB
stays `undefined`. Threaded Stockfish never starts.

Same story on iOS WKWebView for the same reasons.

References:

- web.dev: "Cross-origin isolation guide" notes the WebView limitation.
- Chrome blog: "SharedArrayBuffer updates in Android Chrome 88" —
  COI gating, applies to System WebView identically.

## What we tried before landing here

All of these are committed on `debug/android-diagnostics`:

| Attempt                                                                      | Outcome                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set `app.security.headers` in `tauri.conf.json`                              | Headers _do_ reach the response (verified via in-app `fetch().then(r => r.headers...)`); doesn't help.                                                                                                          |
| `app.windows[0].useHttpsScheme = true`                                       | Switched origin to `https://tauri.localhost`. Doesn't help — single-process is the gate, not scheme.                                                                                                            |
| Patch `RustWebViewClient.kt` to add headers in the `WebViewAssetLoader` path | Aborted — that file doesn't exist in `src-tauri/gen/android/` after `tauri android init` (wry's `build.rs` writes it into a hashed cargo `target/` dir at gradle build time, post-init scripts can't reach it). |

## Realistic fix paths

Ranked by effort / risk:

1. **Single-threaded engine fallback in JS** — detect
   `typeof SharedArrayBuffer === 'undefined'` in
   `src/lib/stockfish/engine.ts` and lazy-load a non-threaded build
   (e.g. nmrugg's `stockfish` npm package, which ships a single-thread
   WASM variant that doesn't need SAB). ~½ the strength at the same
   thinking time, but the feature surface stays intact. **No platform
   work, no Rust work.** Recommended starting point.

2. **Native Stockfish via Tauri sidecar** — cross-compile the upstream
   Stockfish CLI for `aarch64-linux-android`, ship as a
   `tauri.bundle.resources` sidecar, expose UCI over a Tauri command,
   replace `Engine` with a Rust-side adapter. Native speed, no
   WebView involvement. 1–2 days of work; needs CMake in CI.

3. **Disable engine on Android** — feature-detect SAB, hide drill /
   dossier / analysis pages on the Android build, keep library /
   walkthrough / Lichess-server-eval mistake review usable. Keeps the
   APK shippable as a "lite" version while we decide between (1) and
   (2).

## Where this matters in the codebase

- `src/lib/stockfish/engine.ts` — `Engine.init()` is the gate. Logs
  `coi / sab / origin` to the diagnostic overlay before throwing
  `StockfishUnavailable`. Any single-thread fallback hooks in here.
- `src/routes/+layout.svelte` — once-per-session diagnostic effect
  logs the same triple plus a header probe. Useful when re-validating
  after a Tauri / wry version bump.
- `src-tauri/tauri.conf.json` — `app.security.headers` and
  `app.windows[0].useHttpsScheme` both still in place. They're harmless
  (and benefit desktop Tauri) — leave them. Just don't expect them to
  flip COI on Android.
- `scripts/patch-android-mainactivity.mjs` — separate fix for the
  `onNewIntent` panic. Keep — that one is real and load-bearing.

## Don't waste time on

- Fiddling with `app.security.headers` values on Android.
- Switching between `require-corp` and `credentialless`.
- `useHttpsScheme: true` vs `false` — not the lever.
- Patching `RustWebViewClient.kt` post-init — the file isn't there.
- Bumping wry / tao patch versions hoping for a fix — single-process
  is intentional WebView design, not a bug.

## Adjacent (different) issue: same toast on the GH-Pages mobile-browser deploy

You can also see `Engine unavailable: SharedArrayBuffer unavailable —
check COOP/COEP headers` on the **regular web build** when you open
the GH Pages site in mobile Chrome / Samsung Internet, even though it
works fine in desktop Chrome. **The toast itself only fires once per
session — it has `dedupKey: 'engine-init'` — so "I only see it once"
doesn't mean the issue is intermittent; the engine is broken every
time.**

This is **not** the Android-WebView constraint (the GH-Pages deploy
has no Tauri WebView in the picture). The first hypothesis to rule out
is a service-worker race — the SW that grafts COOP/COEP onto
responses only controls _subsequent_ page loads, and the bootstrap
script in `src/routes/+layout.svelte` does one `location.reload()`
once the SW activates. If a manual reload makes it work, that was the
race. If not, the SW isn't actually serving with the headers — most
likely candidates:

- The SW didn't register (private/incognito, in-app browser, content
  blocker, Samsung Internet lifecycle quirks).
- The SW registered but the browser is serving the document from
  HTTP cache without going through the SW (some mobile browsers do
  this on cold starts).
- Mobile Chrome variant honors the SW headers for assets but not for
  the navigation request that determines `crossOriginIsolated` — in
  which case the document origin never qualifies as isolated even
  though the headers arrive.

**Diagnose by inspecting the overlay, not by guessing.** The
overlay's `headers:` line is dispositive:

- `headers: COOP=same-origin COEP=credentialless ...` _and_
  `coi=false` → headers reach the document but the browser refuses
  isolation (mobile browser variant; would need a different deploy).
- `headers: COOP=null COEP=null` _and_ `coi=false` → SW is _not_ in
  the response chain (race, registration failure, or HTTP cache).

**Realistic fixes, ranked:**

1. **Block engine init until SAB is exposed.** In
   `src/lib/stockfish/engine.ts`, when `SharedArrayBuffer` is
   undefined and a SW is registered, wait on
   `navigator.serviceWorker.ready` before throwing — give the SW one
   chance to take over (with a timeout cap so we don't hang on
   private mode). Cheapest fix, addresses the race without changing
   infrastructure.
2. **Move to a host that can set headers directly** — Cloudflare
   Pages reads `static/_headers` natively, removing the SW from the
   COOP/COEP path entirely. The repo already has the `_headers` file
   sitting there from an earlier deploy; just point the workflow at
   Cloudflare. This also fixes the in-app browser / private-mode
   variants where the SW never activates.
3. **Tighten the bootstrap reload script** — keep retrying if
   `controller` stays null after `ready` resolves. Fragile, but
   contains the bug to its current footprint.

This case is **not** in the Tauri-Android scope — packaged Android
builds don't have a SW (we disabled it in `vite.config.ts` because
`*.localhost` rejects SW registration anyway). The two failures look
identical to the user but have different roots.
