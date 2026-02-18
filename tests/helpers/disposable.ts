/**
 * Disposable helpers for test resource cleanup using `await using`.
 *
 * Node.js 20+ supports Symbol.asyncDispose and the `await using` declaration,
 * which guarantees cleanup even if a test throws.
 *
 * Usage:
 *
 *   import { startDisposable } from "../helpers/disposable.js";
 *
 *   it("engine starts and stops cleanly", async () => {
 *     await using engine = await startDisposable({ cwd: tempDir, sessionFactory: factory, skipPrompt: true });
 *     // engine.url, engine.token are available here
 *     // reset() is called automatically when the block exits — even on throw
 *   });
 *
 * Compare to the manual pattern:
 *
 *   afterEach(() => { reset(); });  // easy to forget; doesn't run if beforeEach throws
 */

import { start, reset, type StartOptions } from "../../src/engine.js";

export type StartResult = Awaited<ReturnType<typeof start>>;

/**
 * Start the engine and return an AsyncDisposable handle.
 * `reset()` is called automatically when the `await using` block exits.
 *
 * IMPORTANT: If start() throws after partially mutating engine state (e.g.
 * server started but session creation failed), reset() is still called to
 * clean up leaked resources. This prevents cascading test failures.
 */
export async function startDisposable(
	opts: StartOptions,
): Promise<StartResult & AsyncDisposable> {
	try {
		const result = await start(opts);
		return {
			...result,
			async [Symbol.asyncDispose]() {
				reset();
			},
		};
	} catch (err) {
		// start() threw after mutating global state — clean up before re-throwing
		reset();
		throw err;
	}
}

/**
 * Wrap any cleanup function as an AsyncDisposable.
 * Useful for one-off resources that don't have built-in dispose support.
 *
 * Example:
 *   await using _ = disposable(() => fs.rmSync(tempDir, { recursive: true }));
 */
export function disposable(cleanup: () => void | Promise<void>): AsyncDisposable {
	return {
		async [Symbol.asyncDispose]() {
			await cleanup();
		},
	};
}
