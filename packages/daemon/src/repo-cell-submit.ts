import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  completionGuidance,
  currentExecutionCuts,
  heldLeaseForExecutionActor,
  isNativeExecution,
  isSameExecution,
  isSamePerson,
  isTaskEvent,
  resolveCompletionContract,
  productionDeltaFromNumstat,
  submissionFromCloseout,
  submissionDigest,
  sameWriteSource,
  sha256Text,
  resolveHarnessLayout,
  type DocEventChange,
  type SubmissionV1,
  type WriteSource,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { assertCurrentSubmittedExecution, currentCutReviewForReturn } from "./repo-cell-execution-selection.ts";
import { readSubmissionArtifact } from "./submission-artifacts.ts";
import { runDocAction } from "./doc-sync-actions.ts";
import { makeGitReadinessSource, runProcessText } from "./process-port.ts";
import { repositoryBaseRef } from "./schedule-occurrence-workspace.ts";
import { readTaskTransitionDocument } from "./transition-document-access.ts";
import { dispatchInReviewCutReview } from "./task-review-dispatch.ts";
import { presetSnapshotReader, taskOutputShape, taskWorktreeBinding } from "./task-worktree.ts";
import type { AuthoredCandidateInventoryV1 } from "./doc-sync-candidate-scanner.ts";

