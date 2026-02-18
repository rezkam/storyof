/**
 * Typed event factories for test use.
 *
 * handleEvent() takes AgentSessionEvent which has strict per-variant required
 * fields. These factories provide all required fields with sensible defaults so
 * tests can call handleEvent() without `as any` at every call-site.
 *
 * The engine's handleEvent() only reads a subset of each event's fields, so
 * the empty/default values here are safe for test use.
 */

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

/** Minimal assistant message shape for event factories. */
function assistantMsg(text = "") {
	return {
		role: "assistant" as const,
		content: text ? [{ type: "text" as const, text }] : [],
		usage: { input_tokens: 0, output_tokens: 0 },
		timestamp: 0,
	};
}

// ── Agent lifecycle ──────────────────────────────────────────────────────

/** { type: "agent_start" } */
export function evAgentStart(): AgentSessionEvent {
	return { type: "agent_start" };
}

/** { type: "agent_end" } — engine only reads the type, not messages */
export function evAgentEnd(): AgentSessionEvent {
	return { type: "agent_end", messages: [] } as unknown as AgentSessionEvent;
}

/** { type: "turn_start" } */
export function evTurnStart(): AgentSessionEvent {
	return { type: "turn_start" } as unknown as AgentSessionEvent;
}

// ── Message streaming ────────────────────────────────────────────────────

/** { type: "message_start", message: { role: "assistant" } } */
export function evMessageStart(role: "assistant" | "user" = "assistant"): AgentSessionEvent {
	return {
		type: "message_start",
		message: { ...assistantMsg(), role },
	} as unknown as AgentSessionEvent;
}

/** { type: "message_update" } with a text_delta event */
export function evTextDelta(delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: assistantMsg(),
		assistantMessageEvent: {
			type: "text_delta",
			delta,
			contentIndex: 0,
			partial: assistantMsg(delta),
		},
	} as unknown as AgentSessionEvent;
}

/** { type: "message_update" } with a thinking_delta event */
export function evThinkingDelta(delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: assistantMsg(),
		assistantMessageEvent: {
			type: "thinking_delta",
			delta,
			contentIndex: 0,
			partial: assistantMsg(),
		},
	} as unknown as AgentSessionEvent;
}

/** { type: "message_update" } with a text_end event */
export function evTextEnd(content = ""): AgentSessionEvent {
	return {
		type: "message_update",
		message: assistantMsg(content),
		assistantMessageEvent: {
			type: "text_end",
			content,
			contentIndex: 0,
			partial: assistantMsg(content),
		},
	} as unknown as AgentSessionEvent;
}

/** { type: "message_end" } */
export function evMessageEnd(text = ""): AgentSessionEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			usage: { input_tokens: 10, output_tokens: 10 },
			timestamp: Date.now(),
		},
	} as unknown as AgentSessionEvent;
}

// ── Tool execution ───────────────────────────────────────────────────────

/** { type: "tool_execution_start" } */
export function evToolStart(
	toolName: string,
	toolCallId = "tc1",
	args: Record<string, unknown> = {},
): AgentSessionEvent {
	return {
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args,
	} as unknown as AgentSessionEvent;
}

/** { type: "tool_execution_end" } */
export function evToolEnd(
	toolName: string,
	toolCallId = "tc1",
	result: unknown = "ok",
	isError = false,
): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result,
		isError,
	} as unknown as AgentSessionEvent;
}

/** { type: "tool_execution_update" } */
export function evToolUpdate(
	toolName: string,
	toolCallId = "tc1",
	partialResult: unknown = null,
): AgentSessionEvent {
	return {
		type: "tool_execution_update",
		toolCallId,
		toolName,
		args: {},
		partialResult,
	} as unknown as AgentSessionEvent;
}
