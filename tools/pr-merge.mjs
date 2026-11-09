#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { checkWorkspaceLinks, workspaceLinkFailure } from "../packages/daemon/src/workspace-link-integrity.ts";

const MAIN_BRANCH = "main";
const REMOTE = "origin";
// The kernel's task id shape (doc-sync-validation.ts taskFromPath): a PR head branch equal to a
// task id is the harness convention for task-bound PRs; anything else merges without the check.
const TASK_BRANCH_PATTERN = /^task_(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{26})$/u;
const RUNTIME_BUILD_PACKAGES = ["@harness-anything/daemon", "@harness-anything/cli"];

function run(command, args, { cwd, allowFailure = false, env, stdio = ["ignore", "pipe", "pipe"] } = {}) {
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
    stdio,
    // A long-lived task's `ha task show --json` receipt grows past spawnSync's 1 MiB default
    // (PR #3502's was 2.2 MiB). maxBuffer only caps collection, it does not preallocate.
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  if (result.error) {
    throw new Error(`${command} failed to launch: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
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
  // Untracked files never block the guarded operations: `git merge --ff-only`
  // and `git worktree remove` refuse on their own when untracked files would
  // be lost, so only tracked-file modifications make the worktree dirty here.
  const status = output("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
    cwd: worktree.path,
  });
  if (status) {
    throw new Error(
      `${label} worktree is dirty at ${worktree.path}; refusing to merge, delete, or synchronize.\n${status}`,
    );
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

// The task-show receipt carries the kernel's lifecycle snapshot and its one completion judgment:
// `completionBlocker` ({code, gate} or null) and the `completionNext` remediation. The merge gate
// reads that judgment instead of re-deriving review or consent from the projection. The post-merge
// annotation reads the same receipt, but its failures are bookkeeping and never a merge refusal.
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
    evidence === null ||
    typeof evidence.task?.status !== "string" ||
    !Array.isArray(evidence.executions) ||
    !("completionBlocker" in evidence) ||
    !("completionNext" in evidence)
  ) {
    throw new Error(`Harness task show for ${taskId} returned no completion judgment.`);
  }
  return evidence;
}

// Fail closed: an unreachable ledger or a receipt without the completion judgment cannot authorize
// a merge.
function readTaskCompletionJudgment(taskId, root) {
  try {
    return readTaskLifecycleEvidence(taskId, root);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        "Refusing to merge while the completion judgment is unknown (fail closed).",
    );
  }
}

// The receipt names the cut its completion judgment is about in completionNext.readCut. The merge
// gate reads the frozen delivery commit from that server-chosen cut: filtering executions locally is
// what disagreed with the ledger's submission digest (#4412), and ambiguity is the server's call.
function judgedCut(evidence) {
  const readCut = evidence.completionNext?.readCut;
  if (readCut === null || readCut === undefined) return undefined;
  return evidence.executions.find(
    (execution) =>
      execution?.executionId === readCut.executionId &&
      execution.iteration === readCut.iteration &&
      execution.submission !== null &&
      execution.submission !== undefined,
  );
}

// Replay the exact frozen patch in Git's object database and compare the complete head tree.
// merge-tree avoids lossy patch transport and does not mutate the worktree or index.
function replayEquivalentPatch(root, frozenBase, frozenCommit, rebasedBase, rebasedHead) {
  try {
    const replayedTree = output(
        "git",
        ["merge-tree", "--write-tree", "--merge-base", frozenBase, rebasedBase, frozenCommit],
        { cwd: root },
      ),
      headTree = output("git", ["rev-parse", `${rebasedHead}^{tree}`], { cwd: root });
    return replayedTree === headTree;
  } catch {
    return false;
  }
}

// `gh pr merge --merge` makes the PR head the merge commit's second parent, so completion's
// deliveryContainment() proves the submitted delivery from that ancestry only when the head *is*
// the frozen delivery commit. A rebase changes the commit identity without necessarily changing
// the reviewed change. Replaying the frozen patch must produce the complete new head tree;
// context changes may alter patch-id without altering the reviewed change. Content differences
// still take the existing re-freeze path.
function equivalentRebasedCut(cut, pr, root) {
  const frozen = cut?.submission?.commitSha,
    base = cut?.submission?.productionDelta?.baseSha;
  if (
    typeof frozen !== "string" ||
    typeof base !== "string" ||
    frozen === pr.headRefOid ||
    !/^[0-9a-f]{40}$/u.test(frozen) ||
    !/^[0-9a-f]{40}$/u.test(base)
  )
    return null;
  try {
    run(
      "git",
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        REMOTE,
        `+refs/heads/${MAIN_BRANCH}:refs/remotes/${REMOTE}/${MAIN_BRANCH}`,
        `+refs/heads/${pr.headRefName}:refs/remotes/${REMOTE}/${pr.headRefName}`,
      ],
      { cwd: root },
    );
    const rebasedBase = output("git", ["merge-base", `refs/remotes/${REMOTE}/${MAIN_BRANCH}`, pr.headRefOid], {
      cwd: root,
    });
    if (!replayEquivalentPatch(root, base, frozen, rebasedBase, pr.headRefOid)) return null;
    return { frozen, head: pr.headRefOid, base: rebasedBase };
  } catch {
    // Missing objects or an unavailable remote cannot prove equivalence; keep the merge fail closed.
    return null;
  }
}

function requireMergedHeadIsFrozenCut(taskId, cut, pr, root) {
  const frozen = cut?.submission?.commitSha;
  if (frozen === null || frozen === undefined || frozen === pr.headRefOid) return null;
  const equivalent = equivalentRebasedCut(cut, pr, root);
  if (equivalent !== null) return equivalent;
  throw new Error(
    `Task ${taskId} froze its delivery at ${frozen}, but PR #${pr.number} head is ${pr.headRefOid}; ` +
      "merging this head would leave the frozen cut out of the merge commit and ha task complete " +
      "would then refuse the delivery as delivery_missing. Re-freeze the cut at the PR head so the " +
      `delivery and its review pin name that commit: ha task submit ${taskId} --amend ` +
      "(--as-owner when the task owner amends a worker's cut), then merge again once the amended " +
      "cut meets its review and consent requirements. Refusing to merge.",
  );
}

function requireCompletionGate(pr, root) {
  if (!TASK_BRANCH_PATTERN.test(pr.headRefName)) {
    console.log(`Branch ${pr.headRefName} is not a task branch; merging without a completion check.`);
    return null;
  }
  const taskId = pr.headRefName,
    evidence = readTaskCompletionJudgment(taskId, root),
    blocker = evidence.completionBlocker;
  // The ledger's one completion judgment decides this gate: null means delivery is already proven,
  // `delivery` means only the merge is missing. Every other gate names work that a merge cannot
  // finish, so the server's own remediation is printed verbatim instead of a locally derived one.
  if (blocker !== null && blocker.gate !== "delivery") {
    const action = evidence.completionNext?.action;
    if (typeof action !== "string")
      throw new Error(
        `Harness task show for ${taskId} reported completion blocker ${blocker.code} ` +
          `(gate=${blocker.gate}) without its remediation; refusing to merge (fail closed).`,
      );
    throw new Error(
      `Task ${taskId} (status=${evidence.task.status}) is blocked from completion by ` +
        `${blocker.code} (gate=${blocker.gate}); refusing to merge. Next: ${action}`,
    );
  }
  const cut = judgedCut(evidence);
  // A task PR always owes the frozen-cut comparison: without a server-named submitted execution the
  // merge cannot prove its head contains the delivery, whatever the blocker says (protocol permits a
  // null blocker with completionNext: null, and readCut.executionId: null). Fail closed.
  if (cut === undefined)
    throw new Error(
      `Harness task show for ${taskId} named no submitted delivery cut ` +
        `(blocker=${blocker?.code ?? "none"}); refusing to merge (fail closed).`,
    );
  const equivalent = requireMergedHeadIsFrozenCut(taskId, cut, pr, root);
  if (equivalent !== null && equivalent !== undefined) {
    evidence.rebaseEquivalent = equivalent;
    console.log(
      `Task ${taskId} accepted a rebase-equivalent delivery patch and advanced its merge cut to ${equivalent.head}.`,
    );
  }
  console.log(
    `Task ${taskId} passed the completion check (status=${evidence.task.status}, blocker=${blocker?.code ?? "none"}).`,
  );
  return evidence;
}

function positiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function enqueueOpenPr(pr, root) {
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
    ["pr", "merge", String(pr.number), "--auto", "--merge", "--match-head-commit", pr.headRefOid],
    { cwd: root },
  );
  if (merge.stdout) process.stdout.write(merge.stdout);
  console.log(`PR #${pr.number} was added to the GitHub merge queue at ${pr.headRefOid}.`);
}

