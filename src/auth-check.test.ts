import { describe, it, expect, afterEach } from "vitest";
import { checkAuth } from "./auth-check.js";
import type { AuthCheckResult } from "./auth-check.js";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";

/** Minimal AuthStorage stub — returns null unless a provider is explicitly seeded. */
function makeStorage(seeded: Record<string, object | null> = {}): AuthStorage {
	return {
		get: (provider: string) => seeded[provider] ?? null,
	} as AuthStorage;
}

/** Temporarily set env vars; restores them in the returned cleanup function. */
function withEnv(vars: Record<string, string>): () => void {
	const original: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		original[k] = process.env[k];
		process.env[k] = v;
	}
	return () => {
		for (const [k, v] of Object.entries(original)) {
			if (v === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = v;
			}
		}
	};
}

describe("checkAuth", () => {
	// Ensure env vars are always cleaned up between tests
	const restoreFns: Array<() => void> = [];
	afterEach(() => {
		for (const fn of restoreFns) fn();
		restoreFns.length = 0;
	});

	// ── Storage credentials ───────────────────────────────────────────

	describe("storage credentials", () => {
		it("returns hasAuth=false with empty storage and no env vars", () => {
			// Blank every env var that checkAuth reads — mirrors the full ENV_VAR_MAP
			const restore = withEnv({
				STORYOF_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_OAUTH_TOKEN: "",
				STORYOF_OPENAI_API_KEY: "", OPENAI_API_KEY: "",
				STORYOF_GEMINI_API_KEY: "", GEMINI_API_KEY: "",
				STORYOF_GROQ_API_KEY: "", GROQ_API_KEY: "",
				STORYOF_XAI_API_KEY: "", XAI_API_KEY: "",
				STORYOF_OPENROUTER_API_KEY: "", OPENROUTER_API_KEY: "",
				STORYOF_MISTRAL_API_KEY: "", MISTRAL_API_KEY: "",
				STORYOF_CEREBRAS_API_KEY: "", CEREBRAS_API_KEY: "",
				STORYOF_GITHUB_TOKEN: "", COPILOT_GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_TOKEN: "",
			});
			restoreFns.push(restore);

			const result = checkAuth(makeStorage());
			expect(result.hasAuth).toBe(false);
		});

		it("returns hasAuth=true for anthropic key in storage", () => {
			const result = checkAuth(makeStorage({ anthropic: { type: "api_key", key: "sk-test" } }));
			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("anthropic");
			expect(result.source).toBe("storage");
		});

		it("returns hasAuth=true for openai key in storage", () => {
			const result = checkAuth(makeStorage({ openai: { type: "api_key", key: "sk-openai" } }));
			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("openai");
			expect(result.source).toBe("storage");
		});

		it("returns the first provider found in storage", () => {
			// Anthropic is checked before openai in the provider list
			const storage = makeStorage({
				anthropic: { type: "api_key", key: "sk-ant" },
				openai: { type: "api_key", key: "sk-oai" },
			});
			const result = checkAuth(storage);
			expect(result.provider).toBe("anthropic");
		});
	});

	// ── Environment variable credentials ─────────────────────────────

	describe("environment variable credentials", () => {
		it("detects STORYOF_ANTHROPIC_API_KEY", () => {
			const restore = withEnv({ STORYOF_ANTHROPIC_API_KEY: "sk-storyof-test" });
			restoreFns.push(restore);

			const result = checkAuth(makeStorage());
			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("anthropic");
			expect(result.source).toBe("env");
		});

		it("detects fallback ANTHROPIC_API_KEY", () => {
			const restore = withEnv({
				STORYOF_ANTHROPIC_API_KEY: "",
				ANTHROPIC_API_KEY: "sk-ant-fallback",
			});
			restoreFns.push(restore);

			const result = checkAuth(makeStorage());
			expect(result.hasAuth).toBe(true);
			expect(result.source).toBe("env");
		});

		it("prefers STORYOF_ prefix over standard env var", () => {
			const restore = withEnv({
				STORYOF_ANTHROPIC_API_KEY: "sk-storyof",
				ANTHROPIC_API_KEY: "sk-standard",
			});
			restoreFns.push(restore);

			// Both are set — STORYOF_ is checked first and wins
			const result = checkAuth(makeStorage());
			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("anthropic");
			expect(result.source).toBe("env");
		});

		it("detects ANTHROPIC_OAUTH_TOKEN as fallback", () => {
			const restore = withEnv({
				STORYOF_ANTHROPIC_API_KEY: "",
				ANTHROPIC_API_KEY: "",
				ANTHROPIC_OAUTH_TOKEN: "oauth-token-value",
			});
			restoreFns.push(restore);

			const result = checkAuth(makeStorage());
			expect(result.hasAuth).toBe(true);
			expect(result.source).toBe("env");
		});

		it("storage credentials take priority over env vars", () => {
			// Even if env var has openai, storage has anthropic — anthropic wins
			// (storage is checked first in checkAuth)
			const restore = withEnv({ OPENAI_API_KEY: "sk-openai-env" });
			restoreFns.push(restore);

			const result = checkAuth(makeStorage({ anthropic: { type: "api_key", key: "sk-ant" } }));
			expect(result.source).toBe("storage");
			expect(result.provider).toBe("anthropic");
		});

		it("falls back to env vars when storage is empty", () => {
			const restore = withEnv({
				STORYOF_ANTHROPIC_API_KEY: "",
				ANTHROPIC_API_KEY: "",
				STORYOF_OPENAI_API_KEY: "sk-openai-storyof",
			});
			restoreFns.push(restore);

			const result = checkAuth(makeStorage());
			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("openai");
			expect(result.source).toBe("env");
		});
	});
});
