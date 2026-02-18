/**
 * Typed mock session factory for integration and unit tests.
 *
 * Provides a minimal AgentSession-compatible mock that:
 * - Can emit events via `_emit()` (for triggering handleEvent paths)
 * - Tracks abort calls via `_wasAborted()`
 * - Replaces `as any` casts with `as unknown as AgentSession`
 *
 * Usage:
 *   import { createMockSession, mockSessionFactory } from "../helpers/mock-session.js";
 *
 *   const { factory, session } = mockSessionFactory();
 *   handleEvent(evAgentStart()); // session emits events
 *   expect(session._wasAborted()).toBe(false);
 */

import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { SessionFactory } from "../../src/engine.js";

// ── Internal mock shape ───────────────────────────────────────────────────

type Subscriber = (event: AgentSessionEvent) => void;

/** The minimal set of extra test-control properties exposed on mock sessions. */
export interface MockSessionExtras {
	/** Fire an event to all subscribers — simulates real session events. */
	_emit: (event: AgentSessionEvent) => void;
	/** Returns true if abort() was called at least once. */
	_wasAborted: () => boolean;
	/** Direct access to the messages array for assertions. */
	_messages: unknown[];
}

export type MockSession = AgentSession & MockSessionExtras;

// ── Factory ───────────────────────────────────────────────────────────────

/**
 * Creates a minimal mock AgentSession for tests.
 *
 * The mock satisfies the AgentSession interface without real I/O:
 * - `subscribe()` collects listeners; `_emit()` fires them
 * - `prompt()` is a no-op (tests fire events manually via `_emit`)
 * - `abort()` records the call; `_wasAborted()` returns the result
 * - `setModel()` is a no-op
 */
export function createMockSession(): MockSession {
	const subscribers: Subscriber[] = [];
	let aborted = false;

	const session = {
		// ── AgentSession required interface ──────────────────────────────
		subscribe(fn: Subscriber): () => void {
			subscribers.push(fn);
			return () => {
				const idx = subscribers.indexOf(fn);
				if (idx >= 0) subscribers.splice(idx, 1);
			};
		},
		prompt: async (_text: string, _opts?: unknown): Promise<void> => {
			// no-op: tests fire events manually via _emit
		},
		abort: async (): Promise<void> => {
			aborted = true;
		},
		setModel: async (): Promise<void> => {},
		getActiveToolNames: () => [] as string[],
		getAllTools: () => [] as ReturnType<AgentSession["getAllTools"]>,
		getSteeringMessages: () => [] as readonly string[],
		getFollowUpMessages: () => [] as readonly string[],
		getAvailableThinkingLevels: () => [] as ReturnType<AgentSession["getAvailableThinkingLevels"]>,
		abortCompaction: () => {},
		abortBranchSummary: () => {},
		abortRetry: () => {},
		abortBash: () => {},
		getSessionStats: () => ({
			sessionFile: undefined,
			sessionId: "mock-session-id",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
		}),
		getContextUsage: () => undefined,
		getLastAssistantText: () => undefined,
		getUserMessagesForForking: () => [],
		aborted: false,
		_messages: [] as unknown[],
		get messages() {
			return this._messages;
		},
		get state() {
			return { messages: this._messages };
		},

		// ── Test-control extras ──────────────────────────────────────────
		_emit(event: AgentSessionEvent): void {
			for (const fn of subscribers) fn(event);
		},
		_wasAborted(): boolean {
			return aborted;
		},
	};

	return session as unknown as MockSession;
}

/**
 * Creates a SessionFactory that always returns the same mock session.
 * Useful for testing normal (non-crashing) engine lifecycle.
 */
export function mockSessionFactory(): {
	factory: SessionFactory;
	session: MockSession;
} {
	const session = createMockSession();
	const factory: SessionFactory = async () => session as unknown as AgentSession;
	return { factory, session };
}

/**
 * Creates a SessionFactory that fails N times then succeeds.
 * Useful for testing crash recovery and restart logic.
 */
export function failingSessionFactory(opts: {
	/** Number of times to throw before returning a valid session. */
	failCount?: number;
	/** Error message to throw. Defaults to generic message. */
	failError?: string;
} = {}): {
	factory: SessionFactory;
	get callCount(): number;
	sessions: MockSession[];
} {
	let callCount = 0;
	const sessions: MockSession[] = [];

	const factory: SessionFactory = async () => {
		callCount++;
		if (opts.failCount !== undefined && callCount <= opts.failCount) {
			throw new Error(opts.failError ?? `Session creation failed (attempt ${callCount})`);
		}
		const session = createMockSession();
		sessions.push(session);
		return session as unknown as AgentSession;
	};

	return {
		factory,
		get callCount() {
			return callCount;
		},
		sessions,
	};
}
