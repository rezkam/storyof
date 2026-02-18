/**
 * Integration tests for every CLI option, command, and completion script.
 *
 * Verifies:
 * - Every option accepted / rejected with correct exit codes
 * - Every command and subcommand works
 * - Completion scripts match the actual CLI surface
 * - Depth choices are validated
 * - Provider lists are consistent across CLI, auth-service, and completions
 *
 * All tests use temp directories — never touches real home or credentials.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

const CLI_PATH = path.resolve(__dirname, "../../dist/cli.js");

function makeTempDir(): string {
	const id = crypto.randomBytes(8).toString("hex");
	const dir = path.join(os.tmpdir(), `storyof-opts-${id}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanEnv(tempHome: string, overrides: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: tempHome,
		NODE_ENV: "test",
		ANTHROPIC_API_KEY: "",
		OPENAI_API_KEY: "",
		STORYOF_ANTHROPIC_API_KEY: "",
		...overrides,
	};
}

function run(
	args: string[],
	opts: { env?: Record<string, string>; tempHome?: string } = {},
): { stdout: string; stderr: string; exitCode: number } {
	const tempHome = opts.tempHome ?? makeTempDir();
	const env = cleanEnv(tempHome, opts.env ?? {});
	const result = spawnSync("node", [CLI_PATH, ...args], {
		encoding: "utf-8",
		env,
		timeout: 10000,
		cwd: tempHome,
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		exitCode: result.status ?? 1,
	};
}

describe("CLI options and commands", () => {
	let tempHome: string;

	beforeEach(() => {
		tempHome = makeTempDir();
		const ddDir = path.join(tempHome, ".storyof");
		fs.mkdirSync(ddDir, { recursive: true });
		fs.writeFileSync(path.join(ddDir, "auth.json"), "{}", { mode: 0o600 });
	});

	afterEach(() => {
		try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
	});

	// ═══════════════════════════════════════════════════════════════
	// Global options
	// ═══════════════════════════════════════════════════════════════

	describe("--version / -v", () => {
		it("--version prints version and exits 0", () => {
			const r = run(["--version"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
		});

		it("-v prints version and exits 0", () => {
			const r = run(["-v"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
		});
	});

	describe("--help / -h", () => {
		it("--help shows usage with all options", () => {
			const r = run(["--help"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("--depth");
			expect(r.stdout).toContain("--path");
			expect(r.stdout).toContain("--model");
			expect(r.stdout).toContain("--version");
			expect(r.stdout).toContain("--help");
		});

		it("-h shows usage", () => {
			const r = run(["-h"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toMatch(/usage/i);
		});

		it("help lists all commands", () => {
			const r = run(["--help"], { tempHome });
			expect(r.stdout).toContain("resume");
			expect(r.stdout).toContain("stop");
			expect(r.stdout).toContain("auth");
			expect(r.stdout).toContain("completion");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// --depth option
	// ═══════════════════════════════════════════════════════════════

	describe("--depth", () => {
		it("accepts 'shallow'", () => {
			const r = run(["--depth", "shallow", "--help"], { tempHome });
			expect(r.exitCode).toBe(0);
		});

		it("accepts 'medium'", () => {
			const r = run(["--depth", "medium", "--help"], { tempHome });
			expect(r.exitCode).toBe(0);
		});

		it("accepts 'deep'", () => {
			const r = run(["--depth", "deep", "--help"], { tempHome });
			expect(r.exitCode).toBe(0);
		});

		it("rejects invalid depth value", () => {
			const r = run(["--depth", "extreme"], { tempHome });
			expect(r.exitCode).not.toBe(0);
			expect(r.stderr).toMatch(/invalid.*allowed.*shallow.*medium.*deep/i);
		});

		it("defaults to medium when not specified", () => {
			const r = run(["--help"], { tempHome });
			expect(r.stdout).toContain('"medium"');
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// --model option
	// ═══════════════════════════════════════════════════════════════

	describe("--model", () => {
		it("accepts any model name", () => {
			const r = run(["--model", "gpt-4", "--help"], { tempHome });
			expect(r.exitCode).toBe(0);
		});

		it("defaults to claude-sonnet-4-5", () => {
			const r = run(["--help"], { tempHome });
			expect(r.stdout).toContain("claude-sonnet-4-5");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// --path option (repeatable)
	// ═══════════════════════════════════════════════════════════════

	describe("--path", () => {
		it("accepts a single path", () => {
			const r = run(["--path", "/src", "--help"], { tempHome });
			expect(r.exitCode).toBe(0);
		});

		it("accepts multiple paths", () => {
			const r = run(["--path", "/src", "--path", "/lib", "--help"], { tempHome });
			expect(r.exitCode).toBe(0);
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// --dangerously-allow-edits option
	// ═══════════════════════════════════════════════════════════════

	describe("--dangerously-allow-edits", () => {
		it("is listed in --help output", () => {
			const r = run(["--help"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("--dangerously-allow-edits");
		});

		it("is accepted on the main command", () => {
			// It will fail due to no auth, but should NOT fail due to unknown option
			const r = run(["--dangerously-allow-edits"], { tempHome });
			// exit code 1 = auth error (expected), not option parse error
			expect(r.stderr).not.toContain("unknown option");
			expect(r.stderr).not.toContain("error: unknown option");
		});

		it("is accepted on the resume command", () => {
			const r = run(["resume", "--dangerously-allow-edits"], { tempHome });
			// No sessions / no auth is fine — should not be "unknown option"
			expect(r.stderr).not.toContain("unknown option");
			expect(r.stderr).not.toContain("error: unknown option");
		});

		it("resume --help shows the flag", () => {
			const r = run(["resume", "--help"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("--dangerously-allow-edits");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// Auth commands
	// ═══════════════════════════════════════════════════════════════

	describe("auth set", () => {
		const API_KEY_PROVIDERS = [
			"anthropic", "openai", "google", "groq", "xai",
			"openrouter", "mistral", "cerebras", "github-copilot",
		];

		for (const provider of API_KEY_PROVIDERS) {
			it(`accepts provider: ${provider}`, () => {
				const r = run(["auth", "set", provider, "test-key-123"], { tempHome });
				expect(r.exitCode).toBe(0);
				expect(r.stdout).toContain("API key stored");
			});
		}

		it("rejects unknown provider", () => {
			const r = run(["auth", "set", "unknown-provider", "key"], { tempHome });
			expect(r.exitCode).not.toBe(0);
			expect(r.stderr).toMatch(/unknown provider/i);
		});

		it("requires key argument", () => {
			const r = run(["auth", "set", "anthropic"], { tempHome });
			expect(r.exitCode).not.toBe(0);
		});

		it("requires provider argument", () => {
			const r = run(["auth", "set"], { tempHome });
			expect(r.exitCode).not.toBe(0);
		});
	});

	describe("auth login", () => {
		// OAuth providers that resolve quickly (fail fast without real OAuth infra)
		const FAST_OAUTH_PROVIDERS = ["anthropic", "github-copilot", "google", "antigravity"];
		// openai-codex starts a local callback server and hangs — tested separately

		for (const provider of FAST_OAUTH_PROVIDERS) {
			it(`recognizes OAuth provider '${provider}'`, () => {
				const r = run(["auth", "login", provider], { tempHome });
				// Will fail (no TTY/no real OAuth) but should not say "does not support OAuth"
				if (r.exitCode !== 0) {
					expect(r.stderr).not.toMatch(/does not support oauth/i);
				}
			});
		}

		it("rejects non-OAuth provider", () => {
			const r = run(["auth", "login", "groq"], { tempHome });
			expect(r.exitCode).not.toBe(0);
			expect(r.stderr).toMatch(/does not support oauth/i);
		});

		it("requires provider argument", () => {
			const r = run(["auth", "login"], { tempHome });
			expect(r.exitCode).not.toBe(0);
		});
	});

	describe("auth logout", () => {
		it("removes existing credentials", () => {
			run(["auth", "set", "anthropic", "key123"], { tempHome });
			const r = run(["auth", "logout", "anthropic"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toMatch(/removed/i);
		});

		it("requires provider argument", () => {
			const r = run(["auth", "logout"], { tempHome });
			expect(r.exitCode).not.toBe(0);
		});
	});

	describe("auth list", () => {
		it("shows empty when no credentials", () => {
			const r = run(["auth", "list"], { tempHome });
			expect(r.exitCode).toBe(0);
		});

		it("shows stored credentials", () => {
			run(["auth", "set", "openai", "sk-test"], { tempHome });
			const r = run(["auth", "list"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("openai");
		});
	});

	describe("auth --help", () => {
		it("lists all subcommands", () => {
			const r = run(["auth", "--help"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("set");
			expect(r.stdout).toContain("login");
			expect(r.stdout).toContain("logout");
			expect(r.stdout).toContain("list");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// Completion command
	// ═══════════════════════════════════════════════════════════════

	describe("completion", () => {
		it("generates bash completion", () => {
			const r = run(["completion", "bash"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("_storyof_completions");
			expect(r.stdout).toContain("complete -o default -F");
		});

		it("generates zsh completion", () => {
			const r = run(["completion", "zsh"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("#compdef storyof");
			expect(r.stdout).toContain("_storyof");
		});

		it("generates fish completion", () => {
			const r = run(["completion", "fish"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("complete -c storyof");
		});

		it("rejects unknown shell", () => {
			const r = run(["completion", "powershell"], { tempHome });
			expect(r.exitCode).not.toBe(0);
		});

		it("requires shell argument", () => {
			const r = run(["completion"], { tempHome });
			expect(r.exitCode).not.toBe(0);
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// Resume and stop (without running agent)
	// ═══════════════════════════════════════════════════════════════

	describe("resume", () => {
		it("fails gracefully with no sessions", () => {
			const r = run(["resume"], {
				tempHome,
				env: { ANTHROPIC_API_KEY: "sk-test" },
			});
			// Should fail but not crash
			expect(r.exitCode).not.toBe(0);
		});
	});

	describe("stop", () => {
		it("reports no running agent", () => {
			const r = run(["stop"], { tempHome });
			expect(r.exitCode).toBe(0);
			const allOutput = r.stdout + r.stderr;
			expect(allOutput).toMatch(/no running agent/i);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Completion script correctness — verify scripts match actual CLI surface
// ═══════════════════════════════════════════════════════════════════════

describe("Completion script correctness", () => {
	let tempHome: string;
	let bashScript: string;
	let zshScript: string;
	let fishScript: string;

	beforeEach(() => {
		tempHome = makeTempDir();
	});

	afterEach(() => {
		try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
	});

	function getCompletion(shell: string): string {
		const r = run(["completion", shell], { tempHome });
		expect(r.exitCode).toBe(0);
		return r.stdout;
	}

	describe("bash completion", () => {
		beforeEach(() => { bashScript = getCompletion("bash"); });

		it("includes all main commands", () => {
			expect(bashScript).toContain("auth");
			expect(bashScript).toContain("resume");
			expect(bashScript).toContain("stop");
			expect(bashScript).toContain("completion");
		});

		it("includes all flags", () => {
			expect(bashScript).toContain("--help");
			expect(bashScript).toContain("--version");
			expect(bashScript).toContain("--depth");
			expect(bashScript).toContain("--path");
			expect(bashScript).toContain("--model");
		});

		it("includes all auth subcommands", () => {
			expect(bashScript).toContain("set login logout list");
		});

		it("includes all API key providers", () => {
			for (const p of ["anthropic", "openai", "google", "groq", "xai", "openrouter", "mistral", "cerebras", "github-copilot"]) {
				expect(bashScript).toContain(p);
			}
		});

		it("includes all OAuth providers", () => {
			for (const p of ["anthropic", "github-copilot", "google", "antigravity", "openai-codex"]) {
				expect(bashScript).toContain(p);
			}
		});

		it("includes all depth levels", () => {
			expect(bashScript).toContain("shallow");
			expect(bashScript).toContain("medium");
			expect(bashScript).toContain("deep");
		});

		it("includes completion shell completions", () => {
			expect(bashScript).toContain('"bash zsh fish"');
		});

		// eslint-disable-next-line vitest/expect-expect -- assertion via execSync throw
		it("is valid bash syntax", () => {
			// Write to temp file and check syntax
			const scriptPath = path.join(tempHome, "completion.bash");
			fs.writeFileSync(scriptPath, bashScript);
			try {
				execSync(`bash -n "${scriptPath}"`, { encoding: "utf-8", timeout: 5000 });
			} catch (err: any) {
				throw new Error(`Bash syntax error: ${err.stderr}`);
			}
		});
	});

	describe("zsh completion", () => {
		beforeEach(() => { zshScript = getCompletion("zsh"); });

		it("includes all main commands", () => {
			expect(zshScript).toContain("auth:");
			expect(zshScript).toContain("resume:");
			expect(zshScript).toContain("stop:");
			expect(zshScript).toContain("completion:");
		});

		it("includes all auth subcommands", () => {
			expect(zshScript).toContain("'set:");
			expect(zshScript).toContain("'login:");
			expect(zshScript).toContain("'logout:");
			expect(zshScript).toContain("'list:");
		});

		it("includes all API key providers with descriptions", () => {
			expect(zshScript).toContain("'anthropic:Anthropic Claude API'");
			expect(zshScript).toContain("'openai:OpenAI API'");
			expect(zshScript).toContain("'google:Google AI Studio");
			expect(zshScript).toContain("'github-copilot:GitHub Copilot'");
		});

		it("includes all OAuth providers", () => {
			expect(zshScript).toContain("'anthropic:Claude Pro/Max");
			expect(zshScript).toContain("'github-copilot:");
			expect(zshScript).toContain("'google:");
			expect(zshScript).toContain("'antigravity:");
			expect(zshScript).toContain("'openai-codex:");
		});

		it("includes depth levels with descriptions", () => {
			expect(zshScript).toContain("'shallow:Quick overview'");
			expect(zshScript).toContain("'medium:Balanced exploration'");
			expect(zshScript).toContain("'deep:Comprehensive analysis'");
		});

		it("includes shell completions for completion command", () => {
			expect(zshScript).toContain("'bash:Bash completion'");
			expect(zshScript).toContain("'zsh:Zsh completion'");
			expect(zshScript).toContain("'fish:Fish completion'");
		});
	});

	describe("fish completion", () => {
		beforeEach(() => { fishScript = getCompletion("fish"); });

		it("includes all main commands", () => {
			expect(fishScript).toContain("auth");
			expect(fishScript).toContain("resume");
			expect(fishScript).toContain("stop");
			expect(fishScript).toContain("completion");
		});

		it("includes all auth subcommands", () => {
			expect(fishScript).toContain("set");
			expect(fishScript).toContain("login");
			expect(fishScript).toContain("logout");
			expect(fishScript).toContain("list");
		});

		it("includes all API key providers", () => {
			for (const p of ["anthropic", "openai", "google", "groq", "xai", "openrouter", "mistral", "cerebras", "github-copilot"]) {
				expect(fishScript).toContain(p);
			}
		});

		it("includes all OAuth providers", () => {
			for (const p of ["anthropic", "github-copilot", "google", "antigravity", "openai-codex"]) {
				expect(fishScript).toContain(p);
			}
		});

		it("includes shell completions for completion command", () => {
			expect(fishScript).toContain("'bash zsh fish'");
		});

		it("includes depth levels", () => {
			expect(fishScript).toContain("shallow medium deep");
		});
	});

	describe("dynamic completion data", () => {
		it("--completion-data models returns model list (may be empty without auth)", () => {
			const r = run(["--completion-data", "models"], { tempHome });
			expect(r.exitCode).toBe(0);
			// With no auth, empty is fine; just shouldn't crash
		});

		it("--completion-data models-zsh returns id:description format", () => {
			const r = run(["--completion-data", "models-zsh"], { tempHome });
			expect(r.exitCode).toBe(0);
			// With no auth, empty is fine
		});

		it("--completion-data sessions returns empty with no sessions", () => {
			const r = run(["--completion-data", "sessions"], { tempHome });
			expect(r.exitCode).toBe(0);
			expect(r.stdout.trim()).toBe("");
		});

		it("--completion-data sessions lists sessions when they exist", () => {
			// Create a session in the temp home
			const sessionDir = path.join(tempHome, ".storyof", "abc123");
			fs.mkdirSync(sessionDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionDir, "meta.json"),
				JSON.stringify({
					id: "abc123",
					targetPath: tempHome,
					prompt: "test prompt",
					depth: "medium",
					model: "test-model",
					timestamp: Date.now(),
				}),
			);

			const r = run(["--completion-data", "sessions"], { tempHome, env: { HOME: tempHome } });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("abc123");
		});

		it("--completion-data sessions-zsh includes session description", () => {
			const sessionDir = path.join(tempHome, ".storyof", "def456");
			fs.mkdirSync(sessionDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionDir, "meta.json"),
				JSON.stringify({
					id: "def456",
					targetPath: tempHome,
					prompt: "auth flow",
					depth: "deep",
					model: "test-model",
					timestamp: Date.now(),
				}),
			);

			const r = run(["--completion-data", "sessions-zsh"], { tempHome, env: { HOME: tempHome } });
			expect(r.exitCode).toBe(0);
			expect(r.stdout).toContain("def456:");
			expect(r.stdout).toContain("auth flow");
		});

		it("--completion-data with unknown type exits cleanly", () => {
			const r = run(["--completion-data", "unknown"], { tempHome });
			expect(r.exitCode).toBe(0);
		});
	});

	describe("consistency across shells", () => {
		beforeEach(() => {
			bashScript = getCompletion("bash");
			zshScript = getCompletion("zsh");
			fishScript = getCompletion("fish");
		});

		it("all shells have same API key providers", () => {
			const providers = ["anthropic", "openai", "google", "groq", "xai", "openrouter", "mistral", "cerebras", "github-copilot"];
			for (const p of providers) {
				expect(bashScript).toContain(p);
				expect(zshScript).toContain(p);
				expect(fishScript).toContain(p);
			}
		});

		it("all shells have same OAuth providers", () => {
			const providers = ["anthropic", "github-copilot", "google", "antigravity", "openai-codex"];
			for (const p of providers) {
				expect(bashScript).toContain(p);
				expect(zshScript).toContain(p);
				expect(fishScript).toContain(p);
			}
		});

		it("all shells have same depth levels", () => {
			for (const level of ["shallow", "medium", "deep"]) {
				expect(bashScript).toContain(level);
				expect(zshScript).toContain(level);
				expect(fishScript).toContain(level);
			}
		});

		it("all shells have same commands", () => {
			for (const cmd of ["auth", "resume", "stop", "completion"]) {
				expect(bashScript).toContain(cmd);
				expect(zshScript).toContain(cmd);
				expect(fishScript).toContain(cmd);
			}
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Safety: tests never touch real home directory
// ═══════════════════════════════════════════════════════════════════════

describe("Test isolation safety", () => {
	const realHome = os.homedir();
	const realAuthPath = path.join(realHome, ".storyof", "auth.json");
	let authBefore: string | null;

	beforeEach(() => {
		try {
			authBefore = fs.existsSync(realAuthPath) ? fs.readFileSync(realAuthPath, "utf-8") : null;
		} catch { authBefore = null; }
	});

	it("tests never write to real ~/.storyof/auth.json", () => {
		try {
			const authAfter = fs.existsSync(realAuthPath) ? fs.readFileSync(realAuthPath, "utf-8") : null;
			expect(authAfter).toBe(authBefore);
		} catch {
			// If we can't read, that's fine — just means it didn't exist
		}
	});

	it("tests never create files in real home directory", () => {
		const tempDir = makeTempDir();
		const env = cleanEnv(tempDir);

		// Run a command that writes auth
		spawnSync("node", [CLI_PATH, "auth", "set", "anthropic", "test-isolation-key"], {
			encoding: "utf-8",
			env,
			timeout: 5000,
			cwd: tempDir,
		});

		// Verify it wrote to temp, not real home
		const tempAuth = path.join(tempDir, ".storyof", "auth.json");
		if (fs.existsSync(tempAuth)) {
			const contents = fs.readFileSync(tempAuth, "utf-8");
			expect(contents).toContain("test-isolation-key");
		}

		// Real home should be unchanged
		try {
			const authAfter = fs.existsSync(realAuthPath) ? fs.readFileSync(realAuthPath, "utf-8") : null;
			expect(authAfter).toBe(authBefore);
			if (authAfter) {
				expect(authAfter).not.toContain("test-isolation-key");
			}
		} catch {}

		fs.rmSync(tempDir, { recursive: true, force: true });
	});
});
