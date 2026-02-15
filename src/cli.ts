#!/usr/bin/env node
/**
 * StoryOf CLI - Production-grade TypeScript CLI application.
 *
 * Architecture:
 * - commander: Command parsing and routing
 * - services: Business logic (AuthService, CommandHandler)
 * - logger: Structured logging with levels
 * - errors: Type-safe error handling with exit codes
 */

import { Command, Option } from "commander";
import * as readline from "node:readline";
import * as path from "node:path";
import { APP_CMD, APP_VERSION, GLOBAL_DIR } from "./constants.js";
import { CLILogger, LogLevel } from "./cli/logger.js";
import { handleError } from "./cli/errors.js";
import { AuthService } from "./cli/auth-service.js";
import { CommandHandler } from "./cli/commands.js";
import { createAuthStorage } from "./auth.js";
import { BASH_COMPLETION, ZSH_COMPLETION, FISH_COMPLETION } from "./completion.js";
import { loadLocalSessions, formatSessionLabel } from "./session-meta.js";
import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { sortModelsNewestFirst } from "./model-sort.js";

// ── Dynamic completion data (fast path, runs before Commander) ──────
const completionIdx = process.argv.indexOf("--completion-data");
if (completionIdx !== -1) {
	const kind = process.argv[completionIdx + 1];
	try {
		const storage = createAuthStorage();

		if (kind === "models" || kind === "models-zsh") {
			const registry = new ModelRegistry(storage, path.join(GLOBAL_DIR, "models.json"));
			const available = sortModelsNewestFirst(registry.getAvailable());
			if (kind === "models-zsh") {
				for (const m of available) {
					const desc = `${m.name || m.id} (${m.provider})`;
					console.log(`${m.id}:${desc}`);
				}
			} else {
				console.log(available.map((m) => m.id).join("\n"));
			}
		} else if (kind === "sessions" || kind === "sessions-zsh") {
			const sessions = loadLocalSessions(process.cwd());
			if (kind === "sessions-zsh") {
				for (const s of sessions) {
					const label = formatSessionLabel(s).replace(/:/g, "\\:");
					console.log(`${s.id}:${label}`);
				}
			} else {
				for (const s of sessions) {
					console.log(s.id);
				}
			}
		}
	} catch {}
	process.exit(0);
}

// Initialize logger
const logger = new CLILogger({
	level: process.env.DEBUG ? LogLevel.DEBUG : LogLevel.INFO,
});

// Initialize services
const authStorage = createAuthStorage();
const authService = new AuthService(authStorage, logger);
const commandHandler = new CommandHandler(logger);

// Create CLI program
const program = new Command();

program
	.name(APP_CMD)
	.description("Explore any codebase — generate architecture docs with diagrams, then chat about the code")
	.version(APP_VERSION, "-v, --version", "Show version number")
	.addOption(
		new Option("--depth <level>", "Exploration depth")
			.choices(["shallow", "medium", "deep"])
			.default("medium"),
	)
	.option("--path <dir>", "Subdirectory to focus on (repeatable)", (val, prev: string[]) => [...prev, val], [])
	.option("--model <name>", "LLM model to use", "claude-sonnet-4-5")
	.option("--dangerously-allow-edits", "Allow the agent to edit files (disabled by default for safety)")
	.argument("[prompt...]", "Optional topic or question to focus exploration")
	.addHelpText(
		"after",
		`
Enable tab completion:
  ${APP_CMD} completion bash >> ~/.bashrc  # Bash
  ${APP_CMD} completion zsh               # Zsh (save to fpath)
  ${APP_CMD} completion fish              # Fish (save to completions)
`
	)
	.action(async (promptWords: string[], options) => {
		try {
			await commandHandler.handleStart({
				prompt: promptWords.join(" ").trim() || undefined,
				depth: options.depth as "shallow" | "medium" | "deep",
				paths: options.path,
				model: options.model,
				allowEdits: !!options.dangerouslyAllowEdits,
				cwd: process.cwd(),
			});
		} catch (error) {
			handleError(error);
		}
	});

// Resume command
program
	.command("resume")
	.description("Resume a previous session")
	.option("--dangerously-allow-edits", "Allow the agent to edit files (disabled by default for safety)")
	.action(async (options) => {
		try {
			await commandHandler.handleResume(process.cwd(), { allowEdits: !!options.dangerouslyAllowEdits });
		} catch (error) {
			handleError(error);
		}
	});

// Stop command
program
	.command("stop")
	.description("Stop the running agent")
	.action(() => {
		try {
			commandHandler.handleStop(process.cwd());
		} catch (error) {
			handleError(error);
		}
	});

// Auth command group
const auth = program.command("auth").description("Manage API keys and OAuth tokens");

// Auth set
auth
	.command("set <provider> <key>")
	.description("Store an API key")
	.action(async (provider: string, key: string) => {
		try {
			await authService.setApiKey(provider, key);
		} catch (error) {
			handleError(error);
		}
	});

// Auth login
auth
	.command("login <provider>")
	.description("OAuth login (opens browser)")
	.action(async (provider: string) => {
		try {
			await authService.oauthLogin(provider, {
				onAuth: (info: { url: string; instructions?: string }) => {
					logger.newline();
					logger.info("Open this URL in your browser:");
					logger.command(info.url);
					logger.newline();
					if (info.instructions) {
						logger.hint(info.instructions);
						logger.newline();
					}
				},
				onPrompt: (prompt: { message: string; isPassword?: boolean }) => {
					return new Promise((resolve) => {
						const rl = readline.createInterface({
							input: process.stdin,
							output: process.stdout,
						});
						rl.question(prompt.message + " ", (answer) => {
							rl.close();
							resolve(answer);
						});
					});
				},
			});
		} catch (error) {
			handleError(error);
		}
	});

// Auth logout
auth
	.command("logout <provider>")
	.description("Remove stored credentials")
	.action(async (provider: string) => {
		try {
			await authService.removeCredentials(provider);
		} catch (error) {
			handleError(error);
		}
	});

// Auth list
auth
	.command("list")
	.description("Show stored credentials")
	.action(() => {
		try {
			authService.listCredentials();
		} catch (error) {
			handleError(error);
		}
	});

// Completion command
program
	.command("completion <shell>")
	.description("Generate shell completion script")
	.action((shell: string) => {
		const shells: Record<string, string> = {
			bash: BASH_COMPLETION,
			zsh: ZSH_COMPLETION,
			fish: FISH_COMPLETION,
		};

		if (!shells[shell]) {
			logger.error(`Unknown shell: ${shell}`);
			logger.newline();
			logger.section("Supported shells:");
			logger.keyValue("bash", "Bash completion script");
			logger.keyValue("zsh", "Zsh completion script");
			logger.keyValue("fish", "Fish completion script");
			logger.newline();
			logger.section("Installation:");
			logger.newline();
			logger.hint("# Bash");
			logger.command(`${APP_CMD} completion bash >> ~/.bashrc`);
			logger.newline();
			logger.hint("# Zsh");
			logger.command(`${APP_CMD} completion zsh > ~/.zsh/completions/_${APP_CMD}`);
			logger.newline();
			logger.hint("# Fish");
			logger.command(`${APP_CMD} completion fish > ~/.config/fish/completions/${APP_CMD}.fish`);
			logger.newline();
			process.exit(1);
		}

		console.log(shells[shell]);
	});

// Parse and execute
program.parse();
