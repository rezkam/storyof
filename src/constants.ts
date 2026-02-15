/**
 * StoryOf — constants and shared configuration.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── Branding ──────────────────────────────────────────────────────────
export const APP_NAME = "StoryOf";
export const APP_CMD = "storyof";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
export const APP_VERSION: string = pkg.version;

// ── Directories ───────────────────────────────────────────────────────
/** Global config: ~/.storyof/ */
export const GLOBAL_DIR = join(homedir(), ".storyof");
/** Global auth file */
export const AUTH_PATH = join(GLOBAL_DIR, "auth.json");
/** Global settings file */
export const GLOBAL_SETTINGS_PATH = join(GLOBAL_DIR, "settings.json");
/** Global skills directory */
export const GLOBAL_SKILLS_DIR = join(GLOBAL_DIR, "skills");
/** Global sessions base directory */
export const GLOBAL_SESSIONS_DIR = join(GLOBAL_DIR, "sessions");

/** Project-local directory name */
export const LOCAL_DIR_NAME = ".storyof";

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
 * StoryOf environment variables (STORYOF_ prefix) with fallbacks
 * to standard provider env vars.
 */
export const ENV_VAR_MAP: Record<string, { storyof: string; fallbacks: string[] }> = {
	anthropic: {
		storyof: "STORYOF_ANTHROPIC_API_KEY",
		fallbacks: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
	},
	openai: {
		storyof: "STORYOF_OPENAI_API_KEY",
		fallbacks: ["OPENAI_API_KEY"],
	},
	google: {
		storyof: "STORYOF_GEMINI_API_KEY",
		fallbacks: ["GEMINI_API_KEY"],
	},
	groq: {
		storyof: "STORYOF_GROQ_API_KEY",
		fallbacks: ["GROQ_API_KEY"],
	},
	xai: {
		storyof: "STORYOF_XAI_API_KEY",
		fallbacks: ["XAI_API_KEY"],
	},
	openrouter: {
		storyof: "STORYOF_OPENROUTER_API_KEY",
		fallbacks: ["OPENROUTER_API_KEY"],
	},
	mistral: {
		storyof: "STORYOF_MISTRAL_API_KEY",
		fallbacks: ["MISTRAL_API_KEY"],
	},
	cerebras: {
		storyof: "STORYOF_CEREBRAS_API_KEY",
		fallbacks: ["CEREBRAS_API_KEY"],
	},
	"github-copilot": {
		storyof: "STORYOF_GITHUB_TOKEN",
		fallbacks: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
	},
};


