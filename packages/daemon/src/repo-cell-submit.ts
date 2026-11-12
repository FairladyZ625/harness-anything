import path from "node:path";
import {
  completionContractGap,
  completionGuidance,
  missingChineseCloseoutSections,
  resolveCompletionContract,
  submissionFromCloseout,
  submissionDigest,
  sha256Text,
  type DocEventChange,
  type ExecutionV1,
  type SubmissionV1,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import {
  isAgentRuntimeEvent,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoCellContinuationWrite, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { readSubmissionAdmission } from "./submission-admission.ts";
import { createSubmissionArtifactReader } from "./submission-artifacts.ts";
import { runDocAction } from "./doc-sync-actions.ts";
import { readTaskTransitionDocument } from "./transition-document-access.ts";
import { dispatchInReviewCutReview } from "./task-review-dispatch.ts";
import { presetSnapshotReader, taskOutputShape, taskWorktreeBinding } from "./task-worktree.ts";
import { taskWorktreeCandidateInventory, taskWorktreeRoot } from "./task-worktree-candidates.ts";
import { isReviewerDispatch, readTaskLineageDispatches } from "./dispatch-read.ts";
import { assertOldDataCopyReceipt, oldDataCopyReceiptPath } from "./submit-old-data-copy.ts";
import { publishSubmittedCut } from "./submitted-cut-publication.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { taskExecutionPlacement } from "./task-execution-placement.ts";
import { taskPrBodyRenderer } from "./task-pr-body-render.ts";

import type { PreparedSubmissionDelivery } from "./submission-delivery.ts";
import { preparedSubmission, type PreparedSubmissionAction } from "./submission-preparation.ts";

/** Structured execution binding selects the public delivery commit; Accepted task documents select artifacts. */
export function finalizeCloseoutSubmission(
  cell: Pick<
    RepoCellOperationalContext,
    "rootDir" | "projection" | "store" | "cellCodedError" | "settings" | "projection"
  >,
  taskId: string,
  executionId: string,
  snapshot: Snapshot,
  prepared: PreparedSubmissionDelivery,
  bodyOverrides?: ReadonlyMap<string, string>,
  carried?: { readonly changes: readonly DocEventChange[]; readonly revision: number },
): {
  readonly submission: SubmissionV1;
  readonly packagePath: string;
} {
  const document = readTaskTransitionDocument({
      projection: cell.projection,
      taskId,
      slot: "task.closeout",
      bodyOverrides,
    }),
    frozen = snapshot.executions.find((execution) => execution.executionId === executionId)?.submission,
    // Accepted prose and artifacts are frozen after doc-submit; Git facts were prepared earlier.
    parsed = submissionFromCloseout(document.body, {
      commitSha: "0".repeat(40),
      deliverables: [],
      outputs: [],
      completionContract: frozen?.completionContract ?? freezeCompletionContract(cell, snapshot),
    }),
    // The execution's first submission freezes the gate requirements; resumes and amendments keep them.
    prose = parsed,
    frozenReviewResponses = snapshot.reviewResponses?.length ? snapshot.reviewResponses : undefined,
    readPresetSnapshot = presetSnapshotReader(cell.projection),
    privateDelivery = taskOutputShape(snapshot.task, readPresetSnapshot) !== "repository-diff",
    artifactPaths = automaticSubmissionArtifactPaths(
      cell.projection,
      snapshot,
      taskId,
      document.packagePath,
      carried?.changes,
    );
  // A public PR delivery publishes the closeout's Chinese mirror. The PR body generator judges this
  // at publication time; submit calls the same kernel judgment so the worker sees the missing
  // section next to the file it must fix instead of the CEO seeing it after the cut is frozen.
  if (!privateDelivery && prepared.publicPullRequest) {
    const missing = missingChineseCloseoutSections(document.body),
      listed = missing.map((title) => `## ${title}`).join(" and ");
    if (missing.length > 0)
      throw Object.assign(
        cell.cellCodedError(
          "invalid_submission",
          `Closeout harness/${document.path} is missing ${listed}; a public PR delivery publishes ` +
            "the closeout in Chinese and English, so both sections are required.",
        ),
        { nextAction: `Add ${listed} to harness/${document.path}, then run ha task submit ${taskId}.` },
      );
  }
  const carriedByPath = new Map<string, DocEventChange>(carried?.changes.map((change) => [change.path, change])),
    readArtifact = createSubmissionArtifactReader(cell);
  const freezeArtifact = (artifact: string) => {
    const candidate = carriedByPath.get(artifact)?.candidate;
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
        `Artifact ${artifact}: no center-accepted revision exists. Keep it under the bound task package artifacts/ directory and retry task submit.`,
      );
    return readArtifact(document.packagePath, artifact, acceptedRevision).anchor;
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
          `No accepted task artifacts were found. Put the deliverable under the bound task package artifacts/ directory and retry task submit.`,
        ),
        {
          nextAction:
            `Write the deliverable into harness/${document.packagePath}/artifacts/ (closeout.md and runtime reports are not deliverables), ` +
            `then run ha task submit ${taskId}.`,
        },
      );
    return {
      submission: {
        ...prose,
        commitSha: null,
        artifacts,
        deliverables: artifacts.map((anchor) => anchor.path),
        outputs: [],
        ...(frozenReviewResponses === undefined ? {} : { reviewResponses: frozenReviewResponses }),
        completionContract: frozen?.completionContract ?? freezeCompletionContract(cell, snapshot),
      },
      packagePath: document.packagePath,
    };
  }
  const { commitSha, deliverables, outputs: commitOutputs, changedFiles, productionDelta } = prepared.facts!;
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
    ...(frozenReviewResponses === undefined ? {} : { reviewResponses: frozenReviewResponses }),
  };
  const contractBase = frozen?.completionContract ?? freezeCompletionContract(cell, snapshot),
    assessedDelivery: SubmissionV1 = { ...delivery, completionContract: contractBase };
  // An empty public manifest has no code cut to witness, including when HEAD is an empty commit.
  let submission: SubmissionV1;
  if (commitSha && (deliverables.length || commitOutputs.length)) submission = { ...assessedDelivery, commitSha };
  else {
    const artifactOnly = { ...assessedDelivery };
    delete artifactOnly.changedFiles;
    delete artifactOnly.productionDelta;
    submission = { ...artifactOnly, commitSha: null, artifacts };
  }
  return { submission, packagePath: document.packagePath };
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

