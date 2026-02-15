/**
 * Authentication checking logic.
 * Separated from CLI for better testability.
 */

import { ENV_VAR_MAP } from "./constants.js";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";

export interface AuthCheckResult {
	hasAuth: boolean;
	provider?: string;
	source?: "storage" | "env";
}

export function checkAuth(storage: AuthStorage): AuthCheckResult {
	// Check if any provider has credentials in auth storage
	const providers = [
		"anthropic",
		"openai",
		"google",
		"groq",
		"xai",
		"openrouter",
		"mistral",
		"cerebras",
		"github-copilot",
	];

	for (const provider of providers) {
		const cred = storage.get(provider);
		if (cred) {
			return { hasAuth: true, provider, source: "storage" };
		}
	}

	// Check environment variables
	for (const [provider, envVars] of Object.entries(ENV_VAR_MAP)) {
		// Check CODEDIVE_ prefixed vars first
		if (process.env[envVars.codedive]) {
			return { hasAuth: true, provider, source: "env" };
		}
		// Check fallback env vars
		for (const fallback of envVars.fallbacks) {
			if (process.env[fallback]) {
				return { hasAuth: true, provider, source: "env" };
			}
		}
	}

	return { hasAuth: false };
}
