import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { isSafeReturnPath } from './oauth';

// `isSafeReturnPath` is the same-origin gate that protects the OAuth
// callback from open-redirect / scheme-confusion attacks via a poisoned
// `?return=` query param. Worth pinning down with a test fixture so the
// rejection list doesn't drift.
describe('isSafeReturnPath', () => {
	beforeEach(() => {
		vi.stubGlobal('window', { location: { origin: 'https://app.example' } });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('accepts a plain same-origin path', () => {
		expect(isSafeReturnPath('/repertoire/abc/edit')).toBe(true);
	});

	it('accepts a path with query and hash', () => {
		expect(isSafeReturnPath('/repertoire/abc/edit?prep=walk&gapIdx=0#x')).toBe(true);
	});

	it('rejects a protocol-relative URL (//evil)', () => {
		expect(isSafeReturnPath('//evil.example/x')).toBe(false);
	});

	it('rejects a backslash-prefixed escape (/\\evil)', () => {
		// Some browsers normalise the backslash to `/`, turning this into
		// the protocol-relative form above.
		expect(isSafeReturnPath('/\\evil.example/x')).toBe(false);
	});

	it('rejects an absolute URL with a different origin', () => {
		expect(isSafeReturnPath('https://evil.example/x')).toBe(false);
	});

	it('rejects an absolute URL even when it matches origin', () => {
		// Strictly path-only, never absolute — matches the contract callers
		// rely on (they always store path/search/hash, never origin).
		expect(isSafeReturnPath('https://app.example/repertoire/abc/edit')).toBe(false);
	});

	it('rejects javascript: URIs', () => {
		expect(isSafeReturnPath('javascript:alert(1)')).toBe(false);
	});

	it('rejects bare relative paths (no leading slash)', () => {
		expect(isSafeReturnPath('repertoire/abc/edit')).toBe(false);
	});

	it('rejects empty / non-string input', () => {
		expect(isSafeReturnPath('')).toBe(false);
		expect(isSafeReturnPath(null)).toBe(false);
		expect(isSafeReturnPath(undefined)).toBe(false);
		expect(isSafeReturnPath(42)).toBe(false);
	});
});
