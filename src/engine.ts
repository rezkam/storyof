/**
 * StoryOf — Core engine.
 *
 * Manages the in-process agent session, HTTP/WS server, validation loop,
 * health monitoring, and auto-restart.  Replaces the old subprocess-based
 * architecture with direct use of createAgentSession().
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	type AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	createAgentSession,
	createCodingTools,
	createReadOnlyTools,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

import { createAuthStorage } from "./auth.js";
import { createSafeBashTool } from "./safe-bash.js";
import {
	APP_NAME,
	DEFAULT_PORT,
	DEFAULT_THINKING_LEVEL,
	GLOBAL_DIR,
	GLOBAL_SKILLS_DIR,
	HEALTH_PROBE_TIMEOUT,
	HEARTBEAT_INTERVAL,
	LOCAL_DIR_NAME,
	MAX_CRASH_RESTARTS,
	MAX_VALIDATION_ATTEMPTS,
} from "./constants.js";
import { CostTracker } from "./cost-tracker.js";
import { AgentLogger } from "./logger.js";
import { buildExplorePrompt } from "./prompt-builder.js";
import { renderDocument, getTemplate, clearTemplateCache } from "./renderer.js";
import { sortModelsNewestFirst } from "./model-sort.js";
import { type SessionMeta, saveMeta, sessionDir } from "./session-meta.js";
import { buildFixPrompt, validateHtml } from "./validation.js";
import { type WsClient, wsAccept, wsBroadcast } from "./ws.js";

// ═══════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════

interface EngineState {
	session: AgentSession | null;
	unsubscribe: (() => void) | null;
	server: http.Server | null;
	port: number;
	basePort: number;
	wsClients: Set<WsClient>;
	cwd: string;
	targetPath: string;
	sessionId: string;
	scope: string;
	focus: string;
	depth: string;
	model: string;
	htmlPath: string | null;
	isStreaming: boolean;
	agentReady: boolean;
	secret: string;
	// Validation
	validationInProgress: boolean;
	validationAttempt: number;
	validationQueued: boolean;
	// Auto-restart
	crashCount: number;
	intentionalStop: boolean;
	lastInitialPrompt: string | null;
	isResumedSession: boolean;
	restartTimers: ReturnType<typeof setTimeout>[];
	// Session factory (injectable for testing)
	sessionFactory: SessionFactory;
	// Activity tracking
	lastActivityTs: number;
	heartbeatTimer: ReturnType<typeof setInterval> | null;
	// Health monitoring
	lastHealthyTs: number;
	consecutiveHealthFailures: number;
	healthCheckTimer: ReturnType<typeof setInterval> | null;
	// Cost tracking
	costTracker: CostTracker;
	// Logger
	logger: AgentLogger;
	// Model registry (for available models, model switching)
	modelRegistry: ModelRegistry | null;
	// Provider name (e.g. "anthropic")
	provider: string;
	// Whether current model is using OAuth/subscription
	isSubscription: boolean;
	// Whether file editing is allowed (--dangerously-allow-edits)
	allowEdits: boolean;
	// Pending tool write tracking
	pendingWritePaths: Map<string, string>;
	pendingToolTimers: Map<string, number>;
	// Session manager (for resume)
	piSessionManager: SessionManager | null;
	// Meta for persistence
	meta: SessionMeta | null;
	// Event history for late-joining browser clients
	eventHistory: Array<Record<string, unknown>>;
	// Readiness callback (called once on first agent_start)
	onReady: (() => void) | null;
	readyFired: boolean;
	// Override auth storage (for programmatic use)
	authStorageOverride: AuthStorage | null;
}

function createState(): EngineState {
	return {
		session: null,
		unsubscribe: null,
		server: null,
		port: DEFAULT_PORT,
		basePort: DEFAULT_PORT,
		wsClients: new Set(),
		cwd: "",
		targetPath: "",
		sessionId: "",
		scope: "",
		focus: "",
		depth: "medium",
		model: "",
		htmlPath: null,
		isStreaming: false,
		agentReady: false,
		secret: "",
		validationInProgress: false,
		validationAttempt: 0,
		validationQueued: false,
		crashCount: 0,
		intentionalStop: false,
		lastInitialPrompt: null,
		isResumedSession: false,
		restartTimers: [],
		sessionFactory: createSession,
		lastActivityTs: 0,
		heartbeatTimer: null,
		lastHealthyTs: 0,
		consecutiveHealthFailures: 0,
		healthCheckTimer: null,
		costTracker: new CostTracker(),
		logger: new AgentLogger(),
		modelRegistry: null,
		provider: "",
		isSubscription: false,
		allowEdits: false,
		pendingWritePaths: new Map(),
		pendingToolTimers: new Map(),
		piSessionManager: null,
		meta: null,
		eventHistory: [],
		onReady: null,
		readyFired: false,
		authStorageOverride: null,
	};
}

const S = createState();

// ═══════════════════════════════════════════════════════════════════════
// Broadcast helper
// ═══════════════════════════════════════════════════════════════════════

function broadcast(obj: Record<string, unknown>) {
	// Buffer events so late-joining browser clients get full history
	S.eventHistory.push(obj);
	wsBroadcast(S.wsClients, obj);
}

/** Broadcast current usage/cost/model status to all clients. */
function broadcastStatus() {
	const totals = S.costTracker.getTotals();
	broadcast({
		type: "status_update",
		usage: {
			input: totals.usage.input,
			output: totals.usage.output,
			cacheRead: totals.usage.cacheRead,
			cacheWrite: totals.usage.cacheWrite,
			cost: totals.cost,
			requestCount: totals.requestCount,
		},
		model: S.model,
		provider: S.provider,
		isSubscription: S.isSubscription,
	});
}

// ═══════════════════════════════════════════════════════════════════════
// Agent Session — in-process
// ═══════════════════════════════════════════════════════════════════════

