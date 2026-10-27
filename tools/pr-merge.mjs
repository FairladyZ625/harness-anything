#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  approvedReviewHistoryForExecution,
  consentedApprovedReviewForExecution,
  currentExecutionCuts,
} from "@harness-anything/kernel";

const MAIN_BRANCH = "main";
const REMOTE = "origin";
// The kernel's task id shape (doc-sync-validation.ts taskFromPath): a PR head branch equal to a
// task id is the harness convention for task-bound PRs; anything else merges without the check.
const TASK_BRANCH_PATTERN = /^task_(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{26})$/u;
const RUNTIME_BUILD_PACKAGES = ["@harness-anything/daemon", "@harness-anything/cli"];

function run(command, args, { cwd, allowFailure = false } = {}) {
  const invocation =
    process.platform === "win32" && (command === "gh" || command === "ha")
      ? {
          command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
          args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsArgument).join(" ")],
          windowsVerbatimArguments: true,
        }
      : { command, args };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // A long-lived task's `ha task show --json` receipt grows past spawnSync's 1 MiB default
    // (PR #3502's was 2.2 MiB). maxBuffer only caps collection, it does not preallocate.
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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

function quoteWindowsArgument(value) {
  return /^[^\s"&|<>^()]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
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
    "mergeCommit",
    "isCrossRepository",
    "mergeable",
    "url",
  ].join(",");
  return JSON.parse(output("gh", ["pr", "view", selector, "--json", fields], { cwd: root }));
}