function freezeCompletionContract(
  cell: Pick<RepoCellOperationalContext, "cellCodedError" | "settings" | "projection">,
  snapshot: Snapshot,
): SubmissionV1["completionContract"] {
  const task = snapshot.task;
  if (!task) throw cell.cellCodedError("invalid_submission", "Submission has no task contract to freeze.");
  const gap = completionContractGap(task);
  if (gap)
    throw Object.assign(cell.cellCodedError("invalid_submission", `${gap.reason} Run ${gap.action}.`), {
      nextAction: gap.action,
    });
  if (!task.presetSnapshotDigest)
    throw cell.cellCodedError(
      "invalid_submission",
      `Task ${task.taskId} has no preset snapshot digest, so its completion contract cannot be frozen.`,
    );
  const frozenPreset = cell.projection.readPresetSnapshot(task.presetSnapshotDigest)
    .snapshot as import("@harness-anything/preset").PresetSnapshotV1;
  if (!frozenPreset) {
    // `readPresetSnapshot` answers null when the frozen bytes are unavailable. The old path passed
    // that null into resolveCompletionContract and read `.completion` from it.
    const presetId = task.metadata?.presetId ?? "standard-task",
      action = `ha task contract migrate --task ${task.taskId} --to-preset ${presetId} --apply`;
    throw Object.assign(
      cell.cellCodedError(
        "invalid_submission",
        `Task ${task.taskId} has no usable completion contract: preset snapshot ${task.presetSnapshotDigest} ` +
          `bytes are unavailable. Run ${action}.`,
      ),
      { nextAction: action },
    );
  }
  const resolved = resolveCompletionContract(
    task.completionGateIds ?? [],
    cell.settings.readRepository(),
    frozenPreset,
    task.closeoutOverrides,
  );
  if (!resolved.ok) throw cell.cellCodedError("gate_mapping_invalid", resolved.message);
  // The cut freezes the resolved reviewer declaration so a later settings change never redirects a
  // cut already under review; cuts frozen before the field fall back to the repository default.
  // A task-level reviewer override (dec_E369B861 CH3) beats the repository default here.
  return {
    ...resolved.contract,
    reviewer: {
      agentId: task.reviewer ?? cell.settings.readRepository().roles?.defaultReviewer ?? "closeout-reviewer",
    },
  };
}

