/**
 * Engine state machine — extracted from engine.ts for testability.
 *
 * This module defines the lifecycle states of the StoryOf system
 * (server + agent as a single unit) and provides a testable state
 * machine that can be exercised without real HTTP servers or AI models.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                        STATE DIAGRAM                               │
 * │                                                                    │
 * │  ┌──────┐    start()    ┌──────────┐  agent_start  ┌───────────┐  │
 * │  │ IDLE ├──────────────►│ STARTING ├──────────────►│  RUNNING  │  │
 * │  └──────┘               └────┬─────┘               └─────┬─────┘  │
 * │     ▲                        │                           │         │
 * │     │                   error│                    agent_end         │
 * │     │                        ▼                           ▼         │
 * │     │                  ┌──────────┐               ┌───────────┐   │
 * │     │                  │  FAILED  │               │   IDLE    │   │
 * │     │                  └────┬─────┘               │ (waiting) │   │
 * │     │                       │                     └─────┬─────┘   │
 * │     │               crash < max?                   chat()/prompt  │
 * │     │                ┌──┴──┐                           │         │
 * │     │             yes│    no│                           ▼         │
 * │     │                ▼      ▼                    ┌───────────┐   │
 * │     │         ┌───────────┐ ┌────────┐           │  RUNNING  │   │
 * │     │         │RESTARTING │ │GAVE UP │           └───────────┘   │
 * │     │         └─────┬─────┘ └────────┘                           │
 * │     │               │                                             │
 * │     │          createSession()                                    │
 * │     │               │                                             │
 * │     │         ┌─────┴──────┐                                      │
 * │     │      ok │         err│                                      │
 * │     │         ▼            ▼                                      │
 * │     │   ┌──────────┐ ┌──────────┐                                │
 * │     │   │ STARTING │ │  FAILED  │──► (loop back)                 │
 * │     │   └──────────┘ └──────────┘                                │
 * │     │                                                             │
 * │     │           stop() from ANY state                             │
 * │     ◄─────────────────────────────────────────────────────────────│
 * │                                                                    │
 * │  VALIDATION STATES (parallel):                                    │
 * │  ┌──────┐  doc_ready  ┌────────────┐  pass  ┌───────────┐       │
 * │  │ NONE ├────────────►│ VALIDATING ├───────►│ VALIDATED │       │
 * │  └──────┘             └──────┬─────┘        └───────────┘       │
 * │                              │ fail                               │
 * │                              ▼                                    │
 * │                        ┌──────────┐  attempt <= max               │
 * │                        │ FIX_SENT ├──────────────►VALIDATING     │
 * │                        └────┬─────┘                               │
 * │                             │ attempt > max                       │
 * │                             ▼                                     │
 * │                        ┌──────────┐                               │
 * │                        │ GAVE_UP  │                               │
 * │                        └──────────┘                               │
 * │                                                                    │
 * │  CLIENT STATES:                                                   │
 * │  ┌──────────────┐  ws connect  ┌───────────┐                     │
 * │  │ DISCONNECTED ├────────────►│ CONNECTED │                     │
 * │  └──────────────┘             └─────┬─────┘                     │
 * │         ▲                           │                             │
 * │         │     ws close / error      │                             │
 * │         ◄───────────────────────────┘                             │
 * │                                                                    │
 * │  Connected clients can:                                           │
 * │  - send "prompt" (chat message)                                   │
 * │  - send "abort" (cancel current turn)                             │
 * │  - send "stop" (shutdown agent)                                   │
 * │  - receive all broadcast events                                   │
 * │  - receive event history on connect (replay)                      │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { MAX_CRASH_RESTARTS, MAX_VALIDATION_ATTEMPTS } from "./constants.js";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export type EnginePhase =
	| "idle"
	| "starting"
	| "running"
	| "streaming"   // agent_start fired, actively generating
	| "waiting"     // agent_end fired, waiting for next prompt
	| "restarting"
	| "failed"
	| "stopped";

export type ValidationPhase =
	| "none"
	| "validating"
	| "fix_sent"
	| "validated"
	| "gave_up";

export type ClientPhase = "disconnected" | "connected";

export interface EngineSnapshot {
	phase: EnginePhase;
	validation: ValidationPhase;
	crashCount: number;
	validationAttempt: number;
	clientCount: number;
	hasDocument: boolean;
	isStreaming: boolean;
	agentReady: boolean;
	intentionalStop: boolean;
	eventHistoryLength: number;
}

export interface BroadcastEvent {
	type: string;
	[key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════
// State Machine
// ═══════════════════════════════════════════════════════════════════════

/**
 * Testable state machine for the StoryOf engine.
 *
 * This models the lifecycle without real I/O — no HTTP, no WebSocket,
 * no agent sessions. All side effects are captured as events that can
 * be inspected by tests.
 */
