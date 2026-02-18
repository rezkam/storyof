import { describe, it, expect } from "vitest";
import { extractMermaidBlocks, buildFixPrompt } from "./validation.js";

describe("validation", () => {
	// ── extractMermaidBlocks ──────────────────────────────────────────

	describe("extractMermaidBlocks", () => {
		it("returns empty array for HTML with no mermaid blocks", () => {
			const blocks = extractMermaidBlocks("<html><body><p>hello</p></body></html>");
			expect(blocks).toHaveLength(0);
		});

		it("extracts a single <pre class='mermaid'> block", () => {
			const html = `<pre class="mermaid">graph TD\n  A --> B</pre>`;
			const blocks = extractMermaidBlocks(html);
			expect(blocks).toHaveLength(1);
			expect(blocks[0].index).toBe(0);
			expect(blocks[0].code).toContain("graph TD");
		});

		it("extracts a <div class='mermaid'> block", () => {
			const html = `<div class="mermaid">sequenceDiagram\n  Alice ->> Bob: Hi</div>`;
			const blocks = extractMermaidBlocks(html);
			expect(blocks).toHaveLength(1);
			expect(blocks[0].code).toContain("sequenceDiagram");
		});

		it("extracts multiple blocks and assigns sequential indexes", () => {
			const html = `
				<pre class="mermaid">graph LR\n  A --> B</pre>
				<p>some text</p>
				<pre class="mermaid">flowchart TD\n  C --> D</pre>
			`;
			const blocks = extractMermaidBlocks(html);
			expect(blocks).toHaveLength(2);
			expect(blocks[0].index).toBe(0);
			expect(blocks[1].index).toBe(1);
		});

		it("trims whitespace from block content", () => {
			const html = `<pre class="mermaid">  \n  graph TD\n  A-->B\n  </pre>`;
			const blocks = extractMermaidBlocks(html);
			expect(blocks[0].code).not.toMatch(/^\s/);
			expect(blocks[0].code).not.toMatch(/\s$/);
		});

		it("skips empty mermaid blocks", () => {
			const html = `<pre class="mermaid">   </pre>`;
			const blocks = extractMermaidBlocks(html);
			expect(blocks).toHaveLength(0);
		});

		it("handles additional attributes on the tag", () => {
			const html = `<pre class="mermaid" data-foo="bar">graph TD\n  A-->B</pre>`;
			const blocks = extractMermaidBlocks(html);
			expect(blocks).toHaveLength(1);
			expect(blocks[0].code).toContain("graph TD");
		});

		it("handles multiline diagram content", () => {
			const code = "sequenceDiagram\n  Alice ->> Bob: Hello\n  Bob -->> Alice: Hi";
			const html = `<pre class="mermaid">${code}</pre>`;
			const blocks = extractMermaidBlocks(html);
			expect(blocks[0].code).toBe(code);
		});
	});

	// ── buildFixPrompt ────────────────────────────────────────────────

	describe("buildFixPrompt", () => {
		it("includes the error count", () => {
			const prompt = buildFixPrompt(["Error 1", "Error 2"], "/path/to/doc.md");
			expect(prompt).toContain("2 mermaid diagram error(s)");
		});

		it("includes all errors in the output", () => {
			const prompt = buildFixPrompt(["Syntax error in diagram 1", "Unknown node type"], "/doc.md");
			expect(prompt).toContain("Syntax error in diagram 1");
			expect(prompt).toContain("Unknown node type");
		});

		it("includes the markdown file path", () => {
			const prompt = buildFixPrompt(["error"], "/my/project/story.md");
			expect(prompt).toContain("/my/project/story.md");
		});

		it("separates multiple errors with a divider", () => {
			const prompt = buildFixPrompt(["error A", "error B"], "/doc.md");
			expect(prompt).toContain("---");
		});

		it("includes common fix instructions", () => {
			const prompt = buildFixPrompt(["some error"], "/doc.md");
			expect(prompt).toContain("Common fixes");
			expect(prompt).toContain("backtick");
		});

		it("works with a single error", () => {
			const prompt = buildFixPrompt(["one error"], "/doc.md");
			expect(prompt).toContain("1 mermaid diagram error(s)");
			expect(prompt).toContain("one error");
		});
	});
});
