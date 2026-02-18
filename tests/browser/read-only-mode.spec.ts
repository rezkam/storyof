/**
 * Browser integration tests for read-only mode and chat history edge cases.
 *
 * Tests:
 *   - Read-only badge is always visible (agent is always read-only)
 *   - Empty session has no chat bubbles
 *   - Exploration-only session shows no chat bubbles
 *   - Scroll-to-top loads full history
 *   - New messages after scroll-to-top appear at bottom
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import {
	start,
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
import { evAgentStart, evAgentEnd } from "../helpers/events.js";

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

	test("shows read-only badge", async ({ page }) => {
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

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		// The read-only badge should always be visible
		const badge = page.locator("#statReadOnly");
		await expect(badge).toBeVisible();
		await expect(badge).toHaveText("(read-only)");
	});

	test("read-only badge has correct tooltip", async ({ page }) => {
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

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);

		const badge = page.locator("#statReadOnly");
		await expect(badge).toHaveAttribute("title", /read-only/i);
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
		const factory: SessionFactory = async () => session as unknown as AgentSession;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		// Wait for WebSocket init to complete (no bubbles expected)
		await page.waitForFunction(
			() => document.getElementById("pillText")?.textContent !== "connecting…",
			{ timeout: 5000 },
		);

		// No chat bubbles in an empty session
		const count = await countBubbles(page);
		expect(count).toBe(0);
	});

	test("exploration-only session shows no chat bubbles", async ({ page }) => {
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

		// Add exploration messages (these should be skipped by extractChatMessages)
		addExplorationMessages(session);
		handleEvent(evAgentStart());
		handleEvent(evAgentEnd());

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		// Wait for WebSocket init to complete (no bubbles expected)
		await page.waitForFunction(
			() => document.getElementById("pillText")?.textContent !== "connecting…",
			{ timeout: 5000 },
		);

		// Only exploration — no chat bubbles
		const count = await countBubbles(page);
		expect(count).toBe(0);
	});


	// (reconnect tests moved to chat-history.spec.ts)


	test("scroll-to-top loads full history with many messages", async ({ page }) => {
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

		addExplorationMessages(session);
		handleEvent(evAgentStart());
		handleEvent(evAgentEnd());

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
		await waitForBubbles(page, 20);

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
		await waitForBubbles(page, 30, 10_000);

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
		const factory: SessionFactory = async () => session as unknown as AgentSession;

		const result = await start({
			cwd: tempDir,
			sessionFactory: factory,
			skipPrompt: true,
		});
		port = parseInt(new URL(result.url).port);
		token = result.token;

		addExplorationMessages(session);
		handleEvent(evAgentStart());
		handleEvent(evAgentEnd());

		// Add 12 exchanges (24 messages, exceeds limit of 20)
		for (let i = 0; i < 12; i++) {
			addUserMessage(session, `History Q${i}`);
			addAssistantMessage(session, `History A${i}`);
		}

		await page.goto(`http://localhost:${port}/`);
		await authenticate(page, token);
		await waitForBubbles(page, 20);

		// Load full history
		await page.evaluate(() => {
			const tl = document.getElementById("timeline");
			if (tl) tl.scrollTop = 0;
		});
		await waitForBubbles(page, 24, 10_000);

		const preCount = await countBubbles(page);
		expect(preCount).toBe(24);

		// Now send a new message
		await page.getByTestId("chat-input").fill( "New message after full load");
		await page.getByTestId("send-button").click();
		await waitForUserBubble(page, "New message after full load");

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
