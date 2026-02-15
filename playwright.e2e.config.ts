/**
 * Playwright config for real E2E tests.
 *
 * These tests spawn the actual CLI, call real LLM APIs, and drive a real browser.
 * They are SLOW (minutes per test) and require API keys.
 *
 * Run: npx playwright test --config playwright.e2e.config.ts
 * Or:  npm run test:e2e
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "tests/e2e",
	timeout: 10 * 60 * 1000, // 10 minutes per test (agent exploration takes time)
	expect: {
		timeout: 30_000, // 30s for assertions
	},
	use: {
		browserName: "chromium",
		headless: true,
		viewport: { width: 1280, height: 800 },
	},
	workers: 1, // Serial — one test at a time
	retries: 0, // No retries — flaky = broken
	reporter: [["list"]],
});
