/**
 * Unit tests for the readiness gate:
 * URL/token MUST NOT appear until the agent is confirmed running.
 *
 * We mock the engine so we can control exactly when onReady fires,
 * then verify output ordering.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Track calls ──────────────────────────────────────────────────────
const spinnerCalls: string[] = [];
const logOutput: string[] = [];
let capturedOnReady: (() => void) | null = null;
let startResolve: ((v: { url: string; token: string }) => void) | null = null;
let startReject: ((err: Error) => void) | null = null;

// ── Mock engine ──────────────────────────────────────────────────────
// We make start() return a pending promise so we control resolution timing.
vi.mock("../engine.js", () => ({
	start: vi.fn((opts: any) => {
		capturedOnReady = opts.onReady ?? null;
		return new Promise((resolve, reject) => {
			startResolve = resolve;
			startReject = reject;
		});
	}),
	resume: vi.fn(),
	stopExternal: vi.fn(),
}));

// ── Mock auth ────────────────────────────────────────────────────────
vi.mock("../auth.js", () => ({
	createAuthStorage: vi.fn(() => ({
		get: (provider: string) =>
			provider === "anthropic" ? { type: "api_key", key: "sk-test" } : undefined,
		set: vi.fn(),
		remove: vi.fn(),
		login: vi.fn(),
		setFallbackResolver: vi.fn(),
	})),
}));

vi.mock("../auth-check.js", () => ({
	checkAuth: vi.fn(() => ({
		hasAuth: true,
		provider: "anthropic",
		source: "storage",
	})),
}));

// ── Mock spinner (must be a class) ───────────────────────────────────
vi.mock("./spinner.js", () => ({
	Spinner: class MockSpinner {
		start() { spinnerCalls.push("spinner:start"); }
		phase(label: string) { spinnerCalls.push(`spinner:phase:${label}`); }
		stop(msg?: string) { spinnerCalls.push(`spinner:stop:${msg ?? ""}`); }
	},
}));

import { CommandHandler } from "./commands.js";
import { CLILogger } from "./logger.js";

// ── Intercept logger ─────────────────────────────────────────────────
function createTrackedLogger(): CLILogger {
	const logger = new CLILogger();
	for (const method of ["info", "success", "warn", "error", "section", "hint", "command"] as const) {
		vi.spyOn(logger, method).mockImplementation(function (this: CLILogger, msg: string) {
			logOutput.push(`${method}:${msg}`);
		});
	}
	vi.spyOn(logger, "keyValue").mockImplementation(function (this: CLILogger, key: string, val: string) {
		logOutput.push(`kv:${key}=${val}`);
	});
	vi.spyOn(logger, "newline").mockImplementation(() => { logOutput.push("newline"); });
	vi.spyOn(logger, "debug").mockImplementation(() => {});
	return logger;
}

describe("Readiness gate", () => {
	let handler: CommandHandler;

	beforeEach(() => {
		capturedOnReady = null;
		startResolve = null;
		startReject = null;
		spinnerCalls.length = 0;
		logOutput.length = 0;
		handler = new CommandHandler(createTrackedLogger());
		// waitForShutdown waits for SIGINT/SIGTERM — mock it so tests can await
		// handlePromise without hanging. The readiness-gate logic under test runs
		// before waitForShutdown is reached, so this doesn't hide any assertions.
		vi.spyOn(handler as any, "waitForShutdown").mockResolvedValue(undefined);
	});

	// vi.restoreAllMocks() removed — handled globally by vitest restoreMocks config

	it("shows nothing until onReady fires", async () => {
		// Start handleStart — it will block waiting for both start() and onReady
		const handlePromise = handler.handleStart({
			prompt: "test",
			depth: "medium",
			paths: [],
			model: "claude-sonnet-4-5",
			cwd: "/tmp/test",
		});

		// Tick microtasks to let the promise machinery run
		await new Promise((r) => setTimeout(r, 50));

		// Spinner should have started
		expect(spinnerCalls).toContain("spinner:start");

		// start() hasn't resolved yet — NO URL/token in output
		expect(logOutput.some((l) => l.includes("localhost"))).toBe(false);
		expect(logOutput.some((l) => l.includes("test-token"))).toBe(false);

		// Now resolve start() — server is up, but agent hasn't started yet
		startResolve!({ url: "http://localhost:9876/", token: "test-token-abc" });
		await new Promise((r) => setTimeout(r, 50));

		// Spinner should have advanced to "waiting" phase
		expect(spinnerCalls).toContain("spinner:phase:Waiting for agent...");

		// STILL no URL/token — onReady hasn't fired
		expect(logOutput.some((l) => l.includes("test-token-abc"))).toBe(false);

		// Now fire onReady — agent is confirmed running
		expect(capturedOnReady).not.toBeNull();
		capturedOnReady!();
		await new Promise((r) => setTimeout(r, 50));

		// NOW URL and token should appear
		expect(logOutput.some((l) => l.includes("localhost"))).toBe(true);
		expect(logOutput.some((l) => l.includes("test-token-abc"))).toBe(true);

		// Spinner should have stopped with success
		expect(spinnerCalls).toContain("spinner:stop:Agent is running");
	});

	it("includes all connection details only after readiness", async () => {
		const handlePromise = handler.handleStart({
			prompt: "auth system",
			depth: "deep",
			paths: ["/src"],
			model: "claude-sonnet-4-5",
			cwd: "/home/user/project",
		});

		await new Promise((r) => setTimeout(r, 50));

		// No key-value pairs yet
		expect(logOutput.filter((l) => l.startsWith("kv:")).length).toBe(0);

		// Resolve start
		startResolve!({ url: "http://localhost:9999/", token: "secret-42" });
		await new Promise((r) => setTimeout(r, 50));

		// Still nothing — waiting for agent
		expect(logOutput.filter((l) => l.startsWith("kv:")).length).toBe(0);

		// Fire readiness
		capturedOnReady!();
		await new Promise((r) => setTimeout(r, 50));

		// All details present
		const kvLines = logOutput.filter((l) => l.startsWith("kv:"));
		expect(kvLines.some((l) => l.includes("URL") && l.includes("localhost:9999"))).toBe(true);
		expect(kvLines.some((l) => l.includes("Token") && l.includes("secret-42"))).toBe(true);
		expect(kvLines.some((l) => l.includes("Model") && l.includes("claude-sonnet-4-5"))).toBe(true);
		expect(kvLines.some((l) => l.includes("Target") && l.includes("/home/user/project"))).toBe(true);
		expect(kvLines.some((l) => l.includes("Depth") && l.includes("deep"))).toBe(true);
		expect(kvLines.some((l) => l.includes("Topic") && l.includes("auth system"))).toBe(true);
		expect(kvLines.some((l) => l.includes("Scope") && l.includes("/src"))).toBe(true);
	});

	it("spinner lifecycle: start → phase → stop", async () => {
		const handlePromise = handler.handleStart({
			prompt: "test",
			depth: "medium",
			paths: [],
			model: "claude-sonnet-4-5",
			cwd: "/tmp/test",
		});

		await new Promise((r) => setTimeout(r, 50));

		startResolve!({ url: "http://localhost:9876/", token: "tok" });
		await new Promise((r) => setTimeout(r, 50));

		capturedOnReady!();
		await new Promise((r) => setTimeout(r, 50));

		// Verify order
		const startIdx = spinnerCalls.indexOf("spinner:start");
		const phaseIdx = spinnerCalls.indexOf("spinner:phase:Waiting for agent...");
		const stopIdx = spinnerCalls.indexOf("spinner:stop:Agent is running");

		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(phaseIdx).toBeGreaterThan(startIdx);
		expect(stopIdx).toBeGreaterThan(phaseIdx);
	});

	it("cleans up spinner on engine failure", async () => {
		const handlePromise = handler.handleStart({
			prompt: "test",
			depth: "medium",
			paths: [],
			model: "claude-sonnet-4-5",
			cwd: "/tmp/test",
		});

		await new Promise((r) => setTimeout(r, 50));
		expect(spinnerCalls).toContain("spinner:start");

		// Reject start — simulating engine failure
		startReject!(new Error("No API key configured"));
		
		await expect(handlePromise).rejects.toThrow();

		// Spinner must be cleaned up
		expect(spinnerCalls.some((c) => c.startsWith("spinner:stop"))).toBe(true);

		// No URL/token should have leaked
		expect(logOutput.some((l) => l.includes("localhost"))).toBe(false);
	});

	it("onReady before start resolves still works (race condition)", async () => {
		// Edge case: what if onReady fires before start()'s promise resolves?
		// This can happen if the engine fires agent_start synchronously.

		const { start } = await import("../engine.js");
		vi.mocked(start).mockImplementationOnce(async (opts: any) => {
			capturedOnReady = opts.onReady ?? null;
			// Fire onReady BEFORE returning
			if (capturedOnReady) capturedOnReady();
			return { url: "http://localhost:5555/", token: "race-tok" };
		});

		const handlePromise = handler.handleStart({
			prompt: undefined,
			depth: "shallow",
			paths: [],
			model: "claude-sonnet-4-5",
			cwd: "/tmp/race-test",
		});

		await new Promise((r) => setTimeout(r, 100));

		// Should still show URL/token correctly despite the race
		expect(logOutput.some((l) => l.includes("race-tok"))).toBe(true);
		expect(logOutput.some((l) => l.includes("localhost:5555"))).toBe(true);
		expect(spinnerCalls.some((c) => c.includes("stop"))).toBe(true);
	});
});