/** Git resolves the empty-tree object id virtually; it exists in every repository. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Structured execution binding selects the public delivery commit; Accepted task documents select artifacts. */
export function deriveCloseoutSubmission(
  cell: Pick<
    RepoCellOperationalContext,
    "rootDir" | "projection" | "store" | "cellCodedError" | "settings" | "projection"
  >,
  taskId: string,
  executionId: string,
  snapshot: Snapshot,
  bodyOverrides?: ReadonlyMap<string, string>,
  requestedCommit?: string,
  source?: WriteSource,
  carried?: { readonly changes: readonly DocEventChange[]; readonly revision: number },
): SubmissionV1 {
  const document = readTaskTransitionDocument({
      projection: cell.projection,
      taskId,
      slot: "task.closeout",
      bodyOverrides,
    }),
    frozen = snapshot.executions.find((execution) => execution.executionId === executionId)?.submission,
    // Parse/validate before reading any Git cut. No risk or verification line is filtered.
    parsed = submissionFromCloseout(
      document.body,
      {
        commitSha: "0".repeat(40),
        deliverables: [],
        outputs: [],
        completionContract: frozen?.completionContract ?? freezeCompletionContract(cell, snapshot),
      },
      document.contract ?? undefined,
    ),
    // The execution's first submission freezes the gate requirements; resumes and amendments keep them.
    prose = { ...parsed, completionContract: frozen?.completionContract ?? freezeCompletionContract(cell, snapshot) },
    readPresetSnapshot = presetSnapshotReader(cell.projection),
    privateDelivery = taskOutputShape(snapshot.task, readPresetSnapshot) !== "repository-diff",
    artifactPaths = automaticSubmissionArtifactPaths(
      cell.projection,
      snapshot,
      taskId,
      document.packagePath,
      carried?.changes,
    );
  const freezeArtifact = (artifact: string) => {
    const candidate = carried?.changes.find((change) => change.path === artifact)?.candidate;
    if (candidate) {
      const body = bodyOverrides?.get(artifact);
      if (body === undefined || sha256Text(body) !== candidate.sha256)
        throw cell.cellCodedError("invalid_submission", `Carried artifact ${artifact} does not match its candidate.`);
      return { path: artifact, revision: carried!.revision, blobSha256: candidate.sha256 };
    }
    const acceptedRevision = cell.projection.readDocument(artifact).document?.workspaceRevision;
    if (acceptedRevision === undefined)
      throw cell.cellCodedError(
        "invalid_submission",
        `Artifact ${artifact}: no center-accepted revision exists. Sync deliverables with ha doc sync --submit --task <task-id> before submitting.`,
      );
    return readSubmissionArtifact(cell, document.packagePath, artifact, acceptedRevision).anchor;
  };
  const artifacts = artifactPaths.map(freezeArtifact);
  // The delivery falls to the task's own output shape, not its completion gates (dec_BBA713052997C3EF5F5D3DD952):
  // a repository-diff task derives its public manifest even under a lightweight profile whose
  // gate set is empty; a task-package-artifact task delivers through accepted artifact versions.
  if (privateDelivery) {
    if (!artifacts.length)
      // The default stop guidance says to fill closeout.md, which never counts as a deliverable;
      // this rejection's real remedy is a deliverable file under the package's own artifacts/.
      throw Object.assign(
        cell.cellCodedError(
          "invalid_submission",
          `No accepted task artifacts were found. Sync deliverables with ha doc sync --submit --task <task-id> before submitting.`,
        ),
        {
          nextAction:
            `Write the deliverable into harness/${document.packagePath}/artifacts/ (closeout.md and runtime reports are not deliverables), ` +
            `run ha doc sync --submit --task ${taskId}, then run ha task submit ${taskId}.`,
        },
      );
    return {
      ...prose,
      commitSha: null,
      artifacts,
      deliverables: artifacts.map((anchor) => anchor.path),
      outputs: [],
    };
  }
  // An assignment's checkout belongs to its node. Its delivery was fetched from the
  // center's configured origin before enqueue; a leftover center checkout is not that node's HEAD.
  const remoteDelivery = typeof source === "object" && source.kind === "node";
  const dispatches = cell.projection
      .readRuntimeDispatchesByTaskExecution(taskId, executionId)
      .map(({ event }) => event.payload)
      .filter((dispatch) => dispatch.role !== "reviewer" && dispatch.cwd),
    binding = taskWorktreeBinding(snapshot.task, readPresetSnapshot),
    taskRoot = binding && !remoteDelivery ? path.join(cell.rootDir, binding.path) : null,
    git = makeGitReadinessSource(),
    // Only the bound task worktree names a delivery implicitly: a dispatch cwd may be any checkout,
    // canonical included, so it only locates an explicitly requested commit below.
    // A plain directory at the bound path would resolve to the enclosing checkout, so the path must be its own top level.
    boundHead = taskRoot ? git.run(taskRoot, ["rev-parse", "--show-toplevel", "HEAD"]) : null,
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
  const publishedRoot = [...new Set([...uniqueDirectories, cell.rootDir])].find(
    (candidate) => git.run(candidate, ["cat-file", "-e", `${namedCommit}^{commit}`]).ok,
  );
  if (!publishedRoot)
    throw cell.cellCodedError(
      "invalid_submission",
      `Delivery commit ${namedCommit} is not in any local clone of the bound or canonical repository; ` +
        "if it was just merged or pushed, run git fetch origin in the canonical checkout and rerun this command.",
    );
  const root = publishedRoot,
    commitSha = git.run(root, ["rev-parse", `${namedCommit}^{commit}`]).stdout;
  // Task delivery is not a Git publication state: a resolvable commit may be reviewed before it
  // becomes a bound worktree HEAD or reaches the default branch. The merge base below derives the cut's
  // file manifest only; it is not submission admission.
  const execution = snapshot.executions.find((value) => value.executionId === executionId),
    baseline = execution !== undefined && isNativeExecution(execution) ? execution.deliveryBaseline : undefined,
    defaultBranch = repositoryBaseRef(root),
    mergeBase = defaultBranch ? git.run(root, ["merge-base", defaultBranch, commitSha]) : { ok: false, stdout: "" },
    // The delivery commit is the default branch's own tip. A delivery lands there as a merge commit
    // (ordinary merge, never squash), and an artifact-only branch rebased onto an advanced main is
    // that very merge commit too — so its first-parent diff is the merged PR of whichever task wrote
    // it. Such a commit belongs to this task only through its own record: a frozen cut naming it,
    // this execution's own included, or an earlier cut this merge introduced (the ownership test
    // below) (task_96720a8e).
    publishedMerge =
      mergeBase.ok && mergeBase.stdout === commitSha
        ? git.run(root, ["rev-parse", "--verify", "--quiet", `${commitSha}^2`])
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
              git.run(root, ["merge-base", "--is-ancestor", commitSha, baseline.commitSha]).ok))
        : baseline === undefined && bound === commitSha;
  let deliverables: readonly string[],
    commitOutputs: readonly string[],
    changedFiles: readonly string[] | undefined,
    productionDelta: SubmissionV1["productionDelta"];
  // An unchanged published HEAD is a delivery only when this task's record owns it: another
  // execution's cut, or this execution's own frozen cut — an amendment re-derived at its merged
  // tip froze that merge's second parent. The execution baseline detects new work; task history,
  // rather than that observation, distinguishes a restarted delivery from another task's merge.
  const secondParent = unchanged ? publishedMerge : null,
    priorDelivery =
      unchanged &&
      snapshot.executions.some((prior) => {
        const sha = prior.submission?.commitSha;
        // Only a commit the merge introduced — reachable from its second parent yet absent from
        // main before it — evidences an earlier delivery of this cut. Any older main commit is
        // also reachable from the merged branch and would adopt another PR's manifest.
        return (
          !!sha &&
          (secondParent?.ok === true
            ? git.run(root, ["merge-base", "--is-ancestor", sha, secondParent.stdout]).ok &&
              !git.run(root, ["merge-base", "--is-ancestor", sha, `${commitSha}^1`]).ok
            : sha === commitSha)
        );
      });
  if (unchanged && mergeBase.ok && mergeBase.stdout === commitSha && !priorDelivery) {
    deliverables = [];
    commitOutputs = [];
  } else if (frozen?.commitSha === commitSha) {
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
      const firstParent = git.run(root, ["rev-parse", "--verify", "--quiet", `${commitSha}^1`]);
      base = firstParent.ok ? firstParent.stdout : baseline?.kind === "empty-tree" ? EMPTY_TREE_SHA : "";
    } else {
      // Repositories with no default branch to anchor against (unborn, or a main checkout on a detached HEAD) have
      // no derivable fork point; the start-frozen observation is the only record of where the delivery began.
      base = baseline.kind === "commit" ? baseline.commitSha : EMPTY_TREE_SHA;
      if (baseline.kind === "commit" && !git.run(root, ["cat-file", "-e", `${baseline.commitSha}^{commit}`]).ok)
        throw cell.cellCodedError(
          "invalid_submission",
          `Frozen delivery baseline ${baseline.commitSha} is not readable in the delivery repository.`,
        );
    }
    if (!base) throw cell.cellCodedError("invalid_submission", "Delivery commit has no verifiable comparison cut.");
    changedFiles = runProcessText("git", ["diff", "--name-only", "--no-renames", "-z", base, commitSha, "--"], root)
      .split("\0")
      .filter(Boolean)
      .sort();
    const numstat = runProcessText("git", ["diff", "--no-renames", "--numstat", "-z", base, commitSha, "--"], root)
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const firstTab = record.indexOf("\t"),
          secondTab = record.indexOf("\t", firstTab + 1);
        if (firstTab < 0 || secondTab < 0)
          throw cell.cellCodedError("invalid_submission", "Git produced an invalid numstat record.");
        return {
          addedText: record.slice(0, firstTab),
          deletedText: record.slice(firstTab + 1, secondTab),
          filePath: record.slice(secondTab + 1),
        };
      });
    productionDelta = { baseSha: base, ...productionDeltaFromNumstat(numstat) };
    deliverables = runProcessText(
      "git",
      ["diff", "--name-only", "-z", "--diff-filter=ACMRT", base, commitSha, "--"],
      root,
    )
      .split("\0")
      .filter(Boolean);
    commitOutputs = runProcessText("git", ["diff", "--name-only", "-z", "--diff-filter=D", base, commitSha, "--"], root)
      .split("\0")
      .filter(Boolean)
      .map((target) => `Deleted-Production-Paths: ${target}`);
  }
  // Deliverables stay paths of the delivery commit: anchored in-package artifacts ride in the
  // artifacts field and outputs lines so commit-based gates never verify ledger paths against
  // the public cut.
  const delivery = {
    ...prose,
    ...(artifacts.length ? { artifacts } : {}),
    deliverables,
    ...(changedFiles ? { changedFiles } : {}),
    outputs: [...commitOutputs, ...artifacts.map((anchor) => `Artifact-Anchor: ${anchor.path}@${anchor.revision}`)],
    ...(productionDelta ? { productionDelta } : {}),
  };
  // An empty public manifest has no code cut to witness, including when HEAD is an empty commit.
  return deliverables.length || commitOutputs.length
    ? { ...delivery, commitSha }
    : (() => {
        const artifactOnly = { ...delivery };
        delete artifactOnly.changedFiles;
        delete artifactOnly.productionDelta;
        return { ...artifactOnly, commitSha: null, artifacts };
      })();
}