async function autoDeclareSubmittedExecutor(
  cell: RepoCellOperationalContext,
  taskId: string,
  executionId: string,
  binding: RepoCellBinding,
  enqueuePublication: RepoCellContinuationWrite,
): Promise<WriteReceiptDraft | null> {
  const snapshot = (await cell.service.read(taskId)).snapshot,
    execution = snapshot.executions.find((candidate) => candidate.executionId === executionId);
  if (
    snapshot.task?.currentNode !== "review" ||
    snapshot.task.status !== "in_review" ||
    execution?.state !== "submitted" ||
    execution.actor.executor !== null ||
    execution.submission?.completionContract.closeoutGates.review !== true
  )
    return null;
  // The submit may arrive from an edge immediately after the dispatch event was accepted by the
  // center. Read the execution's raw dispatch events directly so attribution does not depend on a
  // runtime-session row having completed projection yet; reviewer dispatches remain excluded by
  // the same canonical role predicate used by declaration candidates.
  const exact = readSubmittedImplementationDispatches(cell, taskId, executionId),
    projectedExact = cell.projection
      .readRuntimeDispatchesByTaskExecution(taskId, executionId)
      .filter(({ event }) => event.payload.role !== "reviewer" && event.payload.reviewTarget === undefined)
      .map(({ event }) => event.payload),
    rows = exact.length
      ? exact
      : projectedExact.length
        ? projectedExact
        : readTaskLineageDispatches({ projection: cell.projection, taskId }).filter(
            (dispatch) => !isReviewerDispatch(cell.projection, dispatch.dispatchId),
          );
  const candidates = new Map(
    rows.map((dispatch) => [dispatch.runtimeSessionId, { executorId: `runtime-session:${dispatch.runtimeSessionId}` }]),
  );
  if (candidates.size !== 1) return null;
  const [candidate] = candidates.values();
  if (!candidate) return null;
  const action = {
    kind: "task-declare-executor",
    taskId,
    executionId,
    agent: candidate.executorId,
    reason: "Automatically attributed from the unique implementation dispatch for this execution at submission.",
  };
  return enqueuePublication(action, binding);
}

/**
 * A node submit can be the first writer after its dispatch was accepted. The runtime projection
 * is allowed to catch up asynchronously, while the canonical event store already contains the
 * dispatch that proves attribution. Read that bounded task slice at the write boundary so submit
 * does not leave a review cut with an avoidable executor gap.
 */
function readSubmittedImplementationDispatches(
  cell: Pick<RepoCellOperationalContext, "store">,
  taskId: string,
  executionId: string,
): readonly Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }>["payload"][] {
  const events = cell.store.queryEvents?.({
    type: "runtime_dispatch_requested",
    entity: `task/${taskId}`,
    limit: 500,
  });
  if (!events) return [];
  return events
    .filter(
      (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
        isAgentRuntimeEvent(event) &&
        event.type === "runtime_dispatch_requested" &&
        event.payload.taskId === taskId &&
        event.payload.executionId === executionId &&
        event.payload.role !== "reviewer" &&
        event.payload.reviewTarget === undefined,
    )
    .map((event) => event.payload);
}

/** Continues a frozen submit only after the command runner has released its publication turn. */
export async function continueSubmittedTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  receipt: WriteReceiptDraft,
  enqueuePublication: RepoCellContinuationWrite,
): Promise<WriteReceiptDraft> {
  const event = cell.store.readTaskEvent(receipt.opId);
  if (event?.type !== "execution_submitted") return receipt;
  const {
      executionPrincipal: _executionPrincipal,
      authorizationDecision: _authorizationDecision,
      ...principal
    } = binding,
    principalBinding = { ...principal, actor: { principal: binding.actor.principal, executor: null } },
    executor = await autoDeclareSubmittedExecutor(
      cell,
      event.taskId,
      event.payload.execution.executionId,
      principalBinding,
      enqueuePublication,
    ),
    review = await submittedCutReview(
      cell,
      event.taskId,
      action,
      binding,
      receipt,
      enqueuePublication,
      event.payload.execution,
    ),
    warnings = [...(receipt.warnings ?? []), ...review.warnings];
  return {
    ...receipt,
    ...(warnings.length ? { warnings } : {}),
    steps: [
      ...((receipt as { readonly steps?: readonly WriteReceiptDraft[] }).steps ?? []),
      ...(executor ? [executor] : []),
      ...review.steps,
    ],
  } as WriteReceiptDraft;
}

