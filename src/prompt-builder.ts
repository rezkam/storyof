/**
 * StoryOf — Exploration prompt builder.
 *
 * Generates the initial system/user prompt for the agent to explore
 * a codebase and write a markdown architecture document.
 */

import * as path from "node:path";
import { LOCAL_DIR_NAME } from "./constants.js";

export function buildExplorePrompt(
	targetPath: string,
	prompt: string,
	depth: string,
	sessionId: string,
	scope?: string,
): string {
	const outputPath = path.join(targetPath, LOCAL_DIR_NAME, sessionId, "document.md");
	const isFocused = !!prompt;
	const hasScope = !!scope;

	const depthGuide: Record<string, string> = isFocused
		? {
				shallow: "Brief overview of the topic. 2-3 diagrams. ~500 lines. Fast.",
				medium: "Thorough coverage of the topic. 4-7 diagrams. ~1000 lines.",
				deep: "Deep comprehensive analysis. 8-12+ diagrams. Many code examples. 1500+ lines.",
			}
		: {
				shallow: "High-level overview. 3-5 diagrams. ~800 lines.",
				medium: "Cover each major module. 7-12 diagrams. ~1500 lines.",
				deep: "Comprehensive analysis. 12-18+ diagrams. Many code examples. 2000+ lines.",
			};

	const scopeInstruction = hasScope
		? `\nScope: Focus your exploration on these paths within the project: ${scope}\nYou may read files outside the scope to understand imports and dependencies, but the document should be about the scoped area.`
		: "";

	const explorePhase = isFocused
		? `## Phase 1: Targeted Exploration
Your goal: understand and document "${prompt}"
${scopeInstruction}
1. Read project config (package.json / Cargo.toml) — understand the project structure
2. Directory listing${hasScope ? ` — start with the scoped paths: ${scope}` : ""} — identify which files and modules relate to: ${prompt}
3. Read ONLY the relevant source files — follow imports that matter to the topic
4. Skip unrelated modules entirely — don't waste time exploring code that doesn't contribute
5. Trace the complete flow from entry points through implementation
${depth === "deep" ? "6. Read related tests, error handling, and edge cases\n7. Examine configuration and integration points" : ""}

Be efficient: explore what matters to the topic, skip everything else.`
		: `## Phase 1: Explore
${scopeInstruction}
Read the codebase systematically:
1. package.json / Cargo.toml — project structure
2. Directory listing${hasScope ? ` — focus on: ${scope}` : ""} — layout overview
3. Entry points and type definitions
4. Key module implementations
5. Follow imports for module dependencies`;

	const contentGuide = isFocused
		? `
Content — FOCUSED on: ${prompt}
- Every section should directly contribute to understanding this specific topic
- Start with brief project context (1-2 paragraphs max) so the reader knows what the codebase is, then dive into the topic
- Show the complete architecture and data flow for this specific area
- Use REAL code from the codebase — not invented examples
- Explain WHY decisions were made, not just WHAT the code does
- Include diagrams showing how components interact FOR THIS TOPIC specifically
- Don't pad with unrelated modules or generic project overview — stay focused on the question`
		: `
Content: REAL code from the codebase. ACTUAL architecture. Explain WHY not just WHAT.`;

	return `You are a codebase architect. ${isFocused ? "Investigate and document a specific topic in" : "Explore and document:"} ${targetPath}
${isFocused ? `\nTopic to explore: ${prompt}` : ""}${hasScope ? `\nScoped to: ${scope}` : ""}
Depth: ${depth} — ${depthGuide[depth] || depthGuide.medium}

${explorePhase}

## Phase 2: Write Markdown
IMPORTANT: Use the \`write\` tool (not bash/cat/heredoc) to create the file.
Write a MARKDOWN file to: ${outputPath}

Use standard markdown: headings, paragraphs, code blocks, lists, tables, bold, links.
The system renders your markdown to a styled HTML page automatically. Do NOT write HTML.

Structure your document like this:
- Start with a # title and a short subtitle paragraph
- Use ## for major sections, ### for subsections
- Use tables for structured data (| col1 | col2 |)
- Use fenced code blocks with language tags (\`\`\`go, \`\`\`typescript, etc.)
- Use > blockquotes for callouts and important notes

For architecture diagrams, use mermaid code blocks:

\`\`\`mermaid
graph TD
    A[Client Request] --> B[API Gateway]
    B --> C[Auth Service]
    B --> D[Data Service]
    D --> E[(Database)]
\`\`\`

Mermaid rules:
- Write ONLY graph structure: nodes, edges, subgraphs, labels.
- Do NOT add \`style\`, \`classDef\`, \`%%{init:}%%\`, or any color/theme directives.
  The rendering system handles all colors and theming. Any styling you add will be stripped.
- 5-15 nodes per diagram. Use <br/> for multi-line node labels.
- Do NOT use square brackets [] in sequence diagram message text (triggers mermaid "loop" keyword). Use () instead.
- Keep node IDs simple alphanumeric.
${contentGuide}

After writing, the system will render your markdown and validate mermaid diagrams. If there are errors, you'll be asked to fix them.`;
}
