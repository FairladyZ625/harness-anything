#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REQUIRED_CHECKS_FALLBACK = [
  "boundaries",
  "package-policy",
  "typecheck (24)",
  "typecheck (26)",
  "fast-contract",
  "integration",
  "supply-chain",
  "gui-build",
  "node26-compatibility",
  "pr-body-lint"
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
  if (result.error) {
    throw new Error(`${command} failed to launch: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function runJson(command, args, fallback) {
  const output = run(command, args);
  if (!output) return fallback;
  return JSON.parse(output);
}

function repoNameWithOwner() {
  return runJson("gh", ["repo", "view", "--json", "nameWithOwner"], {}).nameWithOwner;
}

function latestChecks(statusCheckRollup = []) {
  const checks = new Map();
  for (const check of statusCheckRollup) {
    if (!check.name) continue;
    const current = checks.get(check.name);
    if (!current || checkTime(check) >= checkTime(current)) {
      checks.set(check.name, check);
    }
  }
  return checks;
}

function checkTime(check) {
  const completed = Date.parse(check.completedAt ?? "");
  const started = Date.parse(check.startedAt ?? "");
  return Number.isFinite(completed) ? completed : (Number.isFinite(started) ? started : 0);
}

function normalizeCheckState(check) {
  if (!check) return "missing";
  if (check.status && check.status !== "COMPLETED") return check.status.toLowerCase();
  return String(check.conclusion || check.status || "unknown").toLowerCase();
}

function summarizeRequiredChecks(pr, requiredChecks) {
  const checks = latestChecks(pr.statusCheckRollup);
  const counts = { success: 0, pending: 0, failed: 0, missing: 0 };
  const failed = [];
  for (const name of requiredChecks) {
    const state = normalizeCheckState(checks.get(name));
    if (state === "success") {
      counts.success += 1;
    } else if (state === "missing") {
      counts.missing += 1;
      failed.push(`${name}:missing`);
    } else if (state === "queued" || state === "in_progress" || state === "requested" || state === "pending") {
      counts.pending += 1;
    } else {
      counts.failed += 1;
      failed.push(`${name}:${state}`);
    }
  }
  const parts = [
    `${counts.success}/${requiredChecks.length} success`,
    counts.pending ? `${counts.pending} pending` : null,
    counts.failed ? `${counts.failed} failed` : null,
    counts.missing ? `${counts.missing} missing` : null
  ].filter(Boolean);
  return {
    summary: parts.join(", "),
    failed
  };
}

function formatLabels(labels = []) {
  const names = labels.map((label) => label.name).filter(Boolean);
  return names.length ? names.join(",") : "-";
}

function activeDrafts(prs) {
  return prs.filter((pr) => pr.title.includes("merge queue: checking"));
}

function summarizeChecks(pr) {
  const checks = [...latestChecks(pr.statusCheckRollup).values()];
  if (checks.length === 0) return "no checks";
  return checks
    .filter((check) => check.name !== "full-check")
    .slice(0, 12)
    .map((check) => `${check.name}:${normalizeCheckState(check)}`)
    .join(", ");
}

function branchProtectionRequired(repo) {
  try {
    return runJson("gh", [
      "api",
      `repos/${repo}/branches/main/protection/required_status_checks`,
      "--jq",
      ".contexts"
    ], []);
  } catch (_error) {
    return REQUIRED_CHECKS_FALLBACK;
  }
}

function mergifyMergeConditions() {
  const text = readFileSync(".mergify.yml", "utf8");
  const lines = text.split(/\r?\n/u);
  const checks = new Set();
  let inDefaultQueue = false;
  let inMergeConditions = false;
  for (const line of lines) {
    if (/^  - name: default\s*$/u.test(line)) {
      inDefaultQueue = true;
      continue;
    }
    if (inDefaultQueue && /^pull_request_rules:\s*$/u.test(line)) {
      break;
    }
    if (!inDefaultQueue) continue;
    if (/^    merge_conditions:\s*$/u.test(line)) {
      inMergeConditions = true;
      continue;
    }
    if (inMergeConditions && /^    [A-Za-z_]+/u.test(line)) {
      inMergeConditions = false;
    }
    if (!inMergeConditions) continue;
    const match = /^\s+- check-success = "?([^"]+?)"?\s*$/u.exec(line);
    if (match) checks.add(match[1]);
  }
  return [...checks].sort();
}

function diffSets(left, right) {
  const rightSet = new Set(right);
  return left.filter((entry) => !rightSet.has(entry));
}

function mergifyCheckRuns(repo, sha) {
  const data = runJson("gh", [
    "api",
    "--method",
    "GET",
    `repos/${repo}/commits/${sha}/check-runs`,
    "-f",
    "per_page=100"
  ], { check_runs: [] });
  return (data.check_runs ?? [])
    .filter((runEntry) => /mergify|summary|queue|dequeue/iu.test(runEntry.name ?? "")
      || /mergify|dequeue|dequeued/iu.test(runEntry.output?.title ?? "")
      || /dequeue|dequeued/iu.test(runEntry.output?.summary ?? ""));
}

function recentDequeueEvents(repo, prs) {
  const seenSha = new Set();
  const events = [];
  for (const pr of prs) {
    if (!pr.headRefOid || seenSha.has(pr.headRefOid)) continue;
    seenSha.add(pr.headRefOid);
    let runs;
    try {
      runs = mergifyCheckRuns(repo, pr.headRefOid);
    } catch (error) {
      events.push(`#${pr.number} ${pr.headRefName}: unable to read check-runs (${error.message})`);
      continue;
    }
    for (const runEntry of runs) {
      const title = runEntry.output?.title || runEntry.name || "";
      const summary = runEntry.output?.summary || "";
      if (!/dequeue|dequeued/iu.test(`${title}\n${summary}\n${runEntry.name ?? ""}`)) continue;
      events.push(`#${pr.number} ${runEntry.name}: ${title || "no output title"}`);
    }
  }
  return events.slice(0, 12);
}

