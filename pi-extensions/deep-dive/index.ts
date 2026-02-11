/**
 * Deep Dive — Codebase architecture explorer with live web UI
 *
 * Spawns a pi subagent (--mode rpc) for exploration.
 * Validates generated HTML (mermaid diagrams) and sends errors back to fix.
 * Runs HTTP + WebSocket server for a split-panel UI.
 *
 * Commands:
 *   /deep-dive [prompt] [--path ./subdir] [--depth shallow|medium|deep] [--model name]
 *   /deep-dive-resume
 *   /deep-dive-stop
 */

import { spawn, exec, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

// ═══════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════
// Pinned dependency versions (these are DIFFERENT packages with independent version numbers)
const MERMAID_CDN_VERSION = "11.4.0";  // mermaid JS library — https://cdn.jsdelivr.net/npm/mermaid@VERSION
const MERMAID_CLI_VERSION = "11.4.2";  // @mermaid-js/mermaid-cli — used for npx validation only
const HLJS_VERSION = "11.9.0";         // highlight.js — CDN for code syntax highlighting
// ═══════════════════════════════════════════════════════════════════════

interface WsClient {
	socket: import("node:net").Socket;
	send: (data: string) => void;
	alive: boolean;
}

const S = {
	proc: null as ChildProcess | null,
	server: null as http.Server | null,
	port: 9876,
	basePort: 9876,
	wsClients: new Set<WsClient>(),
	cwd: "",
	targetPath: "",
	sessionId: "",
	scope: "" as string,
	focus: "",
	depth: "medium",
	model: "",
	htmlPath: null as string | null,
	isStreaming: false,
	agentReady: false,
	buffer: "",
	sessionFile: null as string | null,
	validationInProgress: false,
	validationAttempt: 0,
	maxValidationAttempts: 3,
	secret: "",
	spawnTimers: [] as ReturnType<typeof setTimeout>[],
	// Auto-restart state
	crashCount: 0,
	maxCrashRestarts: 3,
	lastInitialPrompt: null as string | null,
	pendingInitialPrompt: null as string | null,
	intentionalStop: false,
	// Activity tracking
	lastActivityTs: 0,
	heartbeatTimer: null as ReturnType<typeof setInterval> | null,
	// Agent health check
	healthProbePending: false,
	healthProbeTs: 0,
	lastHealthyTs: 0,
	consecutiveHealthFailures: 0,
};

// ═══════════════════════════════════════════════════════════════════════
// Agent log — persisted to .pi/deep-dive-agent.log for debugging
// ═══════════════════════════════════════════════════════════════════════

function sessionDir(): string {
	const base = S.targetPath || S.cwd || process.cwd();
	if (S.sessionId) return path.join(base, ".pi", "deep-dive", S.sessionId);
	return path.join(base, ".pi");
}

function logPath(): string {
	return path.join(sessionDir(), "agent.log");
}

function agentLog(msg: string) {
	try {
		const ts = new Date().toISOString();
		const line = `[${ts}] ${msg}\n`;
		fs.mkdirSync(path.dirname(logPath()), { recursive: true });
		fs.appendFileSync(logPath(), line);
	} catch {}
}

function agentLogStderr(text: string) {
	try {
		const ts = new Date().toISOString();
		const lines = text.split("\n").map(l => `[${ts}] [stderr] ${l}`).join("\n");
		fs.mkdirSync(path.dirname(logPath()), { recursive: true });
		fs.appendFileSync(logPath(), lines + "\n");
	} catch {}
}

// ═══════════════════════════════════════════════════════════════════════
// Argument parsing (handles quoted strings)
// ═══════════════════════════════════════════════════════════════════════

function parseArgs(input: string): string[] {
	const result: string[] = [];
	const re = /(?:"([^"]*?)"|'([^']*?)'|(\S+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(input)) !== null) result.push(m[1] ?? m[2] ?? m[3]);
	return result;
}

// ═══════════════════════════════════════════════════════════════════════
// Metadata for resume
// ═══════════════════════════════════════════════════════════════════════

function saveMeta() {
	if (!S.sessionId || !S.targetPath) return;
	const meta = {
		id: S.sessionId,
		targetPath: S.targetPath, prompt: S.focus, scope: S.scope || undefined, depth: S.depth, model: S.model,
		htmlPath: S.htmlPath, sessionFile: S.sessionFile, port: S.port,
		timestamp: Date.now(),
	};
	try {
		const dir = sessionDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
	} catch {}
}

function loadLocalSessions(targetPath: string): any[] {
	const sessions: any[] = [];
	const deepDiveDir = path.join(targetPath, ".pi", "deep-dive");
	try {
		if (!fs.existsSync(deepDiveDir)) return sessions;
		for (const entry of fs.readdirSync(deepDiveDir)) {
			const metaFile = path.join(deepDiveDir, entry, "meta.json");
			try {
				if (!fs.statSync(path.join(deepDiveDir, entry)).isDirectory()) continue;
				const meta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
				if (!meta.id) meta.id = entry;
				if (!meta.targetPath) meta.targetPath = targetPath;
				sessions.push(meta);
			} catch {}
		}
	} catch {}
	sessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
	return sessions;
}

function formatSessionLabel(meta: any): string {
	const ago = meta.timestamp ? timeAgo(meta.timestamp) : "?";
	const hasDoc = meta.htmlPath ? "📄" : "⏳";
	const depth = meta.depth || "medium";
	const topic = meta.prompt || meta.focus;
	const scopeStr = meta.scope ? ` [${meta.scope}]` : "";
	const label = topic
		? `"${topic.length > 40 ? topic.slice(0, 37) + "…" : topic}"`
		: "full exploration";
	return `${hasDoc} ${label}${scopeStr} (${depth}) — ${ago}`;
}

