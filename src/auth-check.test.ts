import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkAuth } from "./auth-check.js";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";

/**
 * Unit tests for auth-check — pure logic, no filesystem, no network.
 *
 * These tests manipulate process.env in-memory for env var detection tests.
 * The original env is saved in beforeEach and restored in afterEach so
 * nothing leaks between tests or into the real environment.
 */
describe("checkAuth", () => {
	let mockStorage: AuthStorage;
	let savedEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		// Snapshot the real environment so we can restore it
		savedEnv = { ...process.env };

		// Wipe all keys that checkAuth looks for so tests start clean
		for (const key of Object.keys(process.env)) {
			if (
				key.startsWith("STORYOF_") ||
				key === "ANTHROPIC_API_KEY" ||
				key === "ANTHROPIC_OAUTH_TOKEN" ||
				key === "OPENAI_API_KEY" ||
				key === "GEMINI_API_KEY" ||
				key === "GROQ_API_KEY" ||
				key === "XAI_API_KEY" ||
				key === "OPENROUTER_API_KEY" ||
				key === "MISTRAL_API_KEY" ||
				key === "CEREBRAS_API_KEY" ||
				key === "COPILOT_GITHUB_TOKEN" ||
				key === "GH_TOKEN" ||
				key === "GITHUB_TOKEN"
			) {
				delete process.env[key];
			}
		}

		// Mock storage — returns nothing by default
		mockStorage = {
			get: vi.fn().mockReturnValue(undefined),
			set: vi.fn(),
			remove: vi.fn(),
			login: vi.fn(),
			setFallbackResolver: vi.fn(),
		} as unknown as AuthStorage;
	});

	afterEach(() => {
		// Restore the real environment exactly
		process.env = savedEnv;
		// vi.clearAllMocks() removed — handled globally by vitest clearMocks + restoreMocks config
	});

	describe("storage credentials", () => {
		it("detects API key in storage", () => {
			vi.mocked(mockStorage.get).mockImplementation((provider) =>
				provider === "anthropic" ? { type: "api_key", key: "sk-ant-xxx" } : undefined,
			);

			const result = checkAuth(mockStorage);

			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("anthropic");
			expect(result.source).toBe("storage");
		});

		it("returns first provider found", () => {
			vi.mocked(mockStorage.get).mockImplementation((provider) =>
				provider === "openai" ? { type: "api_key", key: "sk-xxx" } : undefined,
			);

			const result = checkAuth(mockStorage);

			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("openai");
		});
	});

	describe("environment variables", () => {
		it("detects STORYOF_ prefixed vars", () => {
			process.env.STORYOF_ANTHROPIC_API_KEY = "sk-ant-test";

			const result = checkAuth(mockStorage);

			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("anthropic");
			expect(result.source).toBe("env");
		});

		it("detects standard env vars as fallback", () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-test";

			const result = checkAuth(mockStorage);

			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("anthropic");
			expect(result.source).toBe("env");
		});

		it("prefers STORYOF_ prefix over standard vars", () => {
			process.env.STORYOF_ANTHROPIC_API_KEY = "sk-storyof";
			process.env.ANTHROPIC_API_KEY = "sk-standard";

			const result = checkAuth(mockStorage);

			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("anthropic");
			expect(result.source).toBe("env");
		});

		it("checks all supported providers", () => {
			process.env.OPENAI_API_KEY = "sk-openai";

			const result = checkAuth(mockStorage);

			expect(result.hasAuth).toBe(true);
			expect(result.provider).toBe("openai");
		});
	});

	describe("no credentials", () => {
		it("returns false when nothing is configured", () => {
			const result = checkAuth(mockStorage);

			expect(result.hasAuth).toBe(false);
			expect(result.provider).toBeUndefined();
			expect(result.source).toBeUndefined();
		});
	});

	describe("priority", () => {
		it("prefers storage over env vars", () => {
			vi.mocked(mockStorage.get).mockImplementation((provider) =>
				provider === "anthropic" ? { type: "api_key", key: "sk-from-storage" } : undefined,
			);
			process.env.ANTHROPIC_API_KEY = "sk-from-env";

			const result = checkAuth(mockStorage);

			expect(result.hasAuth).toBe(true);
			expect(result.source).toBe("storage");
		});
	});
});
