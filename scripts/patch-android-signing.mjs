#!/usr/bin/env node
// Patches src-tauri/gen/android/app/build.gradle.kts to add a release
// signingConfig that reads from keystore.properties at the Android project
// root. `tauri android init` produces a template with no release signing
// config, which makes the release APK ship as `app-*-release-unsigned.apk` —
// Android refuses to install unsigned APKs with a vague "invalid" error.
//
// Idempotent: a marker comment is inserted so re-runs are no-ops.
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

const header = `import java.io.FileInputStream
import java.util.Properties

${marker}
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        load(FileInputStream(keystorePropertiesFile))
    }
}

`;

const signingBlock = `    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
            }
        }
    }

`;

gradle = header + gradle;

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
