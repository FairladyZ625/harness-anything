#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const MAIN_BRANCH = "main";
const REMOTE = "origin";

function run(command, args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`${command} failed to launch: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function output(command, args, options) {
  return run(command, args, options).stdout.trim();
}

function parseWorktrees(root) {
  return output("git", ["worktree", "list", "--porcelain"], { cwd: root })
    .split(/\n\n+/u)
    .filter(Boolean)
    .map((block) => {
      const entry = {};
      for (const line of block.split(/\n/u)) {
        const [key, ...rest] = line.split(" ");
        if (key === "worktree") entry.path = rest.join(" ");
        if (key === "branch") entry.branch = rest.join(" ").replace(/^refs\/heads\//u, "");
      }
      return entry;
    });
}

function readPr(selector, root) {
  const fields = [
    "number",
    "state",
    "isDraft",
    "baseRefName",
    "headRefName",
    "headRefOid",
    "isCrossRepository",
    "mergeable",
    "url",
  ].join(",");
  return JSON.parse(output("gh", ["pr", "view", selector, "--json", fields], { cwd: root }));
}

function requireCleanWorktree(worktree, label) {
  const status = output("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: worktree.path,
  });
  if (status) {
    throw new Error(`${label} worktree is dirty at ${worktree.path}; refusing to merge, delete, or pull.\n${status}`);
  }
}

function preflight(selector) {
  const invocationRoot = output("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  const worktrees = parseWorktrees(invocationRoot);
  const mainWorktree = worktrees.find((entry) => entry.branch === MAIN_BRANCH);
  if (!mainWorktree) {
    throw new Error(`No worktree has ${MAIN_BRANCH} checked out; create or restore the local main worktree first.`);
  }
  if (invocationRoot !== mainWorktree.path) {
    throw new Error(`Run this helper from the main worktree: ${mainWorktree.path}`);
  }

  const pr = readPr(selector, mainWorktree.path);
  if (!Number.isInteger(pr.number) || !pr.headRefName || !pr.headRefOid) {
    throw new Error("GitHub returned incomplete PR identity data.");
  }
  if (pr.baseRefName !== MAIN_BRANCH) {
    throw new Error(`PR #${pr.number} targets ${pr.baseRefName}, not ${MAIN_BRANCH}.`);
  }
  if (pr.headRefName === MAIN_BRANCH) {
    throw new Error(`Refusing to clean protected branch ${MAIN_BRANCH}.`);
  }
  if (pr.isCrossRepository) {
    throw new Error(`PR #${pr.number} comes from a fork; this helper only deletes branches from ${REMOTE}.`);
  }
  if (!/^[0-9a-f]{40}$/u.test(pr.headRefOid)) {
    throw new Error(`PR #${pr.number} has an invalid head commit: ${pr.headRefOid}`);
  }
  if (pr.state !== "OPEN" && pr.state !== "MERGED") {
    throw new Error(`PR #${pr.number} is ${pr.state}; only open or merged PRs can be finalized.`);
  }
  if (pr.state === "OPEN" && pr.isDraft) {
    throw new Error(`PR #${pr.number} is still a draft.`);
  }
  if (pr.state === "OPEN" && pr.mergeable !== "MERGEABLE") {
    throw new Error(`PR #${pr.number} is not mergeable (mergeable=${pr.mergeable}).`);
  }

  const prWorktree = worktrees.find((entry) => entry.branch === pr.headRefName);
  requireCleanWorktree(mainWorktree, "main");
  if (prWorktree) requireCleanWorktree(prWorktree, `PR branch ${pr.headRefName}`);

  return { mainWorktree, pr, prWorktree };
}

function mergeOpenPr(pr, root) {
  const checks = run("gh", ["pr", "checks", String(pr.number), "--required"], {
    cwd: root,
    allowFailure: true,
  });
  if (checks.status !== 0) {
    const detail = (checks.stderr || checks.stdout).trim();
    throw new Error(`Required checks for PR #${pr.number} are not all successful${detail ? `:\n${detail}` : "."}`);
  }
  if (checks.stdout.trim()) process.stdout.write(checks.stdout);

  const merge = run(
    "gh",
    ["pr", "merge", String(pr.number), "--merge", "--admin", "--match-head-commit", pr.headRefOid],
    { cwd: root },
  );
  if (merge.stdout) process.stdout.write(merge.stdout);

  const merged = readPr(String(pr.number), root);
  if (merged.state !== "MERGED") {
    throw new Error(`PR #${pr.number} did not reach MERGED state (state=${merged.state}).`);
  }
}

function deleteRemoteBranch(branch, root) {
  const remoteRef = `refs/heads/${branch}`;
  const probe = run("git", ["ls-remote", "--exit-code", "--heads", REMOTE, remoteRef], {
    cwd: root,
    allowFailure: true,
  });
  if (probe.status === 2) {
    console.log(`Remote branch ${REMOTE}/${branch} is already absent.`);
    return;
  }
  if (probe.status !== 0) {
    throw new Error(`Unable to inspect ${REMOTE}/${branch}: ${(probe.stderr || probe.stdout).trim()}`);
  }
  run("git", ["push", REMOTE, "--delete", branch], { cwd: root });
  console.log(`Deleted remote branch ${REMOTE}/${branch}.`);
}

function removeLocalBranch(pr, prWorktree, root) {
  if (prWorktree) {
    run("git", ["worktree", "remove", prWorktree.path], { cwd: root });
    console.log(`Removed worktree ${prWorktree.path}.`);
  }

  const localRef = run("git", ["show-ref", "--quiet", "--verify", `refs/heads/${pr.headRefName}`], {
    cwd: root,
    allowFailure: true,
  });
  if (localRef.status === 0) {
    run("git", ["branch", "-D", pr.headRefName], { cwd: root });
    console.log(`Deleted local branch ${pr.headRefName}.`);
  } else if (localRef.status !== 1) {
    throw new Error(`Unable to inspect local branch ${pr.headRefName}: ${localRef.stderr.trim()}`);
  }
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node tools/pr-merge.mjs <PR-number-or-url>",
      "",
      "From the local main worktree: merge the PR after required checks pass, delete its",
      "origin branch, remove its clean local worktree/branch, and fast-forward local main.",
      "This helper never pulls the private harness ledger repository.",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    throw new Error("Provide exactly one PR number or URL. Run with --help for usage.");
  }

  const { mainWorktree, pr, prWorktree } = preflight(argv[0]);
  console.log(`Finalizing PR #${pr.number} (${pr.headRefName} -> ${MAIN_BRANCH}).`);
  if (pr.state === "OPEN") mergeOpenPr(pr, mainWorktree.path);
  else console.log(`PR #${pr.number} is already merged; continuing with cleanup.`);

  deleteRemoteBranch(pr.headRefName, mainWorktree.path);
  removeLocalBranch(pr, prWorktree, mainWorktree.path);
  run("git", ["checkout", MAIN_BRANCH], { cwd: mainWorktree.path });
  run("git", ["pull", "--ff-only", REMOTE, MAIN_BRANCH], { cwd: mainWorktree.path });
  const head = output("git", ["rev-parse", "HEAD"], { cwd: mainWorktree.path });
  console.log(`Local ${MAIN_BRANCH} synchronized to ${head}.`);
  console.log("Private harness ledger was not pulled; use the daemon-stop procedure if it needs separate maintenance.");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
