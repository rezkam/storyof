/**
 * Browser integration tests for read-only mode and chat history edge cases.
 *
 * Tests:
 *   - Read-only badge shows by default (allowEdits=false)
 *   - Read-only badge hidden when allowEdits=true
 *   - Chat history survives server restart simulation (stop → start)
 *   - Chat messages arrive in correct order after multiple reconnects
 *   - Empty session has no chat bubbles
 *   - Rapid reconnect doesn't duplicate messages
 *   - Very long messages are preserved correctly
 *   - Chat input is functional after reconnect
 */

import { test, expect, type Page } from "@playwright/test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	start,
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
// Helpers
// ═══════════════════════════════════════════════════════════════════════

const MARKDOWN_SUFFIX =
	"\n\n[Respond in well-structured markdown. Use headings (##), bullet lists, fenced code blocks with language tags (```ts), tables, bold/italic for emphasis. Keep responses clear and organized.]";

function makeTempDir(): string {
	const id = crypto.randomBytes(8).toString("hex");
	const dir = path.join(os.tmpdir(), `storyof-browser-ro-${id}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function addUserMessage(session: MockSession, text: string) {
	session._messages.push({
		role: "user",
		content: [{ type: "text", text: text + MARKDOWN_SUFFIX }],
		timestamp: Date.now(),
	});
}

function addAssistantMessage(session: MockSession, text: string) {
	session._messages.push({
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 100, output: 50 },
		timestamp: Date.now(),
	});
}

/** Add the initial exploration messages (skipped by extractChatMessages). */
function addExplorationMessages(session: MockSession) {
	session._messages.push({
		role: "user",
		content: [{ type: "text", text: "Explore the codebase..." }],
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
		content: [{ type: "text", text: "src/main.ts" }],
		timestamp: Date.now(),
	});
	session._messages.push({
		role: "assistant",
		content: [{ type: "text", text: "Document written." }],
		usage: { input: 1000, output: 200 },
		timestamp: Date.now(),
	});
}

function simulateChatResponse(session: MockSession, userText: string, responseText: string) {
	addUserMessage(session, userText);
	handleEvent({ type: "agent_start" } as any);
	handleEvent({ type: "message_start", message: { role: "assistant" } } as any);
	const chunks = responseText.match(/.{1,20}/g) || [responseText];
	for (const chunk of chunks) {
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: chunk },
		} as any);
	}
	handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_end" } } as any);
	handleEvent({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: responseText }],
			usage: { input: 100, output: 50 },
		},
	} as any);
	addAssistantMessage(session, responseText);
	handleEvent({ type: "agent_end" } as any);
}

async function authenticate(page: Page, token: string) {
	const authHidden = await page.evaluate(
		() => document.getElementById("authScreen")?.classList.contains("hidden"),
	);
	if (!authHidden) {
		await page.fill("#authInput", token);
		await page.click("#authBtn");
	}
	await page.waitForFunction(
		() => document.getElementById("authScreen")?.classList.contains("hidden"),
		{ timeout: 5000 },
	);
	await page.waitForFunction(
		() => {
			const pill = document.getElementById("pillText");
			return pill && pill.textContent !== "connecting…";
		},
		{ timeout: 5000 },
	);
}

async function getChatBubbles(page: Page): Promise<Array<{ role: string; text: string }>> {
	return page.evaluate(() => {
		const bubbles = document.querySelectorAll("#timeline .msg-md");
		return Array.from(bubbles).map((b) => ({
			role: b.classList.contains("ml-8") ? "user" : "assistant",
			text: (b.textContent || "").trim(),
		}));
	});
}

async function countBubbles(page: Page): Promise<number> {
	return page.evaluate(() => document.querySelectorAll("#timeline .msg-md").length);
}

async function waitForUserBubble(page: Page, text: string, timeout = 5000) {
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

// ═══════════════════════════════════════════════════════════════════════
// Test group 1: Read-only mode badge
// ═══════════════════════════════════════════════════════════════════════

test.describe("read-only mode indicator", () => {
	let tempDir: string;
	let port: number;
	let token: string;
	let session: MockSession;

	test.afterEach(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 100));
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("shows read-only badge by default", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
			// allowEdits not set → defaults to false
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// The read-only badge should be visible
		const badge = page.locator("#statReadOnly");
		await expect(badge).toBeVisible();
		await expect(badge).toHaveText("(read-only)");
	});

	test("hides read-only badge when allowEdits is true", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
			allowEdits: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// The read-only badge should be hidden
		const badge = page.locator("#statReadOnly");
		await expect(badge).toBeHidden();
	});

	test("read-only badge has correct tooltip", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		const badge = page.locator("#statReadOnly");
		await expect(badge).toHaveAttribute("title", /dangerously-allow-edits/);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Test group 2: Chat history edge cases
// ═══════════════════════════════════════════════════════════════════════

test.describe("chat history edge cases", () => {
	let tempDir: string;
	let port: number;
	let token: string;
	let session: MockSession;

	test.afterEach(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 100));
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("empty session shows no chat bubbles", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// No chat bubbles in an empty session
		const count = await countBubbles(page);
		expect(count).toBe(0);
	});

	test("exploration-only session shows no chat bubbles", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		// Add exploration messages (these should be skipped by extractChatMessages)
		addExplorationMessages(session);
		handleEvent({ type: "agent_start" } as any);
		handleEvent({ type: "agent_end" } as any);

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// Only exploration — no chat bubbles
		const count = await countBubbles(page);
		expect(count).toBe(0);
	});

	test("rapid reconnect does not duplicate messages", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		// Set up a session with chat messages
		addExplorationMessages(session);
		handleEvent({ type: "agent_start" } as any);
		handleEvent({ type: "agent_end" } as any);

		simulateChatResponse(session, "Hello", "Hi there!");
		simulateChatResponse(session, "How are you?", "I'm doing well.");

		// Connect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		const firstCount = await countBubbles(page);
		expect(firstCount).toBe(4); // 2 user + 2 assistant

		// Rapid disconnect/reconnect 3 times
		for (let i = 0; i < 3; i++) {
			await page.goto("about:blank");
			await page.waitForTimeout(100);
			await page.goto(`http://localhost:${port}/`);
			await authenticate(page, token);
			await page.waitForTimeout(300);
		}

		// Count should be the same — no duplicates
		const finalCount = await countBubbles(page);
		expect(finalCount).toBe(4);
	});

	test("very long messages are preserved after reconnect", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		addExplorationMessages(session);
		handleEvent({ type: "agent_start" } as any);
		handleEvent({ type: "agent_end" } as any);

		// Create a long message (3000+ chars)
		const longQuestion = "Explain in detail: " + "the architecture of this system ".repeat(50);
		const longAnswer = "## Architecture\n\n" + "This module handles data processing by reading input files, transforming the data through a pipeline of processors, and writing the results to the output directory. ".repeat(30);

		simulateChatResponse(session, longQuestion, longAnswer);

		// Connect and verify
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		const bubbles = await getChatBubbles(page);
		expect(bubbles.length).toBe(2);

		// Verify the long content is present
		expect(bubbles[0].text.length).toBeGreaterThan(100);
		expect(bubbles[1].text.length).toBeGreaterThan(100);
		expect(bubbles[1].text).toContain("Architecture");

		// Disconnect and reconnect
		await page.goto("about:blank");
		await page.waitForTimeout(200);
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		const restored = await getChatBubbles(page);
		expect(restored.length).toBe(2);
		expect(restored[1].text).toContain("Architecture");
		expect(restored[1].text.length).toBeGreaterThan(100);
	});

	test("chat input works after reconnect", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		addExplorationMessages(session);
		handleEvent({ type: "agent_start" } as any);
		handleEvent({ type: "agent_end" } as any);

		// First connect — send a message
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(300);

		await page.fill("#input", "First question");
		await page.click("#sendBtn");
		await waitForUserBubble(page, "First question");
		await page.waitForTimeout(200);
		simulateChatResponse(session, "First question", "First answer.");
		await waitForAssistantBubble(page, "First answer");

		// Disconnect
		await page.goto("about:blank");
		await page.waitForTimeout(200);

		// Reconnect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// History should be restored
		const restoredBubbles = await getChatBubbles(page);
		expect(restoredBubbles.length).toBe(2);

		// Send another message — input should still work
		await page.fill("#input", "Second question after reconnect");
		await page.click("#sendBtn");
		await waitForUserBubble(page, "Second question after reconnect");
		await page.waitForTimeout(200);

		simulateChatResponse(session, "Second question after reconnect", "Second answer works!");
		await waitForAssistantBubble(page, "Second answer works");

		const finalBubbles = await getChatBubbles(page);
		expect(finalBubbles.length).toBe(4);
		expect(finalBubbles[2].role).toBe("user");
		expect(finalBubbles[2].text).toContain("Second question");
		expect(finalBubbles[3].role).toBe("assistant");
		expect(finalBubbles[3].text).toContain("Second answer");
	});

	test("messages survive multiple reconnect cycles in correct order", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		addExplorationMessages(session);
		handleEvent({ type: "agent_start" } as any);
		handleEvent({ type: "agent_end" } as any);

		// Build up messages across reconnects
		const exchanges = [
			{ q: "Question Alpha", a: "Answer Alpha" },
			{ q: "Question Beta", a: "Answer Beta" },
			{ q: "Question Gamma", a: "Answer Gamma" },
		];

		for (let i = 0; i < exchanges.length; i++) {
			await page.goto(`http://localhost:${port}/`);
			await authenticate(page, token);
			await page.waitForTimeout(300);

			// Send message and get response
			await page.fill("#input", exchanges[i].q);
			await page.click("#sendBtn");
			await waitForUserBubble(page, exchanges[i].q);
			await page.waitForTimeout(200);
			simulateChatResponse(session, exchanges[i].q, exchanges[i].a);
			await waitForAssistantBubble(page, exchanges[i].a);

			// Verify accumulated count
			const count = await countBubbles(page);
			expect(count).toBe((i + 1) * 2);

			// Disconnect between rounds (except last)
			if (i < exchanges.length - 1) {
				await page.goto("about:blank");
				await page.waitForTimeout(200);
			}
		}

		// Final reconnect — verify all messages in order
		await page.goto("about:blank");
		await page.waitForTimeout(200);
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		const bubbles = await getChatBubbles(page);
		expect(bubbles.length).toBe(6);

		// Verify order
		expect(bubbles[0].role).toBe("user");
		expect(bubbles[0].text).toContain("Alpha");
		expect(bubbles[1].role).toBe("assistant");
		expect(bubbles[1].text).toContain("Alpha");
		expect(bubbles[2].role).toBe("user");
		expect(bubbles[2].text).toContain("Beta");
		expect(bubbles[3].role).toBe("assistant");
		expect(bubbles[3].text).toContain("Beta");
		expect(bubbles[4].role).toBe("user");
		expect(bubbles[4].text).toContain("Gamma");
		expect(bubbles[5].role).toBe("assistant");
		expect(bubbles[5].text).toContain("Gamma");
	});

	test("scroll-to-top loads full history with many messages", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		addExplorationMessages(session);
		handleEvent({ type: "agent_start" } as any);
		handleEvent({ type: "agent_end" } as any);

		// Add 15 chat exchanges (30 messages total, exceeding RECENT_CHAT_LIMIT of 20)
		for (let i = 0; i < 15; i++) {
			addUserMessage(session, `Scroll test Q${i}: What about feature ${i}?`);
			addAssistantMessage(session, `Feature ${i} is implemented in module_${i}.ts.`);
		}

		const totalChat = extractChatMessages().length;
		expect(totalChat).toBe(30);

		// Connect — should get partial (20 most recent)
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		const initialCount = await countBubbles(page);
		expect(initialCount).toBe(20);

		// The first visible message should be from later in the series (not Q0)
		const initialBubbles = await getChatBubbles(page);
		// With 30 messages and limit 20, we skip the first 10 → start from Q5
		expect(initialBubbles[0].text).toContain("Q5");

		// Scroll to top to trigger full history
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});
		await page.waitForTimeout(1000);

		// Now should have all 30 messages
		const fullCount = await countBubbles(page);
		expect(fullCount).toBe(30);

		// First message should now be Q0
		const fullBubbles = await getChatBubbles(page);
		expect(fullBubbles[0].text).toContain("Q0");
		expect(fullBubbles[fullBubbles.length - 1].text).toContain("module_14");
	});

	test("new messages after scroll-to-top appear at bottom", async ({ page }) => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		addExplorationMessages(session);
		handleEvent({ type: "agent_start" } as any);
		handleEvent({ type: "agent_end" } as any);

		// Add 12 exchanges (24 messages, exceeds limit of 20)
		for (let i = 0; i < 12; i++) {
			addUserMessage(session, `History Q${i}`);
			addAssistantMessage(session, `History A${i}`);
		}

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// Load full history
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});
		await page.waitForTimeout(1000);

		const preCount = await countBubbles(page);
		expect(preCount).toBe(24);

		// Now send a new message
		await page.fill("#input", "New message after full load");
		await page.click("#sendBtn");
		await waitForUserBubble(page, "New message after full load");
		await page.waitForTimeout(200);

		simulateChatResponse(session, "New message after full load", "Fresh response!");
		await waitForAssistantBubble(page, "Fresh response");

		const postCount = await countBubbles(page);
		expect(postCount).toBe(26);

		// New messages should be at the end
		const bubbles = await getChatBubbles(page);
		expect(bubbles[bubbles.length - 2].text).toContain("New message after full load");
		expect(bubbles[bubbles.length - 1].text).toContain("Fresh response");
	});
});