function timeAgo(ts: number): string {
	const diff = Date.now() - ts;
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

// ═══════════════════════════════════════════════════════════════════════
// WebSocket — proper RFC 6455
// ═══════════════════════════════════════════════════════════════════════

function wsAccept(req: http.IncomingMessage, socket: import("node:net").Socket): WsClient | null {
	const key = req.headers["sec-websocket-key"];
	if (!key) return null;
	const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

	const send = (data: string) => {
		try {
			const payload = Buffer.from(data, "utf-8");
			const len = payload.length;
			let header: Buffer;
			if (len < 126) {
				header = Buffer.alloc(2); header[0] = 0x81; header[1] = len;
			} else if (len < 65536) {
				header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
			} else {
				header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127;
				header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
				header.writeUInt32BE(len % 0x100000000, 6);
			}
			socket.write(Buffer.concat([header, payload]));
		} catch {}
	};

	const client: WsClient = { socket, send, alive: true };
	let frameBuf = Buffer.alloc(0);

	const processFrames = () => {
		while (frameBuf.length >= 2) {
			const opcode = frameBuf[0] & 0x0f;
			const masked = (frameBuf[1] & 0x80) !== 0;
			let payloadLen = frameBuf[1] & 0x7f;
			let headerLen = 2;
			if (payloadLen === 126) { if (frameBuf.length < 4) return; payloadLen = frameBuf.readUInt16BE(2); headerLen = 4; }
			else if (payloadLen === 127) { if (frameBuf.length < 10) return; payloadLen = frameBuf.readUInt32BE(6); headerLen = 10; }
			const maskLen = masked ? 4 : 0;
			const totalLen = headerLen + maskLen + payloadLen;
			if (frameBuf.length < totalLen) return;
			if (opcode === 0x8) { socket.end(); return; }
			if (opcode === 0x9) { try { socket.write(Buffer.from([0x8a, 0])); } catch {} frameBuf = frameBuf.subarray(totalLen); continue; }
			if (opcode === 0x1 && masked) {
				const mask = frameBuf.subarray(headerLen, headerLen + 4);
				const data = Buffer.from(frameBuf.subarray(headerLen + 4, headerLen + 4 + payloadLen));
				for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
				try { handleWsMessage(JSON.parse(data.toString("utf-8"))); } catch {}
			}
			frameBuf = frameBuf.subarray(totalLen);
		}
	};

	socket.on("data", (chunk: Buffer) => { frameBuf = Buffer.concat([frameBuf, chunk]); processFrames(); });
	socket.on("close", () => { client.alive = false; S.wsClients.delete(client); });
	socket.on("error", () => { client.alive = false; S.wsClients.delete(client); });
	return client;
}

function wsBroadcast(obj: Record<string, unknown>) {
	const json = JSON.stringify(obj);
	for (const c of S.wsClients) if (c.alive) c.send(json);
}

// ═══════════════════════════════════════════════════════════════════════
// Browser → Agent
// ═══════════════════════════════════════════════════════════════════════

function handleWsMessage(msg: Record<string, unknown>) {
	if (msg.type === "prompt") {
		const text = String(msg.text || "");
		// Append formatting instruction so the LLM responds in well-structured markdown
		const formatted = text + "\n\n[Respond in well-structured markdown. Use headings (##), bullet lists, fenced code blocks with language tags (```ts), tables, bold/italic for emphasis. Keep responses clear and organized.]";
		rpcSend({ type: "prompt", message: formatted });
	}
	else if (msg.type === "abort") abortAgent();
	else if (msg.type === "stop") stopAgent();
	else if (msg.type === "get_state") rpcSend({ type: "get_state" });
}

function abortAgent() {
	// Send abort to cancel LLM streaming + tool execution
	rpcSend({ type: "abort" });
	// Also abort any running bash command specifically
	rpcSend({ type: "abort_bash" });
	if (S.isStreaming) {
		S.isStreaming = false;
		agentLog("── turn end (abort) ──");
		// Immediately tell all clients the turn is over — don't wait for agent_end
		// which may or may not arrive from the agent
		wsBroadcast({ type: "rpc_event", event: { type: "agent_end" } });
	}
}

function rpcSend(cmd: Record<string, unknown>) {
	if (S.proc?.stdin?.writable) S.proc.stdin.write(JSON.stringify(cmd) + "\n");
}

// ═══════════════════════════════════════════════════════════════════════
// Post-write document sanitization — fix CDN URLs and ensure dependencies
// ═══════════════════════════════════════════════════════════════════════

const MERMAID_CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_CDN_VERSION}/dist/mermaid.min.js`;
const HLJS_CDN_CSS = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HLJS_VERSION}/styles/atom-one-dark.min.css`;
const HLJS_CDN_JS = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HLJS_VERSION}/highlight.min.js`;
const GOOGLE_FONTS_URL = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap";

function sanitizeDocument(htmlPath: string): { changed: boolean; fixes: string[] } {
	if (!fs.existsSync(htmlPath)) return { changed: false, fixes: [] };
	let doc = fs.readFileSync(htmlPath, "utf-8");
	const original = doc;
	const fixes: string[] = [];

	// 1. Normalize mermaid CDN URLs to known-good version
	doc = doc.replace(
		/https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@[^/]+\/dist\/mermaid[^"'\s]*/g,
		MERMAID_CDN_URL
	);

	// 2. Normalize highlight.js CDN URLs
	doc = doc.replace(
		/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/highlight\.js\/[^/]+\/styles\/[^"'\s]*/g,
		HLJS_CDN_CSS
	);
	doc = doc.replace(
		/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/highlight\.js\/[^/]+\/highlight\.min\.js/g,
		HLJS_CDN_JS
	);

	// 3. Ensure mermaid script exists (agent might have omitted or used wrong tag)
	if (!doc.includes("mermaid") || !doc.includes(MERMAID_CDN_URL)) {
		const tag = `<script src="${MERMAID_CDN_URL}"></script>`;
		if (doc.includes("</head>")) {
			doc = doc.replace("</head>", `${tag}\n</head>`);
			fixes.push("Injected missing mermaid script");
		}
	}

	// 4. Ensure highlight.js exists
	if (!doc.includes("highlight") || !doc.includes(HLJS_CDN_JS)) {
		const tags = `<link rel="stylesheet" href="${HLJS_CDN_CSS}">\n<script src="${HLJS_CDN_JS}"></script>\n<script>document.addEventListener("DOMContentLoaded",function(){hljs.highlightAll();});</script>`;
		if (doc.includes("</head>")) {
			doc = doc.replace("</head>", `${tags}\n</head>`);
			fixes.push("Injected missing highlight.js");
		}
	}

	// 5. Ensure hljs.highlightAll() is called somewhere
	if (doc.includes(HLJS_CDN_JS) && !doc.includes("highlightAll")) {
		const initScript = `<script>document.addEventListener("DOMContentLoaded",function(){if(typeof hljs!=="undefined")hljs.highlightAll();});</script>`;
		if (doc.includes("</body>")) {
			doc = doc.replace("</body>", `${initScript}\n</body>`);
			fixes.push("Injected hljs.highlightAll() call");
		}
	}

	// 6. Ensure Google Fonts loaded
	if (!doc.includes("fonts.googleapis.com")) {
		const link = `<link href="${GOOGLE_FONTS_URL}" rel="stylesheet">`;
		if (doc.includes("</head>")) {
			doc = doc.replace("</head>", `${link}\n</head>`);
			fixes.push("Injected missing Google Fonts");
		}
	}

	const changed = doc !== original;
	if (changed) {
		if (original !== doc) fixes.unshift("CDN URLs normalized");
		fs.writeFileSync(htmlPath, doc);
		agentLog(`Document sanitized: ${fixes.join(", ")}`);
	}
	return { changed, fixes };
}

// ═══════════════════════════════════════════════════════════════════════
// Mermaid validation — extracts diagrams, validates syntax, sends errors to agent
// ═══════════════════════════════════════════════════════════════════════

function extractMermaidBlocks(html: string): { index: number; code: string }[] {
	const blocks: { index: number; code: string }[] = [];
	// Match both <pre class="mermaid"> and <div class="mermaid">
	const re = /<(?:pre|div)\s+class="mermaid"[^>]*>([\s\S]*?)<\/(?:pre|div)>/gi;
	let m;
	while ((m = re.exec(html)) !== null) {
		const code = m[1].trim();
		if (code) blocks.push({ index: blocks.length, code });
	}
	return blocks;
}

function validateMermaidBlock(code: string): Promise<{ valid: boolean; error?: string }> {
	return new Promise((resolve) => {
		const tmpFile = `/tmp/dd-mermaid-${crypto.randomBytes(8).toString("hex")}.mmd`;
		const tmpOut = tmpFile.replace(".mmd", ".svg");
		fs.writeFileSync(tmpFile, code);
		exec(
			`npx -y @mermaid-js/mermaid-cli@${MERMAID_CLI_VERSION} -i "${tmpFile}" -o "${tmpOut}" --quiet 2>&1`,
			{ timeout: 30000 },
			(err, stdout, stderr) => {
				try { fs.unlinkSync(tmpFile); } catch {}
				try { fs.unlinkSync(tmpOut); } catch {}
				const output = (stdout || "") + (stderr || "");
				if (err || output.toLowerCase().includes("error")) {
					resolve({ valid: false, error: output.trim().slice(0, 500) || "Unknown mermaid error" });
				} else {
					resolve({ valid: true });
				}
			}
		);
	});
}

async function validateHtml(htmlPath: string): Promise<{ ok: boolean; errors: string[] }> {
	const html = fs.readFileSync(htmlPath, "utf-8");
	const blocks = extractMermaidBlocks(html);
	const errors: string[] = [];

	wsBroadcast({ type: "validation_start", total: blocks.length });

	for (const block of blocks) {
		wsBroadcast({ type: "validation_block", index: block.index, total: blocks.length, status: "checking" });
		const result = await validateMermaidBlock(block.code);
		if (!result.valid) {
			errors.push(`Diagram ${block.index + 1}: ${result.error}\nCode:\n${block.code.slice(0, 300)}`);
			wsBroadcast({ type: "validation_block", index: block.index, total: blocks.length, status: "error", error: result.error });
		} else {
			wsBroadcast({ type: "validation_block", index: block.index, total: blocks.length, status: "ok" });
		}
	}

	const ok = errors.length === 0;
	wsBroadcast({ type: "validation_end", ok, errorCount: errors.length, total: blocks.length });
	return { ok, errors };
}

let validationQueued = false;

async function runValidationLoop() {
	if (!S.htmlPath || !fs.existsSync(S.htmlPath)) return;
	if (S.validationInProgress) { validationQueued = true; return; }

	S.validationInProgress = true;
	S.validationAttempt++;
	agentLog(`Validation started (attempt ${S.validationAttempt})`);

	const result = await validateHtml(S.htmlPath);

	if (result.ok) {
		agentLog(`Validation passed — all diagrams valid`);
		wsBroadcast({ type: "doc_validated", path: S.htmlPath });
		S.validationInProgress = false;
		S.validationAttempt = 0;
		if (validationQueued) { validationQueued = false; setTimeout(() => runValidationLoop(), 1000); }
		return;
	}

	agentLog(`Validation failed — ${result.errors.length} error(s)`);

	// Errors found — send fix request to agent
	if (S.validationAttempt <= S.maxValidationAttempts && S.proc?.stdin?.writable) {
		const fixPrompt = `The HTML document has ${result.errors.length} mermaid diagram error(s). Please fix them:

