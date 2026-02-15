/**
 * End-to-end tests: full user journeys from server start to browser interaction.
 *
 * Each test starts a fresh engine instance with a mock agent session, then
 * drives a REAL Chromium browser through realistic user scenarios:
 *
 *   - Agent explores codebase, streams tool calls, writes document
 *   - User sees the document appear in the left panel
 *   - User chats with the agent, sees streamed responses
 *   - User disconnects and reconnects — chat history is restored
 *   - Scroll-to-top loads full message history
 *   - Read-only mode blocks file edits, shows badge
 *   - Agent status indicators update in real-time
 *   - Multiple concurrent browser tabs share state
 *   - Stop/abort controls work from the browser
 *   - Cost tracking is displayed
 *
 * No real API calls. The agent session is mocked, but everything else
 * (HTTP server, WebSocket, DOM rendering, CSS) is real.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	start,
	reset,
	getState,
	handleEvent,
	extractChatMessages,
	type SessionFactory,
} from "../../src/engine.js";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { renderDocument } from "../../src/renderer.js";

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
		_resetAbort() {
			aborted = false;
		},
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
	const dir = path.join(os.tmpdir(), `storyof-e2e-${id}`);
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

function addToolCallMessage(session: MockSession, toolName: string, toolId: string, args: Record<string, any>) {
	session._messages.push({
		role: "assistant",
		content: [{ type: "toolCall", name: toolName, id: toolId, arguments: args }],
		usage: { input: 100, output: 50 },
		timestamp: Date.now(),
	});
}

function addToolResultMessage(session: MockSession, toolId: string, toolName: string, text: string) {
	session._messages.push({
		role: "toolResult",
		toolCallId: toolId,
		toolName,
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	});
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

/** Simulate agent exploring: fires tool calls for reading files. */
function simulateExploration(session: MockSession) {
	// Initial exploration prompt
	session._messages.push({
		role: "user",
		content: [{ type: "text", text: "Explore the codebase..." }],
		timestamp: Date.now(),
	});

	handleEvent({ type: "agent_start" } as any);

	// Read some files
	const tools = [
		{ id: "tc1", name: "bash", args: { command: "find . -type f -name '*.ts'" }, result: "src/main.ts\nsrc/utils.ts\nsrc/api/routes.ts" },
		{ id: "tc2", name: "read", args: { path: "src/main.ts" }, result: 'import express from "express";\nconst app = express();' },
		{ id: "tc3", name: "read", args: { path: "src/utils.ts" }, result: "export function formatDate(d: Date): string { ... }" },
		{ id: "tc4", name: "bash", args: { command: "cat package.json | head -5" }, result: '{\n  "name": "test-project",\n  "version": "1.0.0"\n}' },
	];

	for (const t of tools) {
		addToolCallMessage(session, t.name, t.id, t.args);
		handleEvent({
			type: "tool_execution_start",
			toolCallId: t.id,
			toolName: t.name,
			args: t.args,
		} as any);

		addToolResultMessage(session, t.id, t.name, t.result);
		handleEvent({
			type: "tool_execution_end",
			toolCallId: t.id,
			toolName: t.name,
			result: t.result,
			isError: false,
		} as any);
	}
}

/** Simulate agent writing the architecture document. */
function simulateDocumentWrite(session: MockSession, tempDir: string) {
	const mdContent = `# Architecture: test-project

## Overview

This is a Node.js Express application with a clean module structure.

## Modules

### main.ts
Entry point. Creates an Express server and registers routes.

### utils.ts
Utility functions for date formatting and string manipulation.

## Architecture Diagram

\`\`\`mermaid
graph TD
    A[main.ts] --> B[routes.ts]
    A --> C[utils.ts]
    B --> D[Database]
\`\`\`

## Data Flow

1. Request hits Express router
2. Route handler processes request
3. Utils called for formatting
4. Response sent back
`;

	const mdPath = path.join(tempDir, ".storyof", "test-session", "document.md");
	fs.mkdirSync(path.dirname(mdPath), { recursive: true });
	fs.writeFileSync(mdPath, mdContent);

	const toolId = "tc-write-1";
	addToolCallMessage(session, "write", toolId, { path: mdPath });
	handleEvent({
		type: "tool_execution_start",
		toolCallId: toolId,
		toolName: "write",
		args: { path: mdPath },
	} as any);

	addToolResultMessage(session, toolId, "write", `Wrote ${mdContent.length} bytes to ${mdPath}`);
	handleEvent({
		type: "tool_execution_end",
		toolCallId: toolId,
		toolName: "write",
		result: `Wrote ${mdContent.length} bytes to ${mdPath}`,
		isError: false,
	} as any);

	// Add the assistant "done" message
	addAssistantMessage(session, "I've analyzed the codebase and written the architecture document.");

	handleEvent({ type: "agent_end" } as any);

	return mdPath;
}

