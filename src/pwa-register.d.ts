// Module declaration for vite-plugin-pwa's virtual register module. The
// upstream type ships in `vite-plugin-pwa/svelte.d.ts`, but the package's
// `exports` map does not expose it through TS's standard resolution
// (`/// <reference types="vite-plugin-pwa/svelte" />` does not pick it
// up). Inlining the shape here keeps UpdateBanner.svelte's dynamic
// import type-safe without depending on resolution quirks.

declare module 'virtual:pwa-register/svelte' {
	import type { Writable } from 'svelte/store';

	type RegisterSWOptions = {
		immediate?: boolean;
		onNeedRefresh?: () => void;
		onOfflineReady?: () => void;
		onRegistered?: (reg: ServiceWorkerRegistration | undefined) => void;
		onRegisteredSW?: (swScriptUrl: string, reg: ServiceWorkerRegistration | undefined) => void;
		onRegisterError?: (error: unknown) => void;
	};

	export function useRegisterSW(options?: RegisterSWOptions): {
		needRefresh: Writable<boolean>;
		offlineReady: Writable<boolean>;
		updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
	};
}
