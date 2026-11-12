import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import {
  isNativeExecution,
  parseNumstatRecords,
  productionDeltaFromNumstat,
  type SubmissionV1,
  type WriteSource,
} from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { Snapshot } from "./repo-cell-types.ts";
import { runProcessExitAsync, runProcessTextAsync } from "./process-port.ts";
import { repositoryBaseRefAsync } from "./schedule-occurrence-workspace.ts";
import { presetSnapshotReader, taskOutputShape, taskWorktreeBinding } from "./task-worktree.ts";
import {
  assessTaskRiskTier,
  readTaskRiskManifest,
  type TaskRiskManifest,
  type TaskRiskTierScriptInput,
} from "./task-risk-tier.ts";
import { assertNoIgnoredLedgerDelivery } from "./ignored-ledger-delivery.ts";
import { detectHostingProvider } from "./hosting-provider.ts";

const deliveryGitTimeoutMs = 30_000;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
type DeliveryCell = Pick<RepoCellOperationalContext, "rootDir" | "projection" | "cellCodedError" | "settings">;
type DeliveryFacts = Pick<SubmissionV1, "commitSha" | "deliverables" | "outputs" | "changedFiles" | "productionDelta">;

export interface PreparedSubmissionDelivery {
  readonly facts: DeliveryFacts | null;
  readonly publicPullRequest: boolean;
  readonly risk:
    | {
        readonly ok: true;
        readonly assessment: SubmissionV1["riskTierAssessment"];
        readonly manifest: TaskRiskManifest;
      }
    | { readonly ok: false; readonly error: unknown };
  readonly assertCurrent: () => Promise<void>;
  /** A concurrent identical amendment may reuse its new frozen cut; fresh candidates must reprepare. */
  readonly assertFresh?: () => void;
}

