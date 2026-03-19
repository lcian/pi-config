import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawnSync } from "child_process";

const PR_STATUS_TTL = 10_000;

function git(...args: string[]): string | null {
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

function gh(...args: string[]): string | null {
	try {
		const result = spawnSync("gh", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		return result.status === 0 ? result.stdout.trim() : null;
	} catch {
		return null;
	}
}

function getBaseBranch(): string {
	return (
		git("symbolic-ref", "refs/remotes/origin/HEAD")?.replace(
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

function getGitDiffStats(baseBranch: string): DiffStats | null {
	const stat = git("diff", baseBranch, "--shortstat");
	if (!stat) return null;
	const added = parseInt(stat.match(/(\d+) insertion/)?.[1] || "0");
	const deleted = parseInt(stat.match(/(\d+) deletion/)?.[1] || "0");
	const files = parseInt(stat.match(/(\d+) file/)?.[1] || "0");
	if (added === 0 && deleted === 0) return null;
	return { added, deleted, files };
}

interface PrStatus {
	checks: { pass: number; fail: number; pending: number };
	unresolvedComments: number;
	reviewDecision: string | null;
}

function fetchPrStatus(prUrl: string): PrStatus | null {
	const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (!match) return null;
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

	const raw = gh(
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
	);
	if (!raw) return null;

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
	let cachedPrBranch: string | null = null;
	let cachedPrUrl: string | null = null;
	let cachedDiffBranch: string | null = null;
	let cachedDiffStats: DiffStats | null = null;
	let cachedPrStatus: PrStatus | null = null;
	let prStatusFetchTime = 0;
	const baseBranch = getBaseBranch();

	function getPrUrl(branch: string | null): string | null {
		if (
			!branch ||
			branch === "main" ||
			branch === "master" ||
			branch === "detached"
		)
			return null;
		if (branch === cachedPrBranch) return cachedPrUrl;
		cachedPrBranch = branch;
		cachedPrUrl =
			gh("pr", "view", branch, "--json", "url", "-q", ".url") || null;
		return cachedPrUrl;
	}

	function getDiffStats(branch: string | null): DiffStats | null {
		if (!branch || branch === "detached") return null;
		if (branch === cachedDiffBranch) return cachedDiffStats;
		cachedDiffBranch = branch;
		cachedDiffStats = getGitDiffStats(baseBranch);
		return cachedDiffStats;
	}

	function getPrStatus(prUrl: string | null): PrStatus | null {
		if (!prUrl) return null;
		const now = Date.now();
		if (cachedPrStatus && now - prStatusFetchTime < PR_STATUS_TTL)
			return cachedPrStatus;
		prStatusFetchTime = now;
		cachedPrStatus = fetchPrStatus(prUrl);
		return cachedPrStatus;
	}

	function invalidateCaches() {
		cachedPrBranch = null;
		cachedPrUrl = null;
		cachedDiffBranch = null;
		cachedDiffStats = null;
		cachedPrStatus = null;
		prStatusFetchTime = 0;
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => {
				invalidateCaches();
				tui.requestRender();
			});

			return {
				dispose: unsub,
				invalidate() {
					cachedDiffBranch = null;
					cachedDiffStats = null;
				},
				render(width: number): string[] {
					const pad = " ";
					const sep = theme.fg("dim", " │ ");
					const branch = footerData.getGitBranch();

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

					const diff = getDiffStats(branch);
					if (diff) {
						const d: string[] = [];
						if (diff.added > 0) d.push(theme.fg("success", `+${diff.added}`));
						if (diff.deleted > 0) d.push(theme.fg("error", `-${diff.deleted}`));
						if (diff.files > 0) d.push(theme.fg("muted", `~${diff.files}`));
						rightParts.push(d.join(" "));
					}

					const left = pad + leftParts.join(sep);
					const right = rightParts.join(sep) + pad;
					const lines = [alignLine(left, right, width, sep)];

					// === Line 2: PR URL + status (optional) ===
					const prUrl = getPrUrl(branch);
					if (prUrl) {
						const prLeft = pad + theme.fg("muted", prUrl);
						const status = getPrStatus(prUrl);

						if (status) {
							const sections: string[] = [];

							const review: string[] = [];
							if (status.reviewDecision === "APPROVED")
								review.push(theme.fg("success", "Approved"));
							else if (status.reviewDecision === "CHANGES_REQUESTED")
								review.push(theme.fg("error", "Changes Requested"));
							if (status.unresolvedComments > 0) {
								const word =
									status.unresolvedComments === 1 ? "comment" : "comments";
								review.push(
									theme.fg("muted", `${status.unresolvedComments} ${word}`),
								);
							}
							if (review.length > 0) sections.push(review.join(sep));

							const { pass, fail, pending } = status.checks;
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
