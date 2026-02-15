/**
 * StoryOf — Authentication management.
 *
 * Wraps AuthStorage from pi-coding-agent but uses ~/.storyof/auth.json
 * and adds STORYOF_ env var support.
 */

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { AUTH_PATH, ENV_VAR_MAP } from "./constants.js";

/**
 * Create an AuthStorage instance pointing to ~/.storyof/auth.json.
 * Also registers a fallback resolver for STORYOF_ env vars.
 */
export function createAuthStorage(): AuthStorage {
	const authStorage = new AuthStorage(AUTH_PATH);

	// Register fallback resolver for STORYOF_ prefixed env vars
	authStorage.setFallbackResolver((provider: string) => {
		const mapping = ENV_VAR_MAP[provider];
		if (!mapping) return undefined;

		// Check STORYOF_ prefixed var first
		const storyofVal = process.env[mapping.storyof];
		if (storyofVal) return storyofVal;

		// Then check standard env vars
		for (const fallback of mapping.fallbacks) {
			const val = process.env[fallback];
			if (val) return val;
		}
		return undefined;
	});

	return authStorage;
}
