import { execFile } from "node:child_process";
import type {
	AgentEndEvent,
	ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

function run(cmd: string, args: string[]): void {
	execFile(cmd, args, { timeout: 5000 }, () => {});
}

function getTmuxWindowName(): Promise<string> {
	if (!process.env.TMUX) return Promise.resolve("pi");
	return new Promise((resolve) => {
		execFile(
			"tmux",
			["display-message", "-p", "#{window_name}"],
			{ encoding: "utf8", timeout: 3000 },
			(err, stdout) => resolve(err ? "pi" : stdout.trim() || "pi"),
		);
	});
}

/**
 * Heuristics to detect whether the assistant's final text is asking for user
 * input. We bias toward avoiding false positives: only flag text that is
 * clearly a direct question or explicit request for a decision.
 */
function isWaitingForInput(text: string): boolean {
	// Grab the last meaningful line (skip blank / whitespace-only trailing lines).
	const lines = text.trimEnd().split("\n");
	const last = lines[lines.length - 1]?.trim() ?? "";

	// 1. Last line ends with "?" — most reliable signal.
	if (last.endsWith("?")) return true;

	// 2. Explicit choice / decision phrases (case-insensitive, anchored to line
	//    start or after common prefixes to reduce false positives).
	const choicePatterns = [
		/\bwhich (?:option|approach|one|version|method)\b/i,
		/\bwould you (?:like|prefer|rather)\b/i,
		/\bshould I\b/i,
		/\bdo you want\b/i,
		/\blet me know (?:if|which|what|how|whether)\b/i,
		/\bplease (?:choose|pick|select|confirm|let me know)\b/i,
		/\bwhat do you think\b/i,
		/\bwhat would you\b/i,
		/\bshall I\b/i,
	];

	// Only check the last ~3 lines to avoid matching questions buried deep in
	// an explanation that were already answered by the assistant itself.
	const tail = lines
		.slice(-3)
		.map((l) => l.trim())
		.join(" ");

	return choicePatterns.some((re) => re.test(tail));
}

function getLastAssistantText(event: AgentEndEvent): string | null {
	for (let i = event.messages.length - 1; i >= 0; i--) {
		const msg = event.messages[i];
		if (msg && "role" in msg && msg.role === "assistant") {
			const textParts = (
				msg.content as Array<{ type: string; text?: string }>
			).flatMap((c) => (c.type === "text" && c.text ? [c.text] : []));
			if (textParts.length > 0) return textParts.join("\n");
		}
	}
	return null;
}

function notify(title: string, message: string): void {
	run("terminal-notifier", ["-title", title, "-message", message]);
	run("afplay", ["-v", "0.1", "/System/Library/Sounds/Purr.aiff"]);
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event) => {
		const name = await getTmuxWindowName();
		const title = `pi [${name}]`;

		const text = getLastAssistantText(event);
		if (text && isWaitingForInput(text)) {
			notify(title, "Waiting for input");
		} else {
			notify(title, "Task finished");
		}
	});
}
