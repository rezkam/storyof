/**
 * Playwright worker-scoped fixture for engine lifecycle management.
 *
 * Replaces the manual test.beforeAll / test.afterAll pattern that is
 * copy-pasted across every browser test file. Guarantees cleanup even
 * when setup fails, and provides type-safe access to port/token/session.
 *
 * Usage:
 *
 *   import { test, expect } from "./fixtures/engine-fixture.js";
 *
 *   test("my test", async ({ page, engine }) => {
 *     const { port, token, session } = engine;
 *     await page.goto(`http://localhost:${port}/`);
 *     await authenticate(page, token);
 *     // ...
 *   });
 *
 * The fixture is worker-scoped (like beforeAll): one engine per worker,
 * shared across all tests in a file. When workers: 1 (the current
 * default), this means one engine for all tests — matching the old
 * beforeAll semantics exactly.
 *
 * To get a per-test engine (like beforeEach), use testScopedEngine:
 *
 *   test("isolated test", async ({ page, testEngine }) => { ... });
 */

import * as fs from "node:fs";
import { test as base, type Page } from "@playwright/test";
import { start, reset, type SessionFactory } from "../../../src/engine.js";
import { createMockSession, type MockSession } from "./mock-session.js";
import { makeTempDir } from "./page-helpers.js";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface EngineContext {
	port: number;
	token: string;
	session: MockSession;
	tempDir: string;
}

type WorkerFixtures = {
	/** Worker-scoped engine — shared across all tests in the worker (like beforeAll). */
	engine: EngineContext;
};

type TestFixtures = {
	/** Test-scoped engine — fresh engine per test (like beforeEach). */
	testEngine: EngineContext;
};

// ═══════════════════════════════════════════════════════════════════════
// Engine lifecycle helper
// ═══════════════════════════════════════════════════════════════════════

async function startEngine(opts?: {
	model?: string;
	depth?: "shallow" | "medium" | "deep";
}): Promise<EngineContext> {
	const tempDir = makeTempDir();
	const session = createMockSession();
	const factory: SessionFactory = async () => session as any;

	const result = await start({
		cwd: tempDir,
		depth: opts?.depth ?? "medium",
		model: opts?.model ?? "claude-sonnet-4-5",
		sessionFactory: factory,
		skipPrompt: true,
	});

	const port = parseInt(new URL(result.url).port);
	const token = result.token;

	return { port, token, session, tempDir };
}

async function stopEngine(tempDir: string): Promise<void> {
	reset();
	// Give the server socket time to drain before next test
	await new Promise<void>((r) => setTimeout(r, 50));
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

export const test = base.extend<TestFixtures, WorkerFixtures>({
	/**
	 * Worker-scoped: one engine shared across all tests in the file.
	 * Equivalent to test.beforeAll / test.afterAll.
	 *
	 * Use this when tests build on each other's state (e.g. chat history
	 * that accumulates across a test suite).
	 */
	engine: [
		async ({}, use) => {
			const ctx = await startEngine();

			await use(ctx);

			await stopEngine(ctx.tempDir);
		},
		{ scope: "worker" },
	],

	/**
	 * Test-scoped: fresh engine for each test.
	 * Equivalent to test.beforeEach / test.afterEach.
	 *
	 * Use this for tests that need a clean slate (e.g. read-only mode
	 * tests that start their own engine with specific options).
	 */
	testEngine: async ({}, use) => {
		const ctx = await startEngine();

		await use(ctx);

		await stopEngine(ctx.tempDir);
	},
});

export { expect } from "@playwright/test";
export type { Page };

// ═══════════════════════════════════════════════════════════════════════
// Describe-scoped helper (replaces beforeAll/afterAll boilerplate)
// ═══════════════════════════════════════════════════════════════════════

/**
 * withEngine() — drop-in replacement for the repeating beforeAll/afterAll
 * pattern inside test.describe blocks that need their own engine.
 *
 * Usage:
 *
 *   test.describe("my suite", () => {
 *     const ctx = withEngine();
 *
 *     test("my test", async ({ page }) => {
 *       const { port, token, session } = ctx;
 *       await page.goto(`http://localhost:${port}/`);
 *     });
 *   });
 *
 * The object returned by withEngine() is a live reference: its port/token/
 * session properties are undefined until beforeAll resolves, then populated.
 */
export function withEngine(opts?: {
	model?: string;
	depth?: "shallow" | "medium" | "deep";
}): EngineContext {
	// Mutable box — fields are populated in beforeAll.
	const ctx = {} as EngineContext;

	test.beforeAll(async () => {
		const result = await startEngine(opts);
		Object.assign(ctx, result);
	});

	test.afterAll(async () => {
		await stopEngine(ctx.tempDir);
	});

	return ctx;
}

/**
 * withFreshEngine() — like withEngine() but beforeEach / afterEach.
 * Use when each test needs a clean slate (no shared engine state).
 */
export function withFreshEngine(opts?: {
	model?: string;
	depth?: "shallow" | "medium" | "deep";
}): EngineContext {
	const ctx = {} as EngineContext;

	test.beforeEach(async () => {
		const result = await startEngine(opts);
		Object.assign(ctx, result);
	});

	test.afterEach(async () => {
		await stopEngine(ctx.tempDir);
	});


	return ctx;
}

// ═══════════════════════════════════════════════════════════════════════
// Factory for engines with non-default options
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a test fixture that starts an engine with specific options.
 *
 * Usage:
 *   const test = engineWith({ model: "test-model" });
 *   test("custom model test", async ({ page, engine }) => { ... });
 */
export function engineWith(opts: {
	model?: string;
	depth?: "shallow" | "medium" | "deep";
}) {
	return base.extend<TestFixtures, WorkerFixtures>({
		engine: [
			async ({}, use) => {
				const ctx = await startEngine(opts);
				await use(ctx);
				await stopEngine(ctx.tempDir);
			},
			{ scope: "worker" },
		],
		testEngine: async ({}, use) => {
			const ctx = await startEngine(opts);
			await use(ctx);
			await stopEngine(ctx.tempDir);
		},
	});
}