/** All process work finishes before the publication turn; only constant-size ref checks run there. */
export async function prepareSubmissionDelivery(
  cell: DeliveryCell,
  taskId: string,
  executionId: string,
  snapshot: Snapshot,
  requestedCommit?: string,
  source?: WriteSource,
): Promise<PreparedSubmissionDelivery> {
  const frozen = snapshot.executions.find((execution) => execution.executionId === executionId)?.submission,
    readPresetSnapshot = presetSnapshotReader(cell.projection),
    privateDelivery = taskOutputShape(snapshot.task, readPresetSnapshot) !== "repository-diff";
  if (privateDelivery) return finish(null, cell.rootDir, null, null, false, async () => {});
  // An assignment's checkout belongs to its node. Its delivery was fetched from the
  // center's configured origin before enqueue; a leftover center checkout is not that node's HEAD.
  const remoteDelivery = typeof source === "object" && source.kind === "node";
  const dispatches = cell.projection
      .readRuntimeDispatchesByTaskExecution(taskId, executionId)
      .map(({ event }) => event.payload)
      .filter((dispatch) => dispatch.role !== "reviewer" && dispatch.cwd),
    binding = taskWorktreeBinding(snapshot.task, readPresetSnapshot),
    taskRoot = binding && !remoteDelivery ? path.join(cell.rootDir, binding.path) : null,
    // Only the bound task worktree names a delivery implicitly: a dispatch cwd may be any checkout,
    // canonical included, so it only locates an explicitly requested commit below.
    // A plain directory at the bound path would resolve to the enclosing checkout, so the path must be its own top level.
    boundHead = taskRoot ? await gitRead(taskRoot, ["rev-parse", "--show-toplevel", "HEAD"]) : null,
    [boundTop, boundSha] = boundHead?.ok ? boundHead.stdout.split("\n") : [],
    bound = boundTop && boundSha && realpathSync(boundTop) === realpathSync(taskRoot!) ? boundSha : undefined,
    uniqueDirectories = remoteDelivery
      ? [cell.rootDir]
      : [...new Set([...(taskRoot ? [taskRoot] : []), ...dispatches.map((dispatch) => dispatch.cwd!)])],
    namedCommit = requestedCommit ?? bound;
  if (!namedCommit)
    throw cell.cellCodedError(
      "invalid_submission",
      "No readable bound worktree HEAD exists; rerun with --commit <40-character-sha>.",
    );
  if (requestedCommit && bound && requestedCommit !== bound)
    throw cell.cellCodedError(
      "invalid_submission",
      `Requested delivery commit ${requestedCommit} does not match bound worktree HEAD ${bound}.`,
    );
  let publishedRoot: string | undefined;
  for (const candidate of new Set([...uniqueDirectories, cell.rootDir])) {
    if ((await gitRead(candidate, ["cat-file", "-e", `${namedCommit}^{commit}`])).ok) {
      publishedRoot = candidate;
      break;
    }
  }
  if (!publishedRoot)
    throw cell.cellCodedError(
      "invalid_submission",
      `Delivery commit ${namedCommit} is not in any local clone of the bound or canonical repository; ` +
        "if it was just merged or pushed, run git fetch origin in the canonical checkout and rerun this command.",
    );
  const root = publishedRoot,
    commitSha = (await gitRead(root, ["rev-parse", `${namedCommit}^{commit}`])).stdout;
  // Task delivery is not a Git publication state: a resolvable commit may be reviewed before it
  // becomes a bound worktree HEAD or reaches the default branch. The merge base below derives the cut's
  // file manifest only; it is not submission admission.
  const execution = snapshot.executions.find((value) => value.executionId === executionId),
    baseline = execution !== undefined && isNativeExecution(execution) ? execution.deliveryBaseline : undefined,
    origin = await gitRead(root, ["remote", "get-url", "origin"]);
  if (origin.ok) await refreshOrigin(root, cell);
  const defaultBranch = await repositoryBaseRefAsync(root),
    defaultSha = defaultBranch ? (await gitRead(root, ["rev-parse", `${defaultBranch}^{commit}`])).stdout : null,
    mergeBase = defaultSha ? await gitRead(root, ["merge-base", defaultSha, commitSha]) : { ok: false, stdout: "" },
    // The delivery commit is the default branch's own tip. A delivery lands there as a merge commit
    // (ordinary merge, never squash), and an artifact-only branch rebased onto an advanced main is
    // that very merge commit too — so its first-parent diff is the merged PR of whichever task wrote
    // it. Such a commit belongs to this task only through its own record: a frozen cut naming it,
    // this execution's own included, or an earlier cut this merge introduced (the ownership test
    // below) (task_96720a8e).
    publishedMerge =
      mergeBase.ok && mergeBase.stdout === commitSha
        ? await gitRead(root, ["rev-parse", "--verify", "--quiet", `${commitSha}^2`])
        : null,
    unclaimedPublishedMerge =
      requestedCommit === undefined && frozen?.commitSha !== commitSha && publishedMerge?.ok === true,
    // No new work: an inferred delivery commit at or behind the frozen baseline never moved past
    // where its delivery began — the branch's fork for a bound task, where the project HEAD sat at
    // start otherwise — and one main publishes without this task's record produced no commit of its
    // own, so its first-parent merge diff would bill another task's PR here. An explicitly requested
    // commit stays the operator's own cut assertion and keeps the fork-point manifest rule
    // (F-70FB11C4).
    unchanged =
      baseline?.kind === "commit"
        ? baseline.commitSha === commitSha ||
          (requestedCommit === undefined &&
            (unclaimedPublishedMerge ||
              (await gitRead(root, ["merge-base", "--is-ancestor", commitSha, baseline.commitSha])).ok))
        : baseline === undefined && bound === commitSha;
  let deliverables: readonly string[],
    commitOutputs: readonly string[],
    riskBaseSha: string | null = null,
    changedFiles: readonly string[] | undefined,
    productionDelta: SubmissionV1["productionDelta"];
  // An unchanged published HEAD is a delivery only when this task's record owns it: another
  // execution's cut, or this execution's own frozen cut — an amendment re-derived at its merged
  // tip froze that merge's second parent. The execution baseline detects new work; task history,
  // rather than that observation, distinguishes a restarted delivery from another task's merge.
  const secondParent = unchanged ? publishedMerge : null;
  let priorDelivery = false;
  if (unchanged) {
    for (const prior of snapshot.executions) {
      const sha = prior.submission?.commitSha;
      if (
        sha &&
        (secondParent?.ok === true
          ? (await gitRead(root, ["merge-base", "--is-ancestor", sha, secondParent.stdout])).ok &&
            !(await gitRead(root, ["merge-base", "--is-ancestor", sha, `${commitSha}^1`])).ok
          : sha === commitSha)
      ) {
        priorDelivery = true;
        break;
      }
    }
  }
  if (unchanged && mergeBase.ok && mergeBase.stdout === commitSha && !priorDelivery) {
    deliverables = [];
    commitOutputs = [];
  } else if (
    frozen?.commitSha === commitSha &&
    frozen.changedFiles !== undefined &&
    frozen.productionDelta !== undefined
  ) {
    // A submitted commit already owns its file manifest. Advancing main must not
    // shrink a branch-wide diff to the last commit; prose and artifacts remain freshly derived.
    deliverables = frozen.deliverables;
    commitOutputs = frozen.outputs.filter((output) => !output.startsWith("Artifact-Anchor: "));
    changedFiles = frozen.changedFiles;
    productionDelta = frozen.productionDelta;
  } else {
    // One delivery commit owns one manifest: the comparison cut derives from the commit's own fork
    // point on the default branch unless start explicitly pinned an approved upstream delivery; never
    // from where the project HEAD happened to sit when the execution
    // started (F-70FB11C4). Advancing main cannot move a merge base, so the manifest stays identical
    // across submit, publication, and re-derivation. A repository without a remote, or without origin/HEAD,
    // anchors on the branch its main checkout has out: that local branch is where its deliveries land.
    let base: string;
    if (baseline?.kind === "commit" && baseline.stackOn) {
      // A stacked execution owns the cut from its approved upstream delivery, including CEO merges.
      // Main's merge-base would omit files brought in by those merges and include upstream work.
      base = baseline.commitSha;
    } else if (mergeBase.ok && mergeBase.stdout !== commitSha) {
      // Unpublished fork: everything reachable from the commit and not from the default branch.
      base = mergeBase.stdout;
    } else if (mergeBase.ok || baseline === undefined) {
      // A published cut — the merge base is the commit itself — compares against its first parent:
      // the pre-merge main of a merge commit is exactly that PR's branch-wide diff. Executions from
      // before the baseline freeze (dec_D23B9787328EF7E0FACB70F9FE) keep the same first-parent rule. A root
      // commit has no first parent: it delivers its whole tree only when the execution started before any commit.
      const firstParent = await gitRead(root, ["rev-parse", "--verify", "--quiet", `${commitSha}^1`]);
      base = firstParent.ok ? firstParent.stdout : baseline?.kind === "empty-tree" ? EMPTY_TREE_SHA : "";
    } else {
      // Repositories with no default branch to anchor against (unborn, or a main checkout on a detached HEAD) have
      // no derivable fork point; the start-frozen observation is the only record of where the delivery began.
      base = baseline.kind === "commit" ? baseline.commitSha : EMPTY_TREE_SHA;
      if (baseline.kind === "commit" && !(await gitRead(root, ["cat-file", "-e", `${baseline.commitSha}^{commit}`])).ok)
        throw cell.cellCodedError(
          "invalid_submission",
          `Frozen delivery baseline ${baseline.commitSha} is not readable in the delivery repository.`,
        );
    }
    if (!base) throw cell.cellCodedError("invalid_submission", "Delivery commit has no verifiable comparison cut.");
    riskBaseSha = base;
    changedFiles = (
      await runProcessTextAsync("git", ["diff", "--name-only", "--no-renames", "-z", base, commitSha, "--"], root)
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    const numstatOutput = await runProcessTextAsync(
        "git",
        ["diff", "--no-renames", "--numstat", "-z", base, commitSha, "--"],
        root,
      ),
      numstat = (() => {
        try {
          return parseNumstatRecords(numstatOutput);
        } catch (error) {
          throw cell.cellCodedError("invalid_submission", error instanceof Error ? error.message : String(error));
        }
      })();
    productionDelta = { baseSha: base, ...productionDeltaFromNumstat(numstat) };
    deliverables = (
      await runProcessTextAsync(
        "git",
        ["diff", "--name-only", "-z", "--diff-filter=ACMRT", base, commitSha, "--"],
        root,
      )
    )
      .split("\0")
      .filter(Boolean);
    commitOutputs = (
      await runProcessTextAsync("git", ["diff", "--name-only", "-z", "--diff-filter=D", base, commitSha, "--"], root)
    )
      .split("\0")
      .filter(Boolean)
      .map((target) => `Deleted-Production-Paths: ${target}`);
  }
  const facts: DeliveryFacts =
    deliverables.length || commitOutputs.length
      ? {
          commitSha,
          deliverables,
          outputs: commitOutputs,
          ...(changedFiles ? { changedFiles } : {}),
          ...(productionDelta ? { productionDelta } : {}),
        }
      : { commitSha: null, deliverables, outputs: commitOutputs };
  if (facts.productionDelta && facts.commitSha)
    await assertNoIgnoredLedgerDelivery(root, facts.productionDelta.baseSha, facts.commitSha);
  const publicPullRequest = Boolean(await detectHostingProvider(cell.rootDir, undefined, true));
  return finish(facts, root, riskBaseSha, commitSha, publicPullRequest, async () => {
    const currentRef = await repositoryBaseRefAsync(root),
      currentSha = currentRef ? (await gitRead(root, ["rev-parse", `${currentRef}^{commit}`])).stdout : null,
      // An unrelated default-branch advance does not change this immutable delivery's fork.
      // Recheck the comparison cut rather than rejecting concurrent document publications.
      sameComparisonCut =
        currentSha === defaultSha ||
        (currentSha !== null &&
          mergeBase.ok &&
          (await gitRead(root, ["merge-base", currentSha, commitSha])).stdout === mergeBase.stdout);
    if (
      currentRef !== defaultBranch ||
      !sameComparisonCut ||
      (taskRoot && (await gitRead(taskRoot, ["rev-parse", "--show-toplevel", "HEAD"])).stdout !== boundHead?.stdout)
    )
      throw cell.cellCodedError(
        "invalid_transition",
        "Delivery HEAD or default branch changed during submission preparation; retry task submit.",
      );
  });

  async function finish(
    facts: DeliveryFacts | null,
    rootDir: string,
    baseSha: string | null,
    headSha: string | null,
    publicPullRequest: boolean,
    assertCurrent: () => Promise<void>,
  ): Promise<PreparedSubmissionDelivery> {
    try {
      const manifest = readTaskRiskManifest(cell.rootDir),
        delivery =
          baseSha === null || headSha === null
            ? { baseSha, headSha, files: [] }
            : await readDeliveryRiskDiff(rootDir, baseSha, headSha);
      const risk: PreparedSubmissionDelivery["risk"] = {
        ok: true,
        manifest,
        assessment: await assessTaskRiskTier({
          rootDir: cell.rootDir,
          task: taskRiskIdentity(snapshot, taskId),
          delivery,
          pathReviewers: cell.settings.readRepository().review?.pathReviewers,
          matchedPathReviewers: [],
          ...(frozen?.riskTierAssessment ? { previousEffectiveTier: frozen.riskTierAssessment.effectiveTier } : {}),
        }),
      };
      return { facts, publicPullRequest, risk, assertCurrent };
    } catch (error) {
      // A legacy/same frozen cut needs no new assessment. Its final identity includes documents,
      // which are accepted only inside the queue; preserve that verdict there, including errors.
      return { facts, publicPullRequest, risk: { ok: false, error }, assertCurrent };
    }
  }
}

const originRefreshes = new Map<string, Promise<void>>();

/** Linked worktrees share refs. Coalesce their in-flight refresh and leave FETCH_HEAD untouched. */
async function refreshOrigin(rootDir: string, cell: DeliveryCell): Promise<void> {
  const common = (
      await runProcessTextAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], rootDir)
    ).trim(),
    key = realpathSync(common);
  let refreshing = originRefreshes.get(key);
  if (!refreshing) {
    refreshing = runProcessTextAsync(
      "git",
      ["fetch", "--quiet", "--no-write-fetch-head", "origin"],
      rootDir,
      { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      undefined,
      undefined,
      { timeoutMs: deliveryGitTimeoutMs },
    ).then(() => undefined);
    originRefreshes.set(key, refreshing);
  }
  try {
    await refreshing;
  } catch (error) {
    const details =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr !== ""
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw cell.cellCodedError(
      "invalid_submission",
      `Could not refresh origin before deriving delivery facts; refusing to freeze against a stale default branch. ${details}`,
    );
  } finally {
    if (originRefreshes.get(key) === refreshing) originRefreshes.delete(key);
  }
}