${result.errors.join("\n\n---\n\n")}

Common fixes:
- Square brackets [] in sequence diagram messages trigger the "loop" keyword — use parentheses () instead
- Escape &, <, > as &amp; &lt; &gt;
- Use <br/> not \\n for line breaks
- Don't use backticks inside mermaid blocks
- Keep node IDs simple alphanumeric

Read the current file, fix the broken diagrams, and write the corrected HTML back to: ${S.htmlPath}`;

		agentLog(`Sending fix prompt to agent (attempt ${S.validationAttempt}/${S.maxValidationAttempts})`);
		wsBroadcast({ type: "validation_fix_request", attempt: S.validationAttempt, maxAttempts: S.maxValidationAttempts });
		rpcSend({ type: "prompt", message: fixPrompt });
	} else {
		agentLog(`Validation gave up after ${S.validationAttempt} attempts`);
		wsBroadcast({ type: "validation_gave_up", attempt: S.validationAttempt });
	}

	S.validationInProgress = false;
	if (validationQueued) { validationQueued = false; setTimeout(() => runValidationLoop(), 1000); }
}

// ═══════════════════════════════════════════════════════════════════════
// RPC event handling — slim events to browser
// ═══════════════════════════════════════════════════════════════════════

const pendingWritePaths = new Map<string, string>();
const pendingToolTimers = new Map<string, number>();

function handleRpcLine(line: string) {
	let event: any;
	try { event = JSON.parse(line); } catch { return; }
	const type = event.type as string;

	if (type === "extension_ui_request") return;

	S.lastActivityTs = Date.now();

	// Track state
	if (type === "agent_start") { S.isStreaming = true; S.agentReady = true; S.crashCount = 0; agentLog("── turn start ──"); }
	if (type === "agent_end") {
		// If isStreaming is already false, we already detected turn end from message_end
		// and broadcast agent_end — don't broadcast again
		if (!S.isStreaming) { agentLog("── turn end (native, already handled) ──"); return; }
		S.isStreaming = false;
		agentLog("── turn end (native) ──");
		// Fall through to forward the event to browser
	}

	// Track session file + health probe response + deliver pending prompt
	if (type === "response" && event.command === "get_state") {
		S.agentReady = true;
		if (event.data?.sessionFile) { S.sessionFile = event.data.sessionFile; saveMeta(); }
		// Deliver pending initial prompt now that agent is confirmed ready
		if (S.pendingInitialPrompt && S.proc?.stdin?.writable) {
			const prompt = S.pendingInitialPrompt;
			S.pendingInitialPrompt = null;
			agentLog(`Sending initial prompt (agent ready)`);
			S.proc.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
		}
		// Health probe came back — agent is responsive
		if (S.healthProbePending) {
			S.healthProbePending = false;
			S.lastHealthyTs = Date.now();
			if (S.consecutiveHealthFailures > 0) {
				agentLog(`Agent health restored (was unresponsive for ${S.consecutiveHealthFailures} checks)`);
				wsBroadcast({ type: "agent_health", healthy: true, restored: true });
			}
			S.consecutiveHealthFailures = 0;
		}
	}

	// Log + detect turn end + forward assistant message_end (single handler)
	if (type === "message_end" && event.message?.role === "assistant") {
		const content = event.message.content || [];
		const textParts = content.filter((c: any) => c.type === "text").map((c: any) => c.text);
		const text = textParts.join("\n").trim();
		if (text) {
			const usage = event.message.usage;
			const usageStr = usage ? ` [in=${usage.input_tokens} out=${usage.output_tokens}]` : "";
			agentLog(`[assistant]${usageStr} ${text.slice(0, 300)}${text.length > 300 ? "…" : ""}`);
		}
		// Forward to browser
		wsBroadcast({ type: "rpc_event", event: {
			type: "message_end",
			message: { role: "assistant", text: textParts.join("\n"), usage: event.message.usage },
		}});
		// If the assistant message has NO tool calls, the turn is over.
		// The agent chose to respond with text only — no more tools to run.
		const hasToolCalls = content.some((c: any) => c.type === "tool_use" || c.type === "toolCall");
		if (!hasToolCalls && S.isStreaming) {
			S.isStreaming = false;
			agentLog("── turn end (detected: final message has no tool calls) ──");
			wsBroadcast({ type: "rpc_event", event: { type: "agent_end" } });
		}
		return;
	}

	// Detect HTML writes/edits — track on start, validate on end
	if (type === "tool_execution_start") {
		const tn = (event.toolName || "").toLowerCase();
		const args = event.args || {};
		const tcId = event.toolCallId as string;
		const label = tn === "bash" ? `$ ${(args.command || "").slice(0, 150)}` : (args.path || "").slice(0, 150);
		agentLog(`[tool:${event.toolName}] start ${label}`);
		if (tcId) pendingToolTimers.set(tcId, Date.now());
		if ((tn === "write" || tn === "edit") && args.path && String(args.path).endsWith(".html")) {
			if (tcId) pendingWritePaths.set(tcId, String(args.path));
		}
		// Detect bash writes to HTML files (e.g. cat heredoc)
		if (tn === "bash" && args.command) {
			const cmd = String(args.command);
			const htmlMatch = cmd.match(/>\s*(['"]?)(\S+\.html)\1/);
			if (htmlMatch && tcId) pendingWritePaths.set(tcId, htmlMatch[2].startsWith("/") ? htmlMatch[2] : path.join(S.targetPath || "", htmlMatch[2]));
		}
	}

	if (type === "tool_execution_end") {
		const tn = (event.toolName || "").toLowerCase();
		const tcId = event.toolCallId as string;
		const writePath = tcId ? pendingWritePaths.get(tcId) : null;
		if (tcId) pendingWritePaths.delete(tcId);
		const toolStart = tcId ? pendingToolTimers.get(tcId) : null;
		const dur = toolStart ? ` (${Date.now() - toolStart}ms)` : "";
		if (tcId) pendingToolTimers.delete(tcId);
		agentLog(`[tool:${event.toolName}] ${event.isError ? "ERROR" : "ok"}${dur}`);
		if ((tn === "write" || tn === "edit" || tn === "bash") && !event.isError && writePath) {
			if (fs.existsSync(writePath)) {
				S.htmlPath = writePath;
				agentLog(`HTML document detected: ${writePath}`);

				// Sanitize first: fix CDN URLs, ensure dependencies exist
				const sanitizeResult = sanitizeDocument(writePath);
				if (sanitizeResult.fixes.length > 0) {
					wsBroadcast({ type: "doc_sanitized", fixes: sanitizeResult.fixes });
				}

				saveMeta();
				wsBroadcast({ type: "doc_ready", path: S.htmlPath });
				// Then validate mermaid diagrams
				setTimeout(() => runValidationLoop(), 1000);
			}
		}
	}

	// ── Forward slimmed events to browser ──

	if (type === "message_update") {
		const ame = event.assistantMessageEvent;
		if (ame) {
			const t = ame.type;
			// Forward text/thinking deltas
			if (t === "text_delta" || t === "thinking_delta" || t === "thinking_end" || t === "thinking_start" || t === "text_start") {
				wsBroadcast({ type: "rpc_event", event: {
					type: "message_update",
					assistantMessageEvent: { type: t, delta: ame.delta, contentIndex: ame.contentIndex, content: ame.content },
				}});
			}
			// text_end → finalize the text bubble immediately (tool call content may stream for minutes)
			if (t === "text_end") {
				wsBroadcast({ type: "rpc_event", event: { type: "text_done" } });
			}
		}
		return;
	}

	// message_end for assistant is already handled above (log + forward + turn-end detection)

	if (type === "message_start") {
		wsBroadcast({ type: "rpc_event", event: { type: "message_start", message: { role: event.message?.role } } });
		return;
	}

	if (type === "tool_execution_start") {
		wsBroadcast({ type: "rpc_event", event: {
			type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args,
		}});
		return;
	}

	if (type === "tool_execution_end") {
		let result = event.result;
		if (typeof result === "string" && result.length > 10000) result = result.slice(0, 10000) + "\n… (truncated)";
		if (result?.content && Array.isArray(result.content)) {
			result = { ...result, content: result.content.map((c: any) =>
				c.type === "text" && c.text?.length > 10000 ? { ...c, text: c.text.slice(0, 10000) + "\n… (truncated)" } : c
			)};
		}
		wsBroadcast({ type: "rpc_event", event: {
			type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, result, isError: event.isError,
		}});
		return;
	}

	// Forward rest directly
	wsBroadcast({ type: "rpc_event", event });
}

// ═══════════════════════════════════════════════════════════════════════
// Spawn pi subagent
// ═══════════════════════════════════════════════════════════════════════

function spawnAgent(cwd: string, initialPrompt?: string, sessionFile?: string): ChildProcess {
	const args = ["--mode", "rpc", "--cwd", cwd];
	if (S.model) args.push("--model", S.model);
	if (sessionFile && fs.existsSync(sessionFile)) args.push("--session", sessionFile);

	agentLog(`Spawning agent: pi ${args.join(" ")}`);
	if (initialPrompt) S.lastInitialPrompt = initialPrompt;
	S.intentionalStop = false;

	const proc = spawn("pi", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
	proc.on("error", (err) => {
		if (S.proc !== proc) return; // stale process, ignore
		agentLog(`Agent spawn error: ${err}`);
		S.proc = null; S.isStreaming = false; S.agentReady = false;
		handleAgentCrash(-1, String(err));
	});
	S.buffer = ""; S.agentReady = false; S.validationAttempt = 0;

	proc.stdout!.on("data", (chunk: Buffer) => {
		if (S.proc !== proc) return; // stale process, ignore
		S.buffer += chunk.toString();
		const lines = S.buffer.split("\n");
		S.buffer = lines.pop() || "";
		for (const line of lines) { if (line.trim()) handleRpcLine(line); }
	});

	proc.stderr!.on("data", (chunk: Buffer) => {
		if (S.proc !== proc) return; // stale process, ignore
		const text = chunk.toString().trim();
		if (text) {
			agentLogStderr(text);
			wsBroadcast({ type: "agent_stderr", text });
		}
	});

	proc.on("close", (code) => {
		if (S.proc !== proc) return; // stale process from previous session, ignore
		agentLog(`Agent exited with code ${code}${S.intentionalStop ? " (intentional stop)" : ""}`);
		S.proc = null; S.isStreaming = false; S.agentReady = false;
		if (S.intentionalStop) {
			wsBroadcast({ type: "agent_stopped" });
		} else {
			handleAgentCrash(code ?? -1, null);
		}
	});

	if (initialPrompt) {
		S.pendingInitialPrompt = initialPrompt;
	}
	// Ask agent for its state — when the response arrives in handleRpcLine,
	// it sets agentReady=true and sends any pending prompt (event-driven, no polling)
	if (proc.stdin?.writable) proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n");

	return proc;
}

function handleAgentCrash(code: number, error: string | null) {
	S.crashCount++;
	const canRestart = S.crashCount <= S.maxCrashRestarts && S.targetPath && S.server;
	const backoffMs = Math.min(2000 * Math.pow(2, S.crashCount - 1), 15000); // 2s, 4s, 8s, 15s

	agentLog(`Crash #${S.crashCount}/${S.maxCrashRestarts} — ${canRestart ? `restarting in ${backoffMs}ms` : "giving up"}`);

	wsBroadcast({
		type: "agent_exit",
		code,
		error,
		crashCount: S.crashCount,
		willRestart: canRestart,
		restartIn: canRestart ? backoffMs : null,
	});

	if (canRestart) {
		wsBroadcast({ type: "agent_restarting", attempt: S.crashCount, maxAttempts: S.maxCrashRestarts, restartIn: backoffMs });
		const timer = setTimeout(() => {
			if (!S.server || S.proc) return; // server gone or already restarted
			agentLog(`Auto-restart attempt ${S.crashCount}/${S.maxCrashRestarts}`);
			// Resume with session file if available, otherwise no prompt (user can re-prompt)
			S.proc = spawnAgent(S.targetPath, undefined, S.sessionFile ?? undefined);
			saveMeta();
		}, backoffMs);
		S.spawnTimers.push(timer);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// HTTP + WebSocket Server
// ═══════════════════════════════════════════════════════════════════════

function getUiPath(): string {
	const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui.html");
	return fs.existsSync(p) ? p : path.join(process.cwd(), "ui.html");
}

function startServer(): Promise<number> {
	return new Promise((resolve, reject) => {
		if (S.server) { resolve(S.port); return; }
		S.secret = crypto.randomBytes(24).toString("hex");
		const server = http.createServer((req, res) => {
			if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
			const url = req.url?.split("?")[0];

			if (req.method === "GET" && url === "/") {
				try {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(fs.readFileSync(getUiPath(), "utf-8"));
				} catch (e) { res.writeHead(500); res.end("Failed to load UI"); }
				return;
			}
			if (req.method === "GET" && url === "/doc") {
				const reqUrl2 = new URL(req.url || "", "http://localhost");
				if (reqUrl2.searchParams.get("token") !== S.secret) { res.writeHead(403); res.end("Forbidden"); return; }
				if (S.htmlPath && fs.existsSync(S.htmlPath)) {
					let doc = fs.readFileSync(S.htmlPath, "utf-8");
					// Inject selection bridge, mermaid/hljs fallbacks, wheel blocker
					const injectedScripts = `
<script>if(typeof mermaid==="undefined"){var s=document.createElement("script");s.src="${MERMAID_CDN_URL}";s.onload=function(){mermaid.initialize({startOnLoad:true,theme:"dark"});mermaid.run();};document.head.appendChild(s);}<\/script>
<script>if(typeof hljs==="undefined"){var l=document.createElement("link");l.rel="stylesheet";l.href="${HLJS_CDN_CSS}";document.head.appendChild(l);var s=document.createElement("script");s.src="${HLJS_CDN_JS}";s.onload=function(){hljs.highlightAll();};document.head.appendChild(s);}<\/script>
<script>
// Selection bridge for "Ask about this"
document.addEventListener("mouseup",function(){var s=window.getSelection();var t=s&&s.toString().trim();if(!t||t.length<5){parent.postMessage({type:"dd-sel-clear"},"*");return;}var r=s.getRangeAt(0).getBoundingClientRect();parent.postMessage({type:"dd-sel",text:t,rect:{left:r.left,top:r.top,width:r.width,height:r.height}},"*");});
document.addEventListener("mousedown",function(){parent.postMessage({type:"dd-sel-clear"},"*");});
// Block wheel/scroll on mermaid containers
document.addEventListener("wheel",function(e){if(e.target.closest&&e.target.closest(".mermaid-wrap,[class*=mermaid]")){e.preventDefault();e.stopPropagation();}},{passive:false,capture:true});
// Syntax highlight code blocks
document.addEventListener("DOMContentLoaded",function(){if(typeof hljs!=="undefined"){hljs.highlightAll();}});
if(document.readyState==="complete"||document.readyState==="interactive"){if(typeof hljs!=="undefined"){hljs.highlightAll();}}
<\/script>`;
					if (doc.includes("</body>")) doc = doc.replace("</body>", `${injectedScripts}\n</body>`);
					else doc += injectedScripts;
					// Inject responsive overrides for nav and layout
					doc = doc.replace("</head>", `<style id="dd-responsive">
/* Deep Dive responsive overrides */
nav, [class*="nav"], header > div, header > ul, header > nav {
  flex-wrap: wrap !important; overflow-x: hidden !important; overflow: hidden !important;
  scrollbar-width: none !important; -ms-overflow-style: none !important;
}
nav::-webkit-scrollbar, [class*="nav"]::-webkit-scrollbar,
header::-webkit-scrollbar { display: none !important; }
nav a, [class*="nav"] a, header a[href^="#"] {
  white-space: nowrap; font-size: clamp(11px, 1.3vw, 14px); padding: 4px 8px !important;
}
/* Collapse nav to hamburger on narrow viewports */
@media (max-width: 600px) {
  nav, [class*="nav"], header > div { gap: 2px !important; }
  nav a, [class*="nav"] a, header a[href^="#"] { font-size: 11px; padding: 3px 6px !important; }
}
/* Make content responsive */
pre, code { overflow-x: auto; max-width: 100%; }
img, svg, .mermaid-wrap, [class*="mermaid"] { max-width: 100%; overflow: hidden; }
table { display: block; overflow-x: auto; max-width: 100%; }
body { overflow-x: hidden; }
</style>\n</head>`);
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(doc);
				} else {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(`<!DOCTYPE html><html><head><style>body{background:#0c0c0f;color:#5a5a72;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}h2{color:#7c8aff;margin-bottom:8px}.sp{width:32px;height:32px;border:3px solid #2a2a3a;border-top-color:#7c8aff;border-radius:50%;animation:s .8s linear infinite;margin:16px auto}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div><div class="sp"></div><h2>Exploring codebase…</h2><p>The document will appear here when ready.</p></div></body></html>`);
				}
				return;
			}
			if (req.method === "GET" && url === "/status") {
				const reqUrl = new URL(req.url || "", "http://localhost");
				if (reqUrl.searchParams.get("token") !== S.secret) { res.writeHead(403); res.end(); return; }
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ agentRunning: !!S.proc, isStreaming: S.isStreaming, htmlPath: S.htmlPath, clients: S.wsClients.size, targetPath: S.targetPath }));
				return;
			}
			res.writeHead(404); res.end("not found");
		});

		server.on("upgrade", (req, socket) => {
			const reqUrl = new URL(req.url || "", `http://localhost`);
			if (reqUrl.pathname === "/ws" && reqUrl.searchParams.get("token") === S.secret) {
				const client = wsAccept(req, socket);
				if (client) {
					S.wsClients.add(client);
					client.send(JSON.stringify({
						type: "init",
						agentRunning: !!S.proc, isStreaming: S.isStreaming,
						htmlPath: S.htmlPath, targetPath: S.targetPath,
						prompt: S.focus || undefined,
						validating: S.validationInProgress,
						lastActivityTs: S.lastActivityTs,
					}));
				}
			} else { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); }
		});

		// Heartbeat — broadcast agent state every 15s + probe agent health
		const HEALTH_PROBE_TIMEOUT = 10_000; // 10s to respond
		S.heartbeatTimer = setInterval(() => {
			if (S.wsClients.size === 0) return;

			// Check if previous health probe timed out
			if (S.healthProbePending && (Date.now() - S.healthProbeTs) > HEALTH_PROBE_TIMEOUT) {
				S.healthProbePending = false;
				S.consecutiveHealthFailures++;
				const silentMin = S.lastActivityTs ? Math.round((Date.now() - S.lastActivityTs) / 60000) : 0;
				agentLog(`Agent health probe timeout #${S.consecutiveHealthFailures} (no activity for ${silentMin}m)`);
				wsBroadcast({ type: "agent_health", healthy: false, failures: S.consecutiveHealthFailures, silentMin });
			}

			// Send new health probe if agent is running
			if (S.proc?.stdin?.writable && !S.healthProbePending) {
				S.healthProbePending = true;
				S.healthProbeTs = Date.now();
				try { S.proc.stdin.write(JSON.stringify({ type: "get_state" }) + "\n"); } catch {}
			}

			wsBroadcast({
				type: "heartbeat",
				agentRunning: !!S.proc,
				isStreaming: S.isStreaming,
				htmlPath: S.htmlPath,
				validating: S.validationInProgress,
				lastActivityTs: S.lastActivityTs,
				healthy: S.consecutiveHealthFailures === 0,
				consecutiveHealthFailures: S.consecutiveHealthFailures,
				ts: Date.now(),
			});
		}, 15_000);

		let port = S.port;
		const tryListen = () => {
			server.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE" && port < S.port + 10) { port++; tryListen(); }
				else reject(err);
			});
			server.listen(port, "127.0.0.1", () => { S.server = server; S.port = port; resolve(port); });
		};
		tryListen();
	});
}

