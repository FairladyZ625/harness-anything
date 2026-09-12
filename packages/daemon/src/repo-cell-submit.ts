import {
  completionGuidance,
  currentExecutionCuts,
  heldLeaseForExecutionActor,
  isSameExecution,
  isTaskEvent,
  submissionFromCloseout,
  submissionDigest,
  type SubmissionV1,
  type WriteReceiptDraft,
} from "../../kernel/src/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { assertCurrentSubmittedExecution } from "./repo-cell-execution-selection.ts";
import { artifactAnchors, readSubmissionArtifact } from "./submission-artifacts.ts";
import { readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { runDocAction } from "./doc-sync-actions.ts";
import { makeGitReadinessSource, runProcessText } from "./process-port.ts";
import { readTaskTransitionDocument } from "./transition-document-access.ts";
import { prepareSubmissionEvidence } from "./repo-cell-task-progress.ts";

/** Summary explicitly selects a public commit or center-accepted artifact revisions. */
export function deriveCloseoutSubmission(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "projection" | "store" | "cellCodedError">,
  taskId: string,
  executionId: string,
  snapshot: Snapshot,
  bodyOverrides?: ReadonlyMap<string, string>,
): SubmissionV1 {
  const document = readTaskTransitionDocument({
      projection: cell.projection,
      taskId,
      slot: "task.closeout",
      bodyOverrides,
    }),
    // Parse/validate before reading any Git cut. No risk or verification line is filtered.
    prose = submissionFromCloseout(document.body, { commitSha: "0".repeat(40), deliverables: [], outputs: [] }),
    anchors = artifactAnchors(prose.completionClaim),
    named = [...new Set(prose.completionClaim.replace(/artifact:[^\s`<>]+/gu, "").match(/\b[0-9a-f]{40}\b/gu) ?? [])];
  if (
    (named.length === 1) === anchors.length > 0 ||
    named.length > 1 ||
    (prose.completionClaim.match(/artifact:/gu) ?? []).length !== anchors.length
  )
    throw cell.cellCodedError(
      "invalid_submission",
      "Summary must explicitly name one commit or artifact:path@revision anchors.",
    );
  if (anchors.length) {
    const artifacts = anchors.map(
      ({ path, revision }) => readSubmissionArtifact(cell, document.packagePath, path, revision).anchor,
    );
    if (new Set(artifacts.map((anchor) => anchor.path)).size !== artifacts.length)
      throw cell.cellCodedError("invalid_submission", "Summary must name each artifact path once.");
    return { ...prose, commitSha: null, artifacts, deliverables: artifacts.map((anchor) => anchor.path), outputs: [] };
  }
  const dispatches = readDispatchStreamHeaders(cell.rootDir).filter(
      (dispatch) =>
        dispatch.taskId === taskId &&
        dispatch.executionId === executionId &&
        dispatch.role !== "reviewer" &&
        dispatch.cwd,
    ),
    directories = [...new Set(dispatches.map((dispatch) => dispatch.cwd!))],
    git = makeGitReadinessSource();
  if (directories.length > 1)
    throw cell.cellCodedError("invalid_submission", "Execution has more than one delivery worktree.");
  let root = directories[0] ?? cell.rootDir,
    commitSha = named[0]!;
  const publishedRoot = [...new Set([root, cell.rootDir])].find(
    (candidate) => git.run(candidate, ["cat-file", "-e", `${commitSha}^{commit}`]).ok,
  );
  if (!publishedRoot)
    throw cell.cellCodedError(
      "invalid_submission",
      `Delivery commit ${commitSha} is not published in either repository.`,
    );
  root = publishedRoot;
  commitSha = git.run(root, ["rev-parse", `${commitSha}^{commit}`]).stdout;
  if (directories.length && named.length) {
    const dispatchHead = git.run(directories[0]!, ["rev-parse", "HEAD"]).stdout;
    if (
      dispatchHead
        ? commitSha !== dispatchHead &&
          !(
            git.run(root, ["merge-base", "--is-ancestor", dispatchHead, commitSha]).ok &&
            git.run(root, ["merge-base", "--is-ancestor", commitSha, "origin/main"]).ok &&
            git.run(root, ["rev-list", "--parents", "-n", "1", commitSha]).stdout.split(" ").length > 2
          )
        : !git.run(cell.rootDir, ["merge-base", "--is-ancestor", commitSha, "origin/main"]).ok
    )
      throw cell.cellCodedError(
        "invalid_submission",
        "Summary commit must be the bound worktree HEAD or its published merge commit.",
      );
  }
  const mergeBase = git.run(root, ["merge-base", "origin/main", commitSha]);
  const base =
    mergeBase.ok && mergeBase.stdout !== commitSha
      ? mergeBase.stdout
      : git.run(root, ["rev-parse", `${commitSha}^1`]).stdout;
  if (!base) throw cell.cellCodedError("invalid_submission", "Delivery commit has no verifiable comparison cut.");
  const deliverables = runProcessText(
      "git",
      ["diff", "--name-only", "-z", "--diff-filter=ACMRT", base, commitSha, "--"],
      root,
    )
      .split("\0")
      .filter(Boolean),
    removed = runProcessText("git", ["diff", "--name-only", "-z", "--diff-filter=D", base, commitSha, "--"], root)
      .split("\0")
      .filter(Boolean);
  if (!deliverables.length && !removed.length)
    throw cell.cellCodedError("invalid_submission", "Delivery cut contains no changed paths.");
  const { artifacts: _artifacts, ...codeProse } = prose;
  return {
    ...codeProse,
    commitSha,
    deliverables,
    outputs: removed.map((target) => `Deleted-Production-Paths: ${target}`),
  };
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
  if (!selected || !isSameExecution(selected.actor, binding.actor)) return cell.lifecycleAction(action, binding);
  const executionId = selected.executionId;
  if (action.amend === true) assertCurrentSubmittedExecution(current.snapshot, taskId, executionId);
  // A lost response resumes the stored cut. Never re-read HEAD or amend a completed submission implicitly.
  if (selected.submission && action.amend !== true) {
    const opId = cell.projection.readTaskSubmissionOperation(taskId, executionId),
      event = opId === null ? null : cell.store.readEvent(opId);
    if (
      !event ||
      !isTaskEvent(event) ||
      event.type !== "execution_submitted" ||
      event.taskId !== taskId ||
      event.payload.execution.executionId !== executionId ||
      submissionDigest(event.payload.execution.submission!) !== submissionDigest(selected.submission) ||
      !isSameExecution(event.actor, binding.actor) ||
      event.source !== binding.source
    )
      throw cell.cellCodedError("lease_required", "Only the original submission holder may resume this cut.");
    const receipt = cell.receiptForOperation(event.opId, binding);
    if (receipt.outcome !== "applied") return receipt;
    const steps = await prepareSubmissionEvidence(cell, taskId, executionId, binding);
    return {
      ...(steps.find((step) => !["applied", "no_changes"].includes(step.outcome)) ?? receipt),
      steps,
    } as WriteReceiptDraft;
  }
  if (!selected.submission && (!held || current.snapshot.lease?.source !== binding.source))
    return cell.lifecycleAction(action, binding);
  const synced = await runDocAction({
    action: { kind: "doc-submit", taskId },
    binding,
    rootDir: cell.rootDir,
    workspaceId: cell.input.repoId,
    store: cell.store,
    projection: cell.projection,
    now: cell.now,
  });
  if (!["applied", "no_changes"].includes(synced.outcome))
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
  const fresh = await cell.service.read(taskId);
  const derived = readCloseoutSubmission(cell, taskId, executionId, fresh.snapshot);
  if (!derived.ok)
    return submissionStopped(cell, action, binding, fresh.snapshot, executionId, fresh.packagePath, derived.error, [
      synced,
    ]);
  const submission = derived.submission;
  if (selected.submission && submissionDigest(selected.submission) === submissionDigest(submission))
    return submitTask(cell, { ...action, amend: false }, binding);
  const receipt = await cell.lifecycleAction({ ...action, executionId, submission }, binding);
  if (receipt.outcome !== "applied") return receipt;
  const steps = await prepareSubmissionEvidence(cell, taskId, executionId, binding);
  return {
    ...(steps.find((step) => !["applied", "no_changes"].includes(step.outcome)) ?? receipt),
    steps: [synced, ...steps],
  } as WriteReceiptDraft;
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
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    !["closeout_placeholder", "invalid_submission"].includes(String(error.code))
  )
    throw error;
  const code = error.code === "closeout_placeholder" ? "closeout_placeholder" : "document_invalid";
  return {
    ...cell.rejected(cell.operationId(action, binding, cell.input.repoId, snapshot.revision), code),
    next: [
      completionGuidance(
        snapshot,
        executionId,
        `Fill harness/${packagePath}/closeout.md, then run ha task submit ${String(action.taskId)}.`,
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
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      !["closeout_placeholder", "invalid_submission"].includes(String(error.code))
    )
      throw error;
    return { ok: false, error };
  }
}
