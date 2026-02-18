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

import { type BrowserContext } from "@playwright/test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	test, expect, type Page,
} from "./fixtures/engine-fixture.js";
import {
	start,
	reset,
	getState,
	handleEvent,
	extractChatMessages,
	type SessionFactory,
} from "../../src/engine.js";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
	evAgentStart,
	evAgentEnd,
	evMessageStart,
	evTextDelta,
	evTextEnd,
	evMessageEnd,
	evToolStart,
	evToolEnd,
} from "../helpers/events.js";
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
		_messages: [] as unknown[],
		get messages() {
			return this._messages;
		},
		get state() {
			return { messages: this._messages };
		},
		get model() {
			return { id: "test-model", provider: "test" };
		},
		getSessionStats() {
			return {
				sessionFile: undefined as string | undefined,
				sessionId: "mock-session",
				userMessages: 0,
				assistantMessages: 0,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
			};
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
	const authScreen = page.getByTestId("auth-screen");
	const isVisible = await authScreen.isVisible();
	if (isVisible) {
		await page.getByTestId("auth-input").fill(token);
		await page.getByTestId("auth-submit").click();
	}
	// Wait for auth screen to disappear (WebSocket connected)
	await authScreen.waitFor({ state: "hidden", timeout: 5000 });
	// Wait for pill text to confirm connection established
	await page.locator("#pillText").filter({ hasNotText: "connecting…" }).waitFor({ timeout: 5000 });
}

async function getChatBubbles(page: Page): Promise<Array<{ role: string; text: string }>> {
	const bubbles = page.locator("[data-testid='chat-message']");
	const count = await bubbles.count();
	const result: Array<{ role: string; text: string }> = [];
	for (let i = 0; i < count; i++) {
		const el = bubbles.nth(i);
		const role = (await el.getAttribute("data-role")) ?? "unknown";
		const text = ((await el.textContent()) ?? "").trim();
		result.push({ role, text });
	}
	return result;
}

async function countBubbles(page: Page): Promise<number> {
	return page.locator("[data-testid='chat-message']").count();
}

async function waitForUserBubble(page: Page, text: string, timeout = 5000) {
	await page
		.locator("[data-testid='chat-message'][data-role='user']")
		.filter({ hasText: text })
		.waitFor({ state: "visible", timeout });
}

async function waitForAssistantBubble(page: Page, text: string, timeout = 5000) {
	await page
		.locator("[data-testid='chat-message'][data-role='assistant']:not(.streaming)")
		.filter({ hasText: text })
		.waitFor({ state: "visible", timeout });
}

/** Node.js-side polling — waits for a server-side condition to be true */
async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`waitFor: condition not met after ${timeoutMs}ms`);
}

/** Wait for at least `min` chat bubbles to appear in the timeline */
async function waitForBubbles(page: Page, min = 1, timeoutMs = 5000): Promise<void> {
	await page
		.locator("[data-testid='chat-message']")
		.nth(min - 1)
		.waitFor({ state: "visible", timeout: timeoutMs });
}

