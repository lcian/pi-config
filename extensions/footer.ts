import { execFile, spawnSync } from "node:child_process";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const PR_STATUS_TTL = 10_000;
const DIFF_STATS_TTL = 5_000;

/** Sync git call — only used for fast local operations (no network). */
function gitSync(...args: string[]): string | null {
	try {
		const result = spawnSync("git", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		});
		return result.status === 0 ? result.stdout.trim() : null;
	} catch {
		return null;
	}
}

/** Async shell command — returns stdout or null. */
function execAsync(cmd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ encoding: "utf8", timeout: 10_000 },
			(err, stdout) => {
				resolve(err ? null : stdout.trim() || null);
			},
		);
	});
}

function getBaseBranch(): string {
	return (
		gitSync("symbolic-ref", "refs/remotes/origin/HEAD")?.replace(
			/^refs\/remotes\/origin\//,
			"",
		) || "master"
	);
}

interface DiffStats {
	added: number;
	deleted: number;
	files: number;
}

function parseDiffStats(stat: string): DiffStats | null {
	const added = parseInt(stat.match(/(\d+) insertion/)?.[1] || "0", 10);
	const deleted = parseInt(stat.match(/(\d+) deletion/)?.[1] || "0", 10);
	const files = parseInt(stat.match(/(\d+) file/)?.[1] || "0", 10);
	if (added === 0 && deleted === 0) return null;
	return { added, deleted, files };
}

interface PrStatus {
	checks: { pass: number; fail: number; pending: number };
	unresolvedComments: number;
	reviewDecision: string | null;
}

function parsePrStatus(raw: string): PrStatus | null {
	try {
		const pr = JSON.parse(raw).data.repository.pullRequest;

		const contexts =
			pr.commits.nodes[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
		let pass = 0,
			fail = 0,
			pending = 0;
		for (const c of contexts) {
			if (c.__typename === "CheckRun") {
				if (c.status !== "COMPLETED") pending++;
				else if (
					c.conclusion === "SUCCESS" ||
					c.conclusion === "NEUTRAL" ||
					c.conclusion === "SKIPPED"
				)
					pass++;
				else fail++;
			} else if (c.__typename === "StatusContext") {
				if (c.state === "SUCCESS") pass++;
				else if (c.state === "PENDING" || c.state === "EXPECTED") pending++;
				else fail++;
			}
		}

		const threads = pr.reviewThreads.nodes || [];
		const unresolvedComments = threads.filter(
			(t: { isResolved: boolean }) => !t.isResolved,
		).length;

		return {
			checks: { pass, fail, pending },
			unresolvedComments,
			reviewDecision: pr.reviewDecision || null,
		};
	} catch {
		return null;
	}
}

/** Right-align two halves within a given width, falling back to truncation. */
function alignLine(
	left: string,
	right: string,
	width: number,
	sep: string,
): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const gap = width - leftWidth - rightWidth;
	if (gap >= 1) return left + " ".repeat(gap) + right;
	return truncateToWidth(left + sep + right, width);
}