function riskTierCloseoutGates(
  gates: SubmissionV1["completionContract"]["closeoutGates"],
  assessment: SubmissionV1["riskTierAssessment"],
): SubmissionV1["completionContract"]["closeoutGates"] {
  if (!assessment) return gates;
  return {
    ...gates,
    review: assessment.effectiveTier !== "low",
    consent: assessment.effectiveTier === "high" ? true : assessment.effectiveTier === "low" ? false : gates.consent,
  };
}

export function riskTierCompletionContract(
  contract: SubmissionV1["completionContract"],
  assessment: SubmissionV1["riskTierAssessment"],
): SubmissionV1["completionContract"] {
  return {
    ...contract,
    closeoutGates: riskTierCloseoutGates(contract.closeoutGates, assessment),
  };
}

export function sameFrozenSubmissionCut(derived: SubmissionV1, frozen: SubmissionV1 | null | undefined): boolean {
  if (frozen === null || frozen === undefined) return false;
  const { riskTierAssessment: _assessment, ...frozenCut } = frozen;
  return submissionDigest(derived) === submissionDigest(frozenCut as SubmissionV1);
}

export function isLegacyFrozenSubmissionCut(derived: SubmissionV1, frozen: SubmissionV1 | null | undefined): boolean {
  return sameFrozenSubmissionCut(derived, frozen) && frozen?.riskTierAssessment === undefined;
}