async function createSession(targetPath: string, sessionManager?: SessionManager): Promise<AgentSession> {
	const authStorage = S.authStorageOverride ?? createAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, path.join(GLOBAL_DIR, "models.json"));
	S.modelRegistry = modelRegistry;

	S.costTracker.setModel(S.model);

	// Create settings manager
	const settingsManager = SettingsManager.create(targetPath, GLOBAL_DIR);

	// Create resource loader with custom skill paths (only storyof directories)
	const resourceLoader = new DefaultResourceLoader({
		cwd: targetPath,
		agentDir: GLOBAL_DIR,
		settingsManager,
		noExtensions: true,    // No third-party extensions
		noPromptTemplates: true,
		noThemes: true,
		additionalSkillPaths: getSkillPaths(targetPath),
		skillsOverride: (base) => {
			// Filter out any skills from host agent directories
			const filtered = base.skills.filter((s) => {
				const loc = (s as any).filePath || (s as any).location || "";
				return !loc.includes("/.pi/") && !loc.includes("/.claude/");
			});
			return { skills: filtered, diagnostics: base.diagnostics };
		},
		// Custom system prompt — StoryOf branding
		systemPrompt: S.allowEdits
			? `You are StoryOf, a codebase architecture explorer. You read codebases, understand their structure, and generate comprehensive architecture documentation with diagrams. You also answer questions about code you've explored.

When responding to questions, use well-structured markdown: headings (##), bullet lists, fenced code blocks with language tags, tables, bold/italic for emphasis. Keep responses clear and organized.`
			: `You are StoryOf, a codebase architecture explorer. You read codebases, understand their structure, and generate comprehensive architecture documentation with diagrams. You also answer questions about code you've explored.

IMPORTANT: You are running in READ-ONLY mode. You must NOT:
- Edit, create, delete, or modify any files in the codebase
- Run bash commands that write, move, copy, or delete files
- Use output redirects (>, >>), sed -i, or any in-place editing
- Run package managers (npm install, pip install, etc.)
- Run build commands (make, cmake, cargo build, etc.)
- Execute inline scripts (python -c, node -e) that could modify files

The ONLY file you may write to is the architecture document file (via the write tool provided). All other writes will be blocked.

You CAN: read files, grep, find, ls, cat, head, tail, wc, git log, git diff, git show, and other analysis commands.

When responding to questions, use well-structured markdown: headings (##), bullet lists, fenced code blocks with language tags, tables, bold/italic for emphasis. Keep responses clear and organized.`,
		agentsFilesOverride: () => ({ agentsFiles: [] }), // Don't load AGENTS.md / CLAUDE.md
	});
	await resourceLoader.reload();

	const smgr = sessionManager ?? SessionManager.create(targetPath, path.join(targetPath, LOCAL_DIR_NAME, S.sessionId));
	S.piSessionManager = smgr;

	// In read-only mode (default): read-only tools + safe bash (blocks file writes)
	// In edit mode (--dangerously-allow-edits): full coding tools (read, bash, edit, write)
	const tools = S.allowEdits
		? createCodingTools(targetPath)
		: [...createReadOnlyTools(targetPath), createSafeBashTool(targetPath)];

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: targetPath,
		agentDir: GLOBAL_DIR,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager: smgr,
		resourceLoader,
		tools,
	});

	if (modelFallbackMessage) {
		S.logger.log(`Model fallback: ${modelFallbackMessage}`);
	}

	// Capture actual model/provider info from the resolved session
	const resolvedModel = session.model;
	if (resolvedModel) {
		S.model = resolvedModel.id;
		S.provider = resolvedModel.provider;
		S.isSubscription = modelRegistry.isUsingOAuth(resolvedModel);
		S.costTracker.setModel(resolvedModel.id);
		S.logger.log(`Model: ${resolvedModel.id} (${resolvedModel.provider})${S.isSubscription ? " [subscription]" : ""}`);
	}

	return session;
}

function getSkillPaths(targetPath: string): string[] {
	const paths: string[] = [];
	// Global: ~/.storyof/skills/
	if (fs.existsSync(GLOBAL_SKILLS_DIR)) paths.push(GLOBAL_SKILLS_DIR);
	// Project: .storyof/skills/
	const localSkills = path.join(targetPath, LOCAL_DIR_NAME, "skills");
	if (fs.existsSync(localSkills)) paths.push(localSkills);
	return paths;
}

// ═══════════════════════════════════════════════════════════════════════
// Event handling — bridge agent events to WebSocket clients
// ═══════════════════════════════════════════════════════════════════════

