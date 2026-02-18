import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: false, // explicit imports required — all test files already import from "vitest"
		restoreMocks: true, // restore all vi.spyOn/vi.fn after each test automatically
		clearMocks: true, // clear call counts/instances after each test automatically
		expect: {
			requireAssertions: true, // prevent zero-assertion tests from silently passing
		},
		// Coverage applies across all projects
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			// Thresholds set ~5% below measured baseline (63%/58%/57%/63%).
			// Raise incrementally as coverage improves.
			thresholds: {
				statements: 58,
				branches: 53,
				functions: 52,
				lines: 58,
			},
			exclude: [
				"node_modules/**",
				"dist/**",
				"**/*.test.ts",
				"**/*.spec.ts",
				"tests/**",
				"vitest.config.ts",
			],
		},
		// Browser/E2E tests are Playwright — excluded from Vitest
		exclude: ["tests/browser/**", "tests/e2e/**"],
		projects: [
			{
				// Unit tests: fast, parallel, node environment
				test: {
					name: "unit",
					include: ["src/**/*.{test,spec}.ts", "tests/unit/**/*.{test,spec}.ts"],
					environment: "node",
					testTimeout: 10000,
					retry: process.env.CI ? 2 : 0,
				},
			},
			{
				// Integration tests: real HTTP servers, serial execution, longer timeout
				// fileParallelism: false ensures tests run one file at a time (Vitest 4+)
				test: {
					name: "integration",
					include: ["tests/integration/**/*.{test,spec}.ts"],
					environment: "node",
					testTimeout: 20000,
					retry: process.env.CI ? 1 : 0,
					fileParallelism: false,
				},
			},
		],
	},
});
