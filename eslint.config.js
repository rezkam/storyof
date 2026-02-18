// @ts-check
import tseslint from "typescript-eslint";
import vitestPlugin from "eslint-plugin-vitest";

export default tseslint.config(
	// ── Source + test files: type-aware floating-promise detection ────────────
	{
		files: ["src/**/*.ts", "tests/**/*.ts"],
		extends: [tseslint.configs.base],
		languageOptions: {
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
		},
	},
	// ── Source files only: no stray console.log (warn/error allowed for legit logging) ──
	{
		files: ["src/**/*.ts"],
		ignores: ["src/**/*.test.ts"],
		rules: {
			"no-console": ["error", { allow: ["warn", "error"] }],
		},
	},
	// ── Test files: vitest-specific rules + console allowed ───────────────────
	{
		files: ["src/**/*.test.ts", "tests/**/*.ts"],
		plugins: {
			vitest: vitestPlugin,
		},
		rules: {
			// Catches tests that have no expect() calls (compile-time requireAssertions)
			"vitest/expect-expect": "error",
			// Prevents .only from being committed
			"vitest/no-focused-tests": "error",
			// Catches duplicate test names
			"vitest/no-identical-title": "error",
			// console is fine in tests
			"no-console": "off",
		},
	},
);