/** Accepted task artifacts select implicit deliveries; reviewer outputs are credentials, not deliveries. */
function automaticSubmissionArtifactPaths(
  projection: RepoCellOperationalContext["projection"],
  snapshot: Snapshot,
  taskId: string,
  packagePath: string,
  carried: readonly DocEventChange[] = [],
): readonly string[] {
  const reportStems = new Set([
      ...snapshot.reviews.map((review) => review.reviewId.replace(/^review-/u, "")),
      ...snapshot.executions.flatMap((execution) =>
        projection
          .readRuntimeDispatchesByTaskExecution(taskId, execution.executionId)
          .map(({ event }) => event.payload.dispatchId),
      ),
    ]),
    runtimeReportPaths = new Set(
      [...reportStems].flatMap((stem) => [
        `${packagePath}/artifacts/reports/${stem}.md`,
        `${packagePath}/artifacts/reports/${stem}.json`,
      ]),
    );
  return [
    ...new Set([
      ...projection.readDocuments(`${packagePath}/artifacts/`).documents.map(({ path }) => path),
      ...carried.filter((change) => change.candidate !== null).map(({ path }) => path),
    ]),
  ]
    .filter(
      (path) =>
        path.startsWith(`${packagePath}/artifacts/`) && !path.endsWith("/.gitkeep") && !runtimeReportPaths.has(path),
    )
    .sort();
}

