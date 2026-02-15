/**
 * CodeDive — constants and shared configuration.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── Branding ──────────────────────────────────────────────────────────
export const APP_NAME = "CodeDive";
export const APP_CMD = "codedive";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
export const APP_VERSION: string = pkg.version;

// ── Directories ───────────────────────────────────────────────────────
/** Global config: ~/.codedive/ */
export const GLOBAL_DIR = join(homedir(), ".codedive");
/** Global auth file */
export const AUTH_PATH = join(GLOBAL_DIR, "auth.json");
/** Global settings file */
export const GLOBAL_SETTINGS_PATH = join(GLOBAL_DIR, "settings.json");
/** Global skills directory */
export const GLOBAL_SKILLS_DIR = join(GLOBAL_DIR, "skills");
/** Global sessions base directory */
export const GLOBAL_SESSIONS_DIR = join(GLOBAL_DIR, "sessions");

/** Project-local directory name */
export const LOCAL_DIR_NAME = ".codedive";

// ── Mermaid ───────────────────────────────────────────────────────────
export const MERMAID_CLI_VERSION = "11.4.2";

// ── Agent ─────────────────────────────────────────────────────────────
export const DEFAULT_MODEL = "claude-sonnet-4-5";
export const DEFAULT_DEPTH = "medium";
export const DEFAULT_THINKING_LEVEL = "medium";
export const MAX_VALIDATION_ATTEMPTS = 3;
export const MAX_CRASH_RESTARTS = 3;

// ── Server ────────────────────────────────────────────────────────────
export const DEFAULT_PORT = 9876;
export const HEALTH_PROBE_TIMEOUT = 10_000;
export const HEARTBEAT_INTERVAL = 15_000;

// ── Environment Variables ─────────────────────────────────────────────
/**
 * CodeDive environment variables (CODEDIVE_ prefix) with fallbacks
 * to standard provider env vars.
 */
export const ENV_VAR_MAP: Record<string, { codedive: string; fallbacks: string[] }> = {
	anthropic: {
		codedive: "CODEDIVE_ANTHROPIC_API_KEY",
		fallbacks: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
	},
	openai: {
		codedive: "CODEDIVE_OPENAI_API_KEY",
		fallbacks: ["OPENAI_API_KEY"],
	},
	google: {
		codedive: "CODEDIVE_GEMINI_API_KEY",
		fallbacks: ["GEMINI_API_KEY"],
	},
	groq: {
		codedive: "CODEDIVE_GROQ_API_KEY",
		fallbacks: ["GROQ_API_KEY"],
	},
	xai: {
		codedive: "CODEDIVE_XAI_API_KEY",
		fallbacks: ["XAI_API_KEY"],
	},
	openrouter: {
		codedive: "CODEDIVE_OPENROUTER_API_KEY",
		fallbacks: ["OPENROUTER_API_KEY"],
	},
	mistral: {
		codedive: "CODEDIVE_MISTRAL_API_KEY",
		fallbacks: ["MISTRAL_API_KEY"],
	},
	cerebras: {
		codedive: "CODEDIVE_CEREBRAS_API_KEY",
		fallbacks: ["CEREBRAS_API_KEY"],
	},
	"github-copilot": {
		codedive: "CODEDIVE_GITHUB_TOKEN",
		fallbacks: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
	},
};


