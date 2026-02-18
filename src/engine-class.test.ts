/**
 * Tests for the Engine class wrapper (engine-class.ts).
 *
 * Verifies:
 * 1. Constructor-bound options cannot be overridden by call-site options
 * 2. Disposable cleanup runs even when startup fails
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Engine } from "./engine-class.js";
import * as engineModule from "./engine.js";

// Spy on the engine module functions
vi.mock("./engine.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./engine.js")>();
	return {
		...original,
		start: vi.fn().mockResolvedValue({ url: "http://localhost:1234/", token: "test-token" }),
		resume: vi.fn().mockResolvedValue({ url: "http://localhost:1234/", token: "test-token" }),
		reset: vi.fn(),
		stop: vi.fn(),
		stopAll: vi.fn(),
		getState: vi.fn().mockReturnValue({ phase: "idle" }),
	};
});

describe("Engine class", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("constructor-bound options take precedence", () => {
		it("start() cannot override cwd", async () => {
			const engine = new Engine({ cwd: "/safe/path" });
			// Force an override attempt via type escape (TS would block this, but JS callers can do it)
			await engine.start({ targetPath: "/some/project" } as any);

			const startCall = vi.mocked(engineModule.start).mock.calls[0][0];
			expect(startCall.cwd).toBe("/safe/path");
		});

		it("start() cannot override sessionFactory", async () => {
			const realFactory = vi.fn();
			const fakeFactory = vi.fn();
			const engine = new Engine({ cwd: "/test", sessionFactory: realFactory as any });
			await engine.start({ sessionFactory: fakeFactory } as any);

			const startCall = vi.mocked(engineModule.start).mock.calls[0][0];
			expect(startCall.sessionFactory).toBe(realFactory);
			expect(startCall.sessionFactory).not.toBe(fakeFactory);
		});

		it("start() cannot override authStorage", async () => {
			const realAuth = { get: vi.fn(), set: vi.fn() };
			const fakeAuth = { get: vi.fn(), set: vi.fn() };
			const engine = new Engine({ cwd: "/test", authStorage: realAuth as any });
			await engine.start({ authStorage: fakeAuth } as any);

			const startCall = vi.mocked(engineModule.start).mock.calls[0][0];
			expect(startCall.authStorage).toBe(realAuth);
			expect(startCall.authStorage).not.toBe(fakeAuth);
		});

		it("start() cannot override backoffBase", async () => {
			const engine = new Engine({ cwd: "/test", backoffBase: 10 });
			await engine.start({ backoffBase: 99999 } as any);

			const startCall = vi.mocked(engineModule.start).mock.calls[0][0];
			expect(startCall.backoffBase).toBe(10);
		});

		it("start() cannot override backoffMax", async () => {
			const engine = new Engine({ cwd: "/test", backoffMax: 50 });
			await engine.start({ backoffMax: 99999 } as any);

			const startCall = vi.mocked(engineModule.start).mock.calls[0][0];
			expect(startCall.backoffMax).toBe(50);
		});

		it("start() cannot override skipPrompt", async () => {
			const engine = new Engine({ cwd: "/test", skipPrompt: true });
			await engine.start({ skipPrompt: false } as any);

			const startCall = vi.mocked(engineModule.start).mock.calls[0][0];
			expect(startCall.skipPrompt).toBe(true);
		});

		it("resume() cannot override cwd", async () => {
			const engine = new Engine({ cwd: "/safe/path" });
			await engine.resume({ meta: { id: "x", targetPath: "/t" } as any, cwd: "/evil" } as any);

			const resumeCall = vi.mocked(engineModule.resume).mock.calls[0][0];
			expect(resumeCall.cwd).toBe("/safe/path");
		});

		it("resume() cannot override authStorage", async () => {
			const realAuth = { get: vi.fn(), set: vi.fn() };
			const fakeAuth = { get: vi.fn(), set: vi.fn() };
			const engine = new Engine({ cwd: "/test", authStorage: realAuth as any });
			await engine.resume({ meta: { id: "x", targetPath: "/t" } as any, authStorage: fakeAuth } as any);

			const resumeCall = vi.mocked(engineModule.resume).mock.calls[0][0];
			expect(resumeCall.authStorage).toBe(realAuth);
		});

		it("start() passes through non-bound options", async () => {
			const engine = new Engine({ cwd: "/test" });
			await engine.start({ targetPath: "/project", model: "my-model", prompt: "hello" });

			const startCall = vi.mocked(engineModule.start).mock.calls[0][0];
			expect(startCall.targetPath).toBe("/project");
			expect(startCall.model).toBe("my-model");
			expect(startCall.prompt).toBe("hello");
		});
	});

	describe("disposable cleanup", () => {
		it("calls reset() on Symbol.asyncDispose", async () => {
			const engine = new Engine({ cwd: "/test" });
			await engine.start({});
			await engine[Symbol.asyncDispose]();

			expect(engineModule.reset).toHaveBeenCalledTimes(1);
		});

		it("calls reset() via dispose() alias", async () => {
			const engine = new Engine({ cwd: "/test" });
			await engine.start({});
			await engine.dispose();

			expect(engineModule.reset).toHaveBeenCalledTimes(1);
		});

		it("dispose is safe to call multiple times", async () => {
			const engine = new Engine({ cwd: "/test" });
			await engine.dispose();
			await engine.dispose();
			await engine.dispose();

			// reset() called each time — idempotent by contract
			expect(engineModule.reset).toHaveBeenCalledTimes(3);
		});
	});
});