/** Exported for testing — allows injecting events without a real agent. */
export function handleEvent(event: AgentSessionEvent) {
	// Guard: ignore events after intentional stop
	if (S.intentionalStop) return;

	const type = event.type;

	S.lastActivityTs = Date.now();
	S.lastHealthyTs = Date.now();
	S.consecutiveHealthFailures = 0;

	// ── Agent lifecycle ───────────────────────────────────────────────
	if (type === "agent_start") {
		S.isStreaming = true;
		S.agentReady = true;
		S.crashCount = 0;
		S.logger.log("── turn start ──");
		broadcast({ type: "rpc_event", event: { type: "agent_start" } });
		broadcastStatus();

		// Fire readiness callback once — agent is confirmed running
		if (!S.readyFired && S.onReady) {
			S.readyFired = true;
			S.onReady();
		}
		return;
	}

	if (type === "agent_end") {
		S.isStreaming = false;
		S.logger.log("── turn end ──");
		broadcast({ type: "rpc_event", event: { type: "agent_end" } });
		broadcastStatus();
		return;
	}

	// ── Message streaming ─────────────────────────────────────────────
	if (type === "message_update") {
		const ame = (event as any).assistantMessageEvent;
		if (ame) {
			const t = ame.type;
			if (
				t === "text_delta" || t === "thinking_delta" || t === "thinking_end" ||
				t === "thinking_start" || t === "text_start"
			) {
				broadcast({
					type: "rpc_event",
					event: {
						type: "message_update",
						assistantMessageEvent: {
							type: t,
							delta: ame.delta,
							contentIndex: ame.contentIndex,
							content: ame.content,
						},
					},
				});
			}
			if (t === "text_end") {
				broadcast({ type: "rpc_event", event: { type: "text_done" } });
			}
		}
		return;
	}

	if (type === "message_start") {
		const msg = (event as any).message;
		broadcast({ type: "rpc_event", event: { type: "message_start", message: { role: msg?.role } } });
		return;
	}

	if (type === "message_end") {
		const msg = (event as any).message;
		if (msg?.role === "assistant") {
			// Extract text parts
			const content = msg.content || [];
			const textParts = (Array.isArray(content) ? content : [content])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text);
			const text = textParts.join("\n").trim();

			// Track usage and cost
			const usage = msg.usage;
			if (usage) {
				const costEntry = S.costTracker.recordUsage(usage);
				const totals = S.costTracker.getTotals();
				broadcast({
					type: "cost_update",
					latest: {
						input: costEntry.usage.input,
						output: costEntry.usage.output,
						cacheRead: costEntry.usage.cacheRead,
						cacheWrite: costEntry.usage.cacheWrite,
						cost: costEntry.cost,
					},
					session: {
						input: totals.usage.input,
						output: totals.usage.output,
						cacheRead: totals.usage.cacheRead,
						cacheWrite: totals.usage.cacheWrite,
						cost: totals.cost,
						requestCount: totals.requestCount,
					},
					model: S.model,
					provider: S.provider,
					isSubscription: S.isSubscription,
				});
			}

			const usageStr = usage
				? ` [in=${usage.input ?? 0} out=${usage.output ?? 0}]`
				: "";
			S.logger.log(
				`[assistant]${usageStr} ${text.slice(0, 300)}${text.length > 300 ? "…" : ""}`,
			);

			broadcast({
				type: "rpc_event",
				event: {
					type: "message_end",
					message: { role: "assistant", text: textParts.join("\n"), usage },
				},
			});
		}
		return;
	}

	// ── Tool execution ────────────────────────────────────────────────
	if (type === "tool_execution_start") {
		const ev = event as any;
		const tn = (ev.toolName || "").toLowerCase();
		const args = ev.args || {};
		const tcId = ev.toolCallId as string;
		const label = tn === "bash" ? `$ ${(args.command || "").slice(0, 150)}` : (args.path || "").slice(0, 150);
		S.logger.log(`[tool:${ev.toolName}] start ${label}`);
		if (tcId) S.pendingToolTimers.set(tcId, Date.now());

		// Track markdown writes
		if ((tn === "write" || tn === "edit") && args.path && String(args.path).endsWith(".md")) {
			if (tcId) S.pendingWritePaths.set(tcId, String(args.path));
		}
		if (tn === "bash" && args.command) {
			const cmd = String(args.command);
			const mdMatch = cmd.match(/>\s*(['"]?)(\S+\.md)\1/);
			if (mdMatch && tcId) {
				S.pendingWritePaths.set(
					tcId,
					mdMatch[2].startsWith("/") ? mdMatch[2] : path.join(S.targetPath || "", mdMatch[2]),
				);
			}
		}

		broadcast({
			type: "rpc_event",
			event: {
				type: "tool_execution_start",
				toolCallId: ev.toolCallId,
				toolName: ev.toolName,
				args: ev.args,
			},
		});
		return;
	}

	if (type === "tool_execution_end") {
		const ev = event as any;
		const tn = (ev.toolName || "").toLowerCase();
		const tcId = ev.toolCallId as string;
		const writePath = tcId ? S.pendingWritePaths.get(tcId) : null;
		if (tcId) S.pendingWritePaths.delete(tcId);
		const toolStart = tcId ? S.pendingToolTimers.get(tcId) : null;
		const dur = toolStart ? ` (${Date.now() - toolStart}ms)` : "";
		if (tcId) S.pendingToolTimers.delete(tcId);
		S.logger.log(`[tool:${ev.toolName}] ${ev.isError ? "ERROR" : "ok"}${dur}`);

		// Detect markdown writes → render to HTML → validate
		if ((tn === "write" || tn === "edit" || tn === "bash") && !ev.isError && writePath) {
			if (fs.existsSync(writePath)) {
				S.logger.log(`Markdown document detected: ${writePath}`);
				renderDocument(writePath)
					.then((htmlPath) => {
						S.htmlPath = htmlPath;
						updateMeta();
						broadcast({ type: "doc_ready", path: S.htmlPath });
						setTimeout(() => runValidationLoop(), 1000);
					})
					.catch((err) => {
						S.logger.log(`Render error: ${err}`);
						broadcast({ type: "render_error", error: String(err) });
					});
			}
		}

		// Truncate large results for browser
		let result = ev.result;
		if (typeof result === "string" && result.length > 10000) {
			result = result.slice(0, 10000) + "\n… (truncated)";
		}
		if (result?.content && Array.isArray(result.content)) {
			result = {
				...result,
				content: result.content.map((c: any) =>
					c.type === "text" && c.text?.length > 10000
						? { ...c, text: c.text.slice(0, 10000) + "\n… (truncated)" }
						: c,
				),
			};
		}

		broadcast({
			type: "rpc_event",
			event: {
				type: "tool_execution_end",
				toolCallId: ev.toolCallId,
				toolName: ev.toolName,
				result,
				isError: ev.isError,
			},
		});
		broadcastStatus();
		return;
	}

	// ── Tool execution updates (streaming writes etc.) ────────────────
	if (type === "tool_execution_update") {
		const ev = event as any;
		broadcast({
			type: "rpc_event",
			event: {
				type: "tool_execution_update",
				toolCallId: ev.toolCallId,
				toolName: ev.toolName,
			},
		});
		return;
	}

	// ── Auto-compaction and retry ─────────────────────────────────────
	if (type === "auto_compaction_start" || type === "auto_compaction_end") {
		broadcast({ type: "rpc_event", event: { type, ...(event as any) } });
		return;
	}
	if (type === "auto_retry_start" || type === "auto_retry_end") {
		broadcast({ type: "rpc_event", event: { type, ...(event as any) } });
		return;
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Validation loop
// ═══════════════════════════════════════════════════════════════════════

async function runValidationLoop() {
	if (!S.htmlPath || !fs.existsSync(S.htmlPath)) return;
	if (S.validationInProgress) {
		S.validationQueued = true;
		return;
	}

	S.validationInProgress = true;
	S.validationAttempt++;
	S.logger.log(`Validation started (attempt ${S.validationAttempt})`);

	broadcast({ type: "validation_start", total: 0 });

	const result = await validateHtml(S.htmlPath, (index, total, status, error) => {
		broadcast({ type: "validation_block", index, total, status, error });
	});

	broadcast({ type: "validation_end", ok: result.ok, errorCount: result.errors.length, total: result.total });

	if (result.ok) {
		S.logger.log("Validation passed — all diagrams valid");
		broadcast({ type: "doc_validated", path: S.htmlPath });
		S.validationInProgress = false;
		S.validationAttempt = 0;
		if (S.validationQueued) {
			S.validationQueued = false;
			setTimeout(() => runValidationLoop(), 1000);
		}
		return;
	}

	S.logger.log(`Validation failed — ${result.errors.length} error(s)`);

	if (S.validationAttempt <= MAX_VALIDATION_ATTEMPTS && S.session) {
		const mdPath = S.htmlPath.replace(/\.html$/, ".md");
		const fixPrompt = buildFixPrompt(result.errors, mdPath);
		S.logger.log(`Sending fix prompt to agent (attempt ${S.validationAttempt}/${MAX_VALIDATION_ATTEMPTS})`);
		broadcast({ type: "validation_fix_request", attempt: S.validationAttempt, maxAttempts: MAX_VALIDATION_ATTEMPTS });

		try {
			await S.session.prompt(fixPrompt, { expandPromptTemplates: false });
		} catch (err) {
			S.logger.log(`Fix prompt failed: ${err}`);
		}
	} else {
		S.logger.log(`Validation gave up after ${S.validationAttempt} attempts`);
		broadcast({ type: "validation_gave_up", attempt: S.validationAttempt });
	}

	S.validationInProgress = false;
	if (S.validationQueued) {
		S.validationQueued = false;
		setTimeout(() => runValidationLoop(), 1000);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Meta persistence
// ═══════════════════════════════════════════════════════════════════════

function updateMeta() {
	if (!S.sessionId || !S.targetPath) return;
	const meta: SessionMeta = {
		id: S.sessionId,
		targetPath: S.targetPath,
		prompt: S.focus || undefined,
		scope: S.scope || undefined,
		depth: S.depth,
		model: S.model,
		htmlPath: S.htmlPath,
		sessionFile: S.piSessionManager?.getSessionFile?.() ?? null,
		port: S.port,
		timestamp: Date.now(),
	};
	S.meta = meta;
	saveMeta(meta);
}

// ═══════════════════════════════════════════════════════════════════════
// HTTP + WebSocket Server
// ═══════════════════════════════════════════════════════════════════════

function getUiPath(): string {
	const thisDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.join(thisDir, "..", "assets", "ui.html"),
		path.join(thisDir, "assets", "ui.html"),
		path.join(process.cwd(), "assets", "ui.html"),
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) return p;
	}
	throw new Error("ui.html not found");
}

function startServer(): Promise<number> {
	return new Promise((resolve, reject) => {
		if (S.server) {
			resolve(S.port);
			return;
		}
		S.secret = crypto.randomBytes(24).toString("hex");

		const server = http.createServer((req, res) => {
			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}
			const url = req.url?.split("?")[0];

			if (req.method === "GET" && url === "/") {
				try {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(fs.readFileSync(getUiPath(), "utf-8"));
				} catch {
					res.writeHead(500);
					res.end("Failed to load UI");
				}
				return;
			}
			if (req.method === "GET" && url === "/doc") {
				const reqUrl = new URL(req.url || "", "http://localhost");
				if (reqUrl.searchParams.get("token") !== S.secret) {
					res.writeHead(403);
					res.end("Forbidden");
					return;
				}
				if (S.htmlPath && fs.existsSync(S.htmlPath)) {
					// Assemble from body fragment + current template at serve time
					// so UI updates always apply, even to old documents
					const bodyPath = S.htmlPath.replace(/\.html$/, ".body.html");
					const { title, body } = JSON.parse(fs.readFileSync(bodyPath, "utf-8"));
					let doc = getTemplate()
						.replace("{{TITLE}}", (title || "StoryOf").replace(/</g, "&lt;"))
						.replace("{{CONTENT}}", body);
					// Inject selection bridge for "Ask about this"
					const selectionBridge = `<script>
document.addEventListener("mouseup",function(){var s=window.getSelection();var t=s&&s.toString().trim();if(!t||t.length<5){parent.postMessage({type:"dd-sel-clear"},"*");return;}var r=s.getRangeAt(0).getBoundingClientRect();parent.postMessage({type:"dd-sel",text:t,rect:{left:r.left,top:r.top,width:r.width,height:r.height}},"*");});
document.addEventListener("mousedown",function(){parent.postMessage({type:"dd-sel-clear"},"*");});
<\/script>`;
					if (doc.includes("</body>")) doc = doc.replace("</body>", `${selectionBridge}\n</body>`);
					else doc += selectionBridge;
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(doc);
				} else {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(
						`<!DOCTYPE html><html><head><style>body{background:#0c0c0f;color:#5a5a72;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}h2{color:#7c8aff;margin-bottom:8px}.sp{width:32px;height:32px;border:3px solid #2a2a3a;border-top-color:#7c8aff;border-radius:50%;animation:s .8s linear infinite;margin:16px auto}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div><div class="sp"></div><h2>Exploring codebase…</h2><p>The document will appear here when ready.</p></div></body></html>`,
					);
				}
				return;
			}
			if (req.method === "GET" && url === "/status") {
				const reqUrl = new URL(req.url || "", "http://localhost");
				if (reqUrl.searchParams.get("token") !== S.secret) {
					res.writeHead(403);
					res.end();
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						agentRunning: !!S.session,
						isStreaming: S.isStreaming,
						htmlPath: S.htmlPath,
						clients: S.wsClients.size,
						targetPath: S.targetPath,
					}),
				);
				return;
			}
			if (req.method === "GET" && url === "/models") {
				const reqUrl = new URL(req.url || "", "http://localhost");
				if (reqUrl.searchParams.get("token") !== S.secret) {
					res.writeHead(403);
					res.end();
					return;
				}
				const available = sortModelsNewestFirst(S.modelRegistry?.getAvailable() ?? []);
				const models = available.map((m) => ({
					id: m.id,
					name: m.name,
					provider: m.provider,
					reasoning: m.reasoning,
					isOAuth: S.modelRegistry?.isUsingOAuth(m) ?? false,
					active: m.id === S.model && m.provider === S.provider,
				}));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ models, current: { id: S.model, provider: S.provider } }));
				return;
			}
			if (req.method === "GET" && url === "/state") {
				const reqUrl = new URL(req.url || "", "http://localhost");
				if (reqUrl.searchParams.get("token") !== S.secret) {
					res.writeHead(403);
					res.end();
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(getState()));
				return;
			}
			res.writeHead(404);
			res.end("not found");
		});

		server.on("upgrade", (req, socket: import("node:net").Socket) => {
			const reqUrl = new URL(req.url || "", "http://localhost");
			if (reqUrl.pathname === "/ws" && reqUrl.searchParams.get("token") === S.secret) {
				const client = wsAccept(req, socket);
				if (client) {
					S.wsClients.add(client);
					socket.on("close", () => S.wsClients.delete(client));
					socket.on("error", () => S.wsClients.delete(client));

					// Handle messages from browser
					client.onMessage((msg) => {
						if (msg.type === "prompt") {
							chat(String(msg.text || "")).catch((err) => {
								S.logger.log(`Chat error: ${err}`);
							});
						} else if (msg.type === "abort") {
							abort().catch(() => {});
						} else if (msg.type === "stop") {
							stop();
						} else if (msg.type === "change_model") {
							changeModel(String(msg.modelId || ""), String(msg.provider || "")).catch((err) => {
								S.logger.log(`Model change error: ${err}`);
								broadcast({ type: "model_change_error", error: String(err) });
							});
						} else if (msg.type === "load_history") {
							// Client requested full chat history (e.g. scroll to top)
							const all = extractChatMessages();
							client.send(JSON.stringify({
								type: "chat_history",
								messages: all,
								isFullHistory: true,
							}));
						}
					});

					// Send init with current state
					const totals = S.costTracker.getTotals();
					client.send(
						JSON.stringify({
							type: "init",
							agentRunning: !!S.session,
							isStreaming: S.isStreaming,
							htmlPath: S.htmlPath,
							targetPath: S.targetPath,
							prompt: S.focus || undefined,
							validating: S.validationInProgress,
							lastActivityTs: S.lastActivityTs,
							model: S.model,
							provider: S.provider,
							isSubscription: S.isSubscription,
							allowEdits: S.allowEdits,
							depth: S.depth,
							usage: {
								input: totals.usage.input,
								output: totals.usage.output,
								cacheRead: totals.usage.cacheRead,
								cacheWrite: totals.usage.cacheWrite,
								cost: totals.cost,
								requestCount: totals.requestCount,
							},
						}),
					);

					// Replay full event history so late-joining clients see everything
					for (const event of S.eventHistory) {
						client.send(JSON.stringify(event));
					}

					// Send recent chat history from the agent session
					// This restores chat messages after WebSocket reconnects
					const recentChat = extractChatMessages(RECENT_CHAT_LIMIT);
					if (recentChat.length > 0) {
						client.send(JSON.stringify({
							type: "chat_history",
							messages: recentChat,
							isFullHistory: false,
						}));
					}
				}
			} else {
				socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
				socket.destroy();
			}
		});

		// Heartbeat — includes status line data so UI stays current
		S.heartbeatTimer = setInterval(() => {
			if (S.wsClients.size === 0) return;
			const totals = S.costTracker.getTotals();

			broadcast({
				type: "heartbeat",
				agentRunning: !!S.session,
				isStreaming: S.isStreaming,
				htmlPath: S.htmlPath,
				validating: S.validationInProgress,
				lastActivityTs: S.lastActivityTs,
				healthy: S.consecutiveHealthFailures === 0,
				consecutiveHealthFailures: S.consecutiveHealthFailures,
				ts: Date.now(),
				usage: {
					input: totals.usage.input,
					output: totals.usage.output,
					cacheRead: totals.usage.cacheRead,
					cacheWrite: totals.usage.cacheWrite,
					cost: totals.cost,
					requestCount: totals.requestCount,
				},
				model: S.model,
				provider: S.provider,
				isSubscription: S.isSubscription,
			});
		}, HEARTBEAT_INTERVAL);

		// Health check — agent health is implicit (if we receive events, it's healthy)
		// We track lastActivityTs and if no events for a while, mark unhealthy
		S.healthCheckTimer = setInterval(() => {
			if (!S.session || !S.isStreaming) return;
			const silentMs = Date.now() - S.lastActivityTs;
			if (silentMs > HEALTH_PROBE_TIMEOUT && S.isStreaming) {
				S.consecutiveHealthFailures++;
				const silentMin = Math.round(silentMs / 60000);
				S.logger.log(`Agent health check: no activity for ${silentMin}m (failure #${S.consecutiveHealthFailures})`);
				broadcast({
					type: "agent_health",
					healthy: false,
					failures: S.consecutiveHealthFailures,
					silentMin,
				});
			}
		}, HEALTH_PROBE_TIMEOUT);

		let port = S.port;
		const tryListen = () => {
			server.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE" && port < S.port + 10) {
					port++;
					tryListen();
				} else {
					reject(err);
				}
			});
			server.listen(port, "127.0.0.1", () => {
				S.server = server;
				S.port = port;
				resolve(port);
			});
		};
		tryListen();
	});
}