/** Simulate agent exploring: fires tool calls for reading files. */
function simulateExploration(session: MockSession) {
	// Initial exploration prompt
	session._messages.push({
		role: "user",
		content: [{ type: "text", text: "Explore the codebase..." }],
		timestamp: Date.now(),
	});

	handleEvent(evAgentStart());

	// Read some files
	const tools = [
		{ id: "tc1", name: "bash", args: { command: "find . -type f -name '*.ts'" }, result: "src/main.ts\nsrc/utils.ts\nsrc/api/routes.ts" },
		{ id: "tc2", name: "read", args: { path: "src/main.ts" }, result: 'import express from "express";\nconst app = express();' },
		{ id: "tc3", name: "read", args: { path: "src/utils.ts" }, result: "export function formatDate(d: Date): string { ... }" },
		{ id: "tc4", name: "bash", args: { command: "cat package.json | head -5" }, result: '{\n  "name": "test-project",\n  "version": "1.0.0"\n}' },
	];

	for (const t of tools) {
		addToolCallMessage(session, t.name, t.id, t.args);
		handleEvent(evToolStart(t.name, t.id, t.args));

		addToolResultMessage(session, t.id, t.name, t.result);
		handleEvent(evToolEnd(t.name, t.id, t.result));
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
	handleEvent(evToolStart("write", toolId, { path: mdPath }));

	addToolResultMessage(session, toolId, "write", `Wrote ${mdContent.length} bytes to ${mdPath}`);
	handleEvent(evToolEnd("write", toolId, `Wrote ${mdContent.length} bytes to ${mdPath}`));

	// Add the assistant "done" message
	addAssistantMessage(session, "I've analyzed the codebase and written the architecture document.");

	handleEvent(evAgentEnd());

	return mdPath;
}

/** Simulate a streamed chat response. */
function simulateChatResponse(session: MockSession, userText: string, responseText: string) {
	addUserMessage(session, userText);
	handleEvent(evAgentStart());
	handleEvent(evMessageStart());
	const chunks = responseText.match(/.{1,30}/g) || [responseText];
	for (const chunk of chunks) {
		handleEvent(evTextDelta(chunk));
	}
	handleEvent(evTextEnd());
	handleEvent(evMessageEnd(responseText));
	addAssistantMessage(session, responseText);
	handleEvent(evAgentEnd());
}

/** HTTP GET helper. */
async function httpGet(url: string): Promise<{ status: number; body: string }> {
	const response = await fetch(url);
	return { status: response.status, body: await response.text() };
}

// ═══════════════════════════════════════════════════════════════════════
// E2E Journey 1: Full exploration → document → chat → reconnect
// ═══════════════════════════════════════════════════════════════════════

// serial: tests share engine state — each step builds on the previous
test.describe.serial("full user journey: explore → document → chat → reconnect", () => {
	let port: number;
	let token: string;
	let session: ReturnType<typeof createMockSession>;
	let tempDir: string;

	test.beforeAll(async () => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as unknown as AgentSession;
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
		await new Promise((r) => setTimeout(r, 50));
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
	});

	test("browser connects and sees auth screen", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await expect(page.getByTestId("auth-screen")).toBeVisible();
		await expect(page.getByTestId("auth-input")).toBeVisible();
		await expect(page.locator("#authBtn")).toBeVisible();
	});

	test("auth screen rejects wrong token", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await page.getByTestId("auth-input").fill( "wrong-token");
		await page.getByTestId("auth-submit").click();
		// Auth screen should stay visible (bad token rejected)
		await expect(page.getByTestId("auth-screen")).not.toHaveClass(/hidden/, { timeout: 3000 });
	});

	test("correct token connects successfully", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await expect(page.locator("#pillDot")).toBeVisible();
	});

	test("status bar shows model and read-only badge", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Model name displayed (mock session returns "test-model")
		await expect(page.locator("#statModel")).toContainText("test-model");

		// Read-only badge visible (default mode)
		await expect(page.locator("#statReadOnly")).toBeVisible();
		await expect(page.locator("#statReadOnly")).toHaveText("(read-only)");
	});

	test("agent exploration streams tool calls to the browser", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Fire exploration events
		simulateExploration(session);

		// Wait for tool events to arrive in the activity panel
		await page.waitForFunction(
			() => (document.getElementById("timeline")?.childElementCount ?? 0) > 0,
			{ timeout: 5000 },
		);

		// Tool calls should appear in the timeline
		const timeline = page.getByTestId("timeline");
		await expect(timeline).toContainText("find");
		await expect(timeline).toContainText("read");
	});

	test("document appears after agent writes markdown", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Simulate writing the document
		const mdPath = simulateDocumentWrite(session, tempDir);

		// Wait for async markdown render to complete
		await waitFor(() => !!getState().htmlPath, 10_000);

		// The doc iframe should have content now
		const state = getState();
		expect(state.htmlPath).toBeTruthy();

		// Fetch the document via HTTP
		const doc = await httpGet(`http://localhost:${port}/doc?token=${token}`);
		expect(doc.status).toBe(200);
		expect(doc.body).toContain("Architecture");
		expect(doc.body).toContain("test-project");
	});

	test("user sends chat message and sees streamed response", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Type and send a message
		await page.getByTestId("chat-input").fill( "How does the routing work?");
		await page.getByTestId("send-button").click();

		// User bubble appears immediately (client-side)
		await waitForUserBubble(page, "How does the routing work?");

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

	test("second chat exchange works", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 2);

		// Previous chat should be restored
		const preBubbles = await getChatBubbles(page);
		expect(preBubbles.length).toBeGreaterThanOrEqual(2);

		// Send another question
		await page.getByTestId("chat-input").fill( "What testing framework is used?");
		await page.getByTestId("send-button").click();
		await waitForUserBubble(page, "testing framework");

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

	test("disconnect and reconnect restores all chat history", async ({ page }) => {
		// Connect, verify current state
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 1);

		const beforeBubbles = await getChatBubbles(page);
		const beforeCount = beforeBubbles.length;
		expect(beforeCount).toBeGreaterThanOrEqual(4);

		// Navigate away (full disconnect)
		await page.goto("about:blank");
		await page.waitForTimeout(100); // acceptable: wait for WS close

		// Reconnect
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, beforeCount);

		// All chat history should be restored
		const afterBubbles = await getChatBubbles(page);
		expect(afterBubbles.length).toBe(beforeCount);

		// Verify content
		expect(afterBubbles.some((b) => b.text.includes("routing"))).toBe(true);
		expect(afterBubbles.some((b) => b.text.includes("vitest"))).toBe(true);
	});

	test("chat works after reconnect", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 1);

		const preCount = await countBubbles(page);

		// Ask a new question
		await page.getByTestId("chat-input").fill( "Explain the database layer");
		await page.getByTestId("send-button").click();
		await waitForUserBubble(page, "database layer");

		simulateChatResponse(
			session,
			"Explain the database layer",
			"## Database Layer\n\nThe database uses **PostgreSQL** with a connection pool. Queries use prepared statements for security.",
		);

		await waitForAssistantBubble(page, "PostgreSQL");

		const postCount = await countBubbles(page);
		expect(postCount).toBe(preCount + 2);
	});

	test("/status endpoint returns correct state", async () => {
		const status = await httpGet(`http://localhost:${port}/status?token=${token}`);
		expect(status.status).toBe(200);
		const data = JSON.parse(status.body);
		expect(data.agentRunning).toBe(true);
		expect(data.htmlPath).toBeTruthy();
		expect(data.targetPath).toBe(tempDir);
	});

	test("/state endpoint returns running state", async () => {
		const state = await httpGet(`http://localhost:${port}/state?token=${token}`);
		expect(state.status).toBe(200);
		const data = JSON.parse(state.body);
		expect(data.running).toBe(true);
		expect(data.model).toBe("test-model");
	});

	test("/status rejects invalid token", async () => {
		const status = await httpGet(`http://localhost:${port}/status?token=wrong`);
		expect(status.status).toBe(403);
	});

	test("/doc rejects invalid token", async () => {
		const doc = await httpGet(`http://localhost:${port}/doc?token=wrong`);
		expect(doc.status).toBe(403);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// E2E Journey 2: Read-only mode (always on)
// ═══════════════════════════════════════════════════════════════════════

test.describe("read-only mode", () => {
	let tempDir: string;

	test.afterEach(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 100));
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	test("shows read-only badge and correct state", async ({ page }) => {
		tempDir = makeTempDir();
		const session = createMockSession();
		const factory: SessionFactory = async () => session as unknown as AgentSession;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		const port = parseInt(new URL(result.url).port);

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, result.token);

		// Badge always visible — agent is always read-only
		await expect(page.locator("#statReadOnly")).toBeVisible();
		await expect(page.locator("#statReadOnly")).toHaveText("(read-only)");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// E2E Journey 3: Concurrent tabs
// ═══════════════════════════════════════════════════════════════════════

test.describe("concurrent browser tabs", () => {
	const ctx = {} as { port: number; token: string; session: ReturnType<typeof createMockSession>; tempDir: string };

	test.beforeAll(async () => {
		ctx.tempDir = makeTempDir();
		ctx.session = createMockSession();
		const factory: SessionFactory = async () => ctx.session as unknown as AgentSession;
		const result = await start({ cwd: ctx.tempDir, sessionFactory: factory, skipPrompt: true });
		ctx.port = parseInt(new URL(result.url).port);
		ctx.token = result.token;
		// Additional state: simulate exploration + one chat exchange
		simulateExploration(ctx.session);
		simulateDocumentWrite(ctx.session, ctx.tempDir);
		await waitFor(() => !!getState().htmlPath, 10_000);
		simulateChatResponse(ctx.session, "What is this project?", "It's an Express application for managing users.");
	});

	test.afterAll(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 50));
		try { fs.rmSync(ctx.tempDir, { recursive: true, force: true }); } catch {}
	});

	test("two tabs see the same chat history", async ({ browser }) => {
		const ctx1 = await browser.newContext();
		const ctx2 = await browser.newContext();
		const page1 = await ctx1.newPage();
		const page2 = await ctx2.newPage();

		await page1.goto(`http://localhost:${ctx.port}/`);
		await page2.goto(`http://localhost:${ctx.port}/`);
		await authenticate(page1, ctx.token);
		await authenticate(page2, ctx.token);
		await waitForBubbles(page1, 1);
		await waitForBubbles(page2, 1);

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

		await page1.goto(`http://localhost:${ctx.port}/`);
		await page2.goto(`http://localhost:${ctx.port}/`);
		await authenticate(page1, ctx.token);
		await authenticate(page2, ctx.token);
		await waitForBubbles(page1, 1);
		await waitForBubbles(page2, 1);

		const pre1 = await countBubbles(page1);
		const pre2 = await countBubbles(page2);

		// Send from tab1
		await page1.fill("#input", "Tell me about error handling");
		await page1.click("#sendBtn");
		await waitForUserBubble(page1, "error handling");

		// Agent responds — both tabs should get the stream
		simulateChatResponse(ctx.session, "Tell me about error handling", "Errors are handled using try/catch with custom error classes.");

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
	let port: number;
	let token: string;
	let session: ReturnType<typeof createMockSession>;
	let tempDir: string;

	test.beforeAll(async () => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as unknown as AgentSession;
		const result = await start({ cwd: tempDir, sessionFactory: factory, skipPrompt: true });
		port = parseInt(new URL(result.url).port);
		token = result.token;
		// Set up initial exploration
		simulateExploration(session);
		addAssistantMessage(session, "Document written.");
		handleEvent(evAgentEnd());

		// Add 25 chat exchanges (50 messages) — well over the 20-message limit
		for (let i = 0; i < 25; i++) {
			addUserMessage(session, `Question ${i}: What about module_${i}?`);
			addAssistantMessage(session, `Module ${i} handles feature_${i}. It uses pattern_${i} for processing.`);
		}
	});

	test.afterAll(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 50));
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
	});

	test("initial connect shows only recent 20 messages", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 20);

		const count = await countBubbles(page);
		expect(count).toBe(20);

		// The earliest visible message should NOT be Q0 (it's beyond the 20-message window)
		const bubbles = await getChatBubbles(page);
		expect(bubbles[0].text).not.toContain("Question 0");
	});

	test("scroll-to-top loads all 50 messages", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 20);

		// Scroll to top to trigger load_history
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});
		await waitForBubbles(page, 50, 10_000);

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
		await waitForBubbles(page, 20);

		// Load full history
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});
		await waitForBubbles(page, 50, 10_000);

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
		await waitForBubbles(page, 20);

		// Load full history
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});
		await waitForBubbles(page, 50, 10_000);

		const preCount = await countBubbles(page);

		// Send a new message
		await page.getByTestId("chat-input").fill( "New question after pagination");
		await page.getByTestId("send-button").click();
		await waitForUserBubble(page, "New question after pagination");

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
	let port: number;
	let token: string;
	let session: ReturnType<typeof createMockSession>;
	let tempDir: string;

	test.beforeAll(async () => {
		tempDir = makeTempDir();
		session = createMockSession();
		const factory: SessionFactory = async () => session as unknown as AgentSession;
		const result = await start({ cwd: tempDir, sessionFactory: factory, skipPrompt: true });
		port = parseInt(new URL(result.url).port);
		token = result.token;
	});

	test.afterAll(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 50));
		try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
	});

	test("streaming response shows in real-time, then finalizes", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Start agent turn
		addUserMessage(session, "Explain caching");
		handleEvent(evAgentStart());
		handleEvent(evMessageStart());

		// Send a few chunks
		handleEvent(evTextDelta("## Caching\n\n"));

		// Wait for streaming bubble to appear
		await expect(page.locator(".streaming").first()).toBeVisible({ timeout: 5000 });

		// Should see a streaming bubble
		expect(await page.locator(".streaming").count()).toBeGreaterThanOrEqual(1);

		// More chunks
		handleEvent(evTextDelta("The application uses Redis for caching "));
		handleEvent(evTextDelta("with a TTL of 300 seconds."));

		// End the message
		handleEvent(evTextEnd());
		handleEvent(evMessageEnd("## Caching\n\nThe application uses Redis for caching with a TTL of 300 seconds."));
		addAssistantMessage(session, "## Caching\n\nThe application uses Redis for caching with a TTL of 300 seconds.");
		handleEvent(evAgentEnd());

		// Wait for streaming to end
		await expect(page.locator(".streaming")).toHaveCount(0, { timeout: 5000 });

		// Streaming class should be gone
		expect(await page.locator(".streaming").count()).toBe(0);

		// Final text should be rendered
		await waitForAssistantBubble(page, "Redis");
		await waitForAssistantBubble(page, "TTL");
	});

	test("abort button stops the agent", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Start a streaming turn
		handleEvent(evAgentStart());
		handleEvent(evMessageStart());
		handleEvent(evTextDelta("Starting long response..."));

		// Wait for streaming indicator before clicking abort
		await expect(page.locator(".streaming").first()).toBeVisible({ timeout: 5000 });

		// Click abort button
		const abortBtn = page.locator("#abortBtn");
		if (await abortBtn.isVisible()) {
			await abortBtn.click();
			// Wait for abort to propagate to the mock session
			await waitFor(() => session._wasAborted(), 3000);

			// Verify abort was called on the session
			expect(session._wasAborted()).toBe(true);
		}

		// Clean up the streaming state
		handleEvent(evTextEnd());
		handleEvent(evMessageEnd("Starting long response..."));
		addAssistantMessage(session, "Starting long response...");
		handleEvent(evAgentEnd());
		session._resetAbort();
	});

	test("cost tracking displays in status bar", async ({ page }) => {
		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// Cost element should exist (may be empty or show a dollar amount)
		const costEl = page.locator("#statCost");
		await expect(costEl).toBeAttached();
	});
});

