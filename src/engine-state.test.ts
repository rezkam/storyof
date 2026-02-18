/**
 * Comprehensive state machine tests for the StoryOf engine.
 *
 * Tests every state combination of:
 *   - Engine lifecycle: idle → starting → streaming → waiting → stopped/failed
 *   - Validation: none → validating → validated / fix_sent → gave_up
 *   - Client: connected / disconnected (0..N concurrent clients)
 *   - Crash/restart: 1..max crashes with exponential backoff
 *
 * The state machine is tested in isolation — no HTTP, no WebSocket,
 * no AI models. Pure logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EngineStateMachine } from "./engine-state.js";

describe("EngineStateMachine", () => {
	let engine: EngineStateMachine;

	beforeEach(() => {
		engine = new EngineStateMachine();
	});

	// ═════════════════════════════════════════════════════════════════
	// Lifecycle: happy path
	// ═════════════════════════════════════════════════════════════════

	describe("lifecycle: happy path", () => {
		it("starts in idle state", () => {
			const s = engine.snapshot();
			expect(s.phase).toBe("idle");
			expect(s.isStreaming).toBe(false);
			expect(s.agentReady).toBe(false);
			expect(s.crashCount).toBe(0);
			expect(s.clientCount).toBe(0);
			expect(s.hasDocument).toBe(false);
			expect(s.intentionalStop).toBe(false);
		});

		it("idle → starting → streaming → waiting (full cycle)", () => {
			engine.serverStarted();
			expect(engine.snapshot().phase).toBe("starting");

			engine.sessionCreated();
			expect(engine.snapshot().agentReady).toBe(true);

			engine.agentStart();
			expect(engine.snapshot().phase).toBe("streaming");
			expect(engine.snapshot().isStreaming).toBe(true);

			engine.agentEnd();
			expect(engine.snapshot().phase).toBe("waiting");
			expect(engine.snapshot().isStreaming).toBe(false);
			expect(engine.snapshot().agentReady).toBe(true);
		});

		it("fires onReady callback on first agent_start", () => {
			let readyCount = 0;
			engine = new EngineStateMachine({ onReady: () => readyCount++ });

			engine.serverStarted();
			engine.sessionCreated();
			expect(readyCount).toBe(0);

			engine.agentStart();
			expect(readyCount).toBe(1);

			// Second agent_start should NOT fire again
			engine.agentEnd();
			engine.agentStart();
			expect(readyCount).toBe(1);
		});

		it("multiple turn cycles", () => {
			engine.serverStarted();
			engine.sessionCreated();

			// Turn 1
			engine.agentStart();
			expect(engine.snapshot().phase).toBe("streaming");
			engine.agentEnd();
			expect(engine.snapshot().phase).toBe("waiting");

			// Turn 2 (chat)
			const chat = engine.chatMessage("explain this");
			expect(chat.allowed).toBe(true);
			expect(chat.steering).toBe(false);
			expect(engine.snapshot().phase).toBe("streaming");
			engine.agentEnd();
			expect(engine.snapshot().phase).toBe("waiting");

			// Turn 3
			engine.chatMessage("more details");
			engine.agentEnd();
			expect(engine.snapshot().phase).toBe("waiting");
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Lifecycle: stop from any state
	// ═════════════════════════════════════════════════════════════════

	describe("lifecycle: stop from any state", () => {
		it("stop from idle", () => {
			engine.stop();
			expect(engine.snapshot().phase).toBe("stopped");
			expect(engine.snapshot().intentionalStop).toBe(true);
		});

		it("stop from starting", () => {
			engine.serverStarted();
			engine.stop();
			expect(engine.snapshot().phase).toBe("stopped");
		});

		it("stop from streaming", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			expect(engine.snapshot().isStreaming).toBe(true);

			engine.stop();
			expect(engine.snapshot().phase).toBe("stopped");
			expect(engine.snapshot().isStreaming).toBe(false);
			expect(engine.snapshot().agentReady).toBe(false);
		});

		it("stop from waiting", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.agentEnd();

			engine.stop();
			expect(engine.snapshot().phase).toBe("stopped");
		});

		it("stop from restarting", () => {
			engine.serverStarted();
			engine.sessionFailed("error");
			expect(engine.snapshot().phase).toBe("restarting");

			engine.stop();
			expect(engine.snapshot().phase).toBe("stopped");
		});

		it("stop broadcasts agent_stopped", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.broadcasts.length = 0;

			engine.stop();
			expect(engine.broadcasts.some((e) => e.type === "agent_stopped")).toBe(true);
		});

		it("no actions work after stop", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.stop();

			// These should all be no-ops
			const chat = engine.chatMessage("hello");
			expect(chat.allowed).toBe(false);

			engine.agentStart(); // no-op
			engine.agentEnd();   // no-op
			expect(engine.snapshot().phase).toBe("stopped");
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Crash and auto-restart
	// ═════════════════════════════════════════════════════════════════

	describe("crash and auto-restart", () => {
		it("first crash → restarting (under limit)", () => {
			engine = new EngineStateMachine({ maxCrashRestarts: 3 });
			engine.serverStarted();
			engine.sessionFailed("connection error");

			expect(engine.snapshot().phase).toBe("restarting");
			expect(engine.snapshot().crashCount).toBe(1);

			const restartEvent = engine.broadcasts.find((e) => e.type === "agent_restarting");
			expect(restartEvent).toBeDefined();
			expect(restartEvent!.attempt).toBe(1);
		});

		it("crash at max → failed (gave up)", () => {
			engine = new EngineStateMachine({ maxCrashRestarts: 2 });
			engine.serverStarted();

			// Crash 1 → restart
			engine.sessionFailed("err1");
			expect(engine.snapshot().phase).toBe("restarting");

			// Crash 2 → restart
			engine.sessionFailed("err2");
			expect(engine.snapshot().phase).toBe("restarting");

			// Crash 3 → gave up
			engine.sessionFailed("err3");
			expect(engine.snapshot().phase).toBe("failed");
			expect(engine.snapshot().crashCount).toBe(3);

			const exitEvent = engine.broadcasts.filter((e) => e.type === "agent_exit");
			expect(exitEvent[exitEvent.length - 1].willRestart).toBe(false);
		});

		it("successful restart resets crash count", () => {
			engine = new EngineStateMachine({ maxCrashRestarts: 3 });
			engine.serverStarted();

			// Crash and restart
			engine.sessionFailed("err");
			expect(engine.snapshot().crashCount).toBe(1);
			engine.sessionCreated();
			engine.agentStart();

			// Crash count reset on agent_start
			expect(engine.snapshot().crashCount).toBe(0);
		});

		it("intentional stop prevents restart", () => {
			engine = new EngineStateMachine({ maxCrashRestarts: 3 });
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();

			// Intentional stop
			engine.stop();

			// Any subsequent error should not restart
			engine.promptError("post-stop error");
			expect(engine.snapshot().phase).toBe("stopped");
		});

		it("prompt error during streaming triggers crash handler", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();

			engine.promptError("API rate limit");
			expect(engine.snapshot().crashCount).toBe(1);

			const exitEvent = engine.broadcasts.find((e) => e.type === "agent_exit");
			expect(exitEvent).toBeDefined();
			expect(exitEvent!.error).toBe("API rate limit");
		});

		it("exponential backoff increases with each crash", () => {
			engine = new EngineStateMachine({ maxCrashRestarts: 5 });
			engine.serverStarted();

			const backoffs: number[] = [];

			for (let i = 0; i < 4; i++) {
				engine.sessionFailed(`crash ${i}`);
				const restart = engine.broadcasts
					.filter((e) => e.type === "agent_restarting")
					.pop();
				if (restart) backoffs.push(restart.restartIn as number);
			}

			// Backoff should increase: 2000, 4000, 8000, 15000 (capped)
			expect(backoffs[0]).toBe(2000);
			expect(backoffs[1]).toBe(4000);
			expect(backoffs[2]).toBe(8000);
			expect(backoffs[3]).toBe(15000);
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Validation lifecycle
	// ═════════════════════════════════════════════════════════════════

	describe("validation lifecycle", () => {
		beforeEach(() => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
		});

		it("none → validating → validated (happy path)", () => {
			expect(engine.snapshot().validation).toBe("none");

			engine.documentReady("/tmp/doc.html");
			expect(engine.snapshot().hasDocument).toBe(true);

			engine.validationStart();
			expect(engine.snapshot().validation).toBe("validating");

			engine.validationPassed();
			expect(engine.snapshot().validation).toBe("validated");
			expect(engine.snapshot().validationAttempt).toBe(0);
		});

		it("validation fails → fix sent → retry → pass", () => {
			engine.documentReady("/tmp/doc.html");

			engine.validationStart();
			engine.validationFailed(2);
			expect(engine.snapshot().validation).toBe("fix_sent");
			expect(engine.snapshot().validationAttempt).toBe(1);

			// Agent fixes the doc, re-validate
			engine.validationStart();
			engine.validationPassed();
			expect(engine.snapshot().validation).toBe("validated");
		});

		it("validation fails max times → gave_up", () => {
			engine = new EngineStateMachine({ maxValidationAttempts: 2 });
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.documentReady("/tmp/doc.html");

			// Attempt 1
			engine.validationStart();
			engine.validationFailed(1);
			expect(engine.snapshot().validation).toBe("fix_sent");

			// Attempt 2
			engine.validationStart();
			engine.validationFailed(1);
			expect(engine.snapshot().validation).toBe("fix_sent");

			// Attempt 3 — over limit
			engine.validationStart();
			engine.validationFailed(1);
			expect(engine.snapshot().validation).toBe("gave_up");

			const gaveUp = engine.broadcasts.find((e) => e.type === "validation_gave_up");
			expect(gaveUp).toBeDefined();
		});

		it("no validation without document", () => {
			engine.validationStart();
			expect(engine.snapshot().validation).toBe("none");
		});

		it("stop during validation resets", () => {
			engine.documentReady("/tmp/doc.html");
			engine.validationStart();
			expect(engine.snapshot().validation).toBe("validating");

			engine.stop();
			expect(engine.snapshot().validation).toBe("none");
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Client management
	// ═════════════════════════════════════════════════════════════════

	describe("client management", () => {
		it("connect increments count, disconnect decrements", () => {
			expect(engine.snapshot().clientCount).toBe(0);

			engine.clientConnect();
			expect(engine.snapshot().clientCount).toBe(1);

			engine.clientConnect();
			expect(engine.snapshot().clientCount).toBe(2);

			engine.clientDisconnect();
			expect(engine.snapshot().clientCount).toBe(1);

			engine.clientDisconnect();
			expect(engine.snapshot().clientCount).toBe(0);
		});

		it("disconnect never goes below zero", () => {
			engine.clientDisconnect();
			expect(engine.snapshot().clientCount).toBe(0);
		});

		it("connect returns init payload with current state", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.documentReady("/tmp/doc.html");

			const { initPayload } = engine.clientConnect();
			expect(initPayload.type).toBe("init");
			expect(initPayload.agentRunning).toBe(true);
			expect(initPayload.isStreaming).toBe(true);
			expect(initPayload.hasDocument).toBe(true);
			expect(initPayload.phase).toBe("streaming");
		});

		it("connect returns full event history for replay", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.documentReady("/tmp/doc.html");

			const { history } = engine.clientConnect();

			// Should contain agent_start, doc_ready
			expect(history.some((e) => {
				return (e.event as { type?: string })?.type === "agent_start";
			})).toBe(true);
			expect(history.some((e) => e.type === "doc_ready")).toBe(true);
		});

		it("late-joining client gets complete history", () => {
			engine.serverStarted();
			engine.sessionCreated();

			// Lots of events happen...
			engine.agentStart();
			engine.agentEnd();
			engine.agentStart(); // second turn
			engine.documentReady("/tmp/doc.html");
			engine.agentEnd();

			// NOW a client connects
			const { history } = engine.clientConnect();

			// Should have all events
			const types = history.map((e) => e.type);
			expect(types.filter((t) => t === "rpc_event").length).toBeGreaterThanOrEqual(4);
			expect(types).toContain("doc_ready");
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Chat: steering vs new turn
	// ═════════════════════════════════════════════════════════════════

	describe("chat: steering vs new turn", () => {
		beforeEach(() => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
		});

		it("chat while streaming → steering mode", () => {
			const result = engine.chatMessage("what about X?");
			expect(result.allowed).toBe(true);
			expect(result.steering).toBe(true);
			expect(engine.snapshot().phase).toBe("streaming");
		});

		it("chat while waiting → new turn", () => {
			engine.agentEnd();
			const result = engine.chatMessage("tell me more");
			expect(result.allowed).toBe(true);
			expect(result.steering).toBe(false);
			expect(engine.snapshot().phase).toBe("streaming");
		});

		it("chat while stopped → rejected", () => {
			engine.stop();
			const result = engine.chatMessage("hello");
			expect(result.allowed).toBe(false);
		});

		it("chat while failed → rejected", () => {
			engine = new EngineStateMachine({ maxCrashRestarts: 0 });
			engine.serverStarted();
			engine.sessionFailed("fatal");
			expect(engine.snapshot().phase).toBe("failed");

			const result = engine.chatMessage("hello");
			expect(result.allowed).toBe(false);
		});

		it("chat before agent ready → rejected", () => {
			engine = new EngineStateMachine();
			engine.serverStarted();
			// Session not created yet
			const result = engine.chatMessage("hello");
			expect(result.allowed).toBe(false);
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Abort
	// ═════════════════════════════════════════════════════════════════

	describe("abort", () => {
		it("abort while streaming → waiting", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();

			engine.abort();
			expect(engine.snapshot().phase).toBe("waiting");
			expect(engine.snapshot().isStreaming).toBe(false);

			const endEvent = engine.broadcasts.filter(
				(e) => e.type === "rpc_event" && (e.event as { type?: string })?.type === "agent_end",
			);
			expect(endEvent.length).toBeGreaterThan(0);
		});

		it("abort while waiting → no-op", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.agentEnd();
			const prevBroadcasts = engine.broadcasts.length;

			engine.abort();
			// No new broadcasts
			expect(engine.broadcasts.length).toBe(prevBroadcasts);
			expect(engine.snapshot().phase).toBe("waiting");
		});

		it("abort while stopped → no-op", () => {
			engine.stop();
			engine.abort();
			expect(engine.snapshot().phase).toBe("stopped");
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Combined state scenarios
	// ═════════════════════════════════════════════════════════════════

	describe("combined scenarios", () => {
		it("client connects during crash restart cycle", () => {
			engine = new EngineStateMachine({ maxCrashRestarts: 3 });
			engine.serverStarted();
			engine.sessionFailed("crash 1");
			expect(engine.snapshot().phase).toBe("restarting");

			// Client connects during restart
			const { initPayload, history } = engine.clientConnect();
			expect(initPayload.phase).toBe("restarting");
			expect(initPayload.agentRunning).toBe(false);

			// History should include the crash event
			expect(history.some((e) => e.type === "agent_exit")).toBe(true);
		});

		it("multiple clients: one stops, all see it", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();

			engine.clientConnect();
			engine.clientConnect();
			engine.clientConnect();
			expect(engine.snapshot().clientCount).toBe(3);

			// Clear broadcasts to check only stop events
			engine.broadcasts.length = 0;
			engine.stop();

			// agent_stopped should be in broadcasts (visible to all)
			expect(engine.broadcasts.some((e) => e.type === "agent_stopped")).toBe(true);
		});

		it("validation during chat turn", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();

			// Agent writes a document
			engine.documentReady("/tmp/doc.html");

			// Validation starts while agent is streaming
			engine.validationStart();
			expect(engine.snapshot().validation).toBe("validating");
			expect(engine.snapshot().isStreaming).toBe(true);

			// Agent finishes turn
			engine.agentEnd();

			// Validation completes
			engine.validationPassed();
			expect(engine.snapshot().validation).toBe("validated");

			// User can still chat
			const chat = engine.chatMessage("looks good");
			expect(chat.allowed).toBe(true);
		});

		it("crash during validation → validation resets on stop", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.documentReady("/tmp/doc.html");
			engine.validationStart();

			engine.promptError("crash");
			// Engine is restarting, validation should still be tracked
			expect(engine.snapshot().validation).toBe("validating");

			// But if we stop, validation resets
			engine.stop();
			expect(engine.snapshot().validation).toBe("none");
		});

		it("full exploration lifecycle", () => {
			// Simulates a complete storyof session:
			// 1. Start server + agent
			// 2. Agent explores codebase (streaming)
			// 3. Agent writes document
			// 4. Validation runs, finds errors, agent fixes
			// 5. User asks follow-up questions
			// 6. User stops

			engine = new EngineStateMachine({ maxValidationAttempts: 3 });
			engine.serverStarted();
			engine.sessionCreated();

			// Client connects
			engine.clientConnect();

			// Agent starts exploring
			engine.agentStart();
			expect(engine.snapshot().phase).toBe("streaming");

			// Agent writes the architecture document
			engine.documentReady("/tmp/architecture.html");
			expect(engine.snapshot().hasDocument).toBe(true);

			// Agent finishes initial exploration
			engine.agentEnd();
			expect(engine.snapshot().phase).toBe("waiting");

			// Validation runs — finds mermaid errors
			engine.validationStart();
			engine.validationFailed(2);
			expect(engine.snapshot().validation).toBe("fix_sent");

			// Agent fixes (new turn for fix prompt)
			engine.agentStart();
			engine.documentReady("/tmp/architecture.html"); // updated
			engine.agentEnd();

			// Re-validate — passes
			engine.validationStart();
			engine.validationPassed();
			expect(engine.snapshot().validation).toBe("validated");

			// User asks a follow-up question
			const chat1 = engine.chatMessage("explain the auth module");
			expect(chat1.allowed).toBe(true);
			expect(chat1.steering).toBe(false);
			engine.agentEnd();

			// User asks while agent is idle
			const chat2 = engine.chatMessage("what about error handling?");
			expect(chat2.allowed).toBe(true);
			engine.agentEnd();

			// Second client joins late
			const { history } = engine.clientConnect();
			expect(history.length).toBeGreaterThan(5);

			// User stops
			engine.stop();
			expect(engine.snapshot().phase).toBe("stopped");
			expect(engine.snapshot().clientCount).toBe(2);
		});

		it("rapid chat messages during streaming (concurrent)", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();

			// Simulate rapid concurrent chat messages (all steering)
			const r1 = engine.chatMessage("msg1");
			const r2 = engine.chatMessage("msg2");
			const r3 = engine.chatMessage("msg3");

			expect(r1.allowed).toBe(true);
			expect(r1.steering).toBe(true);
			expect(r2.steering).toBe(true);
			expect(r3.steering).toBe(true);

			// Engine should still be streaming
			expect(engine.snapshot().phase).toBe("streaming");
		});

		it("abort then immediate chat", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();

			engine.abort();
			expect(engine.snapshot().phase).toBe("waiting");

			// Immediate chat should start a new turn
			const chat = engine.chatMessage("new question");
			expect(chat.allowed).toBe(true);
			expect(chat.steering).toBe(false);
			expect(engine.snapshot().phase).toBe("streaming");
		});

		it("client disconnects and reconnects, gets history", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.documentReady("/tmp/doc.html");

			// Client 1 connects, sees events live
			engine.clientConnect();

			// Events happen
			engine.agentEnd();
			engine.agentStart();

			// Client 1 disconnects
			engine.clientDisconnect();
			expect(engine.snapshot().clientCount).toBe(0);

			// More events happen while no clients connected
			engine.agentEnd();

			// Client reconnects
			const { history } = engine.clientConnect();

			// Should have ALL events, including those during disconnect
			const agentEndEvents = history.filter(
				(e) => e.type === "rpc_event" && (e.event as { type?: string })?.type === "agent_end",
			);
			expect(agentEndEvents.length).toBe(2); // both agent_end events
		});

		it("stop during active validation fix cycle", () => {
			engine = new EngineStateMachine({ maxValidationAttempts: 3 });
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.documentReady("/tmp/doc.html");

			// Validation fails, fix sent to agent
			engine.validationStart();
			engine.validationFailed(3);
			expect(engine.snapshot().validation).toBe("fix_sent");

			// Agent is working on the fix (streaming)
			engine.agentStart();

			// User stops mid-fix
			engine.stop();
			expect(engine.snapshot().phase).toBe("stopped");
			expect(engine.snapshot().isStreaming).toBe(false);
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Event history integrity
	// ═════════════════════════════════════════════════════════════════

	describe("event history integrity", () => {
		it("all broadcasts are stored in history", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.agentEnd();
			engine.agentStart();
			engine.documentReady("/tmp/doc.html");
			engine.validationStart();
			engine.validationPassed();
			engine.agentEnd();
			engine.stop();

			// Every broadcast should also be in history
			expect(engine.eventHistory.length).toBe(engine.broadcasts.length);
			expect(engine.eventHistory).toEqual(engine.broadcasts);
		});

		it("history survives crash/restart", () => {
			engine = new EngineStateMachine({ maxCrashRestarts: 3 });
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.agentEnd();

			const historyBefore = engine.eventHistory.length;

			engine.promptError("crash");
			// History should grow, not reset
			expect(engine.eventHistory.length).toBeGreaterThan(historyBefore);
		});

		it("history order is chronological", () => {
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.documentReady("/tmp/doc.html");
			engine.agentEnd();

			const types = engine.eventHistory.map((e) => e.type);

			// agent_start should come before doc_ready
			const startIdx = types.findIndex(
				(t, i) => t === "rpc_event" && (engine.eventHistory[i].event as { type?: string })?.type === "agent_start",
			);
			const docIdx = types.indexOf("doc_ready");
			let endIdx = -1;
			for (let i = types.length - 1; i >= 0; i--) {
				if (types[i] === "rpc_event" && (engine.eventHistory[i].event as { type?: string })?.type === "agent_end") {
					endIdx = i;
					break;
				}
			}

			expect(startIdx).toBeLessThan(docIdx);
			expect(docIdx).toBeLessThan(endIdx);
		});
	});

	// ═════════════════════════════════════════════════════════════════
	// Edge cases / guards
	// ═════════════════════════════════════════════════════════════════

	describe("edge cases", () => {
		it("double serverStarted is no-op", () => {
			engine.serverStarted();
			engine.serverStarted(); // should be ignored
			expect(engine.snapshot().phase).toBe("starting");
		});

		it("agentEnd without agentStart on stopped engine", () => {
			engine.stop();
			engine.agentEnd(); // should be no-op
			expect(engine.snapshot().phase).toBe("stopped");
		});

		it("documentReady with no agent", () => {
			engine.documentReady("/tmp/doc.html");
			expect(engine.snapshot().hasDocument).toBe(true);
			// Should still work — document can exist independently
		});

		it("zero max crash restarts → immediate failure", () => {
			engine = new EngineStateMachine({ maxCrashRestarts: 0 });
			engine.serverStarted();
			engine.sessionFailed("err");
			expect(engine.snapshot().phase).toBe("failed");
		});

		it("zero max validation attempts → gave_up on first failure", () => {
			engine = new EngineStateMachine({ maxValidationAttempts: 0 });
			engine.serverStarted();
			engine.sessionCreated();
			engine.agentStart();
			engine.documentReady("/tmp/doc.html");

			engine.validationStart();
			engine.validationFailed(1);
			expect(engine.snapshot().validation).toBe("gave_up");
		});
	});
});