function taskWorktreeRoot(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "projection">,
  snapshot: Snapshot,
): string | null {
  const binding = taskWorktreeBinding(snapshot.task, presetSnapshotReader(cell.projection));
  if (binding === null) return null;
  const taskRoot = path.join(cell.rootDir, binding.path),
    directory = lstatSync(taskRoot, { throwIfNoEntry: false }),
    top =
      directory?.isDirectory() && !directory.isSymbolicLink()
        ? makeGitReadinessSource().run(taskRoot, ["rev-parse", "--show-toplevel"])
        : null;
  return top?.ok && realpathSync(top.stdout.trim()) === realpathSync(taskRoot) ? taskRoot : null;
}

function taskWorktreeCandidateInventory(
  rootDir: string,
  taskRoot: string,
  packagePath: string | null,
  baseLedgerSha: AuthoredCandidateInventoryV1["baseLedgerSha"],
  projection: RepoCellOperationalContext["projection"],
): AuthoredCandidateInventoryV1 | undefined {
  if (packagePath === null) return undefined;
  const layout = resolveHarnessLayout(rootDir),
    authoredRelative = path.relative(layout.rootDir, layout.authoredRoot),
    authoredOutsideCheckout =
      authoredRelative === ".." || authoredRelative.startsWith(`..${path.sep}`) || path.isAbsolute(authoredRelative),
    packageRoot = authoredOutsideCheckout ? null : path.resolve(taskRoot, authoredRelative, ...packagePath.split("/")),
    taskRootResolved = path.resolve(taskRoot);
  if (packageRoot === null) return undefined;
  if (packageRoot !== taskRootResolved && !packageRoot.startsWith(`${taskRootResolved}${path.sep}`))
    throw new Error(`Task package ${packagePath} escapes its bound worktree.`);
  const rows: Array<AuthoredCandidateInventoryV1["rows"][number]> = [];
  collectTaskPackageCandidates(packageRoot, packagePath, rows);
  return {
    schema: "harness-authored-candidate-inventory/v1",
    baseLedgerSha,
    rows: rows.filter(
      (row) =>
        row.path.startsWith(`${packagePath}/artifacts/`) &&
        !row.path.endsWith("/.gitkeep") &&
        projection.readDocument(row.path).document === null,
    ),
  };
}