function waitForMergedPr(pr, root) {
  const maxPolls = positiveIntegerEnv("PR_MERGE_MAX_POLLS", 720),
    waitMs = positiveIntegerEnv("PR_MERGE_WAIT_MS", 5_000);
  for (let attempt = 0; attempt <= maxPolls; attempt += 1) {
    const current = readPr(String(pr.number), root);
    if (current.state === "MERGED") return current;
    if (current.state !== "OPEN") throw new Error(`PR #${pr.number} left the merge queue with state=${current.state}.`);
    if (attempt === maxPolls)
      throw new Error(
        `PR #${pr.number} remained OPEN after ${maxPolls} merge-queue polls; ` +
          "inspect the queue and rerun this command after the required checks settle.",
      );
    console.log(`Waiting for PR #${pr.number} to merge (poll ${attempt + 1}/${maxPolls}).`);
    if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  }
  throw new Error(`PR #${pr.number} did not reach a terminal merge state.`);
}

function recordMergeCommitAnnotation(pr, merged, root, preMergeEvidence) {
  if (!TASK_BRANCH_PATTERN.test(pr.headRefName)) return;
  const taskId = pr.headRefName,
    // The open-PR path read the ledger before merging; reusing that snapshot keeps the annotation
    // from depending on a daemon that may be restarting into a new build right after the merge.
    evidence = preMergeEvidence ?? readTaskLifecycleEvidence(taskId, root),
    mergeCommitOid = merged.mergeCommit?.oid ?? readPr(String(pr.number), root).mergeCommit?.oid;
  if (!mergeCommitOid) throw new Error(`GitHub reports no merge commit for PR #${pr.number}.`);
  const cut = judgedCut(evidence);
  // A ledger that already reports no blocker proved this delivery before the merge; its annotation
  // is present or not required, and there is no server-named cut left to append to.
  if (cut === undefined) {
    if (evidence.completionBlocker === null) return;
    throw new Error(`Task ${taskId} has no server-named delivery cut after merge.`);
  }
  const equivalent = evidence.rebaseEquivalent;
  if (equivalent !== undefined) {
    const equivalenceNote = `rebase-equivalent:${equivalent.frozen}->${equivalent.head}:base=${equivalent.base}`;
    if (!cut.annotations?.some((entry) => entry.note === equivalenceNote))
      output(
        "ha",
        [
          "task",
          "annotate",
          taskId,
          "--execution-id",
          cut.executionId,
          "--kind",
          "correction",
          "--note",
          equivalenceNote,
        ],
        { cwd: root },
      );
  }
  const note = `merge_commit_sha:${mergeCommitOid}`;
  const alreadyAnnotated = cut.annotations?.some((entry) => entry.note === note);
  if (alreadyAnnotated) return;
  output(
    "ha",
    ["task", "annotate", taskId, "--execution-id", cut.executionId, "--kind", "correction", "--note", note],
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
      "       node tools/pr-merge.mjs <PR-number-or-url> [<PR> ...]",
      "",
      "From the local main worktree: enqueue one or more PRs after required checks pass, wait for",
      "GitHub's merge queue to merge them, delete their",
      "origin branch, remove its clean local worktree/branch, and fast-forward local main.",
      "A PR whose head branch is a task id must first pass the harness ledger's server-side completion",
      "judgment (ha task show completionBlocker): only a null blocker or a delivery blocker may merge.",
      "Any other gate refuses before the merge and prints the ledger's own remediation verbatim; the",
      "check fails closed when the ledger is unreachable or its judgment cannot be read. Its head must",
      "also be the execution's frozen delivery commit: a branch that moved after submit (rebase or",
      "follow-up push) is refused before the merge, because the merge commit would not contain that",
      "delivery.",
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
  const workspaceLinks = checkWorkspaceLinks(root);
  if (!workspaceLinks.ok) throw workspaceLinkFailure(workspaceLinks.findings[0]);
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

function reportUnfinished(pr, unfinished, phase = "merged") {
  const prefix =
    phase === "queue"
      ? `PR #${pr.number} was not merged; ${unfinished.length} merge-queue step(s) did not finish:`
      : `PR #${pr.number} is MERGED; ${unfinished.length} post-merge step(s) did not finish:`;
  process.stderr.write(
    [prefix, ...unfinished.map(({ step, detail, remedy }) => `- ${step}: ${detail}\n  finish with: ${remedy}`)].join(
      "\n",
    ) + "\n",
  );
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.length === 0 || argv.some((selector) => selector.startsWith("-")))
    throw new Error("Provide one or more PR numbers or URLs. Run with --help for usage.");

  const entries = argv.map((selector) => ({ selector, ...preflight(selector) })),
    numbers = new Set(entries.map(({ pr }) => pr.number));
  if (numbers.size !== entries.length) throw new Error("Provide each PR only once.");
  const openEntries = entries.filter(({ pr }) => pr.state === "OPEN"),
    evidenceByNumber = new Map();
  for (const { pr, mainWorktree } of openEntries)
    evidenceByNumber.set(pr.number, requireCompletionGate(pr, mainWorktree.path));
  for (const { pr, mainWorktree } of openEntries) enqueueOpenPr(pr, mainWorktree.path);

  const unfinishedEntries = [];
  for (const { pr, prWorktree, mainWorktree } of entries) {
    console.log(`Finalizing PR #${pr.number} (${pr.headRefName} -> ${MAIN_BRANCH}).`);
    let merged = pr;
    if (pr.state === "OPEN") {
      try {
        merged = waitForMergedPr(pr, mainWorktree.path);
      } catch (error) {
        // Queue entries fail independently. Continue with the remaining entries so one rejected
        // or timed-out PR cannot abandon bookkeeping for PRs that did merge successfully.
        unfinishedEntries.push({
          pr,
          phase: "queue",
          unfinished: [
            {
              step: "wait for the merge queue to merge this PR",
              remedy: `node tools/pr-merge.mjs ${pr.number}`,
              detail: error instanceof Error ? error.message : String(error),
            },
          ],
        });
        continue;
      }
    } else console.log(`PR #${pr.number} is already merged; continuing with cleanup.`);
    try {
      const unfinished = finalizeMergedPr(
        pr,
        merged,
        prWorktree,
        mainWorktree.path,
        evidenceByNumber.get(pr.number) ?? null,
      );
      if (unfinished.length > 0) unfinishedEntries.push({ pr, phase: "merged", unfinished });
    } catch (error) {
      unfinishedEntries.push({
        pr,
        phase: "merged",
        unfinished: [
          {
            step: "post-merge bookkeeping",
            remedy: `node tools/pr-merge.mjs ${pr.number}`,
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }
  for (const { pr, phase, unfinished } of unfinishedEntries) reportUnfinished(pr, unfinished, phase);
  if (unfinishedEntries.length > 0) {
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
