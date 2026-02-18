/**
 * Command handlers with proper error handling and validation.
 */

import * as readline from "node:readline";
import { CLILogger } from "./logger.js";
import { Spinner } from "./spinner.js";
import { AuthenticationError, NotFoundError, ValidationError } from "./errors.js";
import { checkAuth } from "../auth-check.js";
import { createAuthStorage } from "../auth.js";
import { start, resume, stopExternal, getState } from "../engine.js";
import { loadLocalSessions, formatSessionLabel } from "../session-meta.js";
import { APP_CMD } from "../constants.js";
import { CostTracker } from "../cost-tracker.js";

export interface StartOptions {
	prompt?: string;
	depth: "shallow" | "medium" | "deep";
	paths: string[];
	model: string;
	cwd: string;
}

export class CommandHandler {
	constructor(private readonly logger: CLILogger) {}

	async handleStart(options: StartOptions): Promise<void> {
		const storage = createAuthStorage();
		const authCheck = checkAuth(storage);

		if (!authCheck.hasAuth) {
			this.showAuthInstructions();
			throw new AuthenticationError("No API credentials found");
		}

		this.logger.debug(
			`Starting with auth from ${authCheck.source}: ${authCheck.provider}`,
		);

		const spinner = new Spinner();
		spinner.start();

		try {
			// Wait for both: (1) server started, (2) agent confirmed running
			const { url, token } = await new Promise<{ url: string; token: string }>(
				(resolve, reject) => {
					let serverResult: { url: string; token: string } | null = null;
					let agentReady = false;
					let settled = false;

					const tryResolve = () => {
						if (settled) return;
						if (serverResult && agentReady) {
							settled = true;
							clearTimeout(timeout);
							spinner.stop("Agent is running");
							resolve(serverResult);
						}
					};

					const timeout = setTimeout(() => {
						if (settled) return;
						settled = true;
						spinner.stop();
						reject(new Error("Agent failed to start within 60 seconds"));
					}, 60_000);

					start({
						cwd: options.cwd,
						prompt: options.prompt,
						depth: options.depth,
						scope: options.paths.length > 0 ? options.paths.join(",") : undefined,
						model: options.model,
						onReady: () => {
							agentReady = true;
							tryResolve();
						},
					})
						.then((result) => {
							serverResult = result;
							spinner.phase("Waiting for agent...");
							tryResolve();
						})
						.catch((err) => {
							if (settled) return;
							settled = true;
							clearTimeout(timeout);
							spinner.stop();
							reject(err);
						});
				},
			);

			this.showConnectionInfo(url, token, options);
		} catch (error) {
			spinner.stop();
			throw error;
		}

		await this.waitForShutdown();
	}

	async handleResume(cwd: string): Promise<void> {
		const storage = createAuthStorage();
		const authCheck = checkAuth(storage);

		if (!authCheck.hasAuth) {
			this.showAuthInstructions();
			throw new AuthenticationError("No API credentials found");
		}

		const sessions = loadLocalSessions(cwd);

		if (sessions.length === 0) {
			this.logger.warn("No sessions found in this directory.");
			this.logger.hint(`Run '${APP_CMD}' to start a new exploration.`);
			this.logger.newline();
			throw new NotFoundError("No sessions found");
		}

		let selectedSession;

		if (sessions.length === 1) {
			selectedSession = sessions[0];
		} else {
			this.logger.section("Resume which session?");
			this.logger.newline();
			sessions.forEach((s, i) => {
				const label = formatSessionLabel(s);
				this.logger.info(`  ${i + 1}) ${label}`);
			});
			this.logger.newline();

			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});

			const answer = await new Promise<string>((resolve) => {
				rl.question(`  Select (1-${sessions.length}): `, resolve);
			});
			rl.close();

			const choice = parseInt(answer.trim(), 10);
			if (isNaN(choice) || choice < 1 || choice > sessions.length) {
				this.logger.error("Invalid selection");
				this.logger.newline();
				throw new ValidationError("Invalid session selection");
			}

