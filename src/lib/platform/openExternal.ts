/**
 * Open an http(s)/mailto URL in the user's preferred browser/mail client.
 *
 * In a Tauri-packaged build (desktop or mobile) the WebView is sandboxed —
 * `<a target="_blank">` either nukes the app session by navigating away or
 * spawns an in-app webview that has none of the user's saved passwords or
 * cookies. The opener plugin hands the URL to the OS so it lands in the
 * user's actual browser.
 *
 * On the regular web build there's no plugin available; fall back to a
 * conventional `window.open` which the browser already handles correctly.
 */
import { isTauri } from '@tauri-apps/api/core';

export async function openExternal(url: string): Promise<void> {
	if (isTauri()) {
		// Dynamic import keeps the plugin code out of the web bundle.
		const { openUrl } = await import('@tauri-apps/plugin-opener');
		await openUrl(url);
		return;
	}
	if (typeof window !== 'undefined') {
		window.open(url, '_blank', 'noopener,noreferrer');
	}
}

/**
 * Returns true if `href` should be routed through `openExternal`. We only
 * intercept absolute http(s) links to a different origin — internal SPA
 * routes, hash anchors, and non-web schemes are left alone.
 */
export function isExternalHttpUrl(href: string): boolean {
	if (typeof window === 'undefined') return false;
	let url: URL;
	try {
		url = new URL(href, window.location.href);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	return url.origin !== window.location.origin;
}
