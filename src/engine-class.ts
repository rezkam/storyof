/**
 * Engine — class wrapper around the engine module singleton.
 *
 * Provides a unified, disposable handle for the engine that:
 * - Pre-binds common options (cwd, sessionFactory, authStorage, backoff tuning)
 *   so tests don't repeat them in every start() call
 * - Implements AsyncDisposable so `await using engine = new Engine(...)` calls
 *   reset() automatically — even on test failure
 * - Serves as the migration path toward a fully injectable engine (Phase 3 of
 *   TODO-706ebebe); right now it delegates to the module singleton, but each
 *   method takes only the incremental options specific to that call
 *
 * ## Why a class instead of the module functions?
 *
 * The module-level `start()` / `stop()` / `reset()` functions share a single
 * global state object (`S`).  This is fine for production (one server per
 * process) but fragile in tests: if a test forgets to call `reset()`, or if
 * an `afterEach` hook is skipped because of a throw, the state leaks into the
 * next test and causes cascading failures.
 *
 * The Engine class solves this with `await using`:
 *
 * ```ts
 * test("...", async () => {
 *   await using engine = new Engine({ cwd: tempDir, sessionFactory: factory });
 *   await engine.start({ targetPath: "/some/dir", prompt: "explore" });
 *   // ... assertions ...
 *   // engine[Symbol.asyncDispose]() is called automatically here
 * });
 * ```
 *
 * Even if the test throws, dispose() runs and leaves the engine in a clean state.
 *
 * ## Future direction (true isolation)
 *
 * The next step (Phase 3) is to move the `S` state object into the Engine class
 * as an instance field, so multiple Engine instances can run truly concurrently
 * without interfering.  That enables parallel test workers and eliminates the
 * `reset()` function entirely.  The public API of this class is designed to be
 * identical to that future version so no tests need to change.
 */

import {
	start,
	stop,
	stopAll,
	reset,
	resume,
	chat,
	abort,
	getState,
	handleEvent,
	handleCrash,
	extractChatMessages,
	changeModel,
	type SessionFactory,
	type StartOptions,
	type ResumeOptions,
	type EnginePublicState,
} from "./engine.js";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

/** Options that apply to all operations on this Engine instance. */
export interface EngineOptions {
	/** Working directory for relative path resolution. */
	cwd: string;
	/** Override the session factory (inject a mock in tests). */
	sessionFactory?: SessionFactory;
	/** Override auth storage (for testing without ~/.storyof). */
	authStorage?: Parameters<typeof start>[0]["authStorage"];
	/** Crash-restart backoff base in ms. Set to a small value (e.g. 10) in tests. */
	backoffBase?: number;
	/** Crash-restart backoff maximum in ms. Set to a small value (e.g. 50) in tests. */
	backoffMax?: number;
	/** Skip sending the exploration prompt (for testing). */
	skipPrompt?: boolean;
}

/**
 * Engine instance — wraps the engine module API with pre-bound options
 * and automatic disposal via `await using`.
 */
export class Engine implements AsyncDisposable {
	constructor(private readonly options: EngineOptions) {}

	/**
	 * Start a new exploration session.
	 * Common options (cwd, sessionFactory, etc.) are merged from the constructor.
	 */
	async start(
		opts: Omit<StartOptions, "cwd" | "sessionFactory" | "authStorage" | "backoffBase" | "backoffMax" | "skipPrompt"> = {},
	): Promise<{ url: string; token: string }> {
		// Spread call opts first, then overlay constructor-bound values so they
		// can never be overridden — this preserves the class contract.
		return start({
			...opts,
			cwd: this.options.cwd,
			sessionFactory: this.options.sessionFactory,
			authStorage: this.options.authStorage,
			backoffBase: this.options.backoffBase,
			backoffMax: this.options.backoffMax,
			skipPrompt: this.options.skipPrompt,
		});
	}

	/**
	 * Resume an existing session from a saved session file.
	 */
	async resume(
		opts: Omit<ResumeOptions, "cwd" | "authStorage">,
	): Promise<{ url: string; token: string }> {
		// Constructor-bound values last — cannot be overridden.
		return resume({
			...opts,
			cwd: this.options.cwd,
			authStorage: this.options.authStorage,
		});
	}

	/** Stop the engine gracefully (marks intentional stop). */
	stop(): void {
		stop();
	}

	/** Stop the engine and close all connections (for between-test cleanup). */
	stopAll(): void {
		stopAll();
	}

	/** Send a chat message to the running agent. */
	async chat(text: string): Promise<void> {
		return chat(text);
	}

	/** Abort the current agent turn. */
	async abort(): Promise<void> {
		return abort();
	}

	/** Change the active AI model. */
	async changeModel(modelId: string, provider: string): Promise<void> {
		return changeModel(modelId, provider);
	}

	/** Get the current engine state (type-safe discriminated union). */
	getState(): EnginePublicState {
		return getState();
	}

	/** Inject a synthetic agent event (for testing). */
	handleEvent(event: AgentSessionEvent): void {
		handleEvent(event);
	}

	/** Inject a synthetic crash event (for testing crash-recovery). */
	handleCrash(error: string): void {
		handleCrash(error);
	}

	/** Extract chat messages from the current session. */
	extractChatMessages(limit?: number): ReturnType<typeof extractChatMessages> {
		return extractChatMessages(limit);
	}

	/**
	 * Dispose the engine — stops the server, resets all state.
	 *
	 * Called automatically by `await using` when the block exits.
	 * Safe to call multiple times.
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		reset();
	}

	/**
	 * Explicit dispose alias (for `afterEach` hooks and non-using contexts).
	 * Equivalent to `await using` disposal.
	 */
	async dispose(): Promise<void> {
		return this[Symbol.asyncDispose]();
	}
}
