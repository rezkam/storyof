/**
 * Safe bash tool — blocks commands that modify files.
 *
 * Used in read-only mode (default). The agent can read files, run grep/find/ls,
 * and execute non-destructive bash commands. Any command that would create, modify,
 * or delete files is rejected with a clear error message.
 *
 * The write tool is available separately for creating story/document files.
 */

import { createBashTool } from "@mariozechner/pi-coding-agent";
import type { BashSpawnContext } from "@mariozechner/pi-coding-agent";

/**
 * Patterns that indicate a command modifies files.
 *
 * These match against the full command string. The list covers:
 * - Shell redirects: >, >>, tee
 * - File operations: rm, mv, cp, mkdir, touch, chmod, chown, ln
 * - Editors: sed -i, perl -i, awk with output redirect
 * - Package managers: npm install, pip install, etc.
 * - Source control writes: git commit, git push, git checkout
 * - Script interpreters with inline code that could write files
 */
const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
	// Shell output redirects (but not grep -r > which is just stdout)
	{ pattern: /(?:^|[;&|])\s*[^#]*\s+>{1,2}\s+\S/, description: "output redirect (> or >>)" },
	{ pattern: /\btee\s+\S/, description: "tee (writes to file)" },

	// File deletion / move / copy that overwrites
	{ pattern: /\brm\s+/, description: "rm (file deletion)" },
	{ pattern: /\brmdir\s+/, description: "rmdir (directory deletion)" },
	{ pattern: /\bunlink\s+/, description: "unlink (file deletion)" },
	{ pattern: /\bshred\s+/, description: "shred (secure deletion)" },

	// File creation / modification
	{ pattern: /\bmv\s+/, description: "mv (move/rename)" },
	{ pattern: /\bcp\s+/, description: "cp (copy)" },
	{ pattern: /\bmkdir\s+/, description: "mkdir (create directory)" },
	{ pattern: /\btouch\s+/, description: "touch (create/modify file)" },
	{ pattern: /\bchmod\s+/, description: "chmod (change permissions)" },
	{ pattern: /\bchown\s+/, description: "chown (change ownership)" },
	{ pattern: /\bln\s+/, description: "ln (create link)" },
	{ pattern: /\binstall\s+/, description: "install (copy with permissions)" },
	{ pattern: /\bmktemp\b/, description: "mktemp (create temp file)" },
	{ pattern: /\btruncate\s+/, description: "truncate (resize file)" },

	// In-place editing
	{ pattern: /\bsed\s+(-[a-zA-Z]*i|--in-place)/, description: "sed -i (in-place edit)" },
	{ pattern: /\bperl\s+(-[a-zA-Z]*i|--in-place)/, description: "perl -i (in-place edit)" },
	{ pattern: /\bawk\s+(-[a-zA-Z]*i|--in-place)/, description: "awk -i (in-place edit)" },

	// Patch / diff apply
	{ pattern: /\bpatch\s+/, description: "patch (apply diff)" },

	// Git write operations
	{ pattern: /\bgit\s+(commit|push|merge|rebase|reset|checkout\s+(?!-b)|stash|cherry-pick|revert|clean|rm|mv)/, description: "git write operation" },
	{ pattern: /\bgit\s+branch\s+-[dD]/, description: "git branch delete" },

	// Package managers (install can modify node_modules, etc.)
	{ pattern: /\bnpm\s+(install|i|ci|uninstall|update|link|rebuild)\b/, description: "npm (package modification)" },
	{ pattern: /\byarn\s+(add|remove|install|upgrade)\b/, description: "yarn (package modification)" },
	{ pattern: /\bpnpm\s+(add|remove|install|update)\b/, description: "pnpm (package modification)" },
	{ pattern: /\bpip\s+install\b/, description: "pip install" },
	{ pattern: /\bcargo\s+(build|install)\b/, description: "cargo build/install" },

	// Compilation / build (produces output files)
	{ pattern: /\bmake\s*(?!.*-n)(?!.*--dry-run)/, description: "make (build)" },
	{ pattern: /\bcmake\b/, description: "cmake (build)" },

	// Dangerous interpreters with inline code
	{ pattern: /\bpython[23]?\s+-c\b/, description: "python -c (inline code execution)" },
	{ pattern: /\bnode\s+-e\b/, description: "node -e (inline code execution)" },
	{ pattern: /\bruby\s+-e\b/, description: "ruby -e (inline code execution)" },

	// dd — disk-level writes
	{ pattern: /\bdd\s+/, description: "dd (disk/file copy)" },

	// curl/wget to write files
	{ pattern: /\bcurl\s+[^|]*(-o|--output|-O)\b/, description: "curl with output file" },
	{ pattern: /\bwget\s+/, description: "wget (downloads to file)" },
];

/**
 * Check if a bash command would modify files.
 * Returns null if safe, or a description of why it's blocked.
 */
export function checkCommandSafety(command: string): string | null {
	// Normalize: collapse whitespace, trim
	const normalized = command.replace(/\s+/g, " ").trim();

	// Skip empty commands
	if (!normalized) return null;

	// Allow comments
	if (normalized.startsWith("#")) return null;

	for (const { pattern, description } of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(normalized)) {
			return description;
		}
	}

	return null;
}

/**
 * Create a bash tool that blocks file-modifying commands.
 * Safe commands (cat, grep, find, ls, head, tail, wc, etc.) pass through.
 */
export function createSafeBashTool(cwd: string) {
	return createBashTool(cwd, {
		spawnHook: (context: BashSpawnContext): BashSpawnContext => {
			const violation = checkCommandSafety(context.command);
			if (violation) {
				throw new Error(
					`Command blocked (read-only mode): ${violation}\n\n` +
					`StoryOf runs in read-only mode to protect your codebase.\n` +
					`The agent can read files and run analysis commands, but cannot modify files.\n` +
					`Use the write tool to create story/document files.`
				);
			}
			return context;
		},
	});
}
