/**
 * CodeDive — Authentication management.
 *
 * Wraps AuthStorage from pi-coding-agent but uses ~/.codedive/auth.json
 * and adds CODEDIVE_ env var support.
 */

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { AUTH_PATH, ENV_VAR_MAP } from "./constants.js";

/**
 * Create an AuthStorage instance pointing to ~/.codedive/auth.json.
 * Also registers a fallback resolver for CODEDIVE_ env vars.
 */
export function createAuthStorage(): AuthStorage {
	const authStorage = new AuthStorage(AUTH_PATH);

	// Register fallback resolver for CODEDIVE_ prefixed env vars
	authStorage.setFallbackResolver((provider: string) => {
		const mapping = ENV_VAR_MAP[provider];
		if (!mapping) return undefined;

		// Check CODEDIVE_ prefixed var first
		const codediveVal = process.env[mapping.codedive];
		if (codediveVal) return codediveVal;

		// Then check standard env vars
		for (const fallback of mapping.fallbacks) {
			const val = process.env[fallback];
			if (val) return val;
		}
		return undefined;
	});

	return authStorage;
}