function collectTaskPackageCandidates(
  directory: string,
  logicalDirectory: string,
  rows: Array<AuthoredCandidateInventoryV1["rows"][number]>,
): void {
  const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name),
      logical = `${logicalDirectory}/${entry.name}`,
      stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      collectTaskPackageCandidates(absolute, logical, rows);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      rows.push({ path: logical, safe: false, size: null, bytes: null, conflicts: [] });
      continue;
    }
    const bytes = readFileSync(absolute);
    rows.push({ path: logical, safe: true, size: bytes.byteLength, bytes, conflicts: [] });
  }
}

function freezeCompletionContract(
  cell: Pick<RepoCellOperationalContext, "cellCodedError" | "settings" | "projection">,
  snapshot: Snapshot,
): SubmissionV1["completionContract"] {
  const frozenPreset = cell.projection.readPresetSnapshot(snapshot.task!.presetSnapshotDigest!)
    .snapshot as import("@harness-anything/preset").PresetSnapshotV1;
  const resolved = resolveCompletionContract(
    snapshot.task?.completionGateIds ?? [],
    cell.settings.readRepository(),
    frozenPreset,
    snapshot.task?.closeoutOverrides,
  );
  if (!resolved.ok) throw cell.cellCodedError("gate_mapping_invalid", resolved.message);
  // The cut freezes the resolved reviewer declaration so a later settings change never redirects a
  // cut already under review; cuts frozen before the field fall back to the repository default.
  return {
    ...resolved.contract,
    reviewer: { agentId: cell.settings.readRepository().roles?.defaultReviewer ?? "closeout-reviewer" },
  };
}

/**
 * The submit/amend advisory: accepted artifact deliveries moved under an unchanged closeout.
 * `outputs`, `deliverables`, `commitSha`, and `artifacts` all derive from the delivery cut rather
 * than closeout.md, so prose equality compares only the fields `submissionFromCloseout` authors.
 * Digest reuse keeps one submission-identity mechanism; the warning never gates the write.
 */
const closeoutProse = (value: SubmissionV1): SubmissionV1 => ({
  ...value,
  deliverables: [],
  outputs: [],
  commitSha: null,
  artifacts: [],
});

export function submissionAnchorDriftWarnings(
  previous: SubmissionV1 | null | undefined,
  submission: SubmissionV1,
): readonly string[] {
  if (
    !previous ||
    submissionDigest(previous) === submissionDigest(submission) ||
    submissionDigest(closeoutProse(previous)) !== submissionDigest(closeoutProse(submission))
  )
    return [];
  return [
    "Anchored artifact deliveries changed while the closeout prose did not; " +
      "verify the closeout claim still describes the delivered artifacts.",
  ];
}

/**
 * The owning creator who is not the submission holder has two real lanes onto a submitted cut —
 * neither is the plain resume this refusal just denied: replace the cut in place with an owner
 * amendment, or return it (with the recorded review once one exists) to reopen the rework round.
 */
function ownerResumeLanes(
  snapshot: Snapshot,
  taskId: string,
  actor: RepoCellBinding["actor"],
  executionId: string,
): string {
  const task = snapshot.task;
  if (!task || !isSamePerson(task.createdBy, actor)) return "";
  const review = currentCutReviewForReturn(snapshot, executionId);
  return (
    ` The owning creator may instead replace the cut with ha task submit ${taskId} --amend --as-owner` +
    `, or reopen the rework round with ha task adjudicate ${taskId} --return${review ? ` --review-id ${review.reviewId}` : ""}.`
  );
}

/**
 * Initial submissions, amendments, and resumed submissions share the in-review dispatch port.
 * The frozen review requirement determines the task phase; review-disabled cuts dispatch nothing.
 */
async function submittedCutReview(
  cell: RepoCellOperationalContext,
  taskId: string,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  receipt: WriteReceiptDraft,
): Promise<{ readonly steps: readonly WriteReceiptDraft[]; readonly warnings: readonly string[] }> {
  const dispatched = await dispatchInReviewCutReview(cell, taskId, action, binding, receipt);
  return dispatched
    ? { steps: [dispatched.step, ...dispatched.laneSteps], warnings: dispatched.laneWarnings }
    : { steps: [], warnings: [] };
}

