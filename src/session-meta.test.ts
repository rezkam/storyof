import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { sessionDir, saveMeta, loadLocalSessions, formatSessionLabel } from "./session-meta.js";
import type { SessionMeta } from "./session-meta.js";

function makeTempDir(): string {
	const id = crypto.randomBytes(8).toString("hex");
	const dir = path.join(os.tmpdir(), `storyof-meta-test-${id}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("session-meta", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ── sessionDir ────────────────────────────────────────────────────

	describe("sessionDir", () => {
		it("returns path inside .storyof/<sessionId>", () => {
			const dir = sessionDir("/my/project", "abc123");
			expect(dir).toBe("/my/project/.storyof/abc123");
		});

		it("includes targetPath as root", () => {
			const dir = sessionDir("/some/other/path", "xyz");
			expect(dir.startsWith("/some/other/path")).toBe(true);
		});
	});

	// ── saveMeta / loadLocalSessions ──────────────────────────────────

	describe("saveMeta + loadLocalSessions roundtrip", () => {
		const baseMeta: SessionMeta = {
			id: "session-1",
			targetPath: "",
			prompt: "explain the architecture",
			depth: "medium",
			model: "claude-sonnet-4-5",
			timestamp: Date.now(),
		};

		it("saves and loads a single session", () => {
			const meta = { ...baseMeta, targetPath: tempDir };
			saveMeta(meta);

			const sessions = loadLocalSessions(tempDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe("session-1");
			expect(sessions[0].prompt).toBe("explain the architecture");
			expect(sessions[0].depth).toBe("medium");
			expect(sessions[0].model).toBe("claude-sonnet-4-5");
		});

		it("loads multiple sessions sorted newest-first", () => {
			const now = Date.now();
			saveMeta({ ...baseMeta, id: "old-session", targetPath: tempDir, timestamp: now - 10000 });
			saveMeta({ ...baseMeta, id: "new-session", targetPath: tempDir, timestamp: now });

			const sessions = loadLocalSessions(tempDir);
			expect(sessions).toHaveLength(2);
			expect(sessions[0].id).toBe("new-session");
			expect(sessions[1].id).toBe("old-session");
		});

		it("returns empty array when directory does not exist", () => {
			const nonExistent = path.join(tempDir, "does-not-exist");
			const sessions = loadLocalSessions(nonExistent);
			expect(sessions).toEqual([]);
		});

		it("skips non-directory entries in .storyof/", () => {
			const storyofDir = path.join(tempDir, ".storyof");
			fs.mkdirSync(storyofDir, { recursive: true });
			// Create a stray file (not a session directory)
			fs.writeFileSync(path.join(storyofDir, "some-file.txt"), "noise");

			// Also save a real session
			saveMeta({ ...baseMeta, id: "real-session", targetPath: tempDir });

			const sessions = loadLocalSessions(tempDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe("real-session");
		});

		it("skips sessions with corrupt meta.json", () => {
			// Write a broken JSON file
			const dir = sessionDir(tempDir, "corrupt-session");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "meta.json"), "{ invalid json");

			// Also save a valid session
			saveMeta({ ...baseMeta, id: "valid-session", targetPath: tempDir });

			const sessions = loadLocalSessions(tempDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe("valid-session");
		});

		it("fills in missing id and targetPath from directory structure", () => {
			// Write a meta.json without id/targetPath fields
			const dir = sessionDir(tempDir, "inferred-id");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, "meta.json"),
				JSON.stringify({ depth: "shallow", model: "gpt-4o", timestamp: Date.now() }),
			);

			const sessions = loadLocalSessions(tempDir);
			expect(sessions[0].id).toBe("inferred-id");
			expect(sessions[0].targetPath).toBe(tempDir);
		});
	});

	// ── formatSessionLabel ────────────────────────────────────────────

	describe("formatSessionLabel", () => {
		function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
			return {
				id: "test-id",
				targetPath: "/proj",
				depth: "medium",
				model: "claude-sonnet-4-5",
				timestamp: Date.now(),
				...overrides,
			};
		}

		it("shows ⏳ when no htmlPath", () => {
			const label = formatSessionLabel(meta());
			expect(label).toContain("⏳");
		});

		it("shows 📄 when htmlPath is set", () => {
			const label = formatSessionLabel(meta({ htmlPath: "/some/doc.html" }));
			expect(label).toContain("📄");
		});

		it("shows prompt in quotes when short enough", () => {
			const label = formatSessionLabel(meta({ prompt: "hello world" }));
			expect(label).toContain('"hello world"');
		});

		it("truncates prompt at 40 chars with ellipsis", () => {
			const long = "a".repeat(50);
			const label = formatSessionLabel(meta({ prompt: long }));
			expect(label).toContain("…");
			// The quoted part should be max ~41 chars (37 + …, but no hard rule on label total)
			const match = label.match(/"([^"]+)"/);
			expect(match).not.toBeNull();
			expect(match![1].length).toBeLessThanOrEqual(40);
		});

		it("shows 'full exploration' when no prompt", () => {
			const label = formatSessionLabel(meta({ prompt: undefined }));
			expect(label).toContain("full exploration");
		});

		it("includes scope in brackets when set", () => {
			const label = formatSessionLabel(meta({ scope: "auth module" }));
			expect(label).toContain("[auth module]");
		});

		it("omits scope when not set", () => {
			const label = formatSessionLabel(meta());
			expect(label).not.toContain("[");
		});

		it("includes depth", () => {
			const label = formatSessionLabel(meta({ depth: "deep" }));
			expect(label).toContain("deep");
		});

		it("shows 'just now' for very recent timestamps", () => {
			const label = formatSessionLabel(meta({ timestamp: Date.now() }));
			expect(label).toContain("just now");
		});

		it("shows minutes ago for timestamps in the past hour", () => {
			const label = formatSessionLabel(meta({ timestamp: Date.now() - 30 * 60_000 }));
			expect(label).toContain("30m ago");
		});

		it("shows hours ago for timestamps today", () => {
			const label = formatSessionLabel(meta({ timestamp: Date.now() - 3 * 3_600_000 }));
			expect(label).toContain("3h ago");
		});

		it("shows days ago for old timestamps", () => {
			const label = formatSessionLabel(meta({ timestamp: Date.now() - 5 * 86_400_000 }));
			expect(label).toContain("5d ago");
		});

		it("shows ? for missing timestamp", () => {
			const label = formatSessionLabel(meta({ timestamp: 0 }));
			expect(label).toContain("?");
		});

		it("defaults to 'medium' depth when depth is empty string", () => {
			// Simulate a session saved before depth was required
			const label = formatSessionLabel({ ...meta(), depth: "" });
			expect(label).toContain("medium");
		});
	});
});