export default function (pi: ExtensionAPI) {
	// Cached data — render always reads from these, never blocks.
	let prUrl: string | null = null;
	let prBranch: string | null = null;
	let prStatus: PrStatus | null = null;
	let diffStats: DiffStats | null = null;
	let diffBranch: string | null = null;

	// In-flight tracking to avoid duplicate async calls.
	let prUrlFetching = false;
	let prStatusFetching = false;
	let prStatusFetchTime = 0;
	let diffStatsFetching = false;
	let diffStatsFetchTime = 0;

	const baseBranch = getBaseBranch();
	let requestRender: (() => void) | null = null;

	function invalidateCaches() {
		prUrl = null;
		prBranch = null;
		prStatus = null;
		prStatusFetchTime = 0;
		diffStats = null;
		diffBranch = null;
		diffStatsFetchTime = 0;
	}

	async function fetchPrUrl(branch: string) {
		if (prUrlFetching) return;
		prUrlFetching = true;
		prBranch = branch;
		try {
			prUrl =
				(await execAsync("gh", [
					"pr",
					"view",
					branch,
					"--json",
					"url",
					"-q",
					".url",
				])) || null;
		} catch {
			prUrl = null;
		}
		prUrlFetching = false;
		requestRender?.();
		// Kick off PR status fetch now that we have the URL.
		if (prUrl) fetchPrStatusAsync(prUrl);
	}

	async function fetchPrStatusAsync(url: string) {
		if (prStatusFetching) return;
		prStatusFetching = true;
		prStatusFetchTime = Date.now();

		const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
		if (!match) {
			prStatusFetching = false;
			return;
		}
		const [, owner, repo, number] = match;

		const query = `query($owner: String!, $repo: String!, $number: Int!) {
			repository(owner: $owner, name: $repo) {
				pullRequest(number: $number) {
					commits(last: 1) {
						nodes {
							commit {
								statusCheckRollup {
									contexts(first: 100) {
										nodes {
											__typename
											... on CheckRun { status conclusion }
											... on StatusContext { state }
										}
									}
								}
							}
						}
					}
					reviewDecision
					reviewThreads(first: 100) {
						nodes { isResolved }
					}
				}
			}
		}`;

		const raw = await execAsync("gh", [
			"api",
			"graphql",
			"-f",
			`query=${query}`,
			"-f",
			`owner=${owner}`,
			"-f",
			`repo=${repo}`,
			"-F",
			`number=${number}`,
		]);

		if (raw) prStatus = parsePrStatus(raw);
		prStatusFetching = false;
		requestRender?.();
	}

	async function fetchDiffStatsAsync(branch: string) {
		if (diffStatsFetching) return;
		diffStatsFetching = true;
		diffStatsFetchTime = Date.now();
		diffBranch = branch;

		const raw = await execAsync("git", ["diff", baseBranch, "--shortstat"]);
		diffStats = raw ? parseDiffStats(raw) : null;
		diffStatsFetching = false;
		requestRender?.();
	}

	/** Trigger background refreshes if caches are stale. Never blocks. */
	function refreshIfNeeded(branch: string | null) {
		// PR URL: fetch once per branch
		if (
			branch &&
			branch !== "main" &&
			branch !== "master" &&
			branch !== "detached" &&
			branch !== prBranch &&
			!prUrlFetching
		) {
			fetchPrUrl(branch);
		}

		// PR status: refresh every PR_STATUS_TTL
		if (prUrl && !prStatusFetching) {
			const now = Date.now();
			if (now - prStatusFetchTime >= PR_STATUS_TTL) {
				fetchPrStatusAsync(prUrl);
			}
		}

		// Diff stats: refresh every DIFF_STATS_TTL
		if (branch && branch !== "detached" && !diffStatsFetching) {
			const now = Date.now();
			if (branch !== diffBranch || now - diffStatsFetchTime >= DIFF_STATS_TTL) {
				fetchDiffStatsAsync(branch);
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			const unsub = footerData.onBranchChange(() => {
				invalidateCaches();
				tui.requestRender();
			});

			return {
				dispose() {
					unsub();
					requestRender = null;
				},
				invalidate() {},
				render(width: number): string[] {
					const pad = " ";
					const sep = theme.fg("dim", " │ ");
					const branch = footerData.getGitBranch();

					// Kick off background fetches if needed — never blocks.
					refreshIfNeeded(branch);

					// === Line 1: left ===
					const leftParts: string[] = [];

					const modelName = ctx.model?.id || "no-model";
					leftParts.push(
						theme.fg("accent", modelName) +
							" " +
							theme.fg("dim", pi.getThinkingLevel()),
					);

					const contextUsage = ctx.getContextUsage();
					const pct = contextUsage?.percent ?? 0;
					const pctStr =
						contextUsage?.percent !== null ? `${pct.toFixed(0)}%` : "?%";
					if (pct > 80) leftParts.push(theme.fg("error", pctStr));
					else if (pct > 50) leftParts.push(theme.fg("warning", pctStr));
					else leftParts.push(theme.fg("success", pctStr));

					if (branch) leftParts.push(theme.fg("muted", branch));

					// === Line 1: right ===
					const rightParts: string[] = [];

					let totalCost = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (
							entry.type === "message" &&
							entry.message.role === "assistant"
						) {
							totalCost += (entry.message as AssistantMessage).usage.cost.total;
						}
					}
					rightParts.push(theme.fg("dim", `$${totalCost.toFixed(2)}`));

					if (diffStats) {
						const d: string[] = [];
						if (diffStats.added > 0)
							d.push(theme.fg("success", `+${diffStats.added}`));
						if (diffStats.deleted > 0)
							d.push(theme.fg("error", `-${diffStats.deleted}`));
						if (diffStats.files > 0)
							d.push(theme.fg("muted", `~${diffStats.files}`));
						if (d.length > 0) rightParts.push(d.join(" "));
					}

					const left = pad + leftParts.join(sep);
					const right = rightParts.join(sep) + pad;
					const lines = [alignLine(left, right, width, sep)];

					// === Line 2: PR URL + status (optional) ===
					if (prUrl) {
						const prLeft = pad + theme.fg("muted", prUrl);

						if (prStatus) {
							const sections: string[] = [];

							const review: string[] = [];
							if (prStatus.reviewDecision === "APPROVED")
								review.push(theme.fg("success", "Approved"));
							else if (prStatus.reviewDecision === "CHANGES_REQUESTED")
								review.push(theme.fg("error", "Changes Requested"));
							if (prStatus.unresolvedComments > 0) {
								const word =
									prStatus.unresolvedComments === 1 ? "comment" : "comments";
								review.push(
									theme.fg("muted", `${prStatus.unresolvedComments} ${word}`),
								);
							}
							if (review.length > 0) sections.push(review.join(sep));

							const { pass, fail, pending } = prStatus.checks;
							const ci: string[] = [];
							if (fail > 0) ci.push(theme.fg("error", `${fail} Failed`));
							if (pending > 0)
								ci.push(theme.fg("warning", `${pending} Running`));
							if (pass > 0) ci.push(theme.fg("dim", `${pass} Passed`));
							if (ci.length > 0) sections.push(ci.join(" "));

							if (sections.length > 0) {
								lines.push(
									alignLine(prLeft, sections.join(sep) + pad, width, sep),
								);
							} else {
								lines.push(truncateToWidth(prLeft, width));
							}
						} else {
							lines.push(truncateToWidth(prLeft, width));
						}
					}

					return lines;
				},
			};
		});
	});
}
