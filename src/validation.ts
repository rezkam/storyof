/**
 * StoryOf — Mermaid diagram validation.
 *
 * Extracts mermaid blocks from HTML, validates each with mermaid-cli,
 * and returns errors for the agent to fix.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { exec } from "node:child_process";
import { MERMAID_CLI_VERSION } from "./constants.js";

export interface ValidationResult {
	ok: boolean;
	errors: string[];
	total: number;
}

export interface BlockValidation {
	index: number;
	code: string;
	valid: boolean;
	error?: string;
}

/** Extract mermaid blocks from rendered HTML */
export function extractMermaidBlocks(html: string): { index: number; code: string }[] {
	const blocks: { index: number; code: string }[] = [];
	const re = /<(?:pre|div)\s+class="mermaid"[^>]*>([\s\S]*?)<\/(?:pre|div)>/gi;
	let m;
	while ((m = re.exec(html)) !== null) {
		const code = m[1].trim();
		if (code) blocks.push({ index: blocks.length, code });
	}
	return blocks;
}

/** Validate a single mermaid block using mermaid-cli */
export function validateMermaidBlock(code: string): Promise<{ valid: boolean; error?: string }> {
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
			},
		);
	});
}

/** Validate all mermaid blocks in an HTML file */
export async function validateHtml(
	htmlPath: string,
	onProgress?: (index: number, total: number, status: "checking" | "ok" | "error", error?: string) => void,
): Promise<ValidationResult> {
	const html = fs.readFileSync(htmlPath, "utf-8");
	const blocks = extractMermaidBlocks(html);
	const errors: string[] = [];

	for (const block of blocks) {
		onProgress?.(block.index, blocks.length, "checking");
		const result = await validateMermaidBlock(block.code);
		if (!result.valid) {
			errors.push(`Diagram ${block.index + 1}: ${result.error}\nCode:\n${block.code.slice(0, 300)}`);
			onProgress?.(block.index, blocks.length, "error", result.error);
		} else {
			onProgress?.(block.index, blocks.length, "ok");
		}
	}

	return { ok: errors.length === 0, errors, total: blocks.length };
}

/** Build a fix prompt to send to the agent when validation fails */
export function buildFixPrompt(errors: string[], mdPath: string): string {
	return `The document has ${errors.length} mermaid diagram error(s). Please fix them:

${errors.join("\n\n---\n\n")}

Common fixes:
- Square brackets [] in sequence diagram messages trigger the "loop" keyword — use parentheses () instead
- Escape &, <, > as &amp; &lt; &gt;
- Use <br/> not \\n for line breaks
- Don't use backticks inside mermaid blocks
- Keep node IDs simple alphanumeric

Read the current markdown file, fix the broken diagrams, and write the corrected file back to: ${mdPath}`;
}
