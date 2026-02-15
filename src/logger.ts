/**
 * StoryOf — Agent log (persisted to disk).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export class AgentLogger {
	private logFilePath: string | null = null;

	setPath(filePath: string) {
		this.logFilePath = filePath;
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
	}

	log(msg: string) {
		if (!this.logFilePath) return;
		try {
			const ts = new Date().toISOString();
			fs.appendFileSync(this.logFilePath, `[${ts}] ${msg}\n`);
		} catch {}
	}

	logStderr(text: string) {
		if (!this.logFilePath) return;
		try {
			const ts = new Date().toISOString();
			const lines = text
				.split("\n")
				.map((l) => `[${ts}] [stderr] ${l}`)
				.join("\n");
			fs.appendFileSync(this.logFilePath, lines + "\n");
		} catch {}
	}
}