export function submissionForRiskTierRetry(
  derived: SubmissionV1,
  frozen: SubmissionV1 | null | undefined,
  assessment: SubmissionV1["riskTierAssessment"],
  completionContract: () => SubmissionV1["completionContract"],
  preserveLegacyCut = false,
): SubmissionV1 {
  if (preserveLegacyCut && isLegacyFrozenSubmissionCut(derived, frozen)) return derived;
  return { ...derived, riskTierAssessment: assessment, completionContract: completionContract() };
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
 * Initial submissions, amendments, and resumed submissions share the in-review dispatch port.
 * The frozen review requirement determines the task phase; review-disabled cuts dispatch nothing.
 */
async function submittedCutReview(
  cell: RepoCellOperationalContext,
  taskId: string,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  receipt: WriteReceiptDraft,
  enqueuePublication: RepoCellContinuationWrite,
  submitted: ExecutionV1,
): Promise<{ readonly steps: readonly WriteReceiptDraft[]; readonly warnings: readonly string[] }> {
  const { snapshot } = await cell.service.read(taskId),
    execution = snapshot.executions.find(
      (value) =>
        value.executionId === submitted.executionId &&
        value.iteration === snapshot.task?.iteration &&
        value.state === "submitted",
    );
  if (
    !execution?.submission ||
    cell.projection.readTaskSubmissionOperation(taskId, execution.executionId) !== receipt.opId
  )
    return { steps: [], warnings: [] };
  if (
    snapshot.task?.status === "in_review" &&
    execution?.submission &&
    taskExecutionPlacement(cell, taskId, execution.executionId).kind === "local"
  ) {
    try {
      const worktree = taskWorktreeBinding(snapshot.task, presetSnapshotReader(cell.projection)),
        instanceId = binding.executionPrincipal
          ? cell.projection.readRuntimeDispatch(binding.executionPrincipal.runtimeSessionId)?.payload.instanceId
          : undefined,
        executionRef = `execution/${execution.executionId}`,
        executionVersion = cell.projection.readEntityVersionWitness(executionRef).currentVersion,
        renderBody = await taskPrBodyRenderer({
          rootDir: cell.rootDir,
          projection: cell.projection,
          taskId,
          submission: execution.submission,
        });
      const current = await publishSubmittedCut({
        rootDir: cell.rootDir,
        repoId: cell.input.repoId,
        taskId,
        taskTitle: snapshot.task.title,
        submission: execution.submission,
        workerRoot: worktree ? path.join(cell.rootDir, worktree.path) : null,
        personId: binding.actor.principal.personId,
        ...(typeof instanceId === "string" ? { instanceId } : {}),
        prepareDaemonGitEnvironment: cell.input.prepareDaemonGitEnvironment,
        ...(renderBody ? { renderBody } : {}),
        isCurrentCut: () =>
          executionVersion !== null &&
          cell.projection.readEntityVersionWitness(executionRef).currentVersion === executionVersion &&
          cell.projection.readTaskSubmissionOperation(taskId, execution.executionId) === receipt.opId,
      });
      if (!current) return { steps: [], warnings: [] };
    } catch (error) {
      const detail = String(scrubProviderValue(error instanceof Error ? error.message : String(error))).slice(0, 512),
        warning = `The cut is frozen, but publication failed before review: ${detail} Retry: ha task submit ${taskId} --amend.`;
      return {
        steps: [cell.failed(receipt.opId, error)],
        warnings: [warning],
      };
    }
  }
  // The review is a new repository dispatch, not a write by the implementation execution that
  // just submitted. A returned worker's execution credential can be at its terminal boundary by
  // the time this post-write hook runs; carrying it into reviewer admission makes a durable submit
  // succeed while suppressing the only reviewer dispatch. Keep the authenticated principal and
  // source, while letting the reviewer dispatch perform its own repository authorization.
  const { executionPrincipal: _executionPrincipal, ...principalBinding } = binding,
    dispatched = await dispatchInReviewCutReview(
      cell,
      taskId,
      action,
      { ...principalBinding, actor: { principal: binding.actor.principal, executor: null } },
      receipt,
      enqueuePublication,
      receipt.opId,
    );
  return dispatched ? { steps: [dispatched.step], warnings: dispatched.warnings } : { steps: [], warnings: [] };
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
    admission = readSubmissionAdmission(cell, action, binding, current.snapshot);
  if (!admission.ok) return admission.reject();
  const { selected, executionId, event, amendCommand } = admission,
    prepared = (action as PreparedSubmissionAction)[preparedSubmission];
  if (!prepared)
    throw cell.cellCodedError(
      "invalid_transition",
      "Submission was not prepared before the write queue; retry task submit.",
    );
  await prepared.assertCurrent(current.snapshot);
  if (!prepared.delivery)
    return submissionStopped(cell, action, binding, current.snapshot, executionId, current.packagePath, prepared.error);
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
    return { ...receipt, steps: [] } as WriteReceiptDraft;
  }
  // Assignment callers carry their changed documents above. With no carried changes,
  // consume center-accepted content; never scan the center worktree on an edge's behalf.
  const taskRoot = taskWorktreeRoot(cell, current.snapshot),
    authoredCandidateInventory =
      taskRoot === null || (typeof binding.source === "object" && binding.source.kind === "node")
        ? undefined
        : taskWorktreeCandidateInventory(cell.rootDir, taskRoot, current.packagePath, cell.store.currentCut(), {
            store: cell.store,
            projection: cell.projection,
            executionIds: current.snapshot.executions.map((execution) => execution.executionId),
          }),
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
    derived = await readCloseoutSubmission(
      cell,
      taskId,
      executionId,
      fresh.snapshot,
      prepared.delivery,
      undefined,
      undefined,
      Boolean(selected?.submission),
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
  const syncDetail = synced?.detail?.kind === "doc_sync" ? synced.detail : null,
    unsynchronized = syncDetail ? [...syncDetail.unresolvedTouches, ...syncDetail.deletions] : [],
    anchorDriftWarnings = [
      ...derived.warnings,
      ...(unsynchronized.length
        ? [
            `Task package has unsynchronized changes: ${unsynchronized.map(({ path }) => path).join(", ")}. ` +
              "Ask the CEO to use each document's required route and amend the cut, or return the task for rework; " +
              "the implementation write lease has ended.",
          ]
        : []),
      ...submissionAnchorDriftWarnings(selected.submission, submission),
    ];
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
    const warnings = anchorDriftWarnings;
    return {
      ...receipt,
      ...(submission.riskTierAssessment ? { riskTierAssessment: submission.riskTierAssessment } : {}),
      ...(warnings.length ? { warnings } : {}),
      steps: [],
    } as WriteReceiptDraft;
  }
  if (selected.submission && submissionDigest(selected.submission) === submissionDigest(submission))
    return submitTask(cell, { ...action, amend: false }, binding);
  const receipt = await cell.lifecycleAction({ ...action, executionId, submission }, binding);
  if (receipt.outcome !== "applied") return receipt;
  const warnings = anchorDriftWarnings;
  return {
    ...receipt,
    ...(submission.riskTierAssessment ? { riskTierAssessment: submission.riskTierAssessment } : {}),
    ...(warnings.length ? { warnings } : {}),
    steps: synced ? [synced] : [],
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
    submitted = await submitTask(cell, { ...action, kind: "task-submit", taskId, asOwner: false }, binding),
    mergedSteps = (submitted as { readonly steps?: readonly WriteReceiptDraft[] }).steps ?? [];
  if (submitted.outcome !== "applied")
    return { ...submitted, unmetCriteria: [], steps: mergedSteps } as WriteReceiptDraft;
  return { ...submitted, steps: mergedSteps } as WriteReceiptDraft;
}

const submissionStopCodes = ["invalid_submission", "gate_mapping_invalid", "ignored_ledger_delivery"];

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
            : `Fill harness/${packagePath}/closeout.md, then run ha task submit ${String(action.taskId)}.`),
        error.message,
      ),
    ],
    steps,
  } as WriteReceiptDraft;
}

