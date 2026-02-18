/**
 * Browser integration tests for chat history recovery.
 *
 * These tests start the REAL engine with a mock agent session,
 * open a REAL Chromium browser via Playwright, and verify that:
 *
 *   - Auth flow works (token entry → WebSocket connection)
 *   - Chat messages stream into the DOM correctly
 *   - Reconnecting restores chat history from the server
 *   - Opening a new page restores chat history
 *   - Multiple exchanges are preserved across reconnects
 *   - Scroll-to-top triggers full history load
 *
 * No AI calls are made — the agent session is mocked and events
 * are fired programmatically from the test.
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import {
	start,
	stop,
	stopAll,
	reset,
	handleEvent,
	extractChatMessages,
	type SessionFactory,
} from "../../src/engine.js";
import {
	createMockSession,
	type MockSession,
	addUserMessage,
	addAssistantMessage,
	addExplorationMessages,
	simulateChatResponse,
} from "./fixtures/mock-session.js";
import {
	makeTempDir,
	authenticate,
	getChatBubbles,
	countBubbles,
	waitForUserBubble,
	waitForAssistantBubble,
	waitForBubbles,
} from "./fixtures/page-helpers.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
	evAgentStart,
	evAgentEnd,
	evMessageStart,
	evTextDelta,
	evTextEnd,
	evMessageEnd,
} from "../helpers/events.js";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

let tempDir: string;
let port: number;
let token: string;
let session: MockSession;

test.beforeAll(async () => {
	tempDir = makeTempDir();
	session = createMockSession();
	const factory: SessionFactory = async () => session as unknown as AgentSession;

	const result = await start({
		cwd: tempDir,
		depth: "medium",
		model: "test-model",
		sessionFactory: factory,
		skipPrompt: true,
	});

	port = parseInt(new URL(result.url).port);
	token = result.token;

	// Add the initial exploration prompt to message history
	// (this is what the real session would have after exploration)
	session._messages.push({
		role: "user",
		content: [{ type: "text", text: "Explore the codebase in depth..." }],
		timestamp: Date.now(),
	});
	session._messages.push({
		role: "assistant",
		content: [
			{ type: "toolCall", name: "bash", id: "tc1", arguments: { command: "find . -type f" } },
		],
		usage: { input: 500, output: 100 },
		timestamp: Date.now(),
	});
	session._messages.push({
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "bash",
		content: [{ type: "text", text: "src/main.ts\nsrc/utils.ts" }],
		timestamp: Date.now(),
	});
	session._messages.push({
		role: "assistant",
		content: [{ type: "text", text: "I've analyzed the codebase and written the document." }],
		usage: { input: 1000, output: 200 },
		timestamp: Date.now(),
	});

	// Signal that the initial exploration is "done"
	handleEvent(evAgentStart());
	handleEvent(evAgentEnd());
});

test.afterAll(async () => {
	reset();
	await new Promise((r) => setTimeout(r, 100));
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {}
});

test.describe("auth flow", () => {
	test("shows auth screen and connects with valid token", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);

		// Auth screen is visible
		await expect(page.getByTestId("auth-screen")).toBeVisible();
		await expect(page.getByTestId("auth-input")).toBeVisible();

		// Enter token and submit
		await authenticate(page, token);

		// Should be connected — pill shows session state
		await expect(page.locator("#pillDot")).toBeVisible();
	});

	test("rejects invalid token", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await page.getByTestId("auth-input").fill( "wrong-token-12345");
		await page.getByTestId("auth-submit").click();

		// Auth screen should remain visible (bad token rejected)
		await expect(page.getByTestId("auth-screen")).not.toHaveClass(/hidden/, { timeout: 3000 });
	});
});

test.describe("chat messaging", () => {
	test("user can send a message and see streamed response", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Type a message
		await page.getByTestId("chat-input").fill( "What does main.ts do?");
		await page.getByTestId("send-button").click();

		// User bubble should appear immediately (browser-side)
		await waitForUserBubble(page, "What does main.ts do?");

		// Simulate the agent responding
		simulateChatResponse(
			session,
			"What does main.ts do?",
			"## main.ts\n\nThe `main.ts` file is the entry point. It initializes the server and starts listening on port 3000.",
		);

		// Wait for the assistant response to appear
		await waitForAssistantBubble(page, "main.ts");
		await waitForAssistantBubble(page, "entry point");

		// Verify both bubbles are present
		const bubbles = await getChatBubbles(page);
		expect(bubbles.length).toBeGreaterThanOrEqual(2);

		const userBubble = bubbles.find((b) => b.role === "user" && b.text.includes("main.ts"));
		const assistantBubble = bubbles.find(
			(b) => b.role === "assistant" && b.text.includes("entry point"),
		);
		expect(userBubble).toBeTruthy();
		expect(assistantBubble).toBeTruthy();
	});
});

test.describe("chat history recovery", () => {
	test.beforeAll(() => {
		// Ensure we have a chat exchange in the session (from previous test or setup)
		// Clear any existing chat messages and add a clean set
		const hasChat = extractChatMessages().length > 0;
		if (!hasChat) {
			addUserMessage(session, "What is utils.ts?");
			addAssistantMessage(session, "## utils.ts\n\nContains helper functions for string formatting and date parsing.");
		}
	});

	test("reconnecting page restores chat history", async ({ page }) => {
		// Connect and verify we see chat history
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 2);

		// Should see restored chat messages
		const bubbles = await getChatBubbles(page);
		expect(bubbles.length).toBeGreaterThanOrEqual(2);

		// Now disconnect by navigating away
		await page.goto("about:blank");
		await page.waitForTimeout(100); // acceptable: wait for WS close

		// Reconnect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 2);

		// Chat history should be restored
		const restoredBubbles = await getChatBubbles(page);
		expect(restoredBubbles.length).toBeGreaterThanOrEqual(2);

		// Verify content matches
		const hasUser = restoredBubbles.some((b) => b.role === "user");
		const hasAssistant = restoredBubbles.some((b) => b.role === "assistant");
		expect(hasUser).toBe(true);
		expect(hasAssistant).toBe(true);
	});

	test("new page gets chat history on first connect", async ({ page }) => {
		// This is a fresh page context — no sessionStorage
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 2);

		const bubbles = await getChatBubbles(page);
		expect(bubbles.length).toBeGreaterThanOrEqual(2);

		const hasUser = bubbles.some((b) => b.role === "user");
		const hasAssistant = bubbles.some((b) => b.role === "assistant");
		expect(hasUser).toBe(true);
		expect(hasAssistant).toBe(true);
	});

	test("multiple chat exchanges are preserved", async ({ page }) => {
		// Add a second chat exchange
		addUserMessage(session, "How does error handling work?");
		addAssistantMessage(session, "## Error Handling\n\nErrors are caught with try/catch blocks and logged to stderr.");

		// Add a third chat exchange
		addUserMessage(session, "What about testing?");
		addAssistantMessage(session, "## Testing\n\nThe project uses vitest for unit and integration tests.");

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 6);

		const bubbles = await getChatBubbles(page);

		// Should have at least 6 bubbles (3 Q&A pairs)
		expect(bubbles.length).toBeGreaterThanOrEqual(6);

		// Verify the exchanges are in order
		const userBubbles = bubbles.filter((b) => b.role === "user");
		const assistantBubbles = bubbles.filter((b) => b.role === "assistant");
		expect(userBubbles.length).toBeGreaterThanOrEqual(3);
		expect(assistantBubbles.length).toBeGreaterThanOrEqual(3);

		// Check content of last exchange
		const lastUser = userBubbles[userBubbles.length - 1];
		const lastAssistant = assistantBubbles[assistantBubbles.length - 1];
		expect(lastUser.text).toContain("testing");
		expect(lastAssistant.text).toContain("vitest");
	});

	test("chat after reconnect adds to existing history", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 1);

		const beforeCount = await countBubbles(page);

		// Send a new message
		await page.getByTestId("chat-input").fill( "What about deployment?");
		await page.getByTestId("send-button").click();
		await waitForUserBubble(page, "deployment");

		// Simulate response
		simulateChatResponse(
			session,
			"What about deployment?",
			"## Deployment\n\nThe app deploys to AWS Lambda via a CI/CD pipeline.",
		);

		await waitForAssistantBubble(page, "AWS Lambda");

		const afterCount = await countBubbles(page);
		expect(afterCount).toBe(beforeCount + 2); // +1 user, +1 assistant
	});

	test("concurrent pages both get chat history", async ({ browser }) => {
		const ctx1 = await browser.newContext();
		const ctx2 = await browser.newContext();
		const page1 = await ctx1.newPage();
		const page2 = await ctx2.newPage();

		// Connect both pages
		await page1.goto(`http://localhost:${port}/`);
		await page2.goto(`http://localhost:${port}/`);
		await authenticate(page1, token);
		await authenticate(page2, token);
		await waitForBubbles(page1, 1);
		await waitForBubbles(page2, 1);

		const bubbles1 = await getChatBubbles(page1);
		const bubbles2 = await getChatBubbles(page2);

		// Both should have the same number of messages
		expect(bubbles1.length).toBe(bubbles2.length);
		expect(bubbles1.length).toBeGreaterThanOrEqual(2);

		await ctx1.close();
		await ctx2.close();
	});
});

test.describe("full history loading", () => {
	test("scroll to top loads full history when partial was sent", async ({ page }) => {
		// Add many messages to exceed the RECENT_CHAT_LIMIT (20)
		const existingCount = extractChatMessages().length;
		const neededPairs = Math.max(0, Math.ceil((22 - existingCount) / 2));

		for (let i = 0; i < neededPairs; i++) {
			addUserMessage(session, `Bulk question ${i}: What about feature ${i}?`);
			addAssistantMessage(session, `Feature ${i} handles data processing for module ${i}.`);
		}

		const totalMessages = extractChatMessages().length;
		expect(totalMessages).toBeGreaterThan(20);

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 1);

		// Should have received partial history (up to 20 messages)
		const initialBubbles = await getChatBubbles(page);
		expect(initialBubbles.length).toBeLessThanOrEqual(20);
		expect(initialBubbles.length).toBeGreaterThan(0);

		// Scroll to top to trigger full history load
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});

		// Wait for full history to load
		await waitForBubbles(page, totalMessages, 10_000);

		const fullBubbles = await getChatBubbles(page);
		expect(fullBubbles.length).toBe(totalMessages);
	});

	test("load_history returns all messages in correct order", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 1);

		// Scroll to top
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});
		// Wait for full history
		await waitForBubbles(page, 21, 10_000);

		const bubbles = await getChatBubbles(page);

		// Check alternating user/assistant pattern
		for (let i = 0; i < bubbles.length; i++) {
			const expectedRole = i % 2 === 0 ? "user" : "assistant";
			expect(bubbles[i].role).toBe(expectedRole);
		}
	});
});

test.describe("streaming during reconnect", () => {
	test("mid-stream disconnect recovers completed messages", async ({ browser }) => {
		// Start with a known state
		const ctx = await browser.newContext();
		const page = await ctx.newPage();

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 1);

		const beforeCount = await countBubbles(page);

		// Start a streaming response
		handleEvent(evAgentStart());
		handleEvent(evMessageStart());

		// Stream a few chunks
		handleEvent(evTextDelta("This is a "));
		handleEvent(evTextDelta("partial response..."));

		// Wait for streaming bubble to appear
		await expect(page.locator(".streaming").first()).toBeVisible({ timeout: 5000 });

		// Verify streaming bubble appeared
		const streamingCount = await page.locator(".streaming").count();
		expect(streamingCount).toBeGreaterThanOrEqual(1);

		// Complete the response and update session
		handleEvent(evTextEnd());
		handleEvent(evMessageEnd("This is a partial response..."));
		addUserMessage(session, "Streaming test question");
		addAssistantMessage(session, "This is a partial response...");
		handleEvent(evAgentEnd());
		// Wait for streaming to end
		await expect(page.locator(".streaming")).toHaveCount(0, { timeout: 5000 });

		// Now navigate away (disconnect)
		await page.goto("about:blank");
		await page.waitForTimeout(100); // acceptable: wait for WS close

		// Reconnect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 1);

		// The completed message should be in chat history
		const bubbles = await getChatBubbles(page);
		const hasResponse = bubbles.some(
			(b) => b.role === "assistant" && b.text.includes("partial response"),
		);
		expect(hasResponse).toBe(true);

		await ctx.close();
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Reconnect edge cases (moved from read-only-mode.spec.ts)
// chat-history.spec.ts is the canonical owner of all reconnect behavior
// ═══════════════════════════════════════════════════════════════════════

test.describe("reconnect edge cases", () => {
	let localDir: string;
	let localPort: number;
	let localToken: string;
	let localSession: ReturnType<typeof createMockSession>;

	test.beforeEach(() => {
		// Reset any engine left over from the file-level beforeAll or a previous test
		reset();
	});

	test.afterEach(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 100));
		try { fs.rmSync(localDir, { recursive: true, force: true }); } catch {}
	});

	test("rapid reconnect does not duplicate messages", async ({ page }) => {
		localDir = makeTempDir("storyof-history");
		localSession = createMockSession();
		const factory: SessionFactory = async () => localSession as unknown as AgentSession;
		const result = await start({ cwd: localDir, sessionFactory: factory, skipPrompt: true });
		localPort = parseInt(new URL(result.url).port);
		localToken = result.token;

		addExplorationMessages(localSession);
		handleEvent(evAgentStart());
		handleEvent(evAgentEnd());
		simulateChatResponse(localSession, "Hello", "Hi there!");
		simulateChatResponse(localSession, "How are you?", "I'm doing well.");

		await page.goto(`http://localhost:${localPort}/`);
		await authenticate(page, localToken);
		await waitForBubbles(page, 4);

		const firstCount = await countBubbles(page);
		expect(firstCount).toBe(4); // 2 user + 2 assistant

		// Rapid disconnect/reconnect 3 times
		for (let i = 0; i < 3; i++) {
			await page.goto("about:blank");
			await page.waitForTimeout(100); // acceptable: wait for WS close
			await page.goto(`http://localhost:${localPort}/`);
			await authenticate(page, localToken);
			await waitForBubbles(page, 4);
		}

		const finalCount = await countBubbles(page);
		expect(finalCount).toBe(4); // No duplicates
	});

	test("very long messages are preserved after reconnect", async ({ page }) => {
		localDir = makeTempDir("storyof-history");
		localSession = createMockSession();
		const factory: SessionFactory = async () => localSession as unknown as AgentSession;
		const result = await start({ cwd: localDir, sessionFactory: factory, skipPrompt: true });
		localPort = parseInt(new URL(result.url).port);
		localToken = result.token;

		addExplorationMessages(localSession);
		handleEvent(evAgentStart());
		handleEvent(evAgentEnd());

		const longAnswer = "## Architecture\n\n" + "This module handles data processing. ".repeat(80);
		simulateChatResponse(localSession, "Explain the architecture", longAnswer);

		await page.goto(`http://localhost:${localPort}/`);
		await authenticate(page, localToken);
		await waitForBubbles(page, 2);

		const before = await getChatBubbles(page);
		expect(before.length).toBe(2);
		expect(before[1].text).toContain("Architecture");
		expect(before[1].text.length).toBeGreaterThan(100);

		await page.goto("about:blank");
		await page.waitForTimeout(100); // acceptable: wait for WS close
		await page.goto(`http://localhost:${localPort}/`);
		await authenticate(page, localToken);
		await waitForBubbles(page, 2);

		const after = await getChatBubbles(page);
		expect(after.length).toBe(2);
		expect(after[1].text).toContain("Architecture");
		expect(after[1].text.length).toBeGreaterThan(100);
	});

	test("chat input works after reconnect", async ({ page }) => {
		localDir = makeTempDir("storyof-history");
		localSession = createMockSession();
		const factory: SessionFactory = async () => localSession as unknown as AgentSession;
		const result = await start({ cwd: localDir, sessionFactory: factory, skipPrompt: true });
		localPort = parseInt(new URL(result.url).port);
		localToken = result.token;

		addExplorationMessages(localSession);
		handleEvent(evAgentStart());
		handleEvent(evAgentEnd());

		await page.goto(`http://localhost:${localPort}/`);
		await authenticate(page, localToken);

		await page.getByTestId("chat-input").fill( "First question");
		await page.getByTestId("send-button").click();
		await waitForUserBubble(page, "First question");
		simulateChatResponse(localSession, "First question", "First answer.");
		await waitForAssistantBubble(page, "First answer");

		await page.goto("about:blank");
		await page.waitForTimeout(100); // acceptable: wait for WS close
		await page.goto(`http://localhost:${localPort}/`);
		await authenticate(page, localToken);
		await waitForBubbles(page, 2);

		const restored = await getChatBubbles(page);
		expect(restored.length).toBe(2);

		await page.getByTestId("chat-input").fill( "Second question after reconnect");
		await page.getByTestId("send-button").click();
		await waitForUserBubble(page, "Second question after reconnect");
		simulateChatResponse(localSession, "Second question after reconnect", "Second answer works!");
		await waitForAssistantBubble(page, "Second answer works");

		const final = await getChatBubbles(page);
		expect(final.length).toBe(4);
		expect(final[2].text).toContain("Second question");
		expect(final[3].text).toContain("Second answer");
	});

	test("messages survive multiple reconnect cycles in correct order", async ({ page }) => {
		localDir = makeTempDir("storyof-history");
		localSession = createMockSession();
		const factory: SessionFactory = async () => localSession as unknown as AgentSession;
		const result = await start({ cwd: localDir, sessionFactory: factory, skipPrompt: true });
		localPort = parseInt(new URL(result.url).port);
		localToken = result.token;

		addExplorationMessages(localSession);
		handleEvent(evAgentStart());
		handleEvent(evAgentEnd());

		const exchanges = [
			{ q: "Question Alpha", a: "Answer Alpha" },
			{ q: "Question Beta", a: "Answer Beta" },
			{ q: "Question Gamma", a: "Answer Gamma" },
		];

		for (let i = 0; i < exchanges.length; i++) {
			await page.goto(`http://localhost:${localPort}/`);
			await authenticate(page, localToken);

			await page.getByTestId("chat-input").fill( exchanges[i].q);
			await page.getByTestId("send-button").click();
			await waitForUserBubble(page, exchanges[i].q);
			simulateChatResponse(localSession, exchanges[i].q, exchanges[i].a);
			await waitForAssistantBubble(page, exchanges[i].a);

			const count = await countBubbles(page);
			expect(count).toBe((i + 1) * 2);

			if (i < exchanges.length - 1) {
				await page.goto("about:blank");
				await page.waitForTimeout(100); // acceptable: wait for WS close
			}
		}

		// Final reconnect — all messages in correct order
		await page.goto("about:blank");
		await page.waitForTimeout(100); // acceptable: wait for WS close
		await page.goto(`http://localhost:${localPort}/`);
		await authenticate(page, localToken);
		await waitForBubbles(page, 6);

		const all = await getChatBubbles(page);
		expect(all.length).toBe(6);
		for (let i = 0; i < exchanges.length; i++) {
			expect(all[i * 2].text).toContain(exchanges[i].q.split(" ")[1]); // "Alpha"/"Beta"/"Gamma"
			expect(all[i * 2 + 1].text).toContain(exchanges[i].a.split(" ")[1]);
		}
	});
});
