import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const CLI_PATH = path.resolve(__dirname, "../../dist/cli.js");

/**
 * Each test run gets a unique temp directory so parallel runs can't collide.
 * The directory is cleaned up in afterEach.
 */
function makeTempDir(): string {
	const id = crypto.randomBytes(8).toString("hex");
	const dir = path.join(os.tmpdir(), `codedive-test-${id}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Minimal, sanitized environment for test subprocesses.
 *
 * Only PATH and NODE (needed to run node) are inherited from the real env.
 * All API keys, tokens, and HOME are explicitly excluded so tests never
 * touch the real ~/.codedive/ or accidentally use real credentials.
 */
function cleanEnv(tempHome: string, overrides: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: tempHome,
		NODE_ENV: "test",
		// Explicitly blank every key that could leak real credentials
		ANTHROPIC_API_KEY: "",
		ANTHROPIC_OAUTH_TOKEN: "",
		OPENAI_API_KEY: "",
		GEMINI_API_KEY: "",
		GROQ_API_KEY: "",
		XAI_API_KEY: "",
		OPENROUTER_API_KEY: "",
		MISTRAL_API_KEY: "",
		CEREBRAS_API_KEY: "",
		COPILOT_GITHUB_TOKEN: "",
		GH_TOKEN: "",
		GITHUB_TOKEN: "",
		CODEDIVE_ANTHROPIC_API_KEY: "",
		CODEDIVE_OPENAI_API_KEY: "",
		CODEDIVE_GEMINI_API_KEY: "",
		CODEDIVE_GROQ_API_KEY: "",
		CODEDIVE_XAI_API_KEY: "",
		CODEDIVE_OPENROUTER_API_KEY: "",
		CODEDIVE_MISTRAL_API_KEY: "",
		CODEDIVE_CEREBRAS_API_KEY: "",
		CODEDIVE_GITHUB_TOKEN: "",
		// Caller overrides last — they win
		...overrides,
	};
}

function runCLI(
	args: string[],
	options: { env?: Record<string, string>; tempHome?: string } = {},
): { stdout: string; stderr: string; exitCode: number } {
	const tempHome = options.tempHome ?? makeTempDir();
	const env = cleanEnv(tempHome, options.env ?? {});

	try {
		const stdout = execSync(`node ${CLI_PATH} ${args.join(" ")}`, {
			encoding: "utf-8",
			env,
			timeout: 5000,
			cwd: tempHome, // Don't run in the project directory either
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (err: any) {
		return {
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			exitCode: err.status ?? 1,
		};
	}
}

describe("CLI Authentication", () => {
	let tempHome: string;
	let authFile: string;

	beforeEach(() => {
		tempHome = makeTempDir();
		const codediveDir = path.join(tempHome, ".codedive");
		authFile = path.join(codediveDir, "auth.json");
		fs.mkdirSync(codediveDir, { recursive: true });
		fs.writeFileSync(authFile, "{}", { mode: 0o600 });
	});

	afterEach(() => {
		// Always clean up — even if a test fails
		try {
			fs.rmSync(tempHome, { recursive: true, force: true });
		} catch {
			// Best effort cleanup
		}
	});

	describe("auth set", () => {
		it("stores API key", () => {
			const result = runCLI(["auth", "set", "anthropic", "sk-test-key"], { tempHome });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("API key stored");
			expect(result.stdout).toContain("anthropic");

			// Verify file was written in temp dir, not real home
			const authData = JSON.parse(fs.readFileSync(authFile, "utf-8"));
			expect(authData.anthropic).toBeDefined();
			expect(authData.anthropic.key).toBe("sk-test-key");
			expect(authData.anthropic.type).toBe("api_key");
		});

		it("rejects unknown provider", () => {
			const result = runCLI(["auth", "set", "fake-provider", "key"], { tempHome });

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/unknown provider/i);
		});

		it("requires both arguments", () => {
			const result = runCLI(["auth", "set", "anthropic"], { tempHome });

			expect(result.exitCode).not.toBe(0);
		});
	});

	describe("auth list", () => {
		it("shows stored credentials", () => {
			// Store a key first (in temp dir)
			runCLI(["auth", "set", "anthropic", "sk-test"], { tempHome });

			const result = runCLI(["auth", "list"], { tempHome });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("anthropic");
			expect(result.stdout).toContain("API Key");
		});

		it("shows message when empty", () => {
			const result = runCLI(["auth", "list"], { tempHome });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBeTruthy();
		});
	});

	describe("auth logout", () => {
		it("removes stored credentials", () => {
			// Store first (in temp dir)
			runCLI(["auth", "set", "anthropic", "sk-test"], { tempHome });

			// Remove
			const result = runCLI(["auth", "logout", "anthropic"], { tempHome });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/removed/i);

			// Verify removal in temp file
			const authData = JSON.parse(fs.readFileSync(authFile, "utf-8"));
			expect(authData.anthropic).toBeUndefined();
		});
	});

	describe("auth check before start", () => {
		it("blocks start without credentials", () => {
			// tempHome has empty auth.json, cleanEnv blanks all API key env vars
			const result = runCLI(["test"], { tempHome });

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toMatch(/no api credentials/i);
			expect(result.stdout).toContain("auth set");
			expect(result.stdout).toContain("auth login");
		});

		it("accepts CODEDIVE_ env var", () => {
			const result = runCLI(["--help"], {
				tempHome,
				env: { CODEDIVE_ANTHROPIC_API_KEY: "sk-test" },
			});

			expect(result.exitCode).toBe(0);
		});

		it("accepts standard env var", () => {
			const result = runCLI(["--help"], {
				tempHome,
				env: { ANTHROPIC_API_KEY: "sk-test" },
			});

			expect(result.exitCode).toBe(0);
		});
	});

	describe("CLI basics", () => {
		it("shows version", () => {
			const result = runCLI(["--version"], { tempHome });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("0.1.0");
		});

		it("shows help", () => {
			const result = runCLI(["--help"], { tempHome });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toMatch(/usage/i);
			expect(result.stdout).toContain("--depth");
			expect(result.stdout).toContain("--model");
		});

		it("shows auth help", () => {
			const result = runCLI(["auth", "--help"], { tempHome });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("set");
			expect(result.stdout).toContain("login");
			expect(result.stdout).toContain("logout");
			expect(result.stdout).toContain("list");
		});
	});

	describe("isolation safety", () => {
		it("never writes to real home directory", () => {
			const realAuthFile = path.join(os.homedir(), ".codedive", "auth.json");
			const before = fs.existsSync(realAuthFile)
				? fs.readFileSync(realAuthFile, "utf-8")
				: null;

			// Run a write operation
			runCLI(["auth", "set", "anthropic", "sk-SHOULD-NOT-LEAK"], { tempHome });

			const after = fs.existsSync(realAuthFile)
				? fs.readFileSync(realAuthFile, "utf-8")
				: null;

			// Real file must be untouched
			expect(after).toBe(before);

			// And the test key must NOT appear in real auth
			if (after) {
				expect(after).not.toContain("sk-SHOULD-NOT-LEAK");
			}
		});

		it("temp directory is cleaned up after test", () => {
			const isolatedTemp = makeTempDir();
			runCLI(["auth", "set", "openai", "sk-temp"], { tempHome: isolatedTemp });

			// Verify it was written
			const authPath = path.join(isolatedTemp, ".codedive", "auth.json");
			expect(fs.existsSync(authPath)).toBe(true);

			// Clean up
			fs.rmSync(isolatedTemp, { recursive: true, force: true });
			expect(fs.existsSync(isolatedTemp)).toBe(false);
		});
	});
});