// ═══════════════════════════════════════════════════════════════════════
// PID file — for external stop command
// ═══════════════════════════════════════════════════════════════════════

function pidFilePath(cwd: string): string {
	return path.join(cwd, LOCAL_DIR_NAME, ".pid");
}

function writePidFile(cwd: string) {
	try {
		const dir = path.join(cwd, LOCAL_DIR_NAME);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(pidFilePath(cwd), JSON.stringify({ pid: process.pid, port: S.port, ts: Date.now() }));
	} catch {}
}

function removePidFile(cwd: string) {
	try {
		const p = pidFilePath(cwd);
		if (fs.existsSync(p)) fs.unlinkSync(p);
	} catch {}
}

/**
 * Send SIGTERM to the running storyof process (from a separate terminal).
 * Returns true if a process was found and signalled.
 */
export function stopExternal(cwd: string): boolean {
	try {
		const p = pidFilePath(cwd);
		if (!fs.existsSync(p)) return false;
		const data = JSON.parse(fs.readFileSync(p, "utf-8"));
		if (data.pid) {
			process.kill(data.pid, "SIGTERM");
			fs.unlinkSync(p);
			return true;
		}
	} catch {}
	return false;
}

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/** Factory function to create an agent session. Override for testing. */
export type SessionFactory = (targetPath: string, sessionManager?: SessionManager) => Promise<AgentSession>;