function requireCleanWorktree(worktree, label) {
  // Untracked files never block the guarded operations: `git pull --ff-only`
  // and `git worktree remove` refuse on their own when untracked files would
  // be lost, so only tracked-file modifications make the worktree dirty here.
  const status = output("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
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

  let pr = readPr(selector, mainWorktree.path);
  // GitHub reports UNKNOWN while it computes mergeability after a push or check result.
  for (let attempt = 0; pr.state === "OPEN" && pr.mergeable === "UNKNOWN" && attempt < 12; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
    pr = readPr(selector, mainWorktree.path);
  }
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

// The task-show receipt is the kernel's lifecycle snapshot. Its read has two callers with different
// contracts: the pre-merge gate must fail closed, while the post-merge merge-sha annotation is
// bookkeeping that must never be worded as a merge refusal after GitHub already merged the PR.
function readTaskLifecycleEvidence(taskId, root) {
  let receipt;
  try {
    receipt = JSON.parse(output("ha", ["task", "show", taskId, "--json"], { cwd: root }));
  } catch (error) {
    throw new Error(
      `Reading harness task ${taskId} failed (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (receipt?.ok !== true) {
    const code = typeof receipt?.error?.code === "string" ? receipt.error.code : "unknown_error";
    throw new Error(`Harness task show for ${taskId} was refused (code=${code}).`);
  }
  let evidence;
  try {
    evidence = JSON.parse(receipt.evidence);
  } catch {
    throw new Error(`Harness task show for ${taskId} returned a malformed receipt.`);
  }
  if (
    typeof evidence?.task?.status !== "string" ||
    evidence.task === null ||
    !["executions", "reviews", "consents", "gateWitnesses"].every((field) => Array.isArray(evidence[field]))
  ) {
    throw new Error(`Harness task show for ${taskId} returned no completion judgment.`);
  }
  return evidence;
}

// The merge gate for task-bound PRs: the kernel's own judgment over the task-show lifecycle snapshot
// decides whether the task's current execution has an owner-consented approved review. The completion
// blocker chain is not consulted: it names only the first unfinished step, and CI witnessing (which
// exists only after merging) precedes the review chain in it.
function readTaskReviewConsent(taskId, root) {
  try {
    return readTaskLifecycleEvidence(taskId, root);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        "Refusing to merge while the review-consent state is unknown (fail closed).",
    );
  }
}

// The kernel's own digest-pinned judgment over the receipt's lifecycle snapshot answers the one
// question the first-blocker chain cannot: does the current execution's cut carry an
// owner-consented approved review? A task that lifted the review and consent gates in its own
// closeoutOverrides (the lightweight declaration — task overrides win over every settings layer)
// owes no consent ever and would otherwise deadlock. Tasks without such a lift are held to the
// consent requirement even if repository settings relaxed it: settings are not part of the
// task-show receipt, so assuming them would fail open.
function reviewChainClosed(taskId, evidence) {
  const task = evidence.task,
    dispositions = Array.isArray(evidence.reviewDispositions) ? evidence.reviewDispositions : [];
  if (task.closeoutOverrides?.review === false && task.closeoutOverrides?.consent === false) return true;
  try {
    const cuts = currentExecutionCuts({
      task,
      executions: evidence.executions,
      reviews: evidence.reviews,
      consents: evidence.consents,
      reviewDispositions: dispositions,
      gateWitnesses: evidence.gateWitnesses,
    });
    if (cuts.length !== 1 || cuts[0].state !== "submitted") return false;
    return (
      consentedApprovedReviewForExecution(evidence.reviews, evidence.consents, cuts[0], dispositions) !== undefined
    );
  } catch (error) {
    throw new Error(
      `Judging the review-consent chain of harness task ${taskId} failed ` +
        `(${error instanceof Error ? error.message : String(error)}); refusing to merge (fail closed).`,
    );
  }
}

function requireReviewConsent(pr, root) {
  if (!TASK_BRANCH_PATTERN.test(pr.headRefName)) {
    console.log(`Branch ${pr.headRefName} is not a task branch; merging without a review-consent check.`);
    return null;
  }
  const taskId = pr.headRefName,
    evidence = readTaskReviewConsent(taskId, root);
  if (!reviewChainClosed(taskId, evidence)) {
    // reviewChainClosed already ran the same judgment, so re-deriving the cut here cannot throw.
    const dispositions = Array.isArray(evidence.reviewDispositions) ? evidence.reviewDispositions : [],
      cut = currentExecutionCuts({
        task: evidence.task,
        executions: evidence.executions,
        reviews: evidence.reviews,
        consents: evidence.consents,
        reviewDispositions: dispositions,
        gateWitnesses: evidence.gateWitnesses,
      }).find(({ state }) => state === "submitted"),
      // Consent states both ids explicitly; the printed command must work as printed.
      next =
        cut === undefined
          ? `ha task show ${taskId} for the current execution, then ha task review-consent ${taskId} ` +
            "--execution-id <execution-id> --review-id <review-id>"
          : approvedReviewHistoryForExecution(evidence.reviews, cut)
              .map(
                ({ reviewId }) =>
                  `ha task review-consent ${taskId} --execution-id ${cut.executionId} --review-id ${reviewId}`,
              )
              .join(" or ");
    throw new Error(
      `Task ${taskId} (status=${evidence.task.status}) has no owner-consented approved review for its ` +
        `current execution; refusing to merge. Next: ${next}`,
    );
  }
  console.log(`Task ${taskId} passed the review-consent check (status=${evidence.task.status}).`);
  return evidence;
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

  // gh's zero exit already proves the merge happened, so a failure to read the PR back must not abort
  // the cleanup: the annotation step re-reads the merge commit and reports itself unfinished instead.
  try {
    const merged = readPr(String(pr.number), root);
    if (merged.state === "MERGED") return merged;
    console.log(`PR #${pr.number} was merged by gh but GitHub still reports state=${merged.state}.`);
  } catch (error) {
    console.log(
      `PR #${pr.number} was merged by gh but reading it back failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { ...pr, state: "MERGED", mergeCommit: null };
}

function recordMergeCommitAnnotation(pr, merged, root, preMergeEvidence) {
  if (!TASK_BRANCH_PATTERN.test(pr.headRefName)) return;
  const taskId = pr.headRefName,
    // The open-PR path read the ledger before merging; reusing that snapshot keeps the annotation
    // from depending on a daemon that may be restarting into a new build right after the merge.
    evidence = preMergeEvidence ?? readTaskLifecycleEvidence(taskId, root),
    mergeCommitOid = merged.mergeCommit?.oid ?? readPr(String(pr.number), root).mergeCommit?.oid;
  if (!mergeCommitOid) throw new Error(`GitHub reports no merge commit for PR #${pr.number}.`);
  const cuts = currentExecutionCuts({
    task: evidence.task,
    executions: evidence.executions,
    reviews: evidence.reviews,
    consents: evidence.consents,
    reviewDispositions: evidence.reviewDispositions ?? [],
    gateWitnesses: evidence.gateWitnesses,
  });
  if (cuts.length !== 1) throw new Error(`Task ${taskId} has no unique current execution after merge.`);
  const note = `merge_commit_sha:${mergeCommitOid}`;
  const alreadyAnnotated = cuts[0].annotations?.some((entry) => entry.note === note);
  if (alreadyAnnotated) return;
  output(
    "ha",
    ["task", "annotate", taskId, "--execution-id", cuts[0].executionId, "--kind", "correction", "--note", note],
    { cwd: root },
  );
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
  const deletion = run("git", ["push", REMOTE, "--delete", branch], { cwd: root, allowFailure: true });
  if (deletion.status !== 0) {
    const detail = (deletion.stderr || deletion.stdout).trim();
    if (detail.includes(`error: unable to delete '${branch}': remote ref does not exist`)) {
      console.log(`Remote branch ${REMOTE}/${branch} is already absent.`);
      return;
    }
    throw new Error(`git push ${REMOTE} --delete ${branch} failed${detail ? `: ${detail}` : ""}`);
  }
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
      "A PR whose head branch is a task id must first have the owner-consented review of its",
      "current execution recorded in the harness ledger (ha task show); the check fails closed",
      "when the ledger is unreachable or its judgment cannot be read.",
      "After a merge every cleanup step runs; any unfinished step is reported with the command that",
      "finishes it, and the exit status is then non-zero.",
      "This helper never pulls the private harness ledger repository.",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

// `git pull` fetches and then reads .git/FETCH_HEAD, one file shared by every worktree of this
// repository. A concurrent fetch (the daemon fetches in the canonical checkout after a merge) can
// rewrite that file between the two steps, and pull then dies with "There are no candidates for
// merging among the refs that you just fetched" (PR #4048). Fetching into the remote-tracking ref
// with --no-write-fetch-head and merging that ref never reads the shared file.
function syncMain(root) {
  run("git", ["checkout", MAIN_BRANCH], { cwd: root });
  run(
    "git",
    [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      REMOTE,
      `+refs/heads/${MAIN_BRANCH}:refs/remotes/${REMOTE}/${MAIN_BRANCH}`,
    ],
    { cwd: root },
  );
  run("git", ["merge", "--ff-only", `${REMOTE}/${MAIN_BRANCH}`], { cwd: root });
  const head = output("git", ["rev-parse", "HEAD"], { cwd: root });
  console.log(`Local ${MAIN_BRANCH} synchronized to ${head}.`);
}

function rebuildRuntimePackages(root) {
  for (const packageName of RUNTIME_BUILD_PACKAGES) {
    try {
      run("npm", ["run", "build", "-w", packageName], { cwd: root });
    } catch (error) {
      throw new Error(
        `Building ${packageName} after synchronizing local ${MAIN_BRANCH} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

// Once GitHub reports MERGED the merge cannot be undone, so the only honest outcomes are "every
// post-merge step completed" or a report naming each unfinished step and the command that finishes
// it. A failure in one step must not silently skip the independent steps after it; only the rebuild
// genuinely depends on a synchronized main.
function finalizeMergedPr(pr, merged, prWorktree, root, preMergeEvidence) {
  const unfinished = [],
    attempt = (step, remedy, action) => {
      try {
        action();
      } catch (error) {
        unfinished.push({ step, remedy, detail: error instanceof Error ? error.message : String(error) });
      }
    };
  attempt(
    "annotate the current execution with merge_commit_sha",
    `node tools/pr-merge.mjs ${pr.number} (skips the merge for a merged PR and retries every unfinished step)`,
    () => recordMergeCommitAnnotation(pr, merged, root, preMergeEvidence),
  );
  attempt(`delete remote branch ${REMOTE}/${pr.headRefName}`, `git push ${REMOTE} --delete ${pr.headRefName}`, () =>
    deleteRemoteBranch(pr.headRefName, root),
  );
  attempt(
    `remove the local worktree and branch for ${pr.headRefName}`,
    prWorktree
      ? `git worktree remove ${prWorktree.path} && git branch -D ${pr.headRefName}`
      : `git branch -D ${pr.headRefName}`,
    () => removeLocalBranch(pr, prWorktree, root),
  );
  let synchronized = false;
  attempt(
    `synchronize local ${MAIN_BRANCH}`,
    `in ${root}: git checkout ${MAIN_BRANCH} && git fetch --no-write-fetch-head ${REMOTE} ` +
      `+refs/heads/${MAIN_BRANCH}:refs/remotes/${REMOTE}/${MAIN_BRANCH} && git merge --ff-only ${REMOTE}/${MAIN_BRANCH}`,
    () => {
      syncMain(root);
      synchronized = true;
    },
  );
  if (synchronized)
    attempt("rebuild the runtime packages", `npm run build -w ${RUNTIME_BUILD_PACKAGES.join(" -w ")}`, () =>
      rebuildRuntimePackages(root),
    );
  else
    unfinished.push({
      step: "rebuild the runtime packages",
      remedy: `npm run build -w ${RUNTIME_BUILD_PACKAGES.join(" -w ")} after local ${MAIN_BRANCH} synchronizes`,
      detail: `skipped because local ${MAIN_BRANCH} did not synchronize`,
    });
  return unfinished;
}

function reportUnfinished(pr, unfinished) {
  process.stderr.write(
    [
      `PR #${pr.number} is MERGED; ${unfinished.length} post-merge step(s) did not finish:`,
      ...unfinished.map(({ step, detail, remedy }) => `- ${step}: ${detail}\n  finish with: ${remedy}`),
    ].join("\n") + "\n",
  );
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
  let merged = pr,
    evidence = null;
  if (pr.state === "OPEN") {
    evidence = requireReviewConsent(pr, mainWorktree.path);
    merged = mergeOpenPr(pr, mainWorktree.path);
  } else {
    console.log(`PR #${pr.number} is already merged; continuing with cleanup.`);
  }
  const unfinished = finalizeMergedPr(pr, merged, prWorktree, mainWorktree.path, evidence);
  if (unfinished.length > 0) {
    reportUnfinished(pr, unfinished);
    process.exitCode = 1;
    return;
  }
  console.log("Private harness ledger was not pulled; use the daemon-stop procedure if it needs separate maintenance.");
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
