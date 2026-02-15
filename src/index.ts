/**
 * StoryOf — Programmatic API.
 *
 * @example
 * ```typescript
 * import { start, stop, getState } from "storyof";
 *
 * const { url, token } = await start({
 *   cwd: "/path/to/project",
 *   prompt: "how does auth work",
 *   depth: "medium",
 * });
 * console.log(`Open ${url} and paste token: ${token}`);
 * ```
 */

export { start, resume, stop, stopAll, stopExternal, chat, abort, getState } from "./engine.js";
export type { StartOptions, ResumeOptions } from "./engine.js";
export { createAuthStorage } from "./auth.js";
export { CostTracker, type TokenUsage, type CostEntry } from "./cost-tracker.js";
export {
	loadLocalSessions,
	formatSessionLabel,
	saveMeta,
	sessionDir,
	type SessionMeta,
} from "./session-meta.js";
export { renderDocument } from "./renderer.js";
export { validateHtml, extractMermaidBlocks, buildFixPrompt } from "./validation.js";
export {
	APP_NAME,
	APP_CMD,
	APP_VERSION,
	GLOBAL_DIR,
	AUTH_PATH,
	LOCAL_DIR_NAME,
	ENV_VAR_MAP,
} from "./constants.js";