export class EngineStateMachine {
	phase: EnginePhase = "idle";
	validation: ValidationPhase = "none";
	crashCount = 0;
	validationAttempt = 0;
	clientCount = 0;
	hasDocument = false;
	isStreaming = false;
	agentReady = false;
	intentionalStop = false;
	eventHistory: BroadcastEvent[] = [];
	broadcasts: BroadcastEvent[] = [];
	readyFired = false;

	private maxCrashRestarts: number;
	private maxValidationAttempts: number;
	private onReadyCallback: (() => void) | null = null;

	constructor(
		options: {
			maxCrashRestarts?: number;
			maxValidationAttempts?: number;
			onReady?: () => void;
		} = {},
	) {
		this.maxCrashRestarts = options.maxCrashRestarts ?? MAX_CRASH_RESTARTS;
		this.maxValidationAttempts = options.maxValidationAttempts ?? MAX_VALIDATION_ATTEMPTS;
		this.onReadyCallback = options.onReady ?? null;
	}

	snapshot(): EngineSnapshot {
		return {
			phase: this.phase,
			validation: this.validation,
			crashCount: this.crashCount,
			validationAttempt: this.validationAttempt,
			clientCount: this.clientCount,
			hasDocument: this.hasDocument,
			isStreaming: this.isStreaming,
			agentReady: this.agentReady,
			intentionalStop: this.intentionalStop,
			eventHistoryLength: this.eventHistory.length,
		};
	}

	private broadcast(event: BroadcastEvent): void {
		this.eventHistory.push(event);
		this.broadcasts.push(event);
	}

	// ── Lifecycle transitions ─────────────────────────────────────────

	/** Server + agent creation initiated */
	serverStarted(): void {
		if (this.phase !== "idle") return;
		this.phase = "starting";
	}

	/** Agent session created, awaiting first agent_start */
	sessionCreated(): void {
		if (this.phase !== "starting" && this.phase !== "restarting") return;
		this.agentReady = true;
	}

	/** Agent creation failed */
	sessionFailed(error: string): void {
		if (this.phase === "stopped") return;

		if (this.phase === "starting" || this.phase === "restarting") {
			this.handleCrash(error);
		}
	}

	/** Agent fires agent_start — now actively streaming */
	agentStart(): void {
		if (this.phase === "stopped" || this.phase === "failed") return;
		this.isStreaming = true;
		this.agentReady = true;
		this.crashCount = 0;
		this.phase = "streaming";

		this.broadcast({ type: "rpc_event", event: { type: "agent_start" } });

		if (!this.readyFired && this.onReadyCallback) {
			this.readyFired = true;
			this.onReadyCallback();
		}
	}

	/** Agent fires agent_end — turn complete, waiting */
	agentEnd(): void {
		if (this.phase === "stopped" || this.phase === "failed") return;
		this.isStreaming = false;
		this.phase = "waiting";
		this.broadcast({ type: "rpc_event", event: { type: "agent_end" } });
	}

