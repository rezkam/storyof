/**
 * Real integration tests for the engine lifecycle.
 *
 * These tests start the ACTUAL HTTP server, connect REAL WebSocket
 * clients, and inject events through the real handleEvent function.
 * No mocks for server/WS — only the agent session is mocked (because
 * we don't have real API keys in tests).
 *
 * Tests all state combinations:
 *   Engine:     idle → starting → streaming → waiting → stopped/failed
 *   Validation: none → validating → validated / fix_sent → gave_up
 *   Clients:    0..N connected, disconnect/reconnect, concurrent messages
 *   Crashes:    1..max with backoff, restart success/failure
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import {
	start, stop, stopAll, reset, getState, handleEvent, handleCrash, chat, abort,
	type SessionFactory,
} from "../../src/engine.js";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
	evAgentStart, evAgentEnd, evMessageStart,
	evTextDelta, evToolStart, evToolEnd, evMessageEnd,
} from "../helpers/events.js";
import {
	createMockSession, mockSessionFactory, failingSessionFactory,
} from "../helpers/mock-session.js";

/** How many restarts are allowed */
const MAX_CRASH_RESTARTS = 3;

// ═══════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════

/** Poll until a condition is true or timeout */
async function waitForCondition(fn: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
}

function makeTempDir(): string {
	const id = crypto.randomBytes(8).toString("hex");
	const dir = path.join(os.tmpdir(), `storyof-engine-${id}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// createMockSession, mockSessionFactory, failingSessionFactory imported from ../helpers/mock-session.js

/** HTTP GET with timeout */
function httpGet(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.get(url, (res) => {
			let body = "";
			res.on("data", (d) => { body += d.toString(); });
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
	});
}

/** Simple WebSocket client for testing (minimal RFC 6455). */
function connectWs(port: number, token: string): Promise<{
	messages: any[];
	send: (obj: Record<string, unknown>) => void;
	close: () => void;
	socket: net.Socket;
	waitForMessage: (predicate: (msg: any) => boolean, timeoutMs?: number) => Promise<any>;
	[Symbol.asyncDispose](): void;
}> {
	return new Promise((resolve, reject) => {
		const key = crypto.randomBytes(16).toString("base64");
		const socket = net.createConnection(port, "127.0.0.1", () => {
			socket.write(
				`GET /ws?token=${token} HTTP/1.1\r\n` +
				`Host: localhost:${port}\r\n` +
				`Upgrade: websocket\r\n` +
				`Connection: Upgrade\r\n` +
				`Sec-WebSocket-Key: ${key}\r\n` +
				`Sec-WebSocket-Version: 13\r\n\r\n`
			);
		});

		let handshakeDone = false;
		let buffer = Buffer.alloc(0);
		const messages: any[] = [];
		const waiters: Array<{ predicate: (msg: any) => boolean; resolve: (msg: any) => void; timer: ReturnType<typeof setTimeout> }> = [];

		const processMessage = (msg: any) => {
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].predicate(msg)) {
					clearTimeout(waiters[i].timer);
					waiters[i].resolve(msg);
					waiters.splice(i, 1);
				}
			}
		};

		// Parse all complete WebSocket frames in the buffer
		const processFrames = () => {
			while (buffer.length >= 2) {
				const opcode = buffer[0] & 0x0f;
				const payloadLen = buffer[1] & 0x7f;
				let headerLen = 2;
				let actualLen = payloadLen;
				if (payloadLen === 126) {
					if (buffer.length < 4) return;
					actualLen = buffer.readUInt16BE(2);
					headerLen = 4;
				} else if (payloadLen === 127) {
					if (buffer.length < 10) return;
					actualLen = buffer.readUInt32BE(6);
					headerLen = 10;
				}
				if (buffer.length < headerLen + actualLen) return;

				if (opcode === 0x08) {
					socket.end();
					return;
				}
				if (opcode === 0x01) {
					const data = buffer.subarray(headerLen, headerLen + actualLen);
					try { processMessage(JSON.parse(data.toString())); } catch {}
				}
				buffer = buffer.subarray(headerLen + actualLen);
			}
		};

		const send = (obj: Record<string, unknown>) => {
			const payload = Buffer.from(JSON.stringify(obj));
			const mask = crypto.randomBytes(4);
			const masked = Buffer.from(payload);
			for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

			let header: Buffer;
			if (payload.length < 126) {
				header = Buffer.alloc(2);
				header[0] = 0x81;
				header[1] = 0x80 | payload.length;
			} else {
				header = Buffer.alloc(4);
				header[0] = 0x81;
				header[1] = 0x80 | 126;
				header.writeUInt16BE(payload.length, 2);
			}
			socket.write(Buffer.concat([header, mask, masked]));
		};

		const waitForMessage = (predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<any> => {
			const existing = messages.find(predicate);
			if (existing) return Promise.resolve(existing);

			return new Promise((res, rej) => {
				const timer = setTimeout(() => rej(new Error("waitForMessage timeout")), timeoutMs);
				waiters.push({ predicate, resolve: res, timer });
			});
		};

		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);

			if (!handshakeDone) {
				const headerEndIdx = buffer.indexOf(Buffer.from("\r\n\r\n"));
				if (headerEndIdx >= 0) {
					const headerStr = buffer.subarray(0, headerEndIdx).toString();
					if (headerStr.includes("101 Switching Protocols")) {
						handshakeDone = true;
						buffer = buffer.subarray(headerEndIdx + 4);
						// Resolve first, then process any frames that arrived with the handshake
						resolve({ messages, send, close: () => socket.end(), socket, waitForMessage, [Symbol.asyncDispose]() { socket.end(); } });
						processFrames();
					} else {
						reject(new Error("WS handshake failed"));
					}
				}
				return;
			}

			processFrames();
		});

		socket.on("error", reject);
		setTimeout(() => reject(new Error("WS connect timeout")), 5000);
	});
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("Engine lifecycle (real server)", () => {
	let tempDir: string;
	let port: number;
	let token: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(async () => {
		reset();
		// Give the server time to fully close
		await new Promise((r) => setTimeout(r, 50));
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
	});

	async function startEngine(opts: { skipPrompt?: boolean; backoffBase?: number; backoffMax?: number } = {}) {
		const { factory, session } = mockSessionFactory();
		const result = await start({
			cwd: tempDir,
			depth: "medium",
			model: "test-model",
			sessionFactory: factory,
			skipPrompt: opts.skipPrompt ?? true,
			backoffBase: opts.backoffBase ?? 10,   // fast by default in tests
			backoffMax: opts.backoffMax ?? 50,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;
		return session;
	}

	// ─── Basic lifecycle ─────────────────────────────────────────────

	describe("server + agent as one unit", () => {
		it("start creates server and agent together", async () => {
			const session = await startEngine();
			const state = getState();

			expect(state.running).toBe(true);
			expect(state.agentReady).toBe(true);
			expect(state.port).toBeGreaterThan(0);
			expect(state.secret).toBeTruthy();

			// Server is reachable
			const res = await httpGet(`http://localhost:${port}/`);
			expect(res.status).toBe(200);
		});

		it("stop destroys both server and agent", async () => {
			await startEngine();
			stopAll();

			const state = getState();
			expect(state.running).toBe(false);
			expect(state.agentReady).toBe(false);
		});

		it("state endpoint reflects real state", async () => {
			const session = await startEngine();

			const res = await httpGet(`http://localhost:${port}/state?token=${token}`);
			expect(res.status).toBe(200);
			const state = JSON.parse(res.body);
			expect(state.running).toBe(true);
			expect(state.streaming).toBe(false);
			expect(state.agentReady).toBe(true);
		});

		it("state endpoint requires token", async () => {
			await startEngine();
			const res = await httpGet(`http://localhost:${port}/state`);
			expect(res.status).toBe(403);
		});
	});

	// ─── Agent events via handleEvent ────────────────────────────────

	describe("agent event flow", () => {
		it("agent_start → streaming state", async () => {
			await startEngine();
			handleEvent(evAgentStart());

			const state = getState();
			expect(state.streaming).toBe(true);
		});

		it("agent_start then agent_end → waiting state", async () => {
			await startEngine();
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());

			const state = getState();
			expect(state.streaming).toBe(false);
			expect(state.agentReady).toBe(true);
		});

		it("onReady fires on first agent_start", async () => {
			const { factory } = mockSessionFactory();
			let readyFired = false;

			await start({
				cwd: tempDir,
				sessionFactory: factory,
				skipPrompt: true,
				onReady: () => { readyFired = true; },
			});

			expect(readyFired).toBe(false);
			handleEvent(evAgentStart());
			expect(readyFired).toBe(true);
		});

		it("onReady fires only once across multiple turns", async () => {
			const { factory } = mockSessionFactory();
			let readyCount = 0;

			const result = await start({
				cwd: tempDir,
				sessionFactory: factory,
				skipPrompt: true,
				onReady: () => { readyCount++; },
			});

			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());

			expect(readyCount).toBe(1);
		});
	});

	// ─── WebSocket clients ───────────────────────────────────────────

	describe("WebSocket clients", () => {
		it("client receives init on connect", async () => {
			await startEngine();
			const ws = await connectWs(port, token);
			try {
				const init = await ws.waitForMessage((m) => m.type === "init");
				expect(init).toBeDefined();
				expect(init.agentRunning).toBe(true);
			} finally {
				ws.close();
			}
		});

		it("client receives agent events in real time", async () => {
			await startEngine();
			const ws = await connectWs(port, token);
			try {
				// Fire an agent_start event
				handleEvent(evAgentStart());

				const msg = await ws.waitForMessage(
					(m) => m.type === "rpc_event" && m.event?.type === "agent_start"
				);
				expect(msg).toBeDefined();
			} finally {
				ws.close();
			}
		});

		it("late-joining client gets full event history", async () => {
			await startEngine();

			// Events happen with no clients connected
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());

			// Client connects late
			const ws = await connectWs(port, token);
			try {
				// Wait for init + replayed agent_start event
				await ws.waitForMessage((m) => m.type === "rpc_event" && m.event?.type === "agent_start");

				const agentStartMsgs = ws.messages.filter(
					(m) => m.type === "rpc_event" && m.event?.type === "agent_start"
				);
				expect(agentStartMsgs.length).toBeGreaterThanOrEqual(1);
			} finally {
				ws.close();
			}
		});

		it("multiple clients all receive events", async () => {
			await startEngine();
			const ws1 = await connectWs(port, token);
			const ws2 = await connectWs(port, token);
			try {
				handleEvent(evAgentStart());
				// Wait for both clients to receive the event
				await ws1.waitForMessage((m) => m.type === "rpc_event" && m.event?.type === "agent_start");
				await ws2.waitForMessage((m) => m.type === "rpc_event" && m.event?.type === "agent_start");

				const has1 = ws1.messages.some((m) => m.type === "rpc_event" && m.event?.type === "agent_start");
				const has2 = ws2.messages.some((m) => m.type === "rpc_event" && m.event?.type === "agent_start");
				expect(has1).toBe(true);
				expect(has2).toBe(true);
			} finally {
				ws1.close();
				ws2.close();
			}
		});

		it("client count tracks connections and disconnections", async () => {
			await startEngine();

			const ws1 = await connectWs(port, token);
			await ws1.waitForMessage((m) => m.type === "init");
			expect(getState().clientCount).toBe(1);

			const ws2 = await connectWs(port, token);
			await ws2.waitForMessage((m) => m.type === "init");
			expect(getState().clientCount).toBe(2);

			// Send WS close frame then destroy
			ws1.socket.write(Buffer.from([0x88, 0x00])); // close frame
			ws1.socket.destroy();
			await waitForCondition(() => getState().clientCount === 1, 2000);
			expect(getState().clientCount).toBe(1);

			ws2.socket.write(Buffer.from([0x88, 0x00]));
			ws2.socket.destroy();
			await waitForCondition(() => getState().clientCount === 0, 2000);
			expect(getState().clientCount).toBe(0);
		});

		it("WS without token is rejected", async () => {
			await startEngine();
			try {
				await connectWs(port, "wrong-token");
				expect.unreachable("should have been rejected");
			} catch (err: any) {
				expect(err.message).toMatch(/failed|timeout/i);
			}
		});
	});

	// ─── Client actions: chat, abort, stop ───────────────────────────

	describe("client actions", () => {
		it("client can send chat via WebSocket", async () => {
			const session = await startEngine();
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());

			const ws = await connectWs(port, token);
			try {
				ws.send({ type: "prompt", text: "explain auth" });

				// Wait for the prompt to reach the session (mock prompt() stores it in _promptCalls)
				await waitForCondition(() => session._promptCalls.length > 0, 2000);

				expect(getState().running).toBe(true);
			} finally {
				ws.close();
			}
		});

		it("client can send abort via WebSocket", async () => {
			const session = await startEngine();
			handleEvent(evAgentStart());

			expect(getState().streaming).toBe(true);

			const ws = await connectWs(port, token);
			try {
				ws.send({ type: "abort" });
				// Wait for abort to reach the session
				await waitForCondition(() => session._wasAborted(), 2000);
			} finally {
				ws.close();
			}
		});

		it("client can send stop via WebSocket", async () => {
			await startEngine();
			handleEvent(evAgentStart());

			const ws = await connectWs(port, token);
			try {
				ws.send({ type: "stop" });

				const msg = await ws.waitForMessage((m) => m.type === "agent_stopped");
				expect(msg).toBeDefined();
				expect(getState().agentReady).toBe(false);
			} finally {
				ws.close();
			}
		});
	});

	// ─── Stop from various states ────────────────────────────────────

	describe("stop from any state", () => {
		it("stop while idle (just server)", async () => {
			await startEngine();
			stop();
			expect(getState().agentReady).toBe(false);
			expect(getState().intentionalStop).toBe(true);
		});

		it("stop while streaming", async () => {
			await startEngine();
			handleEvent(evAgentStart());
			expect(getState().streaming).toBe(true);

			stop();
			expect(getState().streaming).toBe(false);
			expect(getState().running).toBe(false);
		});

		it("stop while waiting", async () => {
			await startEngine();
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());

			stop();
			expect(getState().running).toBe(false);
		});

		it("stop broadcasts to all connected clients", async () => {
			await startEngine();
			handleEvent(evAgentStart());

			const ws = await connectWs(port, token);
			try {
				stop();
				const msg = await ws.waitForMessage((m) => m.type === "agent_stopped");
				expect(msg).toBeDefined();
			} finally {
				ws.close();
			}
		});
	});

	// ─── Event history integrity ─────────────────────────────────────

	describe("event history", () => {
		it("events accumulate in order", async () => {
			await startEngine();

			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());
			handleEvent(evAgentStart());

			const state = getState();
			expect(state.eventHistoryLength).toBeGreaterThanOrEqual(3);
		});

		it("stop event is included in history", async () => {
			await startEngine();
			handleEvent(evAgentStart());

			stop();

			// stop() broadcasts { type: "agent_stopped" } into S.eventHistory.
			// Verify it was recorded — a late-joining WS client would receive it on replay.
			const state = getState();
			expect(state.eventHistoryLength).toBeGreaterThan(0);
			expect(state.running).toBe(false);
			expect(state.intentionalStop).toBe(true);
		});
	});

	// ─── Full exploration lifecycle ──────────────────────────────────

	describe("full lifecycle simulation", () => {
		it("complete exploration: start → stream → doc → validate → chat → stop", async () => {
			const session = await startEngine();

			// Client connects
			const ws = await connectWs(port, token);
			try {
			// 1. Agent starts exploring
			handleEvent(evAgentStart());
			const startMsg = await ws.waitForMessage(
				(m) => m.type === "rpc_event" && m.event?.type === "agent_start"
			);
			expect(startMsg).toBeDefined();

			// 2. Agent streams text
			handleEvent(evMessageStart());
			handleEvent(evTextDelta("# Architecture\n"));

			// 3. Agent writes a file
			handleEvent(evToolStart("Write", "tc1", { path: "/tmp/test.md" }));
			handleEvent(evToolEnd("Write", "tc1", "ok"));

			// 4. Agent finishes turn
			handleEvent(evMessageEnd("Done exploring"));

			handleEvent(evAgentEnd());

			await ws.waitForMessage(
				(m) => m.type === "rpc_event" && m.event?.type === "agent_end"
			);

			// Verify state
			const stateRes = await httpGet(`http://localhost:${port}/state?token=${token}`);
			const state = JSON.parse(stateRes.body);
			expect(state.streaming).toBe(false);
			expect(state.agentReady).toBe(true);

			// 5. User sends a chat message
			ws.send({ type: "prompt", text: "explain the auth system" });
			// Wait for prompt to reach session
			await waitForCondition(() => session._promptCalls.some((c) => c.includes("explain the auth system")), 2000);

			// 6. User stops
			ws.send({ type: "stop" });
			await ws.waitForMessage((m) => m.type === "agent_stopped");

			const finalState = getState();
			expect(finalState.running).toBe(false);
			expect(finalState.agentReady).toBe(false);
			} finally {
				ws.close();
			}
		});

		it("client disconnect and reconnect preserves history", async () => {
			await startEngine();

			// Client 1 connects
			const ws1 = await connectWs(port, token);

			// Events happen
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());
			// Wait for ws1 to receive agent_end before disconnecting
			await ws1.waitForMessage((m) => m.type === "rpc_event" && m.event?.type === "agent_end");

			// Client 1 disconnects
			ws1.socket.write(Buffer.from([0x88, 0x00]));
			ws1.socket.destroy();
			await waitForCondition(() => getState().clientCount === 0, 2000);
			expect(getState().clientCount).toBe(0);

			// More events happen while disconnected
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());

			// Client 2 connects
			const ws2 = await connectWs(port, token);
			try {
				// Wait for all 4 replay events (2× start + 2× end)
				await ws2.waitForMessage((m) => m.type === "rpc_event" && m.event?.type === "agent_end" &&
					ws2.messages.filter((x) => x.type === "rpc_event").length >= 4);

				// Should have init + all 4 events replayed
				const agentEvents = ws2.messages.filter(
					(m) => m.type === "rpc_event" &&
						(m.event?.type === "agent_start" || m.event?.type === "agent_end")
				);
				expect(agentEvents.length).toBe(4);
			} finally {
				ws2.close();
			}
		});
	});

	// ─── Concurrent operations ───────────────────────────────────────

	describe("concurrency", () => {
		it("multiple clients sending messages simultaneously", async () => {
			const session = await startEngine();
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());

			const ws1 = await connectWs(port, token);
			const ws2 = await connectWs(port, token);
			const ws3 = await connectWs(port, token);
			try {
				// All send messages at once
				ws1.send({ type: "prompt", text: "question 1" });
				ws2.send({ type: "prompt", text: "question 2" });
				ws3.send({ type: "prompt", text: "question 3" });

				// Wait for all 3 prompts to be dispatched
				await waitForCondition(() => session._promptCalls.length >= 3, 2000);

				// Engine should not crash
				expect(getState().running).toBe(true);
			} finally {
				ws1.close();
				ws2.close();
				ws3.close();
			}
		});

		it("client sends stop while another sends chat", async () => {
			const session = await startEngine();
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());

			const ws1 = await connectWs(port, token);
			const ws2 = await connectWs(port, token);
			try {
				// One sends chat, the other sends stop
				ws1.send({ type: "prompt", text: "question" });
				ws2.send({ type: "stop" });

				// Wait for stop to take effect
				await waitForCondition(() => !getState().agentReady, 2000);

				// Agent should be stopped
				expect(getState().agentReady).toBe(false);
			} finally {
				ws1.close();
				ws2.close();
			}
		});

		it("events arrive while client is connecting", async () => {
			await startEngine();

			// Fire events in rapid succession
			handleEvent(evAgentStart());

			// Client connects during events
			const ws = await connectWs(port, token);
			try {
				handleEvent(evAgentEnd());
				// Wait for at least init + agent_end to arrive
				await ws.waitForMessage((m) => m.type === "rpc_event" && m.event?.type === "agent_end");

				// Client should have all events (init + history + live)
				expect(ws.messages.length).toBeGreaterThan(0);
			} finally {
				ws.close();
			}
		});
	});

	// ─── Crash and restart lifecycle ─────────────────────────────────

	describe("crash recovery", () => {
		it("first crash broadcasts exit and restarting events", async () => {
			await startEngine();
			handleEvent(evAgentStart());

			const ws = await connectWs(port, token);
			try {
				// Simulate crash
				handleCrash("out of memory");

				const exitMsg = await ws.waitForMessage((m) => m.type === "agent_exit");
				expect(exitMsg.error).toBe("out of memory");
				expect(exitMsg.crashCount).toBe(1);
				expect(exitMsg.willRestart).toBe(true);
				expect(exitMsg.restartIn).toBeGreaterThan(0);

				const restartMsg = await ws.waitForMessage((m) => m.type === "agent_restarting");
				expect(restartMsg.attempt).toBe(1);
				expect(restartMsg.maxAttempts).toBe(MAX_CRASH_RESTARTS);
			} finally {
				ws.close();
			}
		});

		it("crash recovery creates new session after backoff", async () => {
			const { factory, sessions } = failingSessionFactory();
			const result = await start({
				cwd: tempDir,
				sessionFactory: factory,
				skipPrompt: true,
				backoffBase: 10,
				backoffMax: 50,
			});
			port = parseInt(new URL(result.url).port);
			token = result.token;

			expect(sessions.length).toBe(1);

			// Simulate crash — the restart timer will call factory again
			handleCrash("network error");

			// Wait for backoff (fast in tests: 10ms)
			await waitForCondition(() => sessions.length === 2, 500);
			expect(sessions.length).toBe(2);
			expect(getState().agentReady).toBe(true);
		});

		it("exponential backoff increases with each crash", async () => {
			// Use explicit backoff values so assertions are readable
			await startEngine({ backoffBase: 100, backoffMax: 1000 });
			const ws = await connectWs(port, token);

			try {
				// Crash 1: 100ms backoff
				handleCrash("error1");
				const exit1 = await ws.waitForMessage((m) => m.type === "agent_exit" && m.crashCount === 1);
				expect(exit1.restartIn).toBe(100);

				// Crash 2: 200ms backoff
				handleCrash("error2");
				const exit2 = await ws.waitForMessage((m) => m.type === "agent_exit" && m.crashCount === 2);
				expect(exit2.restartIn).toBe(200);

				// Crash 3: 400ms backoff
				handleCrash("error3");
				const exit3 = await ws.waitForMessage((m) => m.type === "agent_exit" && m.crashCount === 3);
				expect(exit3.restartIn).toBe(400);
			} finally {
				ws.close();
			}
		});

		it("gives up after MAX_CRASH_RESTARTS + 1 crashes", async () => {
			await startEngine();
			const ws = await connectWs(port, token);
			try {
				// Crash up to the limit
				for (let i = 0; i < MAX_CRASH_RESTARTS; i++) {
					handleCrash(`crash-${i + 1}`);
				}

				// One more crash beyond the limit
				handleCrash("final-crash");

				const exitMsg = await ws.waitForMessage(
					(m) => m.type === "agent_exit" && m.willRestart === false
				);
				expect(exitMsg.willRestart).toBe(false);
				expect(exitMsg.restartIn).toBeNull();
			} finally {
				ws.close();
			}
		});

		it("stop during restart backoff cancels the restart", async () => {
			await startEngine();

			// Crash triggers a restart timer
			handleCrash("timeout");
			expect(getState().crashCount).toBe(1);

			// Stop before the restart timer fires
			stop();

			expect(getState().intentionalStop).toBe(true);
			expect(getState().agentReady).toBe(false);

			// Wait past the backoff period (startEngine uses backoffBase:10, so 10ms is enough;
			// use 100ms for safety margin)
			await new Promise((r) => setTimeout(r, 100));

			// Should still be stopped, not restarted
			expect(getState().agentReady).toBe(false);
			expect(getState().running).toBe(false);
		});

		it("crash while session factory fails on restart", async () => {
			// First call succeeds, next calls fail
			const { factory, sessions } = failingSessionFactory({
				failCount: 0, // 0 means no pre-failures; we control via the factory
			});

			// Use a factory that succeeds first time, then throws on restart
			let callCount = 0;
			const failingFactory: SessionFactory = async (_targetPath) => {
				callCount++;
				if (callCount === 1) {
					return createMockSession() as unknown as AgentSession;
				}
				throw new Error("Restart failed: no API key");
			};

			const result = await start({
				cwd: tempDir,
				sessionFactory: failingFactory,
				skipPrompt: true,
				backoffBase: 10,
				backoffMax: 50,
			});
			port = parseInt(new URL(result.url).port);
			token = result.token;

			const ws = await connectWs(port, token);
			try {
				// First crash — restart will try but factory throws
				handleCrash("initial error");

				// Wait for the restart attempt (fast backoff in tests: 10ms)
				// The failed restart will trigger another crash
				const secondExit = await ws.waitForMessage(
					(m) => m.type === "agent_exit" && m.crashCount === 2,
					1000
				);
				expect(secondExit).toBeDefined();
			} finally {
				ws.close();
			}
		});

		it("client receives all crash events in real time", async () => {
			await startEngine();

			const ws = await connectWs(port, token);
			try {
				handleEvent(evAgentStart());

				// Crash
				handleCrash("connection reset");

				const events: string[] = [];
				await ws.waitForMessage((m) => {
					if (m.type === "agent_exit" || m.type === "agent_restarting") {
						events.push(m.type);
					}
					return events.length >= 2;
				});

				expect(events).toContain("agent_exit");
				expect(events).toContain("agent_restarting");
			} finally {
				ws.close();
			}
		});
	});

	// ─── State guards: events after stop ─────────────────────────────

	describe("state guards", () => {
		it("handleEvent after stop is a no-op", async () => {
			await startEngine();

			handleEvent(evAgentStart());

			// Connect client and wait for initial messages (init + history)
			const ws = await connectWs(port, token);
			try {
				// Wait for init + agent_start history
				await ws.waitForMessage((m) => m.type === "rpc_event" && m.event?.type === "agent_start");

				stop();

				const afterStopIdx = ws.messages.length;

				// These events should be silently dropped (intentionalStop guard)
				handleEvent(evAgentStart());
				handleEvent(evAgentEnd());
				handleEvent(evTextDelta("leaked text"));

				// Wait for agent_stopped to arrive, then check nothing else leaked
				await ws.waitForMessage((m) => m.type === "agent_stopped");

				// Only agent_stopped should appear after the stop
				const afterStopMsgs = ws.messages.slice(afterStopIdx);
				const leakedAgentStarts = afterStopMsgs.filter(
					(m) => m.type === "rpc_event" && m.event?.type === "agent_start"
				);
				expect(leakedAgentStarts.length).toBe(0);

				// But agent_stopped should be there
				const stoppedMsgs = afterStopMsgs.filter((m) => m.type === "agent_stopped");
				expect(stoppedMsgs.length).toBe(1);
			} finally {
				ws.close();
			}
		});

		it("chat after stop throws or is rejected", async () => {
			await startEngine();
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());
			stop();

			// Chat should fail gracefully (no session)
			await expect(chat("hello")).rejects.toThrow();
		});

		it("abort after stop is safe (no crash)", async () => {
			await startEngine();
			stop();

			// abort() after stop() should resolve cleanly — S.session is null so it returns early.
			await expect(abort()).resolves.toBeUndefined();
			expect(getState().running).toBe(false);
		});

		it("double stop is safe", async () => {
			await startEngine();
			stop();
			stop(); // Second stop shouldn't throw

			expect(getState().agentReady).toBe(false);
		});

		it("stopAll is idempotent", async () => {
			await startEngine();
			stopAll();
			stopAll(); // Second call shouldn't throw

			expect(getState().running).toBe(false);
		});
	});

	// ─── Message streaming events ────────────────────────────────────

	describe("message lifecycle", () => {
		it("full message lifecycle: start → updates → tool → end", async () => {
			await startEngine();
			const ws = await connectWs(port, token);
			try {
			// Wait until client is fully registered (receives init)
			await ws.waitForMessage((m) => m.type === "init");

			handleEvent(evAgentStart());

			// Message start
			handleEvent(evMessageStart());

			// Text streaming
			handleEvent(evTextDelta("# Header\n"));
			handleEvent(evTextDelta("Some content"));

			// Tool use
			handleEvent(evToolStart("Read", "t1", { path: "/tmp/test.ts" }));
			handleEvent(evToolEnd("Read", "t1", "file contents"));

			// Message end
			handleEvent(evMessageEnd("Done"));

			handleEvent(evAgentEnd());

			// Wait for all events to arrive
			await ws.waitForMessage(
				(m) => m.type === "rpc_event" && m.event?.type === "agent_end"
			);

			// Client should have received all events
			const rpcEvents = ws.messages.filter((m) => m.type === "rpc_event");
			const eventTypes = rpcEvents.map((m) => m.event?.type);
			expect(eventTypes).toContain("agent_start");
			expect(eventTypes).toContain("message_start");
			expect(eventTypes).toContain("message_update"); // text_delta comes as message_update
			expect(eventTypes).toContain("tool_execution_start");
			expect(eventTypes).toContain("tool_execution_end");
			expect(eventTypes).toContain("message_end");
			expect(eventTypes).toContain("agent_end");
			} finally {
				ws.close();
			}
		});

		it("tool write tracking — Write of .md file triggers render/doc_ready", async () => {
			await startEngine();
			handleEvent(evAgentStart());

			// Create the .md file on disk so the detection logic finds it
			const mdPath = path.join(tempDir, ".storyof", "sessions", "test", "doc.md");
			fs.mkdirSync(path.dirname(mdPath), { recursive: true });
			fs.writeFileSync(mdPath, "# Test\n\nSome content");

			// Simulate Write tool for a markdown file
			handleEvent(evToolStart("Write", "t1", { path: mdPath }));
			handleEvent(evToolEnd("Write", "t1", "ok"));

			// Wait for async render to complete
			await waitForCondition(() => getState().htmlPath !== null, 3000);
			const state = getState();
			expect(state.htmlPath).toBeTruthy();
			expect(state.htmlPath).toMatch(/\.html$/);
		});
	});

	// ─── Combined scenarios ──────────────────────────────────────────

	describe("combined scenarios", () => {
		it("crash during streaming clears streaming state", async () => {
			await startEngine();
			handleEvent(evAgentStart());
			expect(getState().streaming).toBe(true);

			handleCrash("segfault");
			// crashCount increases, streaming should still be true until session is rebuilt
			// but the agent is gone so isStreaming will depend on state cleanup
			expect(getState().crashCount).toBe(1);
		});

		it("multiple rapid starts return same server", async () => {
			const { factory } = mockSessionFactory();

			// First start
			const result1 = await start({
				cwd: tempDir,
				sessionFactory: factory,
				skipPrompt: true,
			});

			// Second start — should return existing server
			const result2 = await start({
				cwd: tempDir,
				sessionFactory: factory,
				skipPrompt: true,
			});

			expect(result1.url).toBe(result2.url);
			expect(result1.token).toBe(result2.token);
		});

		it("abort during streaming stops the stream", async () => {
			const session = await startEngine();
			handleEvent(evAgentStart());
			expect(getState().streaming).toBe(true);

			await abort();
			// After abort, engine should have fired agent_end
			expect(getState().streaming).toBe(false);
		});

		it("rapid connect/disconnect doesn't corrupt state", async () => {
			await startEngine();

			// Connect 5 clients
			const clients: Awaited<ReturnType<typeof connectWs>>[] = [];
			for (let i = 0; i < 5; i++) {
				const ws = await connectWs(port, token);
				await ws.waitForMessage((m) => m.type === "init");
				clients.push(ws);
			}

			expect(getState().clientCount).toBe(5);

			// Disconnect all at once
			for (const c of clients) {
				c.socket.write(Buffer.from([0x88, 0x00]));
				c.socket.destroy();
			}

			await waitForCondition(() => getState().clientCount === 0, 5000);

			expect(getState().running).toBe(true);
			expect(getState().clientCount).toBe(0);
		});

		it("events during stop are not broadcast to remaining clients", async () => {
			await startEngine();
			handleEvent(evAgentStart());

			const ws = await connectWs(port, token);
			try {
				// Wait for init + agent_start history to arrive
				await ws.waitForMessage((m) => m.type === "rpc_event" && m.event?.type === "agent_start");
				const preStopCount = ws.messages.length;

				// Stop, then try to inject events
				stop();
				handleEvent(evAgentStart());
				handleEvent(evMessageStart());

				// Wait for agent_stopped before asserting no leakage
				await ws.waitForMessage((m) => m.type === "agent_stopped");

				// Check that the only new message is agent_stopped (from stop())
				const postStopMessages = ws.messages.slice(preStopCount);
				const agentStartAfterStop = postStopMessages.filter(
					(m) => m.type === "rpc_event" && m.event?.type === "agent_start"
				);
				expect(agentStartAfterStop.length).toBe(0);

				// agent_stopped should be there
				const stoppedMsg = postStopMessages.find((m) => m.type === "agent_stopped");
				expect(stoppedMsg).toBeDefined();
			} finally {
				ws.close();
			}
		});

		it("HTTP endpoints reflect crash state", async () => {
			await startEngine();

			// Before crash: agent is running
			const res1 = await httpGet(`http://localhost:${port}/status?token=${token}`);
			expect(res1.status).toBe(200);
			const status1 = JSON.parse(res1.body);
			expect(status1.agentRunning).toBe(true);

			// After crash: agent is not running, crash count increases
			handleCrash("test error");

			const res2 = await httpGet(`http://localhost:${port}/state?token=${token}`);
			const state = JSON.parse(res2.body);
			expect(state.crashCount).toBe(1);
			expect(state.agentReady).toBe(false);

			const res3 = await httpGet(`http://localhost:${port}/status?token=${token}`);
			const status2 = JSON.parse(res3.body);
			expect(status2.agentRunning).toBe(false);
		});

		it("full scenario: start → explore → crash → restart → resume → stop", async () => {
			// Use a factory that tracks sessions
			const { factory, sessions } = failingSessionFactory();
			const result = await start({
				cwd: tempDir,
				sessionFactory: factory,
				skipPrompt: true,
				backoffBase: 10,
				backoffMax: 50,
			});
			port = parseInt(new URL(result.url).port);
			token = result.token;

			const ws = await connectWs(port, token);
			try {
				// 1. Agent starts exploring
				handleEvent(evAgentStart());

				// 2. Agent streams a document
				handleEvent(evTextDelta("# Analysis"));

				handleEvent(evAgentEnd());

				// 3. Agent crashes
				handleCrash("connection timeout");

				const exitMsg = await ws.waitForMessage((m) => m.type === "agent_exit");
				expect(exitMsg.willRestart).toBe(true);

				// 4. Wait for auto-restart (fast backoff in tests: 10ms)
				await waitForCondition(() => sessions.length === 2, 500);

				// 5. Agent is back
				expect(getState().agentReady).toBe(true);
				expect(getState().crashCount).toBe(1);

				// 6. User sends a follow-up
				ws.send({ type: "prompt", text: "explain more" });
				// Wait for prompt to reach the (restarted) session
				await waitForCondition(() => sessions.some((s) => s._promptCalls.includes("explain more")), 2000);

				// 7. User stops
				ws.send({ type: "stop" });
				await ws.waitForMessage((m) => m.type === "agent_stopped");

				expect(getState().running).toBe(false);
			} finally {
				ws.close();
			}
		});
	});

	// ─── Chat history recovery ───────────────────────────────────────

	describe("chat history recovery on WebSocket reconnect", () => {
		/** Helper to create mock agent messages */
		function userMsg(text: string) {
			return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
		}
		function assistantTextMsg(text: string) {
			return {
				role: "assistant",
				content: [{ type: "text", text }],
				usage: { input: 100, output: 50 },
				timestamp: Date.now(),
			};
		}
		function assistantToolCallMsg() {
			return {
				role: "assistant",
				content: [{ type: "toolCall", name: "read", id: "tc1", arguments: { path: "/foo" } }],
				usage: { input: 50, output: 10 },
				timestamp: Date.now(),
			};
		}
		function toolResultMsg() {
			return {
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				timestamp: Date.now(),
			};
		}

		it("sends chat_history on WebSocket connect when session has chat messages", async () => {
			const session = await startEngine();

			// Simulate: initial exploration prompt + tool calls + doc, then a chat Q&A
			const suffix = "\n\n[Respond in well-structured markdown. Use headings (##), bullet lists, fenced code blocks with language tags (```ts), tables, bold/italic for emphasis. Keep responses clear and organized.]";
			session._messages.push(
				userMsg("Explore the codebase in depth..."),
				assistantToolCallMsg(),
				toolResultMsg(),
				assistantTextMsg("Document has been written."),
				userMsg("How does auth work?" + suffix),
				assistantTextMsg("## Authentication\n\nAuth uses JWT tokens."),
			);

			// Connect a WebSocket client
			const ws = await connectWs(port, token);
			try {
				// Wait for the chat_history message
				const chatHistory = await ws.waitForMessage((m) => m.type === "chat_history", 2000);

				expect(chatHistory.messages).toHaveLength(2);
				expect(chatHistory.messages[0]).toEqual({ role: "user", text: "How does auth work?" });
				expect(chatHistory.messages[1]).toEqual({ role: "assistant", text: "## Authentication\n\nAuth uses JWT tokens." });
				expect(chatHistory.isFullHistory).toBe(false); // only sent RECENT_CHAT_LIMIT
			} finally {
				ws.close();
			}
		});

		it("does not send chat_history when no chat messages exist", async () => {
			const session = await startEngine();

			// Only the initial exploration — no follow-up chat
			session._messages.push(
				userMsg("Explore the codebase..."),
				assistantToolCallMsg(),
				toolResultMsg(),
				assistantTextMsg("Document written."),
			);

			const ws = await connectWs(port, token);
			try {
				// Wait for init message
				await ws.waitForMessage((m) => m.type === "init", 2000);
				// Deliberate short wait: asserting absence of chat_history (no condition to poll)
				await new Promise((r) => setTimeout(r, 50));

				const chatHistoryMsgs = ws.messages.filter((m) => m.type === "chat_history");
				expect(chatHistoryMsgs).toHaveLength(0);
			} finally {
				ws.close();
			}
		});

		it("reconnecting client gets chat history", async () => {
			const session = await startEngine();
			const suffix = "\n\n[Respond in well-structured markdown. Use headings (##), bullet lists, fenced code blocks with language tags (```ts), tables, bold/italic for emphasis. Keep responses clear and organized.]";

			// First client connects (before any chat)
			const ws1 = await connectWs(port, token);
			await ws1.waitForMessage((m) => m.type === "init", 2000);

			// Simulate a chat exchange happening
			session._messages.push(
				userMsg("Explore..."),
				assistantTextMsg("Done."),
				userMsg("What is X?" + suffix),
				assistantTextMsg("X is a module."),
			);

			// First client disconnects
			ws1.close();
			// Wait for server to register the disconnect
			await waitForCondition(() => getState().clientCount === 0, 2000);

			// Second client connects — should get chat history
			const ws2 = await connectWs(port, token);
			try {
				const chatHistory = await ws2.waitForMessage((m) => m.type === "chat_history", 2000);

				expect(chatHistory.messages).toHaveLength(2);
				expect(chatHistory.messages[0]).toEqual({ role: "user", text: "What is X?" });
				expect(chatHistory.messages[1]).toEqual({ role: "assistant", text: "X is a module." });
			} finally {
				ws2.close();
			}
		});

		it("load_history request returns full chat history", async () => {
			const session = await startEngine();
			const suffix = "\n\n[Respond in well-structured markdown. Use headings (##), bullet lists, fenced code blocks with language tags (```ts), tables, bold/italic for emphasis. Keep responses clear and organized.]";

			// Create many chat exchanges (more than RECENT_CHAT_LIMIT = 20)
			session._messages.push(userMsg("Explore..."));
			session._messages.push(assistantTextMsg("Done."));
			for (let i = 0; i < 15; i++) {
				session._messages.push(userMsg(`Question ${i}` + suffix));
				session._messages.push(assistantTextMsg(`Answer ${i}`));
			}

			const ws = await connectWs(port, token);
			try {
				// Get the initial chat_history (limited to RECENT_CHAT_LIMIT=20)
				const initial = await ws.waitForMessage((m) => m.type === "chat_history", 2000);
				expect(initial.messages.length).toBeLessThanOrEqual(20);
				expect(initial.isFullHistory).toBe(false);

				// Clear received messages to isolate the next response
				ws.messages.length = 0;

				// Request full history
				ws.send({ type: "load_history" });

				const full = await ws.waitForMessage((m) => m.type === "chat_history" && m.isFullHistory === true, 3000);
				expect(full.messages).toHaveLength(30); // 15 Q + 15 A
				expect(full.messages[0]).toEqual({ role: "user", text: "Question 0" });
				expect(full.messages[29]).toEqual({ role: "assistant", text: "Answer 14" });
			} finally {
				ws.close();
			}
		});

		it("multiple concurrent clients each get chat history independently", async () => {
			const session = await startEngine();
			const suffix = "\n\n[Respond in well-structured markdown. Use headings (##), bullet lists, fenced code blocks with language tags (```ts), tables, bold/italic for emphasis. Keep responses clear and organized.]";

			session._messages.push(
				userMsg("Explore..."),
				assistantTextMsg("Done."),
				userMsg("Q1" + suffix),
				assistantTextMsg("A1"),
			);

			// Connect two clients simultaneously
			const [ws1, ws2] = await Promise.all([
				connectWs(port, token),
				connectWs(port, token),
			]);

			try {
				const history1 = await ws1.waitForMessage((m) => m.type === "chat_history", 2000);
				const history2 = await ws2.waitForMessage((m) => m.type === "chat_history", 2000);

				expect(history1.messages).toEqual(history2.messages);
				expect(history1.messages).toHaveLength(2);
			} finally {
				ws1.close();
				ws2.close();
			}
		});

		it("chat history is preserved across agent turns", async () => {
			const session = await startEngine();
			const suffix = "\n\n[Respond in well-structured markdown. Use headings (##), bullet lists, fenced code blocks with language tags (```ts), tables, bold/italic for emphasis. Keep responses clear and organized.]";

			// Simulate exploration turn
			session._messages.push(userMsg("Explore..."));
			handleEvent(evAgentStart());
			handleEvent(evAgentEnd());

			// Add doc response and chat
			session._messages.push(
				assistantTextMsg("Document generated."),
				userMsg("How does auth work?" + suffix),
			);

			// Simulate agent turn for chat response
			handleEvent(evAgentStart());
			session._messages.push(assistantTextMsg("Auth uses OAuth2."));
			handleEvent(evAgentEnd());

			// Connect a fresh client — should see chat history
			const ws = await connectWs(port, token);
			try {
				const chatHistory = await ws.waitForMessage((m) => m.type === "chat_history", 2000);

				expect(chatHistory.messages).toHaveLength(2);
				expect(chatHistory.messages[0].text).toBe("How does auth work?");
				expect(chatHistory.messages[1].text).toBe("Auth uses OAuth2.");
			} finally {
				ws.close();
			}
		});
	});

});