// ═══════════════════════════════════════════════════════════════════════
// Stop / cleanup
// ═══════════════════════════════════════════════════════════════════════

function stopAgent() {
	S.intentionalStop = true;
	for (const t of S.spawnTimers) clearTimeout(t);
	S.spawnTimers = [];
	if (S.proc) {
		agentLog("Stopping agent (intentional)");
		rpcSend({ type: "abort" });
		const p = S.proc;
		setTimeout(() => { try { p.kill("SIGTERM"); } catch {} }, 2000);
		S.proc = null; S.isStreaming = false;
	}
	S.agentReady = false;
	S.pendingInitialPrompt = null;
	S.buffer = "";
	S.validationInProgress = false;
	S.validationAttempt = 0;
	S.crashCount = 0;
	validationQueued = false;
	pendingWritePaths.clear();
	pendingToolTimers.clear();
	S.healthProbePending = false;
	S.consecutiveHealthFailures = 0;
	wsBroadcast({ type: "agent_stopped" });
}

function stopAll() {
	stopAgent();
	if (S.heartbeatTimer) { clearInterval(S.heartbeatTimer); S.heartbeatTimer = null; }
	if (S.server) {
		for (const c of S.wsClients) { try { c.socket.end(); } catch {} }
		S.wsClients.clear(); S.server.close(); S.server = null;
	}
	S.port = S.basePort; // reset so next session starts from base port
}