export async function submitTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceiptDraft> {
  if (["submission", "fromFile", "jsonInput"].some((field) => action[field] !== undefined))
    throw cell.cellCodedError(
      "invalid_command",
      "Write closeout.md, then run ha task submit without a submission packet.",
    );
  // Owner recovery retains the ordinary lease proof: rejoin the active execution through the
  // existing settle path, then return here as a normal lease holder. `--as-owner` does not grant
  // a lease-free write or replace the worker's recorded execution attribution.
  if (action.asOwner === true && action.amend !== true) return settleTask(cell, { ...action, asOwner: false }, binding);
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    current = await cell.service.read(taskId),
    held = heldLeaseForExecutionActor(current.snapshot, undefined, binding.actor),
    cuts = currentExecutionCuts(current.snapshot),
    selected =
      typeof action.executionId === "string"
        ? current.snapshot.executions.find((execution) => execution.executionId === action.executionId)
        : held
          ? current.snapshot.executions.find((execution) => execution.executionId === held.executionId)
          : cuts.length === 1
            ? cuts[0]
            : undefined;
  const ownerAmendment =
    action.amend === true &&
    action.asOwner === true &&
    current.snapshot.task !== null &&
    isSamePerson(current.snapshot.task.createdBy, binding.actor);
  // An owning principal who rejoined from a terminal holds the lease without an executor
  // descriptor; the execution still records the runtime that did the work. First submission
  // through that held lease is admitted on person identity alone — the ordinary lease, source,
  // version, and CAS checks below still gate it.
  const ownerSubmission =
    action.amend !== true &&
    selected !== undefined &&
    selected.submission === null &&
    current.snapshot.task !== null &&
    isSamePerson(current.snapshot.task.createdBy, binding.actor) &&
    isSamePerson(selected.actor, binding.actor);
  // Recovery authority is the submission event caller, not the retained execution attribution.
  const submissionOpId =
      selected?.submission && action.amend !== true
        ? cell.projection.readTaskSubmissionOperation(taskId, selected.executionId)
        : null,
    event = submissionOpId === null ? null : cell.store.readEvent(submissionOpId);
  if (selected?.submission && action.amend !== true) {
    if (
      !event ||
      !isTaskEvent(event) ||
      event.type !== "execution_submitted" ||
      event.taskId !== taskId ||
      event.payload.execution.executionId !== selected.executionId ||
      !event.payload.execution.submission ||
      submissionDigest(event.payload.execution.submission) !== submissionDigest(selected.submission) ||
      !isSameExecution(event.actor, binding.actor) ||
      !sameWriteSource(event.source, binding.source)
    )
      throw cell.cellCodedError(
        "lease_required",
        `Only the original submission holder may resume this cut.${ownerResumeLanes(current.snapshot, taskId, binding.actor, selected.executionId)}`,
      );
  }
  if (!selected || (!isSameExecution(selected.actor, binding.actor) && !ownerAmendment && !ownerSubmission && !event))
    return cell.lifecycleAction(action, binding);
  const executionId = selected.executionId,
    amendCommand = `ha task submit ${taskId} --amend${
      current.snapshot.task &&
      isSamePerson(current.snapshot.task.createdBy, binding.actor) &&
      !isSameExecution(selected.actor, binding.actor)
        ? " --as-owner"
        : ""
    }`;
  if (action.amend === true) assertCurrentSubmittedExecution(current.snapshot, taskId, executionId);
  if (!selected.submission && (!held || !sameWriteSource(current.snapshot.lease?.source, binding.source)))
    return cell.lifecycleAction(action, binding);
  if (Array.isArray(action.docChanges)) {
    // Reuse the existing atomic carried-document submission path. A submitted cut with
    // changed edge documents must be amended explicitly, never silently synchronized.
    if (selected.submission && action.amend !== true)
      throw cell.cellCodedError("invalid_transition", `Carried documents change a submitted cut; use ${amendCommand}.`);
    const receipt = await cell.runTaskCommandWithDocs(
      { ...action, executionId, docChanges: action.docChanges } as Parameters<typeof cell.runTaskCommandWithDocs>[0],
      binding,
    );
    if (receipt.outcome !== "applied") return receipt;
    const review = await submittedCutReview(cell, taskId, action, binding, receipt);
    return {
      ...receipt,
      ...(review.warnings.length ? { warnings: review.warnings } : {}),
      steps: review.steps,
    } as WriteReceiptDraft;
  }
  // Assignment callers carry their changed documents above. With no carried changes,
  // consume center-accepted content; never scan the center worktree on an edge's behalf.
  const taskRoot = taskWorktreeRoot(cell, current.snapshot),
    authoredCandidateInventory =
      taskRoot === null || (typeof binding.source === "object" && binding.source.kind === "node")
        ? undefined
        : taskWorktreeCandidateInventory(
            cell.rootDir,
            taskRoot,
            current.packagePath,
            cell.store.currentCut(),
            cell.projection,
          ),
    synced =
      typeof binding.source === "object" && binding.source.kind === "node"
        ? null
        : await runDocAction({
            action: { kind: "doc-submit", taskId },
            binding,
            rootDir: cell.rootDir,
            workspaceId: cell.input.repoId,
            store: cell.store,
            projection: cell.projection,
            now: cell.now,
            ...(authoredCandidateInventory ? { authoredCandidateInventory } : {}),
          });
  if (synced && !["applied", "no_changes"].includes(synced.outcome))
    return {
      ...synced,
      next: [
        completionGuidance(
          current.snapshot,
          executionId,
          `ha task submit ${taskId}`,
          `Document synchronization is ${synced.outcome}; resume this submission after receipt ${synced.opId} settles.`,
        ),
      ],
    } as WriteReceiptDraft;
  const fresh = await cell.service.read(taskId),
    derived = readCloseoutSubmission(
      cell,
      taskId,
      executionId,
      fresh.snapshot,
      undefined,
      typeof action.commitSha === "string" ? action.commitSha : undefined,
      binding.source,
    );
  if (!derived.ok)
    return submissionStopped(
      cell,
      action,
      binding,
      fresh.snapshot,
      executionId,
      fresh.packagePath,
      derived.error,
      synced ? [synced] : [],
    );
  const submission = derived.submission;
  const anchorDriftWarnings = submissionAnchorDriftWarnings(selected.submission, submission);
  // A lost response resumes the stored cut only when the synchronized closeout still derives the same submission.
  if (selected.submission && action.amend !== true) {
    if (submissionDigest(selected.submission) !== submissionDigest(submission))
      return {
        ...cell.rejected(
          cell.operationId(action, binding, cell.input.repoId, fresh.snapshot.revision),
          "invalid_transition",
        ),
        rejectionExplanation: "The closeout or anchored artifacts differ from the submitted cut.",
        next: [
          completionGuidance(
            fresh.snapshot,
            executionId,
            amendCommand,
            "Amend the submitted cut explicitly before review.",
          ),
        ],
        steps: synced ? [synced] : [],
      } as WriteReceiptDraft;
    const receipt = cell.receiptForOperation(event!.opId, binding);
    if (receipt.outcome !== "applied") return receipt;
    const review = await submittedCutReview(cell, taskId, action, binding, receipt);
    return {
      ...receipt,
      ...(review.warnings.length ? { warnings: review.warnings } : {}),
      steps: review.steps,
    } as WriteReceiptDraft;
  }
  if (selected.submission && submissionDigest(selected.submission) === submissionDigest(submission))
    return submitTask(cell, { ...action, amend: false }, binding);
  const receipt = await cell.lifecycleAction({ ...action, executionId, submission }, binding);
  if (receipt.outcome !== "applied") return receipt;
  const review = await submittedCutReview(cell, taskId, action, binding, receipt),
    warnings = [...anchorDriftWarnings, ...review.warnings];
  return {
    ...receipt,
    ...(warnings.length ? { warnings } : {}),
    steps: [...(synced ? [synced] : []), ...review.steps],
  } as WriteReceiptDraft;
}

