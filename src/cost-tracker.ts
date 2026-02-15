/**
 * StoryOf — Token usage and cost tracking.
 *
 * Consumes pi-ai's Usage type:
 *   { input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }
 */

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CostEntry {
	usage: TokenUsage;
	cost: number;
	modelId: string;
	timestamp: number;
}

export class CostTracker {
	private entries: CostEntry[] = [];
	private currentModelId: string = "unknown";

	setModel(modelId: string) {
		this.currentModelId = modelId;
	}

	getModel(): string {
		return this.currentModelId;
	}

	/**
	 * Record token usage from a message_end event.
	 * Accepts pi-ai's Usage shape: { input, output, cacheRead, cacheWrite, cost: { total } }
	 */
	recordUsage(usage: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	}): CostEntry {
		const tokenUsage: TokenUsage = {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
		};

		// Use the pre-calculated cost from pi-ai when available
		const cost = usage.cost?.total ?? 0;

		const entry: CostEntry = {
			usage: tokenUsage,
			cost,
			modelId: this.currentModelId,
			timestamp: Date.now(),
		};

		this.entries.push(entry);
		return entry;
	}

	/** Get cumulative totals for the session */
	getTotals(): { usage: TokenUsage; cost: number; requestCount: number } {
		const usage: TokenUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
		let cost = 0;
		for (const entry of this.entries) {
			usage.input += entry.usage.input;
			usage.output += entry.usage.output;
			usage.cacheRead += entry.usage.cacheRead;
			usage.cacheWrite += entry.usage.cacheWrite;
			cost += entry.cost;
		}
		return { usage, cost, requestCount: this.entries.length };
	}

	/**
	 * Build a compact status line:
	 *   ↑7.2k ↓295k R80M W3.1M $54.592 (provider) model-name
	 */
	static formatStatusLine(usage: TokenUsage, cost: number, model: string, provider?: string): string {
		const parts: string[] = [];
		parts.push(`↑${fmtTokens(usage.input)}`);
		parts.push(`↓${fmtTokens(usage.output)}`);
		if (usage.cacheRead > 0) parts.push(`R${fmtTokens(usage.cacheRead)}`);
		if (usage.cacheWrite > 0) parts.push(`W${fmtTokens(usage.cacheWrite)}`);
		parts.push(fmtCost(cost));
		if (provider) parts.push(`(${provider})`);
		parts.push(model);
		return parts.join(" ");
	}

	/** Format cost in dollars */
	static formatCost(cost: number): string {
		return fmtCost(cost);
	}
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function fmtCost(cost: number): string {
	if (cost === 0) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}