// ═══════════════════════════════════════════════════════════════════════
// Explore prompt
// ═══════════════════════════════════════════════════════════════════════

function buildExplorePrompt(targetPath: string, prompt: string, depth: string, sessionId: string, scope?: string): string {
	const outputPath = path.join(targetPath, ".pi", "deep-dive", sessionId, "document.html");
	const isFocused = !!prompt;
	const hasScope = !!scope;

	const depthGuide: Record<string, string> = isFocused ? {
		shallow: "Brief overview of the topic. 2-3 diagrams. ~500 lines HTML. Fast.",
		medium: "Thorough coverage of the topic. 4-7 diagrams. ~1000 lines HTML.",
		deep: "Deep comprehensive analysis. 8-12+ diagrams. Many code examples. 1500+ lines.",
	} : {
		shallow: "High-level overview. 3-5 diagrams. ~800 lines HTML.",
		medium: "Cover each major module. 7-12 diagrams. ~1500 lines HTML.",
		deep: "Comprehensive analysis. 12-18+ diagrams. Many code examples. 2000+ lines.",
	};

	const scopeInstruction = hasScope
		? `\nScope: Focus your exploration on these paths within the project: ${scope}\nYou may read files outside the scope to understand imports and dependencies, but the document should be about the scoped area.`
		: "";

	const explorePhase = isFocused ? `## Phase 1: Targeted Exploration
Your goal: understand and document "${prompt}"
${scopeInstruction}
1. Read project config (package.json / Cargo.toml) — understand the project structure
2. Directory listing${hasScope ? ` — start with the scoped paths: ${scope}` : ""} — identify which files and modules relate to: ${prompt}
3. Read ONLY the relevant source files — follow imports that matter to the topic
4. Skip unrelated modules entirely — don't waste time exploring code that doesn't contribute
5. Trace the complete flow from entry points through implementation
${depth === "deep" ? "6. Read related tests, error handling, and edge cases\n7. Examine configuration and integration points" : ""}

Be efficient: explore what matters to the topic, skip everything else.` : `## Phase 1: Explore
${scopeInstruction}
Read the codebase systematically:
1. package.json / Cargo.toml — project structure
2. Directory listing${hasScope ? ` — focus on: ${scope}` : ""} — layout overview
3. Entry points and type definitions
4. Key module implementations
5. Follow imports for module dependencies`;

	const contentGuide = isFocused ? `
Content — FOCUSED on: ${prompt}
- Every section should directly contribute to understanding this specific topic
- Start with brief project context (1-2 paragraphs max) so the reader knows what the codebase is, then dive into the topic
- Show the complete architecture and data flow for this specific area
- Use REAL code from the codebase — not invented examples
- Explain WHY decisions were made, not just WHAT the code does
- Include diagrams showing how components interact FOR THIS TOPIC specifically
- Don't pad with unrelated modules or generic project overview — stay focused on the question` : `
Content: REAL code from the codebase. ACTUAL architecture. Explain WHY not just WHAT.`;

	return `You are a codebase architect. ${isFocused ? "Investigate and document a specific topic in" : "Explore and document:"} ${targetPath}
${isFocused ? `\nTopic to explore: ${prompt}` : ""}${hasScope ? `\nScoped to: ${scope}` : ""}
Depth: ${depth} — ${depthGuide[depth] || depthGuide.medium}

${explorePhase}

## Phase 2: Write HTML
IMPORTANT: Use the \`write\` tool (not bash/cat/heredoc) to create the file.
Write a single self-contained HTML file to: ${outputPath}

Design: dark theme (#0c0c0f bg, #13131a cards, #7c8aff accent, #6fcf97 green, #f0c674 yellow).
Fonts (include these CDN links in the HTML <head>):
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  Space Grotesk for headings, Inter for body, JetBrains Mono for code.
Code highlighting (include in <head>):
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HLJS_VERSION}/styles/atom-one-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HLJS_VERSION}/highlight.min.js"><\/script>
  Call hljs.highlightAll() after DOMContentLoaded. Use <pre><code class="language-xxx"> for code blocks.
Mermaid (include in <head> — IMPORTANT: use this EXACT URL, do not change the version):
  <script src="https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_CDN_VERSION}/dist/mermaid.min.js"><\/script>
- NOT ES module imports. Dark theme config. Each in .mermaid-wrap with button zoom (NO scroll-to-zoom).
- Drag-to-pan: use CSS transform translate() on the .mermaid element (NOT scrollLeft/scrollTop). Track panX/panY per wrapper.
  On mousedown set dragging=true, on mousemove update panX/panY, apply transform: translate(panX,panY) scale(zoom).
  This works at ALL zoom levels including 1x. Set cursor:grab on container, cursor:grabbing on :active.
- 5-15 nodes each. Use <br/> for multi-line labels.
- CRITICAL: Do NOT use square brackets [] in sequence diagram message text — it triggers mermaid's "loop" keyword. Use () instead.
- CRITICAL: Escape &amp; &lt; &gt; properly in HTML context.
Responsive design:
- The page is displayed inside an iframe that can be narrow (400-700px). ALL layout must work at small widths.
- Sticky nav: use flex-wrap so items wrap to multiple rows instead of overflowing. No horizontal scrollbar.
- If there are more than 6 nav sections, put a "Table of Contents" list at the top of the first section instead of cramming them all into the nav bar. Keep only the top 5-6 most important sections in the nav.
- Metrics strip: use flex-wrap so cards wrap on narrow screens.
- Code blocks: overflow-x: auto with max-width: 100%.
- Mermaid diagrams: max-width: 100% on wrapper.
- No fixed pixel widths on content containers. Use max-width + percentage/vw units.

Include: sticky nav (responsive, wrapping), metrics strip, cards, code blocks, callouts.
${contentGuide}

After writing, the system will automatically validate your mermaid diagrams. If there are errors, you'll be asked to fix them.`;
}

