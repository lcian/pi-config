import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TextContent } from "@mariozechner/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	getAgentDir,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const APPLY_PATCH_BIN = join(getAgentDir(), "bin", "apply_patch");
const MAX_LINE_LENGTH = 500;
const DEFAULT_LIMIT = 2000;

const ACTIVE_TOOLS = ["bash", "grep", "find", "ls", "apply_patch", "read_file"];

function runBinary(
	bin: string,
	input: string,
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, [], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 1 });
		});
		child.stdin.write(input);
		child.stdin.end();
	});
}

const APPLY_PATCH_DESCRIPTION = `Use apply_patch to create, update, and delete files.

The patch format is a file-oriented diff:

*** Begin Patch
[ one or more file operations ]
*** End Patch

File operations:

*** Add File: <path> — create a new file. Every following line must start with +.
*** Delete File: <path> — remove an existing file. Nothing follows.
*** Update File: <path> — patch an existing file in place.

Update File may be followed by *** Move to: <new path> to rename.
Then one or more hunks, each starting with @@ (optionally followed by context like a class or function name).

Within a hunk, each line starts with:
  (space) — context line (unchanged)
  - — line to remove
  + — line to add

Context rules:
- Show 3 lines of context above and below each change.
- Don't duplicate context between adjacent changes within 3 lines of each other.
- If 3 lines aren't enough to uniquely identify the location, use @@ headers.
- Multiple @@ headers can narrow down location (e.g., @@ class Foo then @@ def method).

Grammar:
Patch := "*** Begin Patch" NEWLINE { FileOp } "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ "*** Move to: " newPath NEWLINE ] { Hunk }
Hunk := "@@" [ " " header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

Example:
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

Important:
- Always include a header (Add/Delete/Update)
- Prefix new lines with + even when creating a new file
- File paths must be relative, NEVER absolute`;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description: APPLY_PATCH_DESCRIPTION,
		promptSnippet:
			"Create, update, and delete files using a diff-based patch format",
		promptGuidelines: [
			"Use apply_patch for ALL file modifications — creating new files, editing existing files, and deleting files.",
			"Always read_file before editing to understand existing content and get accurate context lines.",
			"File paths in patches must be relative to the working directory.",
		],
		parameters: Type.Object({
			patch: Type.String({
				description: "The patch to apply in the format described above",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { patch } = params;
			try {
				const result = await runBinary(APPLY_PATCH_BIN, patch, ctx.cwd);
				if (result.exitCode === 0) {
					return {
						content: [
							{
								type: "text",
								text: result.stdout || "Patch applied successfully.",
							} as TextContent,
						],
						details: { patch },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Patch failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
						} as TextContent,
					],
					details: { patch },
				};
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `Error running apply_patch: ${msg}`,
						} as TextContent,
					],
					details: { patch },
				};
			}
		},

		renderCall(args, theme) {
			const patchLines = args.patch.split("\n");
			const files: string[] = [];
			for (const line of patchLines) {
				const m = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
				if (m) files.push(m[1]);
			}
			let text = theme.fg("toolTitle", theme.bold("patch "));
			text += theme.fg("accent", files.join(", ") || "...");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Patching..."), 0, 0);

			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";

			if (output.startsWith("Patch failed") || output.startsWith("Error")) {
				return new Text(theme.fg("error", output.split("\n")[0]), 0, 0);
			}

			// Count file operations from the binary output (A/M/D lines)
			const opLines = output.split("\n").filter((l) => /^[AMD] /.test(l));
			let text = theme.fg("success", `${opLines.length} file(s)`);

			// Count additions/removals from the patch itself
			const patch =
				(result.details as { patch?: string } | undefined)?.patch ?? "";
			const patchLines = patch.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of patchLines) {
				if (line.startsWith("+")) additions++;
				if (line.startsWith("-")) removals++;
			}
			if (additions > 0 || removals > 0) {
				text += " ";
				if (additions > 0) text += theme.fg("success", `+${additions}`);
				if (additions > 0 && removals > 0) text += theme.fg("dim", "/");
				if (removals > 0) text += theme.fg("error", `-${removals}`);
			}

			if (expanded) {
				for (const line of patchLines.slice(0, 40)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						text += `\n${theme.fg("success", line)}`;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						text += `\n${theme.fg("error", line)}`;
					} else if (line.startsWith("@@")) {
						text += `\n${theme.fg("accent", line)}`;
					} else if (line.startsWith("***")) {
						text += `\n${theme.fg("toolTitle", line)}`;
					} else {
						text += `\n${theme.fg("dim", line)}`;
					}
				}
				if (patchLines.length > 40) {
					text += `\n${theme.fg("muted", `... ${patchLines.length - 40} more lines`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "read_file",
		label: "read_file",
		description:
			"Read a file's contents with 1-indexed line numbers. Output format: L{line_number}: {content}. Supports reading specific line ranges with offset and limit.",
		promptSnippet: "Read file contents with line numbers, offset, and limit",
		promptGuidelines: [
			"Use read_file to read file contents. Always read before editing.",
			"For large files, use offset and limit to read specific sections.",
		],
		parameters: Type.Object({
			file_path: Type.String({
				description: "Absolute path to the file to read",
			}),
			offset: Type.Optional(
				Type.Number({
					description:
						"1-indexed line number to start reading from (default: 1)",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of lines to return (default: 2000)",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const { file_path, offset: rawOffset, limit: rawLimit } = params;
			const offset = rawOffset ?? 1;
			const limit = rawLimit ?? DEFAULT_LIMIT;

			if (offset < 1) {
				return {
					content: [
						{
							type: "text",
							text: "Error: offset must be 1 or greater.",
						} as TextContent,
					],
				};
			}
			if (limit < 1) {
				return {
					content: [
						{
							type: "text",
							text: "Error: limit must be 1 or greater.",
						} as TextContent,
					],
				};
			}

			try {
				await access(file_path, constants.R_OK);
				const content = await readFile(file_path, "utf-8");
				const lines = content.split("\n");

				if (offset > lines.length) {
					return {
						content: [
							{
								type: "text",
								text: `Error: offset ${offset} exceeds file length (${lines.length} lines).`,
							} as TextContent,
						],
					};
				}

				const startIdx = offset - 1;
				const selectedLines = lines.slice(startIdx, startIdx + limit);

				let output = selectedLines
					.map((line, i) => {
						const lineNum = offset + i;
						const truncated =
							line.length > MAX_LINE_LENGTH
								? `${line.slice(0, MAX_LINE_LENGTH)}...`
								: line;
						return `L${lineNum}: ${truncated}`;
					})
					.join("\n");

				const truncation = truncateHead(output, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

				const truncated = truncation.truncated;
				if (truncated) {
					output = `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`;
				} else {
					output = truncation.content;
				}

				return {
					content: [{ type: "text", text: output } as TextContent],
					details: { totalLines: lines.length, truncated },
				};
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `Error reading file: ${msg}`,
						} as TextContent,
					],
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("read "));
			text += theme.fg("accent", args.file_path);
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);

			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", content.text.split("\n")[0]), 0, 0);
			}

			const outputText = content?.type === "text" ? content.text : "";

			if (!expanded) return undefined;

			const lines = outputText.split("\n");
			let text = "";
			for (const line of lines.slice(0, 30)) {
				text += `${theme.fg("dim", line)}\n`;
			}
			if (lines.length > 30) {
				text += theme.fg("muted", `... ${lines.length - 30} more lines`);
			}

			return new Text(text, 0, 0);
		},
	});

	pi.on("session_start", () => pi.setActiveTools(ACTIVE_TOOLS));
	pi.on("session_tree", () => pi.setActiveTools(ACTIVE_TOOLS));
	pi.on("session_fork", () => pi.setActiveTools(ACTIVE_TOOLS));
}
