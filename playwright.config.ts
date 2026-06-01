import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: { command: 'npm run build && npm run preview', port: 4173 },
	testMatch: '**/*.e2e.{ts,js}',
	// `--no-sandbox` lets Chromium launch as root inside the Playwright CI
	// container; `--disable-dev-shm-usage` avoids the small /dev/shm in
	// containers. Both are harmless for local non-container runs.
	use: { launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] } }
});