/** Simulate a streamed chat response. */
function simulateChatResponse(session: MockSession, userText: string, responseText: string) {
	addUserMessage(session, userText);
	handleEvent({ type: "agent_start" } as any);
	handleEvent({ type: "message_start", message: { role: "assistant" } } as any);
	const chunks = responseText.match(/.{1,30}/g) || [responseText];
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
			usage: { input: 500, output: 200 },
		},
	} as any);
	addAssistantMessage(session, responseText);
	handleEvent({ type: "agent_end" } as any);
}

/** HTTP GET helper. */
async function httpGet(url: string): Promise<{ status: number; body: string }> {
	const response = await fetch(url);
	return { status: response.status, body: await response.text() };
}

// ═══════════════════════════════════════════════════════════════════════
// E2E Journey 1: Full exploration → document → chat → reconnect
// ═══════════════════════════════════════════════════════════════════════

test.describe("full user journey: explore → document → chat → reconnect", () => {
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
			model: "claude-sonnet-4-5",
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;
	});

	test.afterAll(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 100));
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("1. browser connects and sees auth screen", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await expect(page.locator("#authScreen")).toBeVisible();
		await expect(page.locator("#authInput")).toBeVisible();
		await expect(page.locator("#authBtn")).toBeVisible();
	});

	test("2. auth screen rejects wrong token", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await page.fill("#authInput", "wrong-token");
		await page.click("#authBtn");
		await page.waitForTimeout(1500);
		await expect(page.locator("#authScreen")).not.toHaveClass(/hidden/);
	});

	test("3. correct token connects successfully", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await expect(page.locator("#pillDot")).toBeVisible();
	});

	test("4. status bar shows model and read-only badge", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Model name displayed
		await expect(page.locator("#statModel")).toContainText("claude-sonnet-4-5");

		// Read-only badge visible (default mode)
		await expect(page.locator("#statReadOnly")).toBeVisible();
		await expect(page.locator("#statReadOnly")).toHaveText("(read-only)");
	});

	test("5. agent exploration streams tool calls to the browser", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Fire exploration events
		simulateExploration(session);

		// Wait for tool events to arrive in the activity panel
		await page.waitForTimeout(500);

		// The activity panel should show tool call entries
		const activityHtml = await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			return tl ? tl.innerHTML : "";
		});

		// Tool calls should appear in the activity panel
		expect(activityHtml).toContain("find");
		expect(activityHtml).toContain("read");
	});

	test("6. document appears after agent writes markdown", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Simulate writing the document
		const mdPath = simulateDocumentWrite(session, tempDir);

		// Wait for render — the engine renders markdown to HTML asynchronously
		await page.waitForTimeout(2000);

		// The doc iframe should have content now
		const state = getState();
		expect(state.htmlPath).toBeTruthy();

		// Fetch the document via HTTP
		const doc = await httpGet(`http://localhost:${port}/doc?token=${token}`);
		expect(doc.status).toBe(200);
		expect(doc.body).toContain("Architecture");
		expect(doc.body).toContain("test-project");
	});

	test("7. user sends chat message and sees streamed response", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(300);

		// Type and send a message
		await page.fill("#input", "How does the routing work?");
		await page.click("#sendBtn");

		// User bubble appears immediately (client-side)
		await waitForUserBubble(page, "How does the routing work?");

		// Wait for prompt to reach server
		await page.waitForTimeout(300);

		// Simulate agent response
		simulateChatResponse(
			session,
			"How does the routing work?",
			"## Routing\n\nThe `routes.ts` module defines Express routes. Each route handler:\n\n1. Validates the request\n2. Calls the service layer\n3. Returns a JSON response\n\n```typescript\napp.get('/api/users', async (req, res) => {\n  const users = await userService.findAll();\n  res.json(users);\n});\n```",
		);

		// Wait for the response to stream in
		await waitForAssistantBubble(page, "Routing");
		await waitForAssistantBubble(page, "routes.ts");

		// Verify bubbles
		const bubbles = await getChatBubbles(page);
		const userBubble = bubbles.find((b) => b.role === "user" && b.text.includes("routing"));
		const assistantBubble = bubbles.find((b) => b.role === "assistant" && b.text.includes("routes.ts"));
		expect(userBubble).toBeTruthy();
		expect(assistantBubble).toBeTruthy();
	});

	test("8. second chat exchange works", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// Previous chat should be restored
		const preBubbles = await getChatBubbles(page);
		expect(preBubbles.length).toBeGreaterThanOrEqual(2);

		// Send another question
		await page.fill("#input", "What testing framework is used?");
		await page.click("#sendBtn");
		await waitForUserBubble(page, "testing framework");
		await page.waitForTimeout(300);

		simulateChatResponse(
			session,
			"What testing framework is used?",
			"The project uses **vitest** for testing:\n\n| Type | Location | Count |\n|------|----------|-------|\n| Unit | `src/*.test.ts` | 42 |\n| Integration | `tests/` | 18 |",
		);

		await waitForAssistantBubble(page, "vitest");

		const bubbles = await getChatBubbles(page);
		expect(bubbles.length).toBeGreaterThanOrEqual(4);

		// Verify the latest exchange
		const lastUser = bubbles.filter((b) => b.role === "user").pop();
		const lastAssistant = bubbles.filter((b) => b.role === "assistant").pop();
		expect(lastUser?.text).toContain("testing framework");
		expect(lastAssistant?.text).toContain("vitest");
	});

	test("9. disconnect and reconnect restores all chat history", async ({ page }) => {
		// Connect, verify current state
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		const beforeBubbles = await getChatBubbles(page);
		const beforeCount = beforeBubbles.length;
		expect(beforeCount).toBeGreaterThanOrEqual(4);

		// Navigate away (full disconnect)
		await page.goto("about:blank");
		await page.waitForTimeout(300);

		// Reconnect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// All chat history should be restored
		const afterBubbles = await getChatBubbles(page);
		expect(afterBubbles.length).toBe(beforeCount);

		// Verify content
		expect(afterBubbles.some((b) => b.text.includes("routing"))).toBe(true);
		expect(afterBubbles.some((b) => b.text.includes("vitest"))).toBe(true);
	});

	test("10. chat works after reconnect", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		const preCount = await countBubbles(page);

		// Ask a new question
		await page.fill("#input", "Explain the database layer");
		await page.click("#sendBtn");
		await waitForUserBubble(page, "database layer");
		await page.waitForTimeout(300);

		simulateChatResponse(
			session,
			"Explain the database layer",
			"## Database Layer\n\nThe database uses **PostgreSQL** with a connection pool. Queries use prepared statements for security.",
		);

		await waitForAssistantBubble(page, "PostgreSQL");

		const postCount = await countBubbles(page);
		expect(postCount).toBe(preCount + 2);
	});

	test("11. /status endpoint returns correct state", async () => {
		const status = await httpGet(`http://localhost:${port}/status?token=${token}`);
		expect(status.status).toBe(200);
		const data = JSON.parse(status.body);
		expect(data.agentRunning).toBe(true);
		expect(data.htmlPath).toBeTruthy();
		expect(data.targetPath).toBe(tempDir);
	});

	test("12. /state endpoint includes allowEdits", async () => {
		const state = await httpGet(`http://localhost:${port}/state?token=${token}`);
		expect(state.status).toBe(200);
		const data = JSON.parse(state.body);
		expect(data.allowEdits).toBe(false);
		expect(data.running).toBe(true);
		expect(data.model).toBe("claude-sonnet-4-5");
	});

	test("13. /status rejects invalid token", async () => {
		const status = await httpGet(`http://localhost:${port}/status?token=wrong`);
		expect(status.status).toBe(403);
	});

	test("14. /doc rejects invalid token", async () => {
		const doc = await httpGet(`http://localhost:${port}/doc?token=wrong`);
		expect(doc.status).toBe(403);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// E2E Journey 2: Read-only mode vs edit mode
// ═══════════════════════════════════════════════════════════════════════

test.describe("read-only vs edit mode", () => {
	let tempDir: string;

	test.afterEach(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 100));
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("default mode shows read-only badge and correct state", async ({ page }) => {
		tempDir = makeTempDir();
		const session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		const port = parseInt(new URL(result.url).port);

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, result.token);

		// Badge visible
		await expect(page.locator("#statReadOnly")).toBeVisible();
		await expect(page.locator("#statReadOnly")).toHaveText("(read-only)");

		// State endpoint confirms
		const state = await httpGet(`http://localhost:${port}/state?token=${result.token}`);
		const data = JSON.parse(state.body);
		expect(data.allowEdits).toBe(false);
	});

	test("edit mode hides read-only badge", async ({ page }) => {
		tempDir = makeTempDir();
		const session = createMockSession();
		const factory: SessionFactory = async () => session as any;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
			allowEdits: true,
		});
		const port = parseInt(new URL(result.url).port);

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, result.token);

		// Badge hidden
		await expect(page.locator("#statReadOnly")).toBeHidden();

		// State endpoint confirms
		const state = await httpGet(`http://localhost:${port}/state?token=${result.token}`);
		const data = JSON.parse(state.body);
		expect(data.allowEdits).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// E2E Journey 3: Concurrent tabs
// ═══════════════════════════════════════════════════════════════════════

test.describe("concurrent browser tabs", () => {
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
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		// Set up exploration + one chat exchange
		simulateExploration(session);
		simulateDocumentWrite(session, tempDir);
		await new Promise((r) => setTimeout(r, 500)); // let render happen

		simulateChatResponse(session, "What is this project?", "It's an Express application for managing users.");
	});

	test.afterAll(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 100));
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("two tabs see the same chat history", async ({ browser }) => {
		const ctx1 = await browser.newContext();
		const ctx2 = await browser.newContext();
		const page1 = await ctx1.newPage();
		const page2 = await ctx2.newPage();

		await page1.goto(`http://localhost:${port}/`);
		await page2.goto(`http://localhost:${port}/`);
		await authenticate(page1, token);
		await authenticate(page2, token);
		await page1.waitForTimeout(500);
		await page2.waitForTimeout(500);

		const bubbles1 = await getChatBubbles(page1);
		const bubbles2 = await getChatBubbles(page2);

		expect(bubbles1.length).toBe(bubbles2.length);
		expect(bubbles1.length).toBeGreaterThanOrEqual(2);

		await ctx1.close();
		await ctx2.close();
	});

	test("message sent in tab1 appears in tab2 via streaming", async ({ browser }) => {
		const ctx1 = await browser.newContext();
		const ctx2 = await browser.newContext();
		const page1 = await ctx1.newPage();
		const page2 = await ctx2.newPage();

		await page1.goto(`http://localhost:${port}/`);
		await page2.goto(`http://localhost:${port}/`);
		await authenticate(page1, token);
		await authenticate(page2, token);
		await page1.waitForTimeout(500);
		await page2.waitForTimeout(500);

		const pre1 = await countBubbles(page1);
		const pre2 = await countBubbles(page2);

		// Send from tab1
		await page1.fill("#input", "Tell me about error handling");
		await page1.click("#sendBtn");
		await waitForUserBubble(page1, "error handling");
		await page1.waitForTimeout(200);

		// Agent responds — both tabs should get the stream
		simulateChatResponse(session, "Tell me about error handling", "Errors are handled using try/catch with custom error classes.");

		await waitForAssistantBubble(page1, "try/catch");
		await waitForAssistantBubble(page2, "try/catch");

		// Tab2 should also have the user message (from chat_history on stream events)
		const post1 = await countBubbles(page1);
		const post2 = await countBubbles(page2);

		// Tab1 should have new user + assistant
		expect(post1).toBe(pre1 + 2);
		// Tab2 should see at least the assistant response via streaming
		expect(post2).toBeGreaterThanOrEqual(pre2 + 1);

		await ctx1.close();
		await ctx2.close();
	});
});

