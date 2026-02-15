/**
 * StoryOf — Session metadata management.
 *
 * Stores session info in .storyof/<session-id>/meta.json for resume/listing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LOCAL_DIR_NAME } from "./constants.js";

export interface SessionMeta {
	id: string;
	targetPath: string;
	prompt?: string;
	scope?: string;
	depth: string;
	model: string;
	htmlPath?: string | null;
	sessionFile?: string | null;
	port?: number;
	timestamp: number;
}

/** Get session directory path */
export function sessionDir(targetPath: string, sessionId: string): string {
	return path.join(targetPath, LOCAL_DIR_NAME, sessionId);
}

/** Save session metadata */
export function saveMeta(meta: SessionMeta): void {
	try {
		const dir = sessionDir(meta.targetPath, meta.id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
	} catch {}
}

/** Load all sessions for a project directory */
export function loadLocalSessions(targetPath: string): SessionMeta[] {
	const sessions: SessionMeta[] = [];
	const storyofDir = path.join(targetPath, LOCAL_DIR_NAME);
	try {
		if (!fs.existsSync(storyofDir)) return sessions;
		for (const entry of fs.readdirSync(storyofDir)) {
			const metaFile = path.join(storyofDir, entry, "meta.json");
			try {
				if (!fs.statSync(path.join(storyofDir, entry)).isDirectory()) continue;
				const meta: SessionMeta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
				if (!meta.id) meta.id = entry;
				if (!meta.targetPath) meta.targetPath = targetPath;
				sessions.push(meta);
			} catch {}
		}
	} catch {}
	sessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
	return sessions;
}

/** Format a session label for display */
export function formatSessionLabel(meta: SessionMeta): string {
	const ago = meta.timestamp ? timeAgo(meta.timestamp) : "?";
	const hasDoc = meta.htmlPath ? "📄" : "⏳";
	const depth = meta.depth || "medium";
	const topic = meta.prompt;
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
