#!/usr/bin/env node
// Patches src-tauri/gen/android/app/build.gradle.kts to add a release
// signingConfig that reads from keystore.properties at the Android project
// root. The Tauri template (as of @tauri-apps/cli 2.10.x) exposes no release
// signing, so the APK otherwise ships as `app-*-release-unsigned.apk` and
// Android refuses to install it.
//
// The template already starts with `import java.util.Properties`, so we must
// NOT prepend anything above those imports — Kotlin requires every `import`
// to precede all declarations. Instead, we insert the keystore `val` block
// between the imports and the first declaration (`plugins { … }`).
//
// Idempotent: a marker comment guards re-runs.
//
// Usage: node scripts/patch-android-signing.mjs
//   Optionally set COBRA_ANDROID_GRADLE to override the path.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const gradlePath = resolve(
	process.env.COBRA_ANDROID_GRADLE ?? 'src-tauri/gen/android/app/build.gradle.kts'
);

if (!existsSync(gradlePath)) {
	console.error(`[patch-android-signing] not found: ${gradlePath}`);
	process.exit(1);
}

const marker = '// cobra:release-signing';
let gradle = readFileSync(gradlePath, 'utf8');

if (gradle.includes(marker)) {
	console.log('[patch-android-signing] already patched, skipping');
	process.exit(0);
}

// Locate the end of the import header: walk from the top, tracking the last
// `import` line. Stop at the first line that is neither an import nor blank.
const lines = gradle.split('\n');
let lastImportIdx = -1;
for (let i = 0; i < lines.length; i++) {
	if (/^import\s+/.test(lines[i])) {
		lastImportIdx = i;
	} else if (lines[i].trim() !== '') {
		break;
	}
}
if (lastImportIdx < 0) {
	console.error('[patch-android-signing] no import header found; unexpected template shape');
	process.exit(1);
}

// Absorb any trailing blank lines between the import header and the first
// declaration so we can emit our own clean separator.
let firstDeclIdx = lastImportIdx + 1;
while (firstDeclIdx < lines.length && lines[firstDeclIdx].trim() === '') {
	firstDeclIdx++;
}

const valBlock = [
	'',
	marker,
	'val keystorePropertiesFile = rootProject.file("keystore.properties")',
	'val keystoreProperties = Properties().apply {',
	'    if (keystorePropertiesFile.exists()) {',
	'        keystorePropertiesFile.inputStream().use { load(it) }',
	'    }',
	'}',
	''
];
lines.splice(lastImportIdx + 1, firstDeclIdx - (lastImportIdx + 1), ...valBlock);
gradle = lines.join('\n');

// PKCS12 keystores (default in modern keytool, JDK 18+) use a single
// password for both the store and the individual key entries; supplying
// a different `keypass` on creation is silently coerced to the store
// password. So Gradle's `KeyStore.getKey(alias, keyPass)` only works
// when keyPass equals storePass for those keystores. JKS keystores can
// in theory have a different keypass per entry, but the common case
// (and what we ship CI for) is a single password.
//
// Use storePassword for keyPassword unconditionally. This eliminates a
// common, opaque foot-gun: keytool's `-importkeystore -srckeypass:env X`
// probe accepts a wrong X for PKCS12 (it falls back to srcstorepass), so
// a divergent ANDROID_KEY_PASSWORD secret slips past the "Verify
// keystore credentials" CI step and only surfaces during signing as
// "Given final block not properly padded" from Gradle. JKS users with a
// genuine separate keypass can fork the script — that's a rare enough
// case to not be worth a config knob.
const signingBlock = `    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                keyAlias = keystoreProperties["keyAlias"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyPassword = keystoreProperties["storePassword"] as String
            }
        }
    }

`;

const androidBlock = gradle.match(/android\s*\{\s*\n/);
if (!androidBlock) {
	console.error('[patch-android-signing] could not find `android {` block');
	process.exit(1);
}
gradle = gradle.replace(/android\s*\{\s*\n/, `${androidBlock[0]}${signingBlock}`);

const releaseRegex = /getByName\("release"\)\s*\{([\s\S]*?)\n([ \t]*)\}/;
const releaseMatch = gradle.match(releaseRegex);
if (!releaseMatch) {
	console.error('[patch-android-signing] could not find release buildType');
	process.exit(1);
}

const releaseBody = releaseMatch[1];
const closingIndent = releaseMatch[2];
const innerIndent = closingIndent + '    ';
const signingAssignment = `signingConfig = signingConfigs.getByName(if (keystorePropertiesFile.exists()) "release" else "debug")`;

let newReleaseBody;
if (/signingConfig\s*=/.test(releaseBody)) {
	newReleaseBody = releaseBody.replace(
		/signingConfig\s*=\s*signingConfigs\.getByName\([^)]+\)/,
		signingAssignment
	);
} else {
	newReleaseBody = `${releaseBody.replace(/\s*$/, '')}\n${innerIndent}${signingAssignment}\n`;
}

const bodyWithNewline = newReleaseBody.endsWith('\n') ? newReleaseBody : `${newReleaseBody}\n`;
gradle = gradle.replace(releaseRegex, `getByName("release") {${bodyWithNewline}${closingIndent}}`);

writeFileSync(gradlePath, gradle);
console.log(`[patch-android-signing] patched ${gradlePath}`);