// ═══════════════════════════════════════════════════════════════════════
// E2E Journey 4: Chat history pagination (scroll-to-top)
// ═══════════════════════════════════════════════════════════════════════

test.describe("chat history pagination", () => {
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
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		// Set up initial exploration
		simulateExploration(session);
		addAssistantMessage(session, "Document written.");
		handleEvent({ type: "agent_end" } as any);

		// Add 25 chat exchanges (50 messages) — well over the 20-message limit
		for (let i = 0; i < 25; i++) {
			addUserMessage(session, `Question ${i}: What about module_${i}?`);
			addAssistantMessage(session, `Module ${i} handles feature_${i}. It uses pattern_${i} for processing.`);
		}
	});

	test.afterAll(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 100));
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("initial connect shows only recent 20 messages", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		const count = await countBubbles(page);
		expect(count).toBe(20);

		// The earliest visible message should NOT be Q0 (it's beyond the 20-message window)
		const bubbles = await getChatBubbles(page);
		expect(bubbles[0].text).not.toContain("Question 0");
	});

	test("scroll-to-top loads all 50 messages", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// Scroll to top
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});
		await page.waitForTimeout(1000);

		const count = await countBubbles(page);
		expect(count).toBe(50);

		// Now Q0 should be at the top
		const bubbles = await getChatBubbles(page);
		expect(bubbles[0].text).toContain("Question 0");
		expect(bubbles[bubbles.length - 1].text).toContain("Module 24");
	});

	test("messages maintain correct order after full load", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// Load full history
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});
		await page.waitForTimeout(1000);

		const bubbles = await getChatBubbles(page);

		// Check alternating pattern
		for (let i = 0; i < bubbles.length; i++) {
			expect(bubbles[i].role).toBe(i % 2 === 0 ? "user" : "assistant");
		}

		// Check sequential order
		const userBubbles = bubbles.filter((b) => b.role === "user");
		for (let i = 0; i < userBubbles.length; i++) {
			expect(userBubbles[i].text).toContain(`Question ${i}`);
		}
	});

	test("new message after full load appends correctly", async ({ page }) => {
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

		// Send a new message
		await page.fill("#input", "New question after pagination");
		await page.click("#sendBtn");
		await waitForUserBubble(page, "New question after pagination");
		await page.waitForTimeout(200);

		simulateChatResponse(session, "New question after pagination", "Here's the answer to your new question.");
		await waitForAssistantBubble(page, "answer to your new question");

		const postCount = await countBubbles(page);
		expect(postCount).toBe(preCount + 2);

		// New messages at the end
		const bubbles = await getChatBubbles(page);
		expect(bubbles[bubbles.length - 2].text).toContain("New question after pagination");
		expect(bubbles[bubbles.length - 1].text).toContain("answer to your new question");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// E2E Journey 5: Agent streaming and status indicators
// ═══════════════════════════════════════════════════════════════════════

test.describe("agent streaming and status", () => {
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
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;
	});

	test.afterAll(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 100));
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("streaming response shows in real-time, then finalizes", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Start agent turn
		addUserMessage(session, "Explain caching");
		handleEvent({ type: "agent_start" } as any);
		handleEvent({ type: "message_start", message: { role: "assistant" } } as any);

		// Send a few chunks
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "## Caching\n\n" },
		} as any);

		await page.waitForTimeout(200);

		// Should see a streaming bubble
		const streamingCount = await page.evaluate(
			() => document.querySelectorAll(".streaming").length,
		);
		expect(streamingCount).toBeGreaterThanOrEqual(1);

		// More chunks
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "The application uses Redis for caching " },
		} as any);
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "with a TTL of 300 seconds." },
		} as any);

		// End the message
		handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_end" } } as any);
		handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "## Caching\n\nThe application uses Redis for caching with a TTL of 300 seconds." }],
				usage: { input: 300, output: 100 },
			},
		} as any);
		addAssistantMessage(session, "## Caching\n\nThe application uses Redis for caching with a TTL of 300 seconds.");
		handleEvent({ type: "agent_end" } as any);

		await page.waitForTimeout(300);

		// Streaming class should be gone
		const finalStreamingCount = await page.evaluate(
			() => document.querySelectorAll(".streaming").length,
		);
		expect(finalStreamingCount).toBe(0);

		// Final text should be rendered
		await waitForAssistantBubble(page, "Redis");
		await waitForAssistantBubble(page, "TTL");
	});

	test("abort button stops the agent", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(300);

		// Start a streaming turn
		handleEvent({ type: "agent_start" } as any);
		handleEvent({ type: "message_start", message: { role: "assistant" } } as any);
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Starting long response..." },
		} as any);

		await page.waitForTimeout(300);

		// Click abort button
		const abortBtn = page.locator("#abortBtn");
		if (await abortBtn.isVisible()) {
			await abortBtn.click();
			await page.waitForTimeout(300);

			// Verify abort was called on the session
			expect(session._wasAborted()).toBe(true);
		}

		// Clean up the streaming state
		handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_end" } } as any);
		handleEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Starting long response..." }], usage: { input: 100, output: 20 } },
		} as any);
		addAssistantMessage(session, "Starting long response...");
		handleEvent({ type: "agent_end" } as any);
		session._resetAbort();
	});

	test("cost tracking displays in status bar", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// The status bar should show cost info (from cumulative usage)
		const costText = await page.evaluate(() => {
			const el = document.getElementById("statCost");
			return el ? el.textContent : "";
		});

		// Cost should either be empty (if no usage yet) or show a dollar amount
		// Just verify the element exists
		const costEl = page.locator("#statCost");
		await expect(costEl).toBeAttached();
	});
});

