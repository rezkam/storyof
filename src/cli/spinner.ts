/**
 * Terminal spinner with fun storyof themed animations.
 */

const STORYOF_FRAMES = [
	"🤿      Diving into the codebase...",
	" 🤿     Diving into the codebase...",
	"  🤿    Diving into the codebase...",
	"   🤿   Diving into the codebase...",
	"    🤿  Diving into the codebase...",
	"     🤿 Diving into the codebase...",
	"      🤿Diving into the codebase...",
	"     🤿 Diving into the codebase...",
	"    🤿  Diving into the codebase...",
	"   🤿   Diving into the codebase...",
	"  🤿    Diving into the codebase...",
	" 🤿     Diving into the codebase...",
];

const SUBMARINE_FRAMES = [
	"  🫧        ╭───╮  ",
	"     🫧     ╭───╮  ",
	"  🫧     🫧 ╭───╮  ",
	"🫧    🫧    ╭───╮  ",
	"   🫧    🫧 ╭───╮  ",
	"🫧  🫧      ╭───╮  ",
];

const SONAR_FRAMES = [
	"  ·          Scanning...",
	"  · ·        Scanning...",
	"  · · ·      Scanning...",
	"  · · · ·    Scanning...",
	"  · · · · ·  Scanning...",
	"  · · · ·    Scanning...",
	"  · · ·      Scanning...",
	"  · ·        Scanning...",
	"  ·          Scanning...",
	"             Scanning...",
];

const FISH_FRAMES = [
	"  ><>                    ",
	"     ><>                 ",
	"        ><>              ",
	"           ><>           ",
	"              ><>        ",
	"                 ><>     ",
	"                    ><>  ",
	"                 <><     ",
	"              <><        ",
	"           <><           ",
	"        <><              ",
	"     <><                 ",
];

interface SpinnerPhase {
	frames: string[];
	label: string;
	interval: number;
}

const PHASES: SpinnerPhase[] = [
	{ frames: STORYOF_FRAMES, label: "Starting server", interval: 100 },
	{ frames: FISH_FRAMES, label: "Creating agent session", interval: 120 },
	{ frames: SONAR_FRAMES, label: "Connecting to AI model", interval: 150 },
	{ frames: STORYOF_FRAMES, label: "Starting exploration", interval: 100 },
];

export class Spinner {
	private timer: ReturnType<typeof setInterval> | null = null;
	private frameIndex = 0;
	private phaseIndex = 0;
	private startTime = 0;

	start(): void {
		this.startTime = Date.now();
		this.frameIndex = 0;
		this.phaseIndex = 0;

		// Hide cursor
		process.stderr.write("\x1B[?25l");
		this.render();

		const phase = PHASES[this.phaseIndex];
		this.timer = setInterval(() => {
			this.frameIndex++;
			const currentPhase = PHASES[this.phaseIndex];
			if (this.frameIndex >= currentPhase.frames.length) {
				this.frameIndex = 0;
			}
			this.render();
		}, phase.interval);
	}

	/** Advance to next phase with a new label */
	phase(label: string): void {
		this.phaseIndex = Math.min(this.phaseIndex + 1, PHASES.length - 1);
		this.frameIndex = 0;
		// Update the label for the current phase
		PHASES[this.phaseIndex] = { ...PHASES[this.phaseIndex], label };

		if (this.timer) {
			clearInterval(this.timer);
			const currentPhase = PHASES[this.phaseIndex];
			this.timer = setInterval(() => {
				this.frameIndex++;
				if (this.frameIndex >= currentPhase.frames.length) {
					this.frameIndex = 0;
				}
				this.render();
			}, currentPhase.interval);
		}
	}

	stop(finalMessage?: string): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}

		// Clear the spinner line
		process.stderr.write("\r\x1B[K");

		// Show cursor
		process.stderr.write("\x1B[?25h");

		if (finalMessage) {
			const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
			process.stderr.write(`\x1B[32m✓\x1B[0m ${finalMessage} \x1B[2m(${elapsed}s)\x1B[0m\n`);
		}
	}

	private render(): void {
		const phase = PHASES[this.phaseIndex];
		const frame = phase.frames[this.frameIndex % phase.frames.length];
		const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(0);

		// Use stderr so it doesn't mix with stdout data
		process.stderr.write(`\r\x1B[K  ${frame}  \x1B[2m${elapsed}s\x1B[0m`);
	}
}
