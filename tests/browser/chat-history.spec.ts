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

import { test, expect, type Page } from "@playwright/test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	start,
	stop,
	stopAll,
	reset,
	handleEvent,
	extractChatMessages,
	type SessionFactory,
} from "../../src/engine.js";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════════════
// Mock agent session
// ═══════════════════════════════════════════════════════════════════════

function createMockSession() {
	const subscribers: Array<(event: AgentSessionEvent) => void> = [];
	let aborted = false;
	const promptCalls: string[] = [];

	return {
		subscribe(fn: (event: AgentSessionEvent) => void) {
			subscribers.push(fn);
			return () => {
				const idx = subscribers.indexOf(fn);
				if (idx >= 0) subscribers.splice(idx, 1);
			};
		},
		async prompt(text: string, _opts?: any) {
			promptCalls.push(text);
		},
		async abort() {
			aborted = true;
		},
		async setModel() {},
		_messages: [] as any[],
		get messages() {
			return this._messages;
		},
		get state() {
			return { messages: this._messages };
		},
		_emit(event: AgentSessionEvent) {
			for (const fn of subscribers) fn(event);
		},
		_wasAborted: () => aborted,
		_promptCalls: promptCalls,
	};
}

type MockSession = ReturnType<typeof createMockSession>;

// ═══════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════

const MARKDOWN_SUFFIX =
	"\n\n[Respond in well-structured markdown. Use headings (##), bullet lists, fenced code blocks with language tags (```ts), tables, bold/italic for emphasis. Keep responses clear and organized.]";

