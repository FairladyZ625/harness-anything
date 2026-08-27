#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { extractGitHubRequiredStatusCheckContexts } from "./check-github-required-contexts.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
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
  const envRepo = process.env.GITHUB_REPOSITORY;
  if (isValidNameWithOwner(envRepo)) {
    return envRepo;
  }

  const remote = run("git", ["config", "--get", "remote.origin.url"]);
  const parsedRemote = parseGitHubRemote(remote);
  if (parsedRemote) {
    return parsedRemote;
  }

  return runJson("gh", ["repo", "view", "--json", "nameWithOwner"], {}).nameWithOwner;
}

function parseGitHubRemote(remote) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/u.exec(remote.trim());
  return isValidNameWithOwner(match?.[1]) ? match[1] : null;
}

function isValidNameWithOwner(value) {
  return typeof value === "string" && /^[^/\s]+\/[^/\s]+$/u.test(value);
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
  return Number.isFinite(completed) ? completed : Number.isFinite(started) ? started : 0;
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
    counts.missing ? `${counts.missing} missing` : null,
  ].filter(Boolean);
  return {
    summary: parts.join(", "),
    failed,
  };
}

function formatLabels(labels = []) {
  const names = labels.map((label) => label.name).filter(Boolean);
  return names.length ? names.join(",") : "-";
}

function githubRulesRequired(repo) {
  const rules = runJson("gh", ["api", `repos/${repo}/rules/branches/main`], []);
  const result = extractGitHubRequiredStatusCheckContexts(rules);
  if (!result.hasRequiredStatusCheckRule) {
    throw new Error("GitHub branch rules include no required_status_checks rule for main");
  }
  if (result.contexts.length === 0) {
    throw new Error("GitHub branch rules declare no required status check contexts for main");
  }
  return result.contexts;
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
    return runJson(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,state,title,isDraft,url,headRefName",
        "--limit",
        "5",
      ],
      [],
    );
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
  const requiredChecks = githubRulesRequired(repo);
  const prs = runJson(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,title,isDraft,labels,headRefName,headRefOid,url,statusCheckRollup",
      "--limit",
      "100",
    ],
    [],
  );

  console.log(`PR Doctor for ${repo}`);
  console.log(`Required contexts (${requiredChecks.length}): ${requiredChecks.join(", ")}`);

  printSection(
    "Open PRs",
    prs.map((pr) => {
      const checks = summarizeRequiredChecks(pr, requiredChecks);
      const suffix = checks.failed.length ? ` [${checks.failed.join("; ")}]` : "";
      return `#${pr.number} ${pr.isDraft ? "draft" : "ready"} labels=${formatLabels(pr.labels)} ${checks.summary}${suffix} - ${pr.title}`;
    }),
  );

  printSection(
    "Local Worktrees",
    parseWorktrees().map((worktree) => {
      const prsForBranch = prForBranch(worktree.branch);
      if (prsForBranch.length === 0) {
        return `${worktree.branch ?? "(detached)"} ${worktree.path} PR=none`;
      }
      return prsForBranch
        .map((pr) => {
          if (pr.state === "UNKNOWN") {
            return `${worktree.branch} ${worktree.path} PR=unknown - ${pr.title}`;
          }
          const stale = pr.state === "MERGED" ? " STALE-MERGED-WORKTREE" : "";
          return `${worktree.branch} ${worktree.path} PR=#${pr.number} ${pr.state}${pr.isDraft ? " draft" : ""}${stale} - ${pr.title}`;
        })
        .join("; ");
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