/**
 * `ha task settle`: the deterministic half of post-delivery work, assembled once. Lease
 * admission rides the ordinary task-start catalog entry; the delivery itself is exactly one
 * `submitTask` call — no second doc-submit or evidence-preparation pipeline exists here.
 * Anything needing judgment (missing closeout prose, a foreign holder, a cut that differs
 * from what is stored, a preset that moved) stops on the step that rejected it.
 */
export async function settleTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceiptDraft> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    current = await cell.service.read(taskId);
  if (!current.snapshot.task) throw cell.cellCodedError("entity_not_found", `Task ${taskId} does not exist.`);
  const held = heldLeaseForExecutionActor(current.snapshot, undefined, binding.actor),
    alreadySubmitted = currentExecutionCuts(current.snapshot).some((execution) => execution.state === "submitted"),
    steps: WriteReceiptDraft[] = [];
  // A submitted current round needs no lease — the holder checks inside submitTask decide
  // whether this caller may resume or amend that cut. Everything else needs a held lease;
  // the ordinary start path rejoins the active round execution or starts a fresh one and
  // rejects with its own guidance when admission is impossible.
  if (!held && !alreadySubmitted) {
    cell.assertTaskWipCapacity(taskId, "active");
    const started = await cell.lifecycleAction({ kind: "task-start", taskId }, binding);
    steps.push(started);
    if (!["applied", "no_changes"].includes(started.outcome))
      return {
        ...started,
        opId: cell.operationId(action, binding, cell.input.repoId, current.snapshot.revision),
        steps,
      } as WriteReceiptDraft;
  }
  const submitted = await submitTask(cell, { ...action, kind: "task-submit", taskId }, binding),
    mergedSteps = [...steps, ...((submitted as { readonly steps?: readonly WriteReceiptDraft[] }).steps ?? [])];
  if (submitted.outcome !== "applied") return { ...submitted, steps: mergedSteps } as WriteReceiptDraft;
  return { ...submitted, steps: mergedSteps } as WriteReceiptDraft;
}