function makeTempDir(): string {
	const id = crypto.randomBytes(8).toString("hex");
	const dir = path.join(os.tmpdir(), `storyof-browser-test-${id}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Push a user message into the mock session's message history. */
function addUserMessage(session: MockSession, text: string) {
	session._messages.push({
		role: "user",
		content: [{ type: "text", text: text + MARKDOWN_SUFFIX }],
		timestamp: Date.now(),
	});
}

/** Push an assistant text message into the mock session's message history. */
function addAssistantMessage(session: MockSession, text: string) {
	session._messages.push({
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 100, output: 50 },
		timestamp: Date.now(),
	});
}

/** Simulate a complete agent chat response with streaming events. */
function simulateChatResponse(session: MockSession, userText: string, responseText: string) {
	// Add user message to session history (what the SDK would do)
	addUserMessage(session, userText);

	// Fire streaming events through the engine
	handleEvent({ type: "agent_start" } as any);
	handleEvent({
		type: "message_start",
		message: { role: "assistant" },
	} as any);

	// Stream the response in chunks
	const chunks = responseText.match(/.{1,20}/g) || [responseText];
	for (const chunk of chunks) {
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: chunk },
		} as any);
	}

	// End the message
	handleEvent({
		type: "message_update",
		assistantMessageEvent: { type: "text_end" },
	} as any);
	handleEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: responseText }],
			usage: { input: 100, output: 50 },
		},
	} as any);

	// Add assistant message to session history
	addAssistantMessage(session, responseText);

	handleEvent({ type: "agent_end" } as any);
}

/** Authenticate the browser by entering the token. */
async function authenticate(page: Page, token: string) {
	// Check if auth screen is visible (might already be hidden if token is in sessionStorage)
	const authHidden = await page.evaluate(
		() => document.getElementById("authScreen")?.classList.contains("hidden"),
	);

	if (!authHidden) {
		await page.fill("#authInput", token);
		await page.click("#authBtn");
	}

	// Wait for auth screen to get the 'hidden' class (WebSocket connected)
	await page.waitForFunction(
		() => document.getElementById("authScreen")?.classList.contains("hidden"),
		{ timeout: 5000 },
	);

	// Wait for WebSocket init message to be processed
	await page.waitForFunction(() => {
		const pill = document.getElementById("pillText");
		return pill && pill.textContent !== "connecting…";
	}, { timeout: 5000 });
}

/** Wait for a user bubble containing specific text. */
async function waitForUserBubble(page: Page, text: string, timeout = 5000) {
	// User bubbles have bg-emerald-400/5 class
	await page.waitForFunction(
		(t) => {
			const bubbles = document.querySelectorAll(".msg-md");
			return Array.from(bubbles).some(
				(b) => b.classList.contains("ml-8") && b.textContent?.includes(t),
			);
		},
		text,
		{ timeout },
	);
}

/** Wait for an assistant bubble containing specific text. */
async function waitForAssistantBubble(page: Page, text: string, timeout = 5000) {
	await page.waitForFunction(
		(t) => {
			const bubbles = document.querySelectorAll(".msg-md:not(.ml-8):not(.streaming)");
			return Array.from(bubbles).some((b) => b.textContent?.includes(t));
		},
		text,
		{ timeout },
	);
}

/** Get all chat bubble texts from the page. */
async function getChatBubbles(page: Page): Promise<Array<{ role: string; text: string }>> {
	return page.evaluate(() => {
		const bubbles = document.querySelectorAll("#timeline .msg-md");
		return Array.from(bubbles).map((b) => ({
			role: b.classList.contains("ml-8") ? "user" : "assistant",
			text: (b.textContent || "").trim(),
		}));
	});
}

/** Count chat bubbles on the page. */
async function countBubbles(page: Page): Promise<number> {
	return page.evaluate(() => document.querySelectorAll("#timeline .msg-md").length);
}

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
	const factory: SessionFactory = async () => session as any;

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
	handleEvent({ type: "agent_start" } as any);
	handleEvent({ type: "agent_end" } as any);
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
		await expect(page.locator("#authScreen")).toBeVisible();
		await expect(page.locator("#authInput")).toBeVisible();

		// Enter token and submit
		await authenticate(page, token);

		// Should be connected — pill shows session state
		await expect(page.locator("#pillDot")).toBeVisible();
	});

	test("rejects invalid token", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await page.fill("#authInput", "wrong-token-12345");
		await page.click("#authBtn");

		// Auth screen should remain visible (or show error)
		// The WebSocket connection will fail and show auth error
		await page.waitForTimeout(1500);
		await expect(page.locator("#authScreen")).not.toHaveClass(/hidden/);
	});
});

test.describe("chat messaging", () => {
	test("user can send a message and see streamed response", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Type a message
		await page.fill("#input", "What does main.ts do?");
		await page.click("#sendBtn");

		// User bubble should appear immediately (browser-side)
		await waitForUserBubble(page, "What does main.ts do?");

		// Wait for the prompt to reach the server
		await page.waitForTimeout(200);

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

		// Wait for chat_history to be processed
		await page.waitForTimeout(500);

		// Should see restored chat messages
		const bubbles = await getChatBubbles(page);
		expect(bubbles.length).toBeGreaterThanOrEqual(2);

		// Now disconnect by navigating away
		await page.goto("about:blank");
		await page.waitForTimeout(200);

		// Reconnect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

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
		await page.waitForTimeout(500);

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
		await page.waitForTimeout(500);

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
		await page.waitForTimeout(500);

		const beforeCount = await countBubbles(page);

		// Send a new message
		await page.fill("#input", "What about deployment?");
		await page.click("#sendBtn");
		await waitForUserBubble(page, "deployment");
		await page.waitForTimeout(200);

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
		await page1.waitForTimeout(500);
		await page2.waitForTimeout(500);

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
		await page.waitForTimeout(500);

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
		await page.waitForTimeout(1000);

		const fullBubbles = await getChatBubbles(page);
		expect(fullBubbles.length).toBe(totalMessages);
	});

	test("load_history returns all messages in correct order", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// Scroll to top
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});
		await page.waitForTimeout(1000);

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
		await page.waitForTimeout(500);

		const beforeCount = await countBubbles(page);

		// Start a streaming response
		handleEvent({ type: "agent_start" } as any);
		handleEvent({
			type: "message_start",
			message: { role: "assistant" },
		} as any);

		// Stream a few chunks
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "This is a " },
		} as any);
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "partial response..." },
		} as any);

		await page.waitForTimeout(200);

		// Verify streaming bubble appeared
		const streamingCount = await page.evaluate(
			() => document.querySelectorAll(".streaming").length,
		);
		expect(streamingCount).toBeGreaterThanOrEqual(1);

		// Complete the response and update session
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_end" },
		} as any);
		handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "This is a partial response..." }],
				usage: { input: 50, output: 20 },
			},
		} as any);
		addUserMessage(session, "Streaming test question");
		addAssistantMessage(session, "This is a partial response...");
		handleEvent({ type: "agent_end" } as any);

		await page.waitForTimeout(200);

		// Now navigate away (disconnect)
		await page.goto("about:blank");
		await page.waitForTimeout(200);

		// Reconnect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// The completed message should be in chat history
		const bubbles = await getChatBubbles(page);
		const hasResponse = bubbles.some(
			(b) => b.role === "assistant" && b.text.includes("partial response"),
		);
		expect(hasResponse).toBe(true);

		await ctx.close();
	});
});
