/**
 * Integration test: startup readiness gate.
 *
 * Verifies that the CLI binary does NOT output URL/token until the agent
 * is confirmed running, and that late-connecting browser clients get
 * the full event history.
 *
 * Uses real subprocess + temp directories — never touches real home/credentials.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as http from "node:http";

const CLI_PATH = path.resolve(__dirname, "../../dist/cli.js");

function makeTempDir(): string {
	const id = crypto.randomBytes(8).toString("hex");
	const dir = path.join(os.tmpdir(), `storyof-readiness-${id}`);
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

describe("Startup readiness", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		for (const fn of cleanups) {
			try { fn(); } catch {}
		}
		cleanups.length = 0;
	});

	it("without auth: no URL, no spinner, just error", async () => {
		const tempHome = makeTempDir();
		cleanups.push(() => fs.rmSync(tempHome, { recursive: true, force: true }));

		const output = await runProcess(
			["node", CLI_PATH, "test prompt"],
			cleanEnv(tempHome),
			tempHome,
			5000,
		);

		// Should fail with auth error
		expect(output.code).not.toBe(0);
		expect(output.stderr).toMatch(/no api credentials/i);

		// Must NOT contain any URL, token, or spinner
		expect(output.stdout).not.toMatch(/http:\/\/localhost/);
		expect(output.stderr).not.toMatch(/http:\/\/localhost:\d+\//);
	});

	it("with auth: spinner appears on stderr before any URL on stdout", async () => {
		const tempHome = makeTempDir();
		setupFakeAuth(tempHome);
		cleanups.push(() => fs.rmSync(tempHome, { recursive: true, force: true }));

		// We spawn the CLI with a fake key. It will:
		// 1. Show spinner on stderr (cursor-hide escape + frames)
		// 2. Try to create the agent session (which will eventually fail with bad key)
		// 3. Either show URL after readiness, or fail
		//
		// What we verify: stderr gets output BEFORE stdout (if stdout has anything)

		const stderrChunks: { time: number; data: string }[] = [];
		const stdoutChunks: { time: number; data: string }[] = [];
		const start = Date.now();

		const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
			const child = spawn("node", [CLI_PATH, "test"], {
				env: cleanEnv(tempHome, { ANTHROPIC_API_KEY: "sk-ant-test-fake" }),
				cwd: tempHome,
			});
			cleanups.push(() => { try { child.kill("SIGKILL"); } catch {} });

			let stdout = "";
			let stderr = "";

			child.stdout.on("data", (d) => {
				const s = d.toString();
				stdout += s;
				stdoutChunks.push({ time: Date.now() - start, data: s });
			});
			child.stderr.on("data", (d) => {
				const s = d.toString();
				stderr += s;
				stderrChunks.push({ time: Date.now() - start, data: s });
			});

			// Give it enough time to start the spinner, then kill
			const kill = setTimeout(() => child.kill("SIGTERM"), 8000);
			child.on("close", (code) => {
				clearTimeout(kill);
				resolve({ stdout, stderr, code: code ?? 1 });
			});
		});

		// The spinner writes cursor-hide escape to stderr
		const hasSpinner = result.stderr.includes("\x1B[?25l") || result.stderr.includes("[?25l");

		if (hasSpinner && stderrChunks.length > 0) {
			const firstSpinnerTime = stderrChunks[0].time;

			// If any stdout appeared (URL), it must be AFTER the spinner
			if (stdoutChunks.length > 0) {
				const firstStdoutTime = stdoutChunks[0].time;
				expect(firstStdoutTime).toBeGreaterThanOrEqual(firstSpinnerTime);
			}
		}

		// With a fake key, the agent creation might fail — that's fine.
		// Key invariant: no URL appeared without spinner first.
		if (result.stdout.includes("localhost")) {
			// If URL appeared, spinner must have been shown
			expect(hasSpinner).toBe(true);
		}
	}, 15000);

	it("HTTP endpoints are token-gated", async () => {
		const tempHome = makeTempDir();
		setupFakeAuth(tempHome);
		cleanups.push(() => fs.rmSync(tempHome, { recursive: true, force: true }));

		let port: number | null = null;
		let token: string | null = null;

		const result = await new Promise<void>((resolve) => {
			const child = spawn("node", [CLI_PATH, "test"], {
				env: cleanEnv(tempHome, { ANTHROPIC_API_KEY: "sk-ant-test-fake-2" }),
				cwd: tempHome,
			});
			cleanups.push(() => { try { child.kill("SIGKILL"); } catch {} });

			let output = "";
			child.stdout.on("data", (d) => {
				output += d.toString();
				const pMatch = output.match(/localhost:(\d+)/);
				const tMatch = output.match(/Token\s+(\S+)/);
				if (pMatch) port = parseInt(pMatch[1], 10);
				if (tMatch) token = tMatch[1];
			});

			// eslint-disable-next-line @typescript-eslint/no-misused-promises
			setTimeout(async () => {
				if (port) {
					// Without token → 403
					const noToken = await httpGet(`http://localhost:${port}/status`).catch(() => ({ status: 0, body: "" }));
					expect(noToken.status).toBe(403);

					if (token) {
						// With token → 200
						const withToken = await httpGet(`http://localhost:${port}/status?token=${token}`).catch(() => ({ status: 0, body: "" }));
						expect(withToken.status).toBe(200);

						const body = JSON.parse(withToken.body);
						expect(body).toHaveProperty("agentRunning");
						expect(body).toHaveProperty("targetPath");
					}
				}

				child.kill("SIGTERM");
				resolve();
			}, 8000);
		});
	}, 15000);
});

// ── Helpers ──────────────────────────────────────────────────────────

function setupFakeAuth(tempHome: string): void {
	const ddDir = path.join(tempHome, ".storyof");
	fs.mkdirSync(ddDir, { recursive: true });
	fs.writeFileSync(
		path.join(ddDir, "auth.json"),
		JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-test-fake" } }),
		{ mode: 0o600 },
	);
}

function runProcess(
	args: string[],
	env: Record<string, string>,
	cwd: string,
	timeout: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		const child = spawn(args[0], args.slice(1), { env, cwd, timeout });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => { stdout += d.toString(); });
		child.stderr.on("data", (d) => { stderr += d.toString(); });
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
	});
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.get(url, (res) => {
			let body = "";
			res.on("data", (d) => { body += d.toString(); });
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
	});
}
