#!/usr/bin/env node
// Writes src-tauri/gen/android/keystore.properties from env vars, using proper
// Java .properties escaping so special characters in passwords (notably `\`
// and leading whitespace) don't silently get mangled when Gradle parses the
// file. Plain `echo key=$PASSWORD` into a properties file is unsafe: a password
// like `foo\bar` is parsed as `foobar`, and the resulting keystore decryption
// failure shows up only much later, as an opaque `Given final block not
// properly padded` error from the Android signer.
//
// Required env:
//   ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
// Optional env:
//   COBRA_KEYSTORE_PATH        default: src-tauri/gen/android/release.keystore
//   COBRA_KEYSTORE_PROPERTIES  default: src-tauri/gen/android/keystore.properties

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const required = ['ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
for (const name of required) {
	if (!process.env[name]) {
		console.error(`[write-keystore-properties] missing env var: ${name}`);
		process.exit(1);
	}
}

const keystorePath = resolve(
	process.env.COBRA_KEYSTORE_PATH ?? 'src-tauri/gen/android/release.keystore'
);
const outputPath = resolve(
	process.env.COBRA_KEYSTORE_PROPERTIES ?? 'src-tauri/gen/android/keystore.properties'
);

// Java .properties value escaping. `\` is the escape character, leading
// whitespace is stripped unless escaped, and raw newlines terminate the logical
// line. `:` / `=` / `#` / `!` inside a value are fine — they only need escaping
// when they appear in a key.
//
// Critically, Properties.load(InputStream) decodes the file as ISO-8859-1, but
// Node's writeFileSync defaults to UTF-8. Any non-Latin-1 character in the
// password (umlauts, em-dashes, currency symbols, …) would round-trip wrong
// and surface as "Given final block not properly padded" during signing.
// Emit any non-printable-ASCII char as \uXXXX so the file is pure ASCII and
// what Java reads matches what we wrote. Surrogate pairs are emitted as two
// \uXXXX escapes — Java reassembles them as a single supplementary char.
function escapeValue(v) {
	let s = '';
	for (let i = 0; i < v.length; i++) {
		const c = v[i];
		const code = v.charCodeAt(i);
		if (c === '\\') s += '\\\\';
		else if (c === '\n') s += '\\n';
		else if (c === '\r') s += '\\r';
		else if (c === '\t') s += '\\t';
		else if (code < 0x20 || code > 0x7e) {
			s += '\\u' + code.toString(16).padStart(4, '0');
		} else {
			s += c;
		}
	}
	if (/^\s/.test(s)) s = '\\' + s;
	return s;
}

const props = {
	storeFile: keystorePath,
	storePassword: process.env.ANDROID_KEYSTORE_PASSWORD,
	keyAlias: process.env.ANDROID_KEY_ALIAS,
	keyPassword: process.env.ANDROID_KEY_PASSWORD
};

const contents =
	Object.entries(props)
		.map(([k, v]) => `${k}=${escapeValue(v)}`)
		.join('\n') + '\n';

writeFileSync(outputPath, contents, { mode: 0o600 });
console.log(`[write-keystore-properties] wrote ${outputPath}`);