function parseWorktrees() {
  const output = run("git", ["worktree", "list", "--porcelain"]);
  const blocks = output.split(/\n\n+/u).filter(Boolean);
  return blocks.map((block) => {
    const entry = {};
    for (const line of block.split(/\n/u)) {
      const [key, ...rest] = line.split(" ");
      if (key === "worktree") entry.path = rest.join(" ");
      if (key === "branch") entry.branch = rest.join(" ").replace(/^refs\/heads\//u, "");
      if (key === "HEAD") entry.head = rest.join(" ");
    }
    return entry;
  });
}

function prForBranch(branch) {
  if (!branch) return [];
  try {
    return runJson("gh", [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state,title,isDraft,url,headRefName",
      "--limit",
      "5"
    ], []);
  } catch (error) {
    return [{ state: "UNKNOWN", title: error.message, isDraft: false }];
  }
}

function printSection(title, lines) {
  console.log(`\n## ${title}`);
  if (lines.length === 0) {
    console.log("- none");
    return;
  }
  for (const line of lines) console.log(`- ${line}`);
}

function main() {
  const repo = repoNameWithOwner();
  const requiredChecks = branchProtectionRequired(repo);
  const prs = runJson("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number,title,isDraft,labels,headRefName,headRefOid,url,statusCheckRollup",
    "--limit",
    "100"
  ], []);

  console.log(`PR Doctor for ${repo}`);
  console.log(`Required contexts (${requiredChecks.length}): ${requiredChecks.join(", ")}`);

  printSection("Open PRs", prs.map((pr) => {
    const checks = summarizeRequiredChecks(pr, requiredChecks);
    const suffix = checks.failed.length ? ` [${checks.failed.join("; ")}]` : "";
    return `#${pr.number} ${pr.isDraft ? "draft" : "ready"} labels=${formatLabels(pr.labels)} ${checks.summary}${suffix} - ${pr.title}`;
  }));

  printSection("Active Mergify Drafts", activeDrafts(prs).map((pr) => (
    `#${pr.number} ${pr.headRefName} - ${pr.title} :: ${summarizeChecks(pr)}`
  )));

  printSection("Recent Dequeue Events", recentDequeueEvents(repo, prs));

  const mergifyChecks = mergifyMergeConditions();
  printSection("Branch Protection vs Mergify", [
    `required-only: ${diffSets(requiredChecks, mergifyChecks).join(", ") || "none"}`,
    `mergify-only: ${diffSets(mergifyChecks, requiredChecks).join(", ") || "none"}`
  ]);

  printSection("Local Worktrees", parseWorktrees().map((worktree) => {
    const prsForBranch = prForBranch(worktree.branch);
    if (prsForBranch.length === 0) {
      return `${worktree.branch ?? "(detached)"} ${worktree.path} PR=none`;
    }
    return prsForBranch.map((pr) => {
      if (pr.state === "UNKNOWN") {
        return `${worktree.branch} ${worktree.path} PR=unknown - ${pr.title}`;
      }
      const stale = pr.state === "MERGED" ? " STALE-MERGED-WORKTREE" : "";
      return `${worktree.branch} ${worktree.path} PR=#${pr.number} ${pr.state}${pr.isDraft ? " draft" : ""}${stale} - ${pr.title}`;
    }).join("; ");
  }));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