async function gitRead(
  rootDir: string,
  args: readonly string[],
): Promise<{ readonly ok: boolean; readonly stdout: string }> {
  if (!existsSync(rootDir)) return { ok: false, stdout: "" };
  const result = await runProcessExitAsync("git", args, rootDir, undefined, undefined, undefined, {
    timeoutMs: deliveryGitTimeoutMs,
  });
  return { ok: result.exitCode === 0, stdout: result.exitCode === 0 ? result.stdout.trim() : "" };
}

function taskRiskIdentity(snapshot: Snapshot, taskId: string): TaskRiskTierScriptInput["task"] {
  const metadata = snapshot.task?.metadata;
  return {
    taskId,
    declaredTier: metadata?.riskTier ?? "medium",
    verticalId: metadata?.verticalId ?? "software/coding",
    presetId: metadata?.presetId ?? "standard-task",
    workKind: metadata?.workKind ?? null,
  };
}

async function readDeliveryRiskDiff(
  rootDir: string,
  baseSha: string,
  headSha: string,
): Promise<TaskRiskTierScriptInput["delivery"]> {
  const gitArgs = ["--find-renames", baseSha, headSha, "--"],
    [statusText, numstatText] = await Promise.all([
      runProcessTextAsync(
        "git",
        ["diff", "--name-status", "-z", ...gitArgs],
        rootDir,
        undefined,
        undefined,
        undefined,
        {
          timeoutMs: deliveryGitTimeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        },
      ),
      runProcessTextAsync("git", ["diff", "--numstat", "-z", ...gitArgs], rootDir, undefined, undefined, undefined, {
        timeoutMs: deliveryGitTimeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      }),
    ]),
    statusTokens = statusText.split("\0").filter(Boolean),
    numstatTokens = numstatText.split("\0").filter(Boolean),
    statuses = new Map<string, TaskRiskTierScriptInput["delivery"]["files"][number]["status"]>(),
    counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let index = 0; index < statusTokens.length; ) {
    const code = statusTokens[index++]!,
      oldPath = statusTokens[index++]!;
    if (code.startsWith("R") || code.startsWith("C")) {
      const newPath = statusTokens[index++]!;
      statuses.set(newPath, code.startsWith("R") ? "renamed" : "copied");
    } else {
      statuses.set(
        oldPath,
        code === "A" ? "added" : code === "D" ? "deleted" : code === "T" ? "type-changed" : "modified",
      );
    }
  }
  for (let index = 0; index < numstatTokens.length; ) {
    const row = numstatTokens[index++]!,
      firstTab = row.indexOf("\t"),
      secondTab = row.indexOf("\t", firstTab + 1),
      added = row.slice(0, firstTab),
      removed = row.slice(firstTab + 1, secondTab),
      inlinePath = row.slice(secondTab + 1),
      oldPath = inlinePath || (numstatTokens[index++] ?? ""),
      finalPath = inlinePath || (numstatTokens[index++] ?? oldPath);
    if (!finalPath) continue;
    const binary = added === "-" || removed === "-";
    counts.set(finalPath, {
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(removed),
      binary,
    });
  }
  const paths = [...statuses.keys()].sort(),
    files: TaskRiskTierScriptInput["delivery"]["files"][number][] = [];
  for (let offset = 0; offset < paths.length; offset += 4) {
    const batch = await Promise.all(
      paths.slice(offset, offset + 4).map(async (filePath) => {
        const patch = await runProcessTextAsync(
          "git",
          ["diff", "--no-ext-diff", "--binary", "--find-renames", baseSha, headSha, "--", filePath],
          rootDir,
          undefined,
          undefined,
          undefined,
          { timeoutMs: deliveryGitTimeoutMs, maxBuffer: 16 * 1024 * 1024 },
        );
        return {
          path: filePath,
          status: statuses.get(filePath)!,
          ...(counts.get(filePath) ?? { additions: 0, deletions: 0, binary: false }),
          patch,
        };
      }),
    );
    files.push(...batch);
  }
  return { baseSha, headSha, files };
}