	/** User sends a chat message */
	chatMessage(text: string): { allowed: boolean; steering: boolean } {
		if (!this.agentReady || this.phase === "stopped" || this.phase === "failed") {
			return { allowed: false, steering: false };
		}

		if (this.isStreaming) {
			// Steering mode — inject into current turn
			return { allowed: true, steering: true };
		}

		// New turn
		this.phase = "streaming";
		this.isStreaming = true;
		return { allowed: true, steering: false };
	}

	/** User sends abort */
	abort(): void {
		if (!this.agentReady || this.phase === "stopped") return;

		if (this.isStreaming) {
			this.isStreaming = false;
			this.phase = "waiting";
			this.broadcast({ type: "rpc_event", event: { type: "agent_end" } });
		}
	}

	/** Intentional stop from user or client */
	stop(): void {
		this.intentionalStop = true;
		this.isStreaming = false;
		this.agentReady = false;
		this.phase = "stopped";
		this.validation = this.validation === "validating" ? "none" : this.validation;
		this.crashCount = 0;
		this.broadcast({ type: "agent_stopped" });
	}

	// ── Crash/restart ─────────────────────────────────────────────────

	private handleCrash(error: string): void {
		this.crashCount++;
		const canRestart =
			this.crashCount <= this.maxCrashRestarts && !this.intentionalStop;

		this.broadcast({
			type: "agent_exit",
			error,
			crashCount: this.crashCount,
			willRestart: canRestart,
			restartIn: canRestart ? this.backoffMs() : null,
		});

		if (canRestart) {
			this.phase = "restarting";
			this.broadcast({
				type: "agent_restarting",
				attempt: this.crashCount,
				maxAttempts: this.maxCrashRestarts,
				restartIn: this.backoffMs(),
			});
		} else {
			this.phase = "failed";
		}
	}

	/** Agent prompt rejected/errored */
	promptError(error: string): void {
		if (this.phase === "stopped") return;
		this.handleCrash(error);
	}

	private backoffMs(): number {
		return Math.min(2000 * Math.pow(2, this.crashCount - 1), 15000);
	}

	// ── Document and validation ───────────────────────────────────────

	/** A markdown document was written and rendered to HTML */
	documentReady(path: string): void {
		this.hasDocument = true;
		this.broadcast({ type: "doc_ready", path });
	}

	/** Validation started */
	validationStart(): void {
		if (!this.hasDocument) return;
		this.validation = "validating";
		this.validationAttempt++;
		this.broadcast({ type: "validation_start", total: 0 });
	}

	/** Validation passed */
	validationPassed(): void {
		this.validation = "validated";
		this.validationAttempt = 0;
		this.broadcast({ type: "validation_end", ok: true, errorCount: 0 });
		this.broadcast({ type: "doc_validated" });
	}

	/** Validation failed */
	validationFailed(errorCount: number): void {
		this.broadcast({
			type: "validation_end",
			ok: false,
			errorCount,
		});

		if (this.validationAttempt <= this.maxValidationAttempts && this.agentReady) {
			this.validation = "fix_sent";
			this.broadcast({
				type: "validation_fix_request",
				attempt: this.validationAttempt,
				maxAttempts: this.maxValidationAttempts,
			});
		} else {
			this.validation = "gave_up";
			this.broadcast({
				type: "validation_gave_up",
				attempt: this.validationAttempt,
			});
		}
	}

	// ── Client management ─────────────────────────────────────────────

	/** Browser client connects via WebSocket */
	clientConnect(): { initPayload: BroadcastEvent; history: BroadcastEvent[] } {
		this.clientCount++;
		const initPayload: BroadcastEvent = {
			type: "init",
			agentRunning: this.agentReady,
			isStreaming: this.isStreaming,
			hasDocument: this.hasDocument,
			phase: this.phase,
			validation: this.validation,
		};
		// Return history for replay
		return { initPayload, history: [...this.eventHistory] };
	}

	/** Browser client disconnects */
	clientDisconnect(): void {
		this.clientCount = Math.max(0, this.clientCount - 1);
	}
}