export interface StartOptions {
	cwd: string;
	prompt?: string;
	depth?: string;
	model?: string;
	scope?: string;
	/** Allow the agent to edit/write/delete files (default: false, read-only). */
	allowEdits?: boolean;
	/** Called once when the agent is confirmed running (first agent_start event). */
	onReady?: () => void;
	/** Override session factory (for testing without real API keys). */
	sessionFactory?: SessionFactory;
	/** Skip sending the exploration prompt (for testing). */
	skipPrompt?: boolean;
	/** Override auth storage (for programmatic/embedded use). */
	authStorage?: AuthStorage;
}

export interface ResumeOptions {
	cwd: string;
	meta: SessionMeta;
	/** Allow the agent to edit/write/delete files (default: false, read-only). */
	allowEdits?: boolean;
	/** Called once when the agent is confirmed running (first agent_start event). */
	onReady?: () => void;
	/** Override auth storage (for programmatic/embedded use). */
	authStorage?: AuthStorage;
}

/**
 * Start a new storyof exploration.
 */
export async function start(opts: StartOptions): Promise<{ url: string; token: string }> {
	if (S.session && S.server) {
		return { url: `http://localhost:${S.port}/`, token: S.secret };
	}

	const targetPath = path.resolve(opts.cwd);
	const sessionId = crypto.randomBytes(4).toString("hex");

	clearTemplateCache(); // Always serve latest template on start
	S.cwd = opts.cwd;
	S.targetPath = targetPath;
	S.sessionId = sessionId;
	S.scope = opts.scope || "";
	S.focus = opts.prompt || "";
	S.depth = opts.depth || "medium";
	S.model = opts.model || "claude-sonnet-4-5";
	S.htmlPath = null;
	S.crashCount = 0;
	S.isResumedSession = false;
	S.intentionalStop = false;
	S.allowEdits = opts.allowEdits ?? false;
	S.eventHistory = [];
	S.readyFired = false;
	S.onReady = opts.onReady ?? null;
	S.authStorageOverride = opts.authStorage ?? null;

	// Create session directory
	const sDir = sessionDir(targetPath, sessionId);
	fs.mkdirSync(sDir, { recursive: true });
	S.logger.setPath(path.join(sDir, "agent.log"));

	const port = await startServer();
	writePidFile(opts.cwd);

	// Create in-process agent session
	S.sessionFactory = opts.sessionFactory ?? createSession;
	try {
		S.session = await S.sessionFactory(targetPath);
		S.unsubscribe = S.session.subscribe(handleEvent);
		S.agentReady = true;

		// Send the exploration prompt
		const prompt = buildExplorePrompt(targetPath, S.focus, S.depth, sessionId, S.scope || undefined);
		S.lastInitialPrompt = prompt;
		S.logger.log(`Starting exploration: depth=${S.depth} model=${S.model}`);
		if (S.focus) S.logger.log(`Topic: ${S.focus}`);
		if (S.scope) S.logger.log(`Scope: ${S.scope}`);

		updateMeta();

		if (opts.skipPrompt) {
			// Test mode — don't send prompt, let tests drive events
		} else {
		// Prompt the agent (don't await — it runs in background)
		S.session.prompt(prompt, { expandPromptTemplates: false }).catch((err) => {
			const errStr = String(err);
			S.logger.log(`Prompt error: ${errStr}`);
			// Check for auth errors and provide helpful message
			if (errStr.includes("No API key") || errStr.includes("No model") || errStr.includes("Authentication")) {
				broadcast({
					type: "agent_exit",
					error: `No API key configured.\n\nSet an API key:\n  storyof auth set anthropic sk-ant-xxx\n\nOr login with OAuth:\n  storyof auth login anthropic`,
					crashCount: 0,
					willRestart: false,
					restartIn: null,
				});
			} else {
				handleCrash(errStr);
			}
		});
		} // end if (!opts.skipPrompt)
	} catch (err) {
		const errStr = String(err);
		S.logger.log(`Failed to create session: ${errStr}`);
		// Provide helpful auth error message
		if (errStr.includes("No API key") || errStr.includes("No model") || errStr.includes("Authentication")) {
			throw new Error(
				`No API key configured.\n\n  Set an API key:\n    storyof auth set anthropic sk-ant-xxx\n\n  Or login with OAuth:\n    storyof auth login anthropic\n\n  Or set an environment variable:\n    export STORYOF_ANTHROPIC_API_KEY=sk-ant-xxx`,
			);
		}
		throw err;
	}

	const url = `http://localhost:${port}/`;
	return { url, token: S.secret };
}

