/**
 * StoryOf — Markdown → HTML renderer.
 *
 * Pipeline: .md → marked (with custom mermaid renderer) → template → .html
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Template ──────────────────────────────────────────────────────────

let _templateCache: string | null = null;

function getTemplatePath(): string {
	// Look for template.html in the assets directory relative to this file
	const thisDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.join(thisDir, "..", "assets", "template.html"),
		path.join(thisDir, "assets", "template.html"),
		path.join(process.cwd(), "assets", "template.html"),
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) return p;
	}
	throw new Error("template.html not found");
}

export function getTemplate(): string {
	if (!_templateCache) _templateCache = fs.readFileSync(getTemplatePath(), "utf-8");
	return _templateCache;
}

/** Clear template cache — forces re-read on next getTemplate() call. */
export function clearTemplateCache(): void {
	_templateCache = null;
}

// ── Mermaid source cleanup ────────────────────────────────────────────

function cleanMermaidSource(code: string): string {
	return code
		.split("\n")
		.filter((line) => !line.trim().match(/^style\s+\S+\s+/))
		.filter((line) => !line.trim().match(/^%%\{init:/))
		.filter((line) => !line.trim().match(/^classDef\s+/))
		.filter((line) => !line.trim().match(/^class\s+\S+\s+\S+$/))
		.join("\n")
		.trim();
}

// ── Renderer ──────────────────────────────────────────────────────────

let _marked: typeof import("marked") | null = null;
async function getMarked() {
	if (!_marked) _marked = await import("marked");
	return _marked;
}

/**
 * Render a markdown file to HTML using the template.
 *
 * - ```mermaid blocks become <div class="mermaid-box"> containers
 * - Style directives are stripped from mermaid source
 * - All other markdown renders to standard HTML
 * - Result is wrapped in template.html (owns CDN deps, CSS, mermaid theme, JS)
 */
export async function renderDocument(mdPath: string): Promise<string> {
	const md = fs.readFileSync(mdPath, "utf-8");
	const htmlPath = mdPath.replace(/\.md$/, ".html");

	const { marked } = await getMarked();

	const renderer = new marked.Renderer();
	const origCode = renderer.code.bind(renderer);
	renderer.code = function (args: any) {
		const text: string = args.text;
		const lang: string | undefined = args.lang;
		if (lang === "mermaid") {
			const clean = cleanMermaidSource(text);
			return `<div class="mermaid-box">
  <div class="controls">
    <button class="zoom-in">+</button>
    <button class="zoom-out">&minus;</button>
    <button class="zoom-reset">Reset</button>
  </div>
  <div class="pan-area">
    <div class="mermaid">
${clean}
    </div>
  </div>
</div>`;
		}
		return origCode(args);
	};

	// Extract title from first h1
	const titleMatch = md.match(/^#\s+(.+)$/m);
	const title = titleMatch ? titleMatch[1].trim() : "StoryOf";

	const body = await marked.parse(md, { renderer });
	const template = getTemplate();
	const html = template
		.replace("{{TITLE}}", title.replace(/</g, "&lt;"))
		.replace("{{CONTENT}}", body);

	// Write full HTML (used for validation + standalone export)
	fs.writeFileSync(htmlPath, html);

	// Write body fragment (served wrapped in latest template at request time)
	const bodyPath = mdPath.replace(/\.md$/, ".body.html");
	fs.writeFileSync(bodyPath, JSON.stringify({ title, body }));

	return htmlPath;
}