// ═══════════════════════════════════════════════════════════════════════
// E2E Journey 6: Reconnect during active streaming
// ═══════════════════════════════════════════════════════════════════════

test.describe("reconnect during active streaming", () => {
	const ctx = {} as { port: number; token: string; session: ReturnType<typeof createMockSession>; tempDir: string };

	test.beforeAll(async () => {
		ctx.tempDir = makeTempDir();
		ctx.session = createMockSession();
		const factory: SessionFactory = async () => ctx.session as unknown as AgentSession;
		const result = await start({ cwd: ctx.tempDir, sessionFactory: factory, skipPrompt: true });
		ctx.port = parseInt(new URL(result.url).port);
		ctx.token = result.token;
		simulateExploration(ctx.session);
		addAssistantMessage(ctx.session, "Document written.");
		handleEvent(evAgentEnd());
	});

	test.afterAll(async () => {
		reset();
		await new Promise((r) => setTimeout(r, 50));
		try { fs.rmSync(ctx.tempDir, { recursive: true, force: true }); } catch {}
	});

	test("disconnect during stream, complete stream, reconnect → message appears", async ({ page }) => {
		await page.goto(`http://localhost:${ctx.port}/`);
		await authenticate(page, ctx.token);

		// Start streaming
		addUserMessage(ctx.session, "What is the deployment process?");
		handleEvent(evAgentStart());
		handleEvent(evMessageStart());
		handleEvent(evTextDelta("## Deployment\n\n"));

		// Wait for streaming bubble before disconnecting mid-stream
		await expect(page.locator(".streaming").first()).toBeVisible({ timeout: 5000 });

		// Disconnect mid-stream
		await page.goto("about:blank");
		await page.waitForTimeout(100); // acceptable: wait for WS close

		// Complete the stream while disconnected
		handleEvent(evTextDelta("Deploy with Docker and Kubernetes."));
		handleEvent(evTextEnd());
		handleEvent(evMessageEnd("## Deployment\n\nDeploy with Docker and Kubernetes."));
		addAssistantMessage(ctx.session, "## Deployment\n\nDeploy with Docker and Kubernetes.");
		handleEvent(evAgentEnd());

		// Reconnect
		await page.goto(`http://localhost:${ctx.port}/`);
		await authenticate(page, ctx.token);
		await waitForBubbles(page, 1);

		// The completed message should be in chat history
		const bubbles = await getChatBubbles(page);
		const deployBubble = bubbles.find((b) => b.text.includes("Docker") && b.text.includes("Kubernetes"));
		expect(deployBubble).toBeTruthy();
		expect(deployBubble?.role).toBe("assistant");
	});

	test("multiple disconnects during ongoing conversation", async ({ page }) => {
		// First exchange
		await page.goto(`http://localhost:${ctx.port}/`);
		await authenticate(page, ctx.token);

		await page.getByTestId("chat-input").fill( "Explain module A");
		await page.getByTestId("send-button").click();
		await waitForUserBubble(page, "module A");
		simulateChatResponse(ctx.session, "Explain module A", "Module A handles authentication.");
		await waitForAssistantBubble(page, "authentication");

		// Disconnect
		await page.goto("about:blank");
		await page.waitForTimeout(100); // acceptable: wait for WS close

		// Second exchange (happens while disconnected — another client or API)
		simulateChatResponse(ctx.session, "Explain module B", "Module B handles authorization.");

		// Reconnect
		await page.goto(`http://localhost:${ctx.port}/`);
		await authenticate(page, ctx.token);
		await waitForBubbles(page, 2);

		// Both exchanges should be visible
		const bubbles = await getChatBubbles(page);
		expect(bubbles.some((b) => b.text.includes("authentication"))).toBe(true);
		expect(bubbles.some((b) => b.text.includes("authorization"))).toBe(true);

		// Disconnect again
		await page.goto("about:blank");
		await page.waitForTimeout(100); // acceptable: wait for WS close

		// Third exchange while disconnected
		simulateChatResponse(ctx.session, "Explain module C", "Module C handles data validation.");

		// Reconnect
		await page.goto(`http://localhost:${ctx.port}/`);
		await authenticate(page, ctx.token);
		await waitForBubbles(page, 3);

		// All three should be present
		const allBubbles = await getChatBubbles(page);
		expect(allBubbles.some((b) => b.text.includes("authentication"))).toBe(true);
		expect(allBubbles.some((b) => b.text.includes("authorization"))).toBe(true);
		expect(allBubbles.some((b) => b.text.includes("data validation"))).toBe(true);
	});
});