/**
 * Resume a previous session.
 */
export async function resume(opts: ResumeOptions): Promise<{ url: string; token: string }> {
	if (S.session && S.server) {
		return { url: `http://localhost:${S.port}/`, token: S.secret };
	}

	const meta = opts.meta;
	const targetPath = meta.targetPath;
	const sessionId = meta.id;

	clearTemplateCache(); // Always serve latest template on resume
	S.cwd = opts.cwd;
	S.targetPath = targetPath;
	S.sessionId = sessionId;
	S.focus = meta.prompt || "";
	S.scope = meta.scope || "";
	S.depth = meta.depth || "medium";
	S.model = meta.model || "claude-sonnet-4-5";
	S.htmlPath = meta.htmlPath || null;
	S.crashCount = 0;
	S.isResumedSession = true;
	S.intentionalStop = false;
	S.allowEdits = opts.allowEdits ?? false;
	S.eventHistory = [];
	S.readyFired = false;
	S.onReady = opts.onReady ?? null;
	S.authStorageOverride = opts.authStorage ?? null;

	const sDir = sessionDir(targetPath, sessionId);
	fs.mkdirSync(sDir, { recursive: true });
	S.logger.setPath(path.join(sDir, "agent.log"));

	const port = await startServer();
	writePidFile(opts.cwd);

	// Resume with existing session file if available
	let sessionManager: SessionManager | undefined;
	if (meta.sessionFile && fs.existsSync(meta.sessionFile)) {
		sessionManager = SessionManager.open(meta.sessionFile);
	} else {
		sessionManager = SessionManager.continueRecent(targetPath, path.join(targetPath, LOCAL_DIR_NAME, sessionId));
	}

	try {
		S.session = await createSession(targetPath, sessionManager);
		S.unsubscribe = S.session.subscribe(handleEvent);
		S.agentReady = true;
		S.logger.log(`Resumed session ${sessionId}`);
		updateMeta();
	} catch (err) {
		S.logger.log(`Failed to resume session: ${err}`);
		throw err;
	}

	const url = `http://localhost:${port}/`;
	return { url, token: S.secret };
}

