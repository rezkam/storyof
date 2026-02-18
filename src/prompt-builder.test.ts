import { describe, it, expect } from "vitest";
import { buildExplorePrompt } from "./prompt-builder.js";

describe("buildExplorePrompt", () => {
	const TARGET = "/my/project";
	const SESSION_ID = "test-session-123";

	// ── Output path ───────────────────────────────────────────────────

	it("includes the output path with session ID", () => {
		const prompt = buildExplorePrompt(TARGET, "", "medium", SESSION_ID);
		expect(prompt).toContain(`${TARGET}/.storyof/${SESSION_ID}/document.md`);
	});

	// ── Focused vs full-exploration mode ──────────────────────────────

	describe("focused mode (with prompt)", () => {
		it("includes the topic in the output", () => {
			const out = buildExplorePrompt(TARGET, "authentication flow", "medium", SESSION_ID);
			expect(out).toContain("authentication flow");
		});

		it("uses targeted exploration phase heading", () => {
			const out = buildExplorePrompt(TARGET, "database layer", "medium", SESSION_ID);
			expect(out).toContain("Targeted Exploration");
		});

		it("uses focused depth guides", () => {
			const shallow = buildExplorePrompt(TARGET, "a topic", "shallow", SESSION_ID);
			expect(shallow).toContain("2-3 diagrams");

			const deep = buildExplorePrompt(TARGET, "a topic", "deep", SESSION_ID);
			expect(deep).toContain("8-12+ diagrams");
		});
	});

	describe("full exploration mode (no prompt)", () => {
		it("does not mention a specific topic", () => {
			const out = buildExplorePrompt(TARGET, "", "medium", SESSION_ID);
			expect(out).not.toContain("Topic to explore");
		});

		it("uses general exploration phase heading", () => {
			const out = buildExplorePrompt(TARGET, "", "medium", SESSION_ID);
			expect(out).toContain("## Phase 1: Explore");
		});

		it("uses full-exploration depth guides", () => {
			const shallow = buildExplorePrompt(TARGET, "", "shallow", SESSION_ID);
			expect(shallow).toContain("3-5 diagrams");

			const deep = buildExplorePrompt(TARGET, "", "deep", SESSION_ID);
			expect(deep).toContain("12-18+ diagrams");
		});
	});

	// ── Scope ─────────────────────────────────────────────────────────

	describe("scope parameter", () => {
		it("includes scope path when provided", () => {
			const out = buildExplorePrompt(TARGET, "", "medium", SESSION_ID, "src/auth");
			expect(out).toContain("src/auth");
		});

		it("mentions scoped paths in exploration instructions", () => {
			const out = buildExplorePrompt(TARGET, "", "medium", SESSION_ID, "src/db");
			expect(out).toContain("Scoped to:");
		});

		it("omits scope section when not provided", () => {
			const out = buildExplorePrompt(TARGET, "", "medium", SESSION_ID);
			expect(out).not.toContain("Scoped to:");
		});

		it("scope works in focused mode too", () => {
			const out = buildExplorePrompt(TARGET, "caching", "medium", SESSION_ID, "src/cache");
			expect(out).toContain("src/cache");
			expect(out).toContain("caching");
		});
	});

	// ── Depth ─────────────────────────────────────────────────────────

	describe("depth guides", () => {
		it("deep mode adds extra exploration steps for focused prompts", () => {
			const deep = buildExplorePrompt(TARGET, "some topic", "deep", SESSION_ID);
			// Deep focused mode adds steps 6 and 7
			expect(deep).toContain("Read related tests");
		});

		it("shallow and medium modes do not add deep-specific steps", () => {
			const shallow = buildExplorePrompt(TARGET, "some topic", "shallow", SESSION_ID);
			expect(shallow).not.toContain("Read related tests");

			const medium = buildExplorePrompt(TARGET, "some topic", "medium", SESSION_ID);
			expect(medium).not.toContain("Read related tests");
		});
	});

	it("falls back to medium depth guide for unknown depth values", () => {
		const out = buildExplorePrompt(TARGET, "", "ultra-deep", SESSION_ID);
		// Unknown depth → falls back to medium guide text
		expect(out).toContain("Cover each major module");
	});

	// ── Mermaid instructions ──────────────────────────────────────────

	it("always includes mermaid diagram rules", () => {
		const out = buildExplorePrompt(TARGET, "", "medium", SESSION_ID);
		expect(out).toContain("mermaid");
		expect(out).toContain("classDef");
		expect(out).toContain("style");
	});

	it("instructs use of write tool, not bash", () => {
		const out = buildExplorePrompt(TARGET, "", "medium", SESSION_ID);
		expect(out).toContain("`write` tool");
		expect(out).toContain("not bash");
	});

	it("instructs writing markdown, not HTML", () => {
		const out = buildExplorePrompt(TARGET, "", "medium", SESSION_ID);
		expect(out).toContain("Do NOT write HTML");
	});
});