// ═══════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {

	pi.registerMessageRenderer("deep-dive-info", (message, { expanded }, theme) => {
		const d = (message.details || {}) as Record<string, string>;
		const lines: string[] = [];
		lines.push(theme.bold(theme.fg("accent", "π Deep Dive")));
		lines.push("");
		if (d.url) lines.push(`  ${theme.fg("dim", "URL")}     ${theme.fg("accent", d.url)}`);
		if (d.token) lines.push(`  ${theme.fg("dim", "Token")}   ${d.token}`);
		if (d.model) lines.push(`  ${theme.fg("dim", "Model")}   ${theme.fg("success", d.model)}`);
		if (d.target) lines.push(`  ${theme.fg("dim", "Target")}  ${d.target}`);
		if (d.depth) lines.push(`  ${theme.fg("dim", "Depth")}   ${d.depth}`);
		if (d.topic) lines.push(`  ${theme.fg("dim", "Topic")}   ${theme.fg("accent", d.topic)}`);
		if (d.scope) lines.push(`  ${theme.fg("dim", "Scope")}   ${d.scope}`);
		if (d.usage) lines.push(`  ${theme.fg("dim", "Usage")}   ${d.usage}`);
		if (expanded && d.hint) { lines.push(""); lines.push(`  ${theme.fg("dim", d.hint)}`); }
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	pi.registerCommand("deep-dive", {
		description: "Explore a codebase (or a specific topic) and generate architecture docs",
		getArgumentCompletions: (prefix: string) => [
			{ value: "--depth shallow", label: "--depth shallow", description: "Quick overview (faster)" },
			{ value: "--depth medium", label: "--depth medium", description: "Standard depth (default)" },
			{ value: "--depth deep", label: "--depth deep", description: "Comprehensive analysis" },
			{ value: "--path", label: "--path <subdir>", description: "Subdirectory or file to focus on (can repeat)" },
			{ value: "--model claude-sonnet-4-5", label: "--model claude-sonnet-4-5", description: "Sonnet 4.5 (default)" },
			{ value: "--model claude-opus-4-6", label: "--model claude-opus-4-6", description: "Opus 4.6 (slow, expensive)" },
			{ value: "--model gpt-5.2-codex", label: "--model gpt-5.2-codex", description: "GPT 5.2 Codex" },
			{ value: "--help", label: "--help", description: "Show usage examples" },
		].filter(i => !prefix || i.value.startsWith(prefix)),
		handler: async (args, ctx) => {
			const parts = parseArgs(args ?? "");

			// ── Help ──
			if (parts.includes("--help") || parts.includes("-h")) {
				pi.sendMessage({ customType: "deep-dive-info", content: "Usage", display: true, details: {
					usage: "/deep-dive [prompt] [--path ./subdir] [--depth level] [--model name]",
					hint: [
						"Examples:",
						"  /deep-dive                                  Full codebase exploration",
						"  /deep-dive how does authentication work     Focused dive (no quotes needed)",
						"  /deep-dive --path ./src                     Focus on the ./src subdirectory",
						"  /deep-dive --path ./src --path ./lib        Focus on multiple subdirectories",
						"  /deep-dive auth flow --path ./api --depth deep",
						"  /deep-dive project overview --depth shallow",
						"",
						"Everything that isn't a flag is your prompt — no quotes needed.",
						"Paths starting with ./ are auto-detected as scope (e.g. /deep-dive ./src).",
						"Use --path to narrow exploration to specific subdirectories or files.",
						"The project root is always the current working directory.",
						"",
						"--path:  subdirectory or file to focus on (repeatable)",
						"--depth: shallow (fast overview) | medium (standard) | deep (comprehensive)",
					].join("\n"),
				}});
				return;
			}

			if (S.proc && S.server) {
				pi.sendMessage({ customType: "deep-dive-info", content: "Already running", display: true, details: { url: `http://localhost:${S.port}/`, token: S.secret, model: S.model, target: S.targetPath, topic: S.focus || undefined, scope: S.scope || undefined } });
				return;
			}

			// ── Parse arguments ──
			let depth = "medium", model = "claude-sonnet-4-5";
			const scopePaths: string[] = [];
			const promptParts: string[] = [];

			for (let i = 0; i < parts.length; i++) {
				if (parts[i] === "--depth" && parts[i + 1]) { depth = parts[++i]; continue; }
				if (parts[i] === "--model" && parts[i + 1]) { model = parts[++i]; continue; }
				if (parts[i] === "--path" && parts[i + 1]) { scopePaths.push(parts[++i]); continue; }
				if (parts[i] === "--focus" && parts[i + 1]) { promptParts.push(parts[++i]); continue; }
				if (parts[i].startsWith("--")) continue;
				// Auto-detect scope paths: starts with ./ or contains /
				const looksLikePath = parts[i].startsWith("./") || parts[i].startsWith("../");
				if (looksLikePath) {
					const resolved = path.resolve(ctx.cwd, parts[i]);
					if (fs.existsSync(resolved)) { scopePaths.push(parts[i]); continue; }
				}
				promptParts.push(parts[i]);
			}

			const targetPath = path.resolve(ctx.cwd, ".");
			const prompt = promptParts.join(" ").trim();

			// Validate scope paths are inside cwd
			for (const sp of scopePaths) {
				const abs = path.resolve(ctx.cwd, sp);
				if (!abs.startsWith(targetPath)) {
					ctx.ui.notify(`Scope path must be inside the current directory: ${sp}\nRun /deep-dive --help for usage.`, "error"); return;
				}
				if (!fs.existsSync(abs)) {
					ctx.ui.notify(`Scope path not found: ${sp}\nRun /deep-dive --help for usage.`, "error"); return;
				}
			}
			const scope = scopePaths.join(", ");

			// Validate depth
			if (!["shallow", "medium", "deep"].includes(depth)) {
				ctx.ui.notify(`Invalid depth "${depth}". Use: shallow, medium, or deep.\nRun /deep-dive --help for usage.`, "error");
				return;
			}

			const sessionId = crypto.randomBytes(4).toString("hex");
			S.cwd = ctx.cwd; S.targetPath = targetPath; S.sessionId = sessionId; S.scope = scope; S.focus = prompt; S.depth = depth; S.model = model; S.htmlPath = null; S.sessionFile = null; S.crashCount = 0;

			// Create session directory
			fs.mkdirSync(path.join(targetPath, ".pi", "deep-dive", sessionId), { recursive: true });

			try {
				const port = await startServer();
				S.proc = spawnAgent(targetPath, buildExplorePrompt(targetPath, prompt, depth, sessionId, scope));
				saveMeta();
				const url = `http://localhost:${port}/`;
				const details: Record<string, string> = { url, token: S.secret, model, target: targetPath, depth };
				if (prompt) details.topic = prompt;
				if (scope) details.scope = scope;
				details.hint = "Open the URL in your browser and paste the token to connect.";
				pi.sendMessage({ customType: "deep-dive-info", content: prompt ? "Focused deep dive started" : "Deep dive started", display: true, details });
				ctx.ui.setStatus("deep-dive", `📖 ${url}`);
			} catch (err) { ctx.ui.notify(`Failed: ${err}`, "error"); }
		},
	});

	pi.registerCommand("deep-dive-resume", {
		description: "Resume a previous deep-dive session",
		handler: async (_args, ctx) => {
			if (S.proc && S.server) {
				pi.sendMessage({ customType: "deep-dive-info", content: "Already running", display: true, details: { url: `http://localhost:${S.port}/`, token: S.secret, model: S.model, target: S.targetPath, topic: S.focus || undefined, scope: S.scope || undefined } });
				return;
			}
			S.cwd = ctx.cwd;

			const targetPath = path.resolve(ctx.cwd, ".");
			const sessions = loadLocalSessions(targetPath);
			if (sessions.length === 0) {
				ctx.ui.notify("No deep-dive sessions found in this directory. Run /deep-dive to start one.", "warning");
				return;
			}

			let meta: any;
			if (sessions.length === 1) {
				meta = sessions[0];
			} else {
				// Show picker — each session shows target, prompt, depth, and age
				const labels = sessions.map(s => formatSessionLabel(s));
				const choice = await ctx.ui.select("Resume which session?", labels);
				if (choice == null) return; // cancelled
				const idx = labels.indexOf(choice);
				if (idx < 0) return;
				meta = sessions[idx];
			}

			if (!meta.targetPath || !fs.existsSync(meta.targetPath) || !fs.statSync(meta.targetPath).isDirectory()) {
				ctx.ui.notify(`Target no longer exists: ${meta.targetPath}`, "error"); return;
			}

			const sessionId = meta.id || crypto.randomBytes(4).toString("hex");
			S.targetPath = meta.targetPath; S.sessionId = sessionId;
			S.focus = meta.prompt || meta.focus || ""; S.scope = meta.scope || "";
			S.depth = meta.depth || "medium"; S.model = meta.model || "claude-sonnet-4-5";
			S.htmlPath = meta.htmlPath; S.sessionFile = meta.sessionFile; S.crashCount = 0;

			// Ensure session directory exists
			fs.mkdirSync(sessionDir(), { recursive: true });

			try {
				const port = await startServer();
				S.proc = spawnAgent(meta.targetPath, undefined, meta.sessionFile);
				const url = `http://localhost:${port}/`;
				const details: Record<string, string> = { url, token: S.secret, model: S.model, target: meta.targetPath, depth: S.depth };
				if (S.focus) details.topic = S.focus;
				if (S.scope) details.scope = S.scope;
				details.hint = "Open the URL in your browser and paste the token to connect.";
				pi.sendMessage({ customType: "deep-dive-info", content: "Resumed", display: true, details });
				ctx.ui.setStatus("deep-dive", `📖 ${url}`);
			} catch (err) { ctx.ui.notify(`Failed: ${err}`, "error"); }
		},
	});

	pi.registerCommand("deep-dive-stop", {
		description: "Stop the deep-dive agent and server",
		handler: async (_args, ctx) => { stopAll(); ctx.ui.setStatus("deep-dive", undefined); ctx.ui.notify("Stopped.", "info"); },
	});

	pi.on("session_shutdown", async () => { saveMeta(); stopAll(); });
}