// ═══════════════════════════════════════════════════════════════════════
// Chat history extraction from agent session
// ═══════════════════════════════════════════════════════════════════════

interface ChatMessage {
	role: "user" | "assistant";
	text: string;
}

/**
 * Extract user/assistant text messages from the agent session.
 * Skips the initial exploration prompt (first user message) and tool results.
 * Returns messages in chronological order.
 *
 * @param limit - Maximum number of messages to return (from the end)
 * @param messagesOverride - For testing: pass messages directly instead of reading from session
 */
export function extractChatMessages(limit?: number, messagesOverride?: readonly Record<string, unknown>[]): ChatMessage[] {
	const messages = messagesOverride ?? (S.session ? S.session.messages : null);
	if (!messages) return [];
	const result: ChatMessage[] = [];
	let skippedFirst = false;

	for (const msg of messages) {
		if (msg.role === "user") {
			// Skip the first user message (the exploration prompt)
			if (!skippedFirst) {
				skippedFirst = true;
				continue;
			}
			const content = (msg as any).content;
			if (!Array.isArray(content)) continue;
			const textParts = content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text);
			let text = textParts.join("\n").trim();
			// Strip the markdown formatting instruction suffix we append in chat()
			const instrIdx = text.lastIndexOf("\n\n[Respond in well-structured markdown.");
			if (instrIdx > 0) text = text.substring(0, instrIdx).trim();
			if (text) result.push({ role: "user", text });
		} else if (msg.role === "assistant") {
			const content = (msg as any).content;
			if (!Array.isArray(content)) continue;
			const textParts = content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text);
			const text = textParts.join("\n").trim();
			// Skip assistant messages that are just tool calls or the initial doc generation
			// Only include messages that have substantive text and follow a user chat message
			if (text && result.length > 0 && result[result.length - 1].role === "user") {
				result.push({ role: "assistant", text });
			}
		}
	}

	if (limit !== undefined) {
		if (limit <= 0) return [];
		if (result.length > limit) return result.slice(-limit);
	}
	return result;
}

/** Default number of recent chat messages sent on WebSocket connect */
const RECENT_CHAT_LIMIT = 20;

/**
 * Send a chat message from the user.
 */