export function readCloseoutSubmission(
  ...args: [...Parameters<typeof finalizeCloseoutSubmission>, preserveLegacyCut?: boolean]
):
  | { readonly ok: true; readonly submission: SubmissionV1; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: Error } {
  try {
    const deriveArgs = args.slice(0, 7) as Parameters<typeof finalizeCloseoutSubmission>,
      preserveLegacyCut = args[7] === true,
      [cell, taskId, executionId, snapshot] = deriveArgs,
      derived = finalizeCloseoutSubmission(...deriveArgs);
    const frozen = snapshot.executions.find((execution) => execution.executionId === executionId)?.submission,
      sameCut = sameFrozenSubmissionCut(derived.submission, frozen),
      legacyFrozenCut = preserveLegacyCut && isLegacyFrozenSubmissionCut(derived.submission, frozen),
      riskTierAssessment = legacyFrozenCut
        ? undefined
        : sameCut && frozen?.riskTierAssessment
          ? frozen.riskTierAssessment
          : (() => {
              const risk = deriveArgs[4].risk;
              if (!risk.ok) throw risk.error;
              return risk.assessment;
            })(),
      submission: SubmissionV1 = submissionForRiskTierRetry(
        derived.submission,
        frozen,
        riskTierAssessment,
        () => riskTierCompletionContract(derived.submission.completionContract, riskTierAssessment),
        preserveLegacyCut,
      );
    // The frozen path lanes are the review routing evidence; a cut that seats the data-migration
    // reviewer must carry its real old-data-copy receipt. Read the same place doc submit accepted
    // it, including a receipt carried in this very submit.
    const packagePath = derived.packagePath,
      receiptPath = oldDataCopyReceiptPath(packagePath);
    assertOldDataCopyReceipt({
      taskId,
      packagePath,
      submission,
      readReceipt: () =>
        deriveArgs[5]?.get(receiptPath) ?? cell.projection.readDocument(receiptPath).document?.body ?? null,
    });
    return {
      ok: true,
      submission,
      warnings: [],
    };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !submissionStopCodes.includes(String(error.code)))
      throw error;
    return { ok: false, error };
  }
}
