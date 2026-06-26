// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

declare global {
	/** Build-time default Cloudflare sync backend URL (Vite define); '' when unset. */
	const __COBRA_SYNC_URL__: string;

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