export async function chat(text: string): Promise<void> {
	if (!S.session) throw new Error("No active session");

	const formatted =
		text +
		"\n\n[Respond in well-structured markdown. Use headings (##), bullet lists, fenced code blocks with language tags (```ts), tables, bold/italic for emphasis. Keep responses clear and organized.]";

	if (S.isStreaming) {
		await S.session.prompt(formatted, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
		});
	} else {
		S.session.prompt(formatted, { expandPromptTemplates: false }).catch((err) => {
			S.logger.log(`Chat prompt error: ${err}`);
		});
	}
}

/**
 * Change the active model.
 */
export async function changeModel(modelId: string, provider: string): Promise<void> {
	if (!S.session || !S.modelRegistry) {
		throw new Error("No active session");
	}

	const model = S.modelRegistry.find(provider, modelId);
	if (!model) {
		throw new Error(`Model not found: ${provider}/${modelId}`);
	}

	await S.session.setModel(model);

	S.model = model.id;
	S.provider = model.provider;
	S.isSubscription = S.modelRegistry.isUsingOAuth(model);
	S.costTracker.setModel(model.id);

	S.logger.log(`Model changed to: ${model.id} (${model.provider})${S.isSubscription ? " [subscription]" : ""}`);

	broadcast({
		type: "model_changed",
		model: model.id,
		provider: model.provider,
		isSubscription: S.isSubscription,
	});
}

/**
 * Abort the current agent turn.
 */
export async function abort(): Promise<void> {
	if (!S.session) return;
	try {
		await S.session.abort();
	} catch {}
	if (S.isStreaming) {
		S.isStreaming = false;
		S.logger.log("── turn end (abort) ──");
		broadcast({ type: "rpc_event", event: { type: "agent_end" } });
	}
}

/**
 * Stop the agent and server.
 */
export function stop(): void {
	S.intentionalStop = true;
	for (const t of S.restartTimers) clearTimeout(t);
	S.restartTimers = [];

	if (S.session) {
		S.logger.log("Stopping agent (intentional)");
		try {
			S.session.abort().catch(() => {});
		} catch {}
		if (S.unsubscribe) {
			S.unsubscribe();
			S.unsubscribe = null;
		}
		S.session = null;
		S.isStreaming = false;
	}

	S.agentReady = false;
	S.validationInProgress = false;
	S.validationAttempt = 0;
	S.validationQueued = false;
	S.crashCount = 0;
	S.pendingWritePaths.clear();
	S.pendingToolTimers.clear();
	S.consecutiveHealthFailures = 0;

	broadcast({ type: "agent_stopped" });
}

/**
 * Stop everything including the HTTP server.
 */
export function stopAll(): void {
	stop();
	if (S.heartbeatTimer) {
		clearInterval(S.heartbeatTimer);
		S.heartbeatTimer = null;
	}
	if (S.healthCheckTimer) {
		clearInterval(S.healthCheckTimer);
		S.healthCheckTimer = null;
	}
	if (S.server) {
		for (const c of S.wsClients) {
			try {
				c.socket.end();
			} catch {}
		}
		S.wsClients.clear();
		S.server.close();
		S.server = null;
	}
	if (S.cwd) removePidFile(S.cwd);
	S.port = S.basePort;
}

/** Handle agent crash with auto-restart */
/** Exported for testing — simulates agent crash with auto-restart logic. */
export function handleCrash(error: string) {
	S.crashCount++;
	const canRestart = S.crashCount <= MAX_CRASH_RESTARTS && S.targetPath && S.server && !S.intentionalStop;
	const backoffMs = Math.min(2000 * Math.pow(2, S.crashCount - 1), 15000);

	S.logger.log(`Crash #${S.crashCount}/${MAX_CRASH_RESTARTS} — ${canRestart ? `restarting in ${backoffMs}ms` : "giving up"}`);

	// Clean up the crashed session
	if (S.unsubscribe) {
		S.unsubscribe();
		S.unsubscribe = null;
	}
	S.session = null;
	S.isStreaming = false;
	S.agentReady = false;

	broadcast({
		type: "agent_exit",
		error,
		crashCount: S.crashCount,
		willRestart: canRestart,
		restartIn: canRestart ? backoffMs : null,
	});

	if (canRestart) {
		broadcast({
			type: "agent_restarting",
			attempt: S.crashCount,
			maxAttempts: MAX_CRASH_RESTARTS,
			restartIn: backoffMs,
		});
		const timer = setTimeout(async () => {
			if (!S.server || S.session) return;
			S.logger.log(`Auto-restart attempt ${S.crashCount}/${MAX_CRASH_RESTARTS}`);
			try {
				S.session = await S.sessionFactory(S.targetPath);
				S.unsubscribe = S.session.subscribe(handleEvent);
				S.agentReady = true;
				updateMeta();
			} catch (err) {
				S.logger.log(`Auto-restart failed: ${err}`);
				handleCrash(String(err));
			}
		}, backoffMs);
		S.restartTimers.push(timer);
	}
}

/** Get current state — full snapshot for testing and CLI display */
export function getState() {
	return {
		running: !!S.session,
		streaming: S.isStreaming,
		agentReady: S.agentReady,
		port: S.port,
		secret: S.secret,
		targetPath: S.targetPath,
		sessionId: S.sessionId,
		htmlPath: S.htmlPath,
		model: S.model,
		provider: S.provider,
		isSubscription: S.isSubscription,
		allowEdits: S.allowEdits,
		depth: S.depth,
		focus: S.focus,
		scope: S.scope,
		crashCount: S.crashCount,
		intentionalStop: S.intentionalStop,
		validationInProgress: S.validationInProgress,
		validationAttempt: S.validationAttempt,
		validationQueued: S.validationQueued,
		clientCount: S.wsClients.size,
		eventHistoryLength: S.eventHistory.length,
		costTotals: S.costTracker.getTotals(),
	};
}

/**
 * Reset all state — for testing only.
 * Stops everything and returns to initial state.
 */
export function reset(): void {
	stopAll();
	clearTemplateCache();
	Object.assign(S, createState());
}
