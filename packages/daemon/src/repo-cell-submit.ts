import {
  completionGuidance,
  consumeKnownError,
  currentExecutionCuts,
  heldLeaseForExecutionActor,
  isNativeExecution,
  isSameExecution,
  isSamePerson,
  isTaskEvent,
  ledgerGitPath,
  resolveCompletionContract,
  resolveLedgerGitLayout,
  reviewsForExecution,
  submissionFromCloseout,
  submissionDigest,
  sameWriteSource,
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
import { isPresetSnapshotCurrent, prepareSubmissionEvidence } from "./repo-cell-task-progress.ts";
import { actionWitnessCollections } from "./repo-cell-witness-adapters.ts";
import { dispatchCompletionReview } from "./task-completion-review.ts";
import { readEffectiveCloseoutGates } from "./repo-cell-settings-state.ts";

/** Git resolves the empty-tree object id virtually; it exists in every repository. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Summary selects one public delivery commit, center-accepted artifacts, or both. */
export function deriveCloseoutSubmission(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "projection" | "store" | "cellCodedError" | "settings">,
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
    frozen = snapshot.executions.find((execution) => execution.executionId === executionId)?.submission,
    // Parse/validate before reading any Git cut. No risk or verification line is filtered.
    parsed = submissionFromCloseout(document.body, {
      commitSha: "0".repeat(40),
      deliverables: [],
      outputs: [],
      completionContract: { gates: [] },
    }),
    // The execution's first submission freezes the gate requirements; resumes and amendments keep them.
    prose = { ...parsed, completionContract: frozen?.completionContract ?? freezeCompletionContract(cell, snapshot) },
    anchors = artifactAnchors(prose.completionClaim),
    named = [...new Set(removeArtifactAnchors(prose.completionClaim).match(/\b[0-9a-f]{40}\b/gu) ?? [])];
  if (named.length > 1)
    throw cell.cellCodedError(
      "invalid_submission",
      `Summary names ${named.length} delivery commits; one execution has exactly one delivery cut, ` +
        "so name only the commit being delivered.",
    );
  // Only `artifact:` immediately followed by a path character is an anchor attempt; prose labels
  // like "Delivery artifact:" end in whitespace and must not count against the parsed anchors.
  if (
    (named.length === 0 && anchors.length === 0) ||
    (prose.completionClaim.match(/artifact:\S/gu) ?? []).length !== anchors.length
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
  let deliverables: readonly string[], commitOutputs: readonly string[];
  if (frozen?.commitSha === commitSha) {
    // A submitted commit already owns its file manifest. Advancing main must not
    // shrink a branch-wide diff to the last commit; prose and artifacts remain freshly derived.
    deliverables = frozen.deliverables;
    commitOutputs = frozen.outputs.filter((output) => !output.startsWith("Artifact-Anchor: "));
  } else {
    const execution = snapshot.executions.find((value) => value.executionId === executionId),
      baseline = execution !== undefined && isNativeExecution(execution) ? execution.deliveryBaseline : undefined;
    if (baseline === undefined)
      throw cell.cellCodedError(
        "invalid_submission",
        "Execution has no frozen delivery baseline; the comparison cut is fixed at execution start.",
      );
    const base = baseline.kind === "commit" ? baseline.commitSha : EMPTY_TREE_SHA;
    if (baseline.kind === "commit" && !git.run(root, ["cat-file", "-e", `${baseline.commitSha}^{commit}`]).ok)
      throw cell.cellCodedError(
        "invalid_submission",
        `Frozen delivery baseline ${baseline.commitSha} is not readable in the delivery repository.`,
      );
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
  if (!deliverables.length && !commitOutputs.length && !artifacts.length) {
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
    outputs: [...commitOutputs, ...artifacts.map((anchor) => `Artifact-Anchor: ${anchor.path}@${anchor.revision}`)],
  };
}

function freezeCompletionContract(
  cell: Pick<RepoCellOperationalContext, "cellCodedError" | "settings">,
  snapshot: Snapshot,
): SubmissionV1["completionContract"] {
  const resolved = resolveCompletionContract(snapshot.task?.completionGateIds ?? [], cell.settings.readRepository());
  if (!resolved.ok) throw cell.cellCodedError("gate_mapping_invalid", resolved.message);
  // The cut freezes the resolved reviewer declaration so a later settings change never redirects a
  // cut already under review; cuts frozen before the field fall back to the repository default.
  return {
    ...resolved.contract,
    reviewer: { agentId: cell.settings.readRepository().defaultReviewer ?? "closeout-reviewer" },
  };
}

/**
 * Submit-triggered review dispatch (dec_59FA45A407F850E2B167A192D7 CH2 §3): once the canonical
 * submission is accepted and evidence preparation ran, the cut's frozen reviewer claim owns the
 * dispatch — the same claim complete's review_missing branch reuses, keyed by task/execution/
 * iteration/digest. The submission is already accepted, so a dispatch failure lands as a receipt
 * step and never reports the accepted cut as unsubmitted. Tasks whose closeout profile disables
 * review, and cuts that already carry a recorded review, dispatch nothing.
 */
async function dispatchSubmittedCutReview(
  cell: RepoCellOperationalContext,
  taskId: string,
  executionId: string,
  binding: RepoCellBinding,
  opId: string,
): Promise<WriteReceiptDraft | null> {
  const current = await cell.service.read(taskId),
    snapshot = current.snapshot,
    execution = snapshot.executions.find(
      (candidate) => candidate.executionId === executionId && candidate.iteration === snapshot.task?.iteration,
    );
  if (
    !execution?.submission ||
    !current.packagePath ||
    !readEffectiveCloseoutGates(
      cell.projection,
      snapshot.task?.completionGateIds ?? [],
      snapshot.task?.closeoutOverrides,
    ).review ||
    reviewsForExecution(snapshot.reviews, execution).length > 0
  )
    return null;
  try {
    return await dispatchCompletionReview(cell, snapshot, execution, current.packagePath, binding, opId, []);
  } catch (error) {
    consumeKnownError(error);
    return cell.failed(cell.errorOperationId(error) ?? opId, error);
  }
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
      throw cell.cellCodedError("lease_required", "Only the original submission holder may resume this cut.");
  }
  if (!selected || (!isSameExecution(selected.actor, binding.actor) && !ownerAmendment && !ownerSubmission && !event))
    return cell.lifecycleAction(action, binding);
  const executionId = selected.executionId,
    amendCommand = `ha task submit --amend ${taskId}${
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
    const steps = await prepareSubmissionEvidence(cell, taskId, executionId, binding, actionWitnessCollections(action)),
      review = await dispatchSubmittedCutReview(cell, taskId, executionId, binding, receipt.opId);
    return {
      ...(steps.find((step) => !["applied", "no_changes"].includes(step.outcome)) ?? receipt),
      steps: [...steps, ...(review === null ? [] : [review])],
    } as WriteReceiptDraft;
  }
  // Assignment callers carry their changed documents above. With no carried changes,
  // consume center-accepted content; never scan the center worktree on an edge's behalf.
  const synced =
    typeof binding.source === "object" && binding.source.kind === "assignment"
      ? null
      : await runDocAction({
          action: { kind: "doc-submit", taskId },
          binding,
          rootDir: cell.rootDir,
          workspaceId: cell.input.repoId,
          store: cell.store,
          projection: cell.projection,
          now: cell.now,
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
    derived = readCloseoutSubmission(cell, taskId, executionId, fresh.snapshot);
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
  const submission = derived.submission,
    anchorDriftWarnings = submissionAnchorDriftWarnings(selected.submission, submission);
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
    const steps = await prepareSubmissionEvidence(cell, taskId, executionId, binding, actionWitnessCollections(action)),
      review = await dispatchSubmittedCutReview(cell, taskId, executionId, binding, receipt.opId);
    return {
      ...(steps.find((step) => !["applied", "no_changes"].includes(step.outcome)) ?? receipt),
      steps: [...steps, ...(review === null ? [] : [review])],
    } as WriteReceiptDraft;
  }
  if (selected.submission && submissionDigest(selected.submission) === submissionDigest(submission))
    return submitTask(cell, { ...action, amend: false }, binding);
  const receipt = await cell.lifecycleAction({ ...action, executionId, submission }, binding);
  if (receipt.outcome !== "applied") return receipt;
  const steps = await prepareSubmissionEvidence(cell, taskId, executionId, binding, actionWitnessCollections(action)),
    review = await dispatchSubmittedCutReview(cell, taskId, executionId, binding, receipt.opId);
  return {
    ...(steps.find((step) => !["applied", "no_changes"].includes(step.outcome)) ?? receipt),
    ...(anchorDriftWarnings.length ? { warnings: anchorDriftWarnings } : {}),
    steps: [...(synced ? [synced] : []), ...steps, ...(review === null ? [] : [review])],
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
    if (!["applied", "no_changes"].includes(started.outcome)) return { ...started, steps } as WriteReceiptDraft;
  }
  const submitted = await submitTask(cell, { ...action, kind: "task-submit", taskId }, binding),
    mergedSteps = [...steps, ...((submitted as { readonly steps?: readonly WriteReceiptDraft[] }).steps ?? [])];
  if (submitted.outcome !== "applied") return { ...submitted, steps: mergedSteps } as WriteReceiptDraft;
  const fresh = await cell.service.read(taskId),
    submittedExecutionId =
      currentExecutionCuts(fresh.snapshot).find((execution) => execution.state === "submitted")?.executionId ?? "";
  if (
    fresh.snapshot.task?.presetSnapshotDigest &&
    !isPresetSnapshotCurrent(cell, taskId, fresh.snapshot, fresh.packagePath, `ha task settle ${taskId}`)
  )
    return {
      ...cell.rejected(
        cell.operationId(action, binding, cell.input.repoId, fresh.snapshot.revision),
        "preset_snapshot_mismatch",
      ),
      rejectionExplanation:
        "The submitted cut is recorded, but the task contract was written against an older preset snapshot.",
      next: [
        completionGuidance(
          fresh.snapshot,
          submittedExecutionId,
          `ha preset upgrade ${taskId}`,
          "Upgrade the task contract preset, then continue review and completion.",
        ),
      ],
      steps: mergedSteps,
    } as WriteReceiptDraft;
  return { ...submitted, steps: mergedSteps } as WriteReceiptDraft;
}

const submissionStopCodes = ["closeout_placeholder", "invalid_submission", "gate_mapping_invalid"];

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
        code === "gate_mapping_invalid"
          ? `Map every declared gate in harness.yaml settings.gates, then run ha task submit ${String(action.taskId)}.`
          : `Fill harness/${packagePath}/closeout.md, run ha doc sync --submit --task ${String(action.taskId)}, ` +
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
    if (!(error instanceof Error) || !("code" in error) || !submissionStopCodes.includes(String(error.code)))
      throw error;
    return { ok: false, error };
  }
}
