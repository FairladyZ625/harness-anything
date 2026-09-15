import {
  completionGuidance,
  currentExecutionCuts,
  heldLeaseForExecutionActor,
  isSameExecution,
  isSamePerson,
  isTaskEvent,
  ledgerGitPath,
  resolveLedgerGitLayout,
  submissionFromCloseout,
  submissionDigest,
  type SubmissionV1,
  type WriteReceiptDraft,
} from "../../kernel/src/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { assertCurrentSubmittedExecution } from "./repo-cell-execution-selection.ts";
import {
  artifactAnchorGuidance,
  artifactAnchors,
  removeArtifactAnchors,
  readSubmissionArtifact,
  submissionArtifactPath,
} from "./submission-artifacts.ts";
import { readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { runDocAction } from "./doc-sync-actions.ts";
import { makeGitReadinessSource, runProcessText } from "./process-port.ts";
import { readTaskTransitionDocument } from "./transition-document-access.ts";
import { prepareSubmissionEvidence } from "./repo-cell-task-progress.ts";

/** Summary selects one public delivery commit, center-accepted artifacts, or both. */
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
    named = [...new Set(removeArtifactAnchors(prose.completionClaim).match(/\b[0-9a-f]{40}\b/gu) ?? [])];
  if (named.length > 1)
    throw cell.cellCodedError(
      "invalid_submission",
      `Summary names ${named.length} delivery commits; one execution has exactly one delivery cut, ` +
        "so name only the commit being delivered.",
    );
  if (
    (named.length === 0 && anchors.length === 0) ||
    (prose.completionClaim.match(/artifact:/gu) ?? []).length !== anchors.length
  )
    throw cell.cellCodedError(
      "invalid_submission",
      `Summary must name one delivery commit or at least one artifact:path@revision anchor. ` + artifactAnchorGuidance,
    );
  const artifacts = anchors.map(({ path, revision }) => {
    const artifact = submissionArtifactPath(document.packagePath, path);
    const acceptedRevision = revision ?? cell.projection.readDocument(artifact).document?.workspaceRevision;
    if (acceptedRevision === undefined)
      throw cell.cellCodedError(
        "invalid_submission",
        `Artifact ${artifact}: no center-accepted revision exists. ${artifactAnchorGuidance}`,
      );
    return readSubmissionArtifact(cell, document.packagePath, artifact, acceptedRevision).anchor;
  });
  if (new Set(artifacts.map((anchor) => anchor.path)).size !== artifacts.length)
    throw cell.cellCodedError(
      "invalid_submission",
      `Summary must name each artifact path once. ${artifactAnchorGuidance}`,
    );
  if (named.length === 0)
    return { ...prose, commitSha: null, artifacts, deliverables: artifacts.map((anchor) => anchor.path), outputs: [] };
  const dispatches = readDispatchStreamHeaders(cell.rootDir).filter(
      (dispatch) =>
        dispatch.taskId === taskId &&
        dispatch.executionId === executionId &&
        dispatch.role !== "reviewer" &&
        dispatch.cwd,
    ),
    directories = [...new Set(dispatches.map((dispatch) => dispatch.cwd!))],
    git = makeGitReadinessSource(),
    publishedRoot = [...new Set([...directories, cell.rootDir])].find(
      (candidate) => git.run(candidate, ["cat-file", "-e", `${named[0]!}^{commit}`]).ok,
    );
  if (!publishedRoot)
    throw cell.cellCodedError(
      "invalid_submission",
      `Delivery commit ${named[0]!} is not published in any bound or canonical repository.`,
    );
  const root = publishedRoot,
    commitSha = git.run(root, ["rev-parse", `${named[0]!}^{commit}`]).stdout;
  // One execution may dispatch through several cwds (delivery worktree, then closeout prep at
  // the canonical root). A cut already published to origin/main needs nothing else; an
  // unpublished cut must be the HEAD of one of those directories.
  if (
    directories.length &&
    !git.run(root, ["merge-base", "--is-ancestor", commitSha, "origin/main"]).ok &&
    !directories.some((directory) => git.run(directory, ["rev-parse", "HEAD"]).stdout === commitSha)
  )
    throw cell.cellCodedError(
      "invalid_submission",
      "Summary commit must be the bound worktree HEAD or its published merge commit.",
    );
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
  // Deliverables stay paths of the delivery commit: anchored in-package artifacts ride in the
  // artifacts field and outputs lines so commit-based gates never verify ledger paths against
  // the public cut.
  if (!deliverables.length && !removed.length && !artifacts.length) {
    // A task without CI or code-doc gates delivers authored documents: its cut is the private
    // ledger HEAD plus this package's accepted artifacts, never a public code diff.
    const privateDelivery = !(snapshot.task?.completionGateIds ?? []).some(
      (gate) => gate === "ci" || gate === "code-doc-reconciliation",
    );
    if (!privateDelivery) throw cell.cellCodedError("invalid_submission", "Delivery cut contains no changed paths.");
    const ledger = resolveLedgerGitLayout(cell.rootDir),
      ledgerArtifacts = git.run(ledger.rootDir, [
        "ls-tree",
        "-r",
        "--name-only",
        "HEAD",
        "--",
        ledgerGitPath(ledger, `${document.packagePath}/artifacts/`),
      ]);
    if (!ledgerArtifacts.ok || !ledgerArtifacts.stdout)
      throw cell.cellCodedError(
        "invalid_submission",
        `Delivery cut contains no changed paths; publish harness/${document.packagePath}/artifacts/ ` +
          `or name artifact:path@revision anchors in Summary. ${artifactAnchorGuidance}`,
      );
    return {
      ...prose,
      commitSha: git.run(ledger.rootDir, ["rev-parse", "HEAD"]).stdout,
      deliverables: ledgerArtifacts.stdout.split("\n"),
      outputs: [],
    };
  }
  return {
    ...prose,
    commitSha,
    ...(artifacts.length ? { artifacts } : {}),
    deliverables,
    outputs: [
      ...removed.map((target) => `Deleted-Production-Paths: ${target}`),
      ...artifacts.map((anchor) => `Artifact-Anchor: ${anchor.path}@${anchor.revision}`),
    ],
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
  const ownerAmendment =
    action.amend === true &&
    action.asOwner === true &&
    current.snapshot.task !== null &&
    isSamePerson(current.snapshot.task.createdBy, binding.actor);
  if (!selected || (!isSameExecution(selected.actor, binding.actor) && !ownerAmendment))
    return cell.lifecycleAction(action, binding);
  const executionId = selected.executionId;
  if (action.amend === true) assertCurrentSubmittedExecution(current.snapshot, taskId, executionId);
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
  const fresh = await cell.service.read(taskId),
    derived = readCloseoutSubmission(cell, taskId, executionId, fresh.snapshot);
  if (!derived.ok)
    return submissionStopped(cell, action, binding, fresh.snapshot, executionId, fresh.packagePath, derived.error, [
      synced,
    ]);
  const submission = derived.submission,
    anchorDriftWarnings = submissionAnchorDriftWarnings(selected.submission, submission);
  // A lost response resumes the stored cut only when the synchronized closeout still derives the same submission.
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
            `ha task submit --amend ${taskId}`,
            "Amend the submitted cut explicitly before review.",
          ),
        ],
        steps: [synced],
      } as WriteReceiptDraft;
    const receipt = cell.receiptForOperation(event.opId, binding);
    if (receipt.outcome !== "applied") return receipt;
    const steps = await prepareSubmissionEvidence(cell, taskId, executionId, binding);
    return {
      ...(steps.find((step) => !["applied", "no_changes"].includes(step.outcome)) ?? receipt),
      steps,
    } as WriteReceiptDraft;
  }
  if (selected.submission && submissionDigest(selected.submission) === submissionDigest(submission))
    return submitTask(cell, { ...action, amend: false }, binding);
  const receipt = await cell.lifecycleAction({ ...action, executionId, submission }, binding);
  if (receipt.outcome !== "applied") return receipt;
  const steps = await prepareSubmissionEvidence(cell, taskId, executionId, binding);
  return {
    ...(steps.find((step) => !["applied", "no_changes"].includes(step.outcome)) ?? receipt),
    ...(anchorDriftWarnings.length ? { warnings: anchorDriftWarnings } : {}),
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
    // The remapped code alone cannot say why the document was rejected; the guard's own message can.
    rejectionExplanation: error.message,
    next: [
      completionGuidance(
        snapshot,
        executionId,
        `Fill harness/${packagePath}/closeout.md, run ha doc sync --submit --task ${String(action.taskId)}, ` +
          `then run ha task submit ${String(action.taskId)}.`,
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