			selectedSession = sessions[choice - 1];
		}

		const spinner = new Spinner();
		spinner.start();

		try {
			const { url, token } = await new Promise<{ url: string; token: string }>(
				(resolve, reject) => {
					let serverResult: { url: string; token: string } | null = null;
					let agentReady = false;
					let settled = false;

					const tryResolve = () => {
						if (settled) return;
						if (serverResult && agentReady) {
							settled = true;
							clearTimeout(timeout);
							spinner.stop("Session resumed");
							resolve(serverResult);
						}
					};

					const timeout = setTimeout(() => {
						if (settled) return;
						settled = true;
						spinner.stop();
						reject(new Error("Agent failed to start within 60 seconds"));
					}, 60_000);

					resume({
						meta: selectedSession,
						cwd,
						onReady: () => {
							agentReady = true;
							tryResolve();
						},
					})
						.then((result) => {
							serverResult = result;
							spinner.phase("Reconnecting to agent...");
							tryResolve();
						})
						.catch((err) => {
							if (settled) return;
							settled = true;
							clearTimeout(timeout);
							spinner.stop();
							reject(err);
						});
				},
			);

			this.logger.newline();
			this.logger.section("🔍 StoryOf");
			this.logger.newline();
			this.logger.keyValue("Resumed", formatSessionLabel(selectedSession));
			this.logger.keyValue("URL", url);
			this.logger.keyValue("Token", token);
			const resumeState = getState();
			if (resumeState.model) {
				this.logger.keyValue("Model", resumeState.model);
			}
			this.logger.newline();
			this.logger.hint("Open the URL in your browser and paste the token to connect.");
			this.logger.hint("Press Ctrl+C to stop.");
			this.logger.newline();
		} catch (error) {
			spinner.stop();
			throw error;
		}

		await this.waitForShutdown();
	}

	handleStop(cwd: string): void {
		const stopped = stopExternal(cwd);
		if (stopped) {
			this.logger.success("Agent stopped.");
			this.logger.newline();
		} else {
			this.logger.warn("No running agent found in this directory.");
			this.logger.newline();
		}
	}

	private showConnectionInfo(
		url: string,
		token: string,
		options: StartOptions,
	): void {
		this.logger.newline();
		this.logger.section("🔍 StoryOf");
		this.logger.newline();
		this.logger.keyValue("URL", url);
		this.logger.keyValue("Token", token);
		// Show the actual resolved model — always use engine state since S.model
		// is set during createSession() before the first prompt is sent.
		// Don't gate on phase: the agent may have already crashed by the time
		// we get here (fast auth error), resetting phase to "starting".
		const state = getState();
		const resolvedModel = state.model || options.model || "(auto-selecting)";
		this.logger.keyValue("Model", resolvedModel);
		this.logger.keyValue("Target", options.cwd);
		this.logger.keyValue("Depth", options.depth);
		if (options.prompt) {
			this.logger.keyValue("Topic", options.prompt);
		}
		if (options.paths.length > 0) {
			this.logger.keyValue("Scope", options.paths.join(", "));
		}
		this.logger.newline();
		this.logger.hint(
			"Open the URL in your browser and paste the token to connect.",
		);
		this.logger.hint("Press Ctrl+C to stop.");
		this.logger.newline();
	}

	private showAuthInstructions(): void {
		this.logger.error("No API credentials found");
		this.logger.newline();
		this.logger.info("You need to authenticate before using StoryOf.");
		this.logger.newline();

		this.logger.section("Option 1: API Keys (Direct access)");
		this.logger.hint("Get API keys from provider websites:");
		this.logger.newline();

		const providers = [
			["anthropic", "sk-ant-xxx", "console.anthropic.com"],
			["openai", "sk-xxx", "platform.openai.com"],
			["google", "<key>", "aistudio.google.com"],
			["groq", "<key>", "console.groq.com"],
			["xai", "<key>", "x.ai"],
			["openrouter", "<key>", "openrouter.ai"],
			["mistral", "<key>", "console.mistral.ai"],
			["cerebras", "<key>", "cloud.cerebras.ai"],
		];

		for (const [provider, placeholder, url] of providers) {
			this.logger.command(
				`${APP_CMD} auth set ${provider} ${placeholder}  # ${url}`,
			);
		}
		this.logger.newline();

		this.logger.section("Option 2: OAuth Login (Subscription required)");
		this.logger.hint("Uses your existing subscription:");
		this.logger.newline();

		const oauth = [
			["anthropic", "Claude Pro/Max or Team"],
			["github-copilot", "GitHub Copilot Individual/Business/Enterprise"],
			["google", "Google Gemini CLI access"],
			["antigravity", "Google Cloud Antigravity"],
			["openai-codex", "ChatGPT Plus/Pro or Team"],
		];

		for (const [provider, desc] of oauth) {
			this.logger.command(
				`${APP_CMD} auth login ${provider.padEnd(18)} # ${desc}`,
			);
		}
		this.logger.newline();

		this.logger.section("Option 3: Environment Variables");
		this.logger.command(`export STORYOF_ANTHROPIC_API_KEY=sk-ant-xxx`);
		this.logger.command(`export ANTHROPIC_API_KEY=sk-ant-xxx`);
		this.logger.newline();

		this.logger.hint(`Then run ${APP_CMD} again.`);
		this.logger.newline();
	}

	private async waitForShutdown(): Promise<void> {
		return new Promise<void>((resolve) => {
			const cleanup = () => {
				this.logger.newline();

				// Show session summary before exiting
				const state = getState();
				if (state.costTotals && (state.costTotals.usage.input > 0 || state.costTotals.usage.output > 0)) {
					const { usage, cost, requestCount } = state.costTotals;
					const line = CostTracker.formatStatusLine(
						usage, cost, state.model || "unknown", state.provider || undefined,
					);
					this.logger.section("Session Summary");
					this.logger.keyValue("Usage", line);
					this.logger.keyValue("Requests", String(requestCount));
					if (state.sessionId) {
						this.logger.keyValue("Resume", `${APP_CMD} resume ${state.sessionId}`);
					}
					this.logger.newline();
				} else if (state.sessionId) {
					this.logger.keyValue("Resume", `${APP_CMD} resume ${state.sessionId}`);
					this.logger.newline();
				}

				this.logger.info("Shutting down...");
				resolve();
				process.exit(0);
			};
			process.on("SIGINT", cleanup);
			process.on("SIGTERM", cleanup);
		});
	}
}