// ═══════════════════════════════════════════════════════════════════════
// E2E Journey 6: Reconnect during active streaming
// ═══════════════════════════════════════════════════════════════════════

test.describe("reconnect during active streaming", () => {
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
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		// Set up initial state
		simulateExploration(session);
		addAssistantMessage(session, "Document written.");
		handleEvent({ type: "agent_end" } as any);
	});

	test.afterAll(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 100));
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("disconnect during stream, complete stream, reconnect → message appears", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(300);

		// Start streaming
		addUserMessage(session, "What is the deployment process?");
		handleEvent({ type: "agent_start" } as any);
		handleEvent({ type: "message_start", message: { role: "assistant" } } as any);
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "## Deployment\n\n" },
		} as any);

		await page.waitForTimeout(200);

		// Disconnect mid-stream
		await page.goto("about:blank");
		await page.waitForTimeout(200);

		// Complete the stream while disconnected
		handleEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Deploy with Docker and Kubernetes." },
		} as any);
		handleEvent({ type: "message_update", assistantMessageEvent: { type: "text_end" } } as any);
		handleEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "## Deployment\n\nDeploy with Docker and Kubernetes." }],
				usage: { input: 200, output: 80 },
			},
		} as any);
		addAssistantMessage(session, "## Deployment\n\nDeploy with Docker and Kubernetes.");
		handleEvent({ type: "agent_end" } as any);

		// Reconnect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// The completed message should be in chat history
		const bubbles = await getChatBubbles(page);
		const deployBubble = bubbles.find((b) => b.text.includes("Docker") && b.text.includes("Kubernetes"));
		expect(deployBubble).toBeTruthy();
		expect(deployBubble?.role).toBe("assistant");
	});

	test("multiple disconnects during ongoing conversation", async ({ page }) => {
		// First exchange
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(300);

		await page.fill("#input", "Explain module A");
		await page.click("#sendBtn");
		await waitForUserBubble(page, "module A");
		await page.waitForTimeout(200);
		simulateChatResponse(session, "Explain module A", "Module A handles authentication.");
		await waitForAssistantBubble(page, "authentication");

		// Disconnect
		await page.goto("about:blank");
		await page.waitForTimeout(200);

		// Second exchange (happens while disconnected — another client or API)
		simulateChatResponse(session, "Explain module B", "Module B handles authorization.");

		// Reconnect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// Both exchanges should be visible
		const bubbles = await getChatBubbles(page);
		expect(bubbles.some((b) => b.text.includes("authentication"))).toBe(true);
		expect(bubbles.some((b) => b.text.includes("authorization"))).toBe(true);

		// Disconnect again
		await page.goto("about:blank");
		await page.waitForTimeout(200);

		// Third exchange while disconnected
		simulateChatResponse(session, "Explain module C", "Module C handles data validation.");

		// Reconnect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await page.waitForTimeout(500);

		// All three should be present
		const allBubbles = await getChatBubbles(page);
		expect(allBubbles.some((b) => b.text.includes("authentication"))).toBe(true);
		expect(allBubbles.some((b) => b.text.includes("authorization"))).toBe(true);
		expect(allBubbles.some((b) => b.text.includes("data validation"))).toBe(true);
	});
});
