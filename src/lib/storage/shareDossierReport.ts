/**
 * Style-report share codec.
 *
 * Analogous to the repertoire share flow: gzip the DossierScanResult and
 * base64url-encode it so the full payload fits in a URL fragment. The
 * recipient's /dossier/shared page decodes, previews, then (on explicit
 * confirmation) writes the report into their local IDB via
 * `saveDossierReport`, so every downstream page (the 21 subpage drill-downs
 * plus the main audit) reads it the same way a local report would.
 *
 * Size budget: a 50-game engine-analysed scan gzips to ~150–300 KB
 * base64. URL fragments happily carry that in modern browsers. For very
 * large scans we also expose file-based export so the recipient can
 * import from disk instead of a URL.
 */
import type { DossierScanResult } from '$lib/dossier/scan';
import { saveDossierReport } from './dossierReport';

export interface DossierShareBundle {
	version: 1;
	createdAt: number;
	report: DossierScanResult;
}

export function buildDossierShareBundle(report: DossierScanResult): DossierShareBundle {
	// Structured-clone the report so we don't accidentally serialise IDB
	// proxies or other non-plain objects.
	return {
		version: 1,
		createdAt: Date.now(),
		report: JSON.parse(JSON.stringify(report)) as DossierScanResult
	};
}

export async function encodeDossierShare(bundle: DossierShareBundle): Promise<string> {
	const json = JSON.stringify(bundle);
	const bytes = new TextEncoder().encode(json);
	const gz = await gzip(bytes);
	return bytesToBase64Url(gz);
}

export async function decodeDossierShare(encoded: string): Promise<DossierShareBundle> {
	const bytes = base64UrlToBytes(encoded);
	const raw = await gunzip(bytes);
	const json = new TextDecoder().decode(raw);
	const parsed = JSON.parse(json) as DossierShareBundle;
	if (parsed.version !== 1) throw new Error(`Unsupported dossier-share version: ${parsed.version}`);
	if (!parsed.report || typeof parsed.report !== 'object') {
		throw new Error('Share bundle is missing the report payload.');
	}
	return parsed;
}

/**
 * Write the shared report into the recipient's local storage. This will
 * overwrite any existing saved report — callers should confirm with the
 * user first.
 */
export async function adoptDossierShare(bundle: DossierShareBundle): Promise<void> {
	await saveDossierReport(bundle.report);
}

/** Approximate shared-link length (base64url chars). Useful for warnings. */
export async function estimateShareSize(
	report: DossierScanResult
): Promise<{ base64Chars: number; jsonBytes: number }> {
	const bundle = buildDossierShareBundle(report);
	const json = JSON.stringify(bundle);
	const bytes = new TextEncoder().encode(json);
	const gz = await gzip(bytes);
	const b64 = bytesToBase64Url(gz);
	return { base64Chars: b64.length, jsonBytes: bytes.length };
}

// --- Compression + base64url helpers (mirrors share.ts) ------------------

async function gzip(data: Uint8Array): Promise<Uint8Array> {
	const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'));
	const out = await new Response(stream).arrayBuffer();
	return new Uint8Array(out);
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
	const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
	const out = await new Response(stream).arrayBuffer();
	return new Uint8Array(out);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
	const pad = '='.repeat((4 - (s.length % 4)) % 4);
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
