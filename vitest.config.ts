import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		retry: process.env.CI ? 2 : 0,
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: [
				"node_modules/**",
				"dist/**",
				"**/*.test.ts",
				"**/*.spec.ts",
				"tests/**",
				"vitest.config.ts",
			],
		},
		include: ["src/**/*.{test,spec}.ts", "tests/integration/**/*.{test,spec}.ts"],
		exclude: ["tests/browser/**"],
		testTimeout: 10000,
	},
});