const submissionStopCodes = ["closeout_placeholder", "invalid_submission", "gate_mapping_invalid"];

/** A stop guard that knows its own remedy attaches it to the error it throws; the closeout default covers the rest. */
function submissionStopNextAction(error: Error): string | null {
  const action = (error as Error & { readonly nextAction?: unknown }).nextAction;
  return typeof action === "string" && action !== "" ? action : null;
}

export function submissionStopped(
  cell: Pick<RepoCellOperationalContext, "rejected" | "operationId" | "input">,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  snapshot: Snapshot,
  executionId: string,
  packagePath: string | null,
  error: unknown,
  steps: readonly WriteReceiptDraft[] = [],
): WriteReceiptDraft {
  if (!(error instanceof Error) || !("code" in error) || !submissionStopCodes.includes(String(error.code))) throw error;
  const code = error.code === "invalid_submission" ? "document_invalid" : String(error.code);
  return {
    ...cell.rejected(cell.operationId(action, binding, cell.input.repoId, snapshot.revision), code),
    // The remapped code alone cannot say why the document was rejected; the guard's own message can.
    rejectionExplanation: error.message,
    next: [
      completionGuidance(
        snapshot,
        executionId,
        submissionStopNextAction(error) ??
          (code === "gate_mapping_invalid"
            ? `Map every declared gate in harness.yaml settings.gates, then run ha task submit ${String(action.taskId)}.`
            : `Fill harness/${packagePath}/closeout.md, run ha doc sync --submit --task ${String(action.taskId)}, ` +
              `then run ha task submit ${String(action.taskId)}.`),
        error.message,
      ),
    ],
    steps,
  } as WriteReceiptDraft;
}

export function readCloseoutSubmission(
  ...args: Parameters<typeof deriveCloseoutSubmission>
): { readonly ok: true; readonly submission: SubmissionV1 } | { readonly ok: false; readonly error: Error } {
  try {
    return { ok: true, submission: deriveCloseoutSubmission(...args) };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !submissionStopCodes.includes(String(error.code)))
      throw error;
    return { ok: false, error };
  }
}
