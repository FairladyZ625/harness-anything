import { createHash } from "node:crypto";
import {
  assessFactRetirement,
  canStartExecution,
  assessTransitionDocument,
  compileTaskProgress,
  completionPreparationBlockers,
  approvedReviewsForExecution,
  reviewDigest,
  taskCompletionNext,
  completionGuidance,
  completionEvidenceBasis,
  completionEvidenceResults,
  effectiveCloseoutGates,
  currentCodeDocWitness,
  judgeCompletionEvidence,
  type CiRunObservationEventV3,
  consumeKnownError,
  isTaskProgressEvent,
  requireTransitionDocumentKind,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
  stableStringify,
  localGitObjectRefStore,
  resolveHarnessLayout,
  taskProgressWritePlan,
  validFactStillHoldsAttestation,
  type CompletionReadinessContext,
  type CompletionEvidenceBasis,
  type CompletionEvidenceProvenance,
  type CompletionEvidenceResult,
  type CompletionEvidenceV1,
  type FactRetirementAssessment,
  type FactStillHoldsAttestation,
  type TaskProgressEventV1,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { compileRepoTaskPackage } from "../../preset/src/index.ts";
import { runDocAction } from "./doc-sync-actions.ts";
import { scanDocCandidates } from "./doc-sync-candidate-scanner.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import { verifyCodeDocCommitPaths } from "./code-doc-path-verification.ts";
import { readCompletionContext, completionBlockersForAction } from "./task-completion-read.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";

import { dispatchCompletionReview } from "./task-completion-review.ts";

function relatedCiObservation(root: string, event: CiRunObservationEventV3, submitted: string): boolean {
  return (
    event.payload.run.sha === submitted || localGitObjectRefStore.isAncestor(root, submitted, event.payload.run.sha)
  );
}

export function readLatestCiEvidence(
  cell: RepoCellOperationalContext,
  execution: Snapshot["executions"][number] | undefined,
): CompletionEvidenceV1 | null {
  if (!execution?.submission?.commitSha) return null;
  const observations = cell.projection.readCiRunObservations(2000);
  if (!cell.projectionReady(observations))
    throw cell.cellCodedError("content_not_ready", "CI observation projection is not ready.");
  // Newest observation first; never skip a red/unverified run for an older green; cancelled/skipped: no verdict.
  const submitted = execution.submission.commitSha,
    publicCut = localGitObjectRefStore.hasCommit(cell.rootDir, submitted),
    root = publicCut ? cell.rootDir : resolveHarnessLayout(cell.rootDir).authoredRoot;
  for (const event of observations.events) {
    if (!relatedCiObservation(root, event, submitted)) continue;
    const verification = event.payload.verification;
    if (
      !localGitObjectRefStore.hasCommit(root, submitted) ||
      !verification ||
      (publicCut
        ? verification.source !== "github-actions" ||
          !cell.settings.read().ci.workflows.includes(verification.workflow) ||
          event.payload.run.branch !== "main"
        : verification.source !== "write-coordinator" || verification.workflow !== "ledger-publication")
    )
      throw cell.cellCodedError(
        "invalid_proof",
        publicCut
          ? `Public delivery requires a verified ${cell.settings.read().ci.workflows.join(" or ")} GitHub main run.`
          : "Private delivery requires a verified ledger-publication observation for its authored cut.",
      );
    if (verification.conclusion === "cancelled" || verification.conclusion === "skipped") continue;
    const result: CompletionEvidenceResult = verification.conclusion === "success" ? "pass" : "fail";
    if (!completionEvidenceResults.includes(result)) return null;
    const basis: CompletionEvidenceBasis = {
        ...completionEvidenceBasis(execution),
        ledgerCut: event.workspaceRevision,
      },
      provenance: CompletionEvidenceProvenance = {
        source: "runner",
        runId: event.payload.run.runId,
        rawResult: `event:${event.opId}`,
      };
    return {
      schema: "completion-evidence/v1",
      evidenceId: `ci-${event.opId}`,
      checkerId: "ci",
      gateId: "ci",
      result,
      observed: true,
      basis,
      provenance,
    };
  }
  return null;
}

/** Attach only existing evidence to the submitted cut; document sync belongs to its original holder. */
export async function prepareSubmissionEvidence(
  cell: RepoCellOperationalContext,
  taskId: string,
  executionId: string,
  binding: RepoCellBinding,
): Promise<readonly WriteReceipt[]> {
  const current = await cell.service.read(taskId),
    snapshot = current.snapshot,
    execution = snapshot.executions.find(
      (candidate) => candidate.executionId === executionId && candidate.iteration === snapshot.task?.iteration,
    );
  if (!execution?.submission)
    throw cell.cellCodedError("invalid_transition", "Evidence preparation requires a submitted execution.");
  const steps: WriteReceipt[] = [],
    gates = snapshot.task?.completionGateIds ?? [],
    ci = gates.includes("ci") ? readLatestCiEvidence(cell, execution) : null,
    witness = currentCodeDocWitness(snapshot.codeDocWitnesses, executionId);
  if (ci?.result === "fail")
    throw cell.cellCodedError("invalid_proof", `CI receipt ${ci.provenance.rawResult} reported fail.`);
  if (
    gates.includes("code-doc-reconciliation") &&
    !(
      witness?.iteration === execution.iteration &&
      (witness.schema === "code-doc-witness-repoint/v1" || witness.commitSha === execution.submission.commitSha)
    )
  ) {
    const step = await cell.lifecycleAction(
      {
        kind: "task-code-doc-reconcile",
        taskId,
        paths: execution.submission.deliverables,
      },
      binding,
    );
    steps.push(step);
    if (step.outcome !== "applied") return steps;
  }
  const refreshed = cell.projection.read(taskId),
    recorded = refreshed.snapshot.gateWitnesses.find(
      (candidate) =>
        candidate.executionId === executionId &&
        candidate.gateId === "ci" &&
        candidate.commitSha === execution.submission!.commitSha &&
        candidate.iteration === execution.iteration,
    ),
    alreadyVerified =
      recorded?.basis &&
      recorded.provenance &&
      recorded.observed !== undefined &&
      judgeCompletionEvidence(
        { ...recorded, basis: recorded.basis, provenance: recorded.provenance, observed: recorded.observed },
        { execution, gateId: "ci" },
      ).accepted;
  if (ci && !alreadyVerified)
    steps.push(cell.publishCiWitness(taskId, executionId, refreshed.snapshot, refreshed.packagePath, binding, ci));
  return steps;
}

export function appendProgress(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  carried: {
    readonly changes: readonly import("../../kernel/src/index.ts").DocEventChange[];
    readonly blobs: readonly {
      readonly sha256: string;
      readonly size: number;
      readonly mediaType: string;
      readonly body: string;
    }[];
  } | null = null,
): WriteReceipt {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    task = cell.projection.read(taskId),
    expectedRevision = task.snapshot.revision,
    opId = cell.operationId(action, binding, cell.input.repoId, expectedRevision),
    existing = cell.store.readEvent(opId);
  if (existing) {
    if (!isTaskProgressEvent(existing))
      throw cell.cellCodedError("op_conflict", `opId ${opId} belongs to another event`);
    if (stableStringify(existing.payload.carriedDocumentClaims ?? null) !== stableStringify(carried?.changes ?? null))
      throw cell.cellCodedError("op_conflict", `opId ${opId} already carries different task documents`);
    return cell.progressReceipt(existing, cell.publicPublication(cell.store.publication(existing)));
  }
  if (task.watermark < task.sourceRevision || !task.snapshot.task || !task.packagePath)
    throw cell.cellCodedError("content_not_ready", `Task ${taskId} is not ready for progress append.`);
  const at = cell.now(),
    lease = cell.projection.currentLease(taskId, at),
    executionId = typeof action.executionId === "string" ? action.executionId : (lease?.executionId ?? ""),
    recoveryExecutionId =
      lease?.executionId ??
      task.snapshot.executions.find(
        (value) => value.iteration === task.snapshot.task?.iteration && value.state === "active",
      )?.executionId ??
      "progress-recovery",
    recoverySnapshot = lease?.phase === "orphaned" ? { ...task.snapshot, lease: null } : task.snapshot,
    runtimeSessionId = runtimeSessionIdFromActor(binding.actor),
    runtimeSession = runtimeSessionId === null ? null : cell.projection.readRuntimeSession(runtimeSessionId),
    runtimeBinding = resolveTaskBoundRuntimeBinding(runtimeSession, taskId, executionId),
    progressPath = `${task.packagePath}/progress.md`,
    document = cell.projection.readDocument(progressPath);
  if (document.watermark < document.sourceRevision)
    throw cell.cellCodedError("content_not_ready", `Progress projection for ${taskId} is not ready.`);
  const compiled = compileTaskProgress({
    taskId,
    executionId,
    packagePath: task.packagePath,
    text: cell.requiredCellText(action.text, "text"),
    evidence: cell.progressEvidence(action.evidence),
    ...(typeof action.baseDocumentSha256 === "string" || action.baseDocumentSha256 === null
      ? { expectedBaseSha256: action.baseDocumentSha256 }
      : {}),
    currentDocument:
      document.document && document.document.path === progressPath
        ? {
            path: progressPath,
            blobSha256: document.document.blobSha256,
            body: document.document.body,
          }
        : null,
    activeLease: lease,
    startRecoveryAvailable: canStartExecution(recoverySnapshot, recoveryExecutionId),
    ...(runtimeBinding ? { runtimeBinding } : {}),
    actor: binding.actor,
    source: binding.source,
    eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
    opId,
    workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
    occurredAt: at,
  });
  const event =
      carried === null
        ? compiled.event
        : ({
            ...compiled.event,
            payload: {
              ...compiled.event.payload,
              carriedDocumentClaims: carried.changes,
            },
          } as TaskProgressEventV1),
    plan = carried === null ? compiled.plan : taskProgressWritePlan(event),
    blobs = carried === null ? compiled.blobs : [...compiled.blobs, ...carried.blobs];
  const appended = cell.store.append({ event, plan, blobs });
  cell.input.killpoint?.("after_sqlite_commit");
  cell.projection.apply(event, plan);
  const receipt = cell.progressReceipt(event, cell.publicPublication(appended));
  cell.input.killpoint?.("before_response_write");
  cell.input.killpoint?.("after_response_write");
  return receipt;
}

function latestApprovedReview(cell: RepoCellOperationalContext, reviews: Snapshot["reviews"]) {
  return reviews
    .map((review) => {
      const row = cell.projection.getEntity("review", review.reviewId);
      if (!row) throw cell.cellCodedError("content_not_ready", `Review ${review.reviewId} is not projected.`);
      return { review, revision: row.workspaceRevision };
    })
    .sort((a, b) => b.revision - a.revision)[0]?.review;
}

export async function completeTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    initial = await cell.service.read(taskId),
    initialContext = readCompletionContext(cell.projection, taskId, initial.snapshot, initial.status),
    decision = taskCompletionNext(
      initial.snapshot,
      { ...initialContext, authorization: binding.authorizationDecision?.outcome === "allowed" ? "allowed" : "denied" },
      typeof action.executionId === "string" ? action.executionId : undefined,
    ),
    executionId = decision.executionId ?? "",
    allowed = ["kind", "taskId", "executionId", "verb", "commandType", "factHolds", "consent"],
    factRetirementAttestations = stillHoldsAttestations(cell, action.factHolds),
    submittedExecution = initial.snapshot.executions.find(
      (value) => value.executionId === executionId && value.iteration === initial.snapshot.task?.iteration,
    ),
    paths = submittedExecution?.submission?.deliverables ?? [],
    initialReviews =
      action.consent === true && submittedExecution?.submission
        ? approvedReviewsForExecution(initial.snapshot.reviews, submittedExecution)
        : [],
    consentReview = latestApprovedReview(cell, initialReviews);
  if (Object.keys(action).some((field) => !allowed.includes(field)))
    throw cell.cellCodedError("invalid_command", "Complete derives CI evidence and paths from the submitted cut.");
  const initialOpId = cell.operationId(action, binding, cell.input.repoId, initial.snapshot.revision);
  if (
    !decision.executionId ||
    decision.blocker?.code === "projection_unknown" ||
    decision.blocker?.code === "execution_ambiguous"
  )
    return cell.completionStopped(initialOpId, initial.snapshot, executionId, decision.blocker!, []);
  const completedEvent = cell.projection.readTaskCompletion(taskId, executionId);
  if (completedEvent) {
    const publication = cell.publicPublication(cell.store.publication(completedEvent));
    return cell.completionApplied(
      cell.lifecycleReceipt(
        completedEvent,
        initial.snapshot,
        publication,
        cell.receiptProof(completedEvent, publication),
      ),
      initial.snapshot,
      executionId,
      [],
    );
  }
  const ciEvidence = initial.snapshot.task?.completionGateIds.includes("ci")
    ? readLatestCiEvidence(cell, submittedExecution)
    : null;
  if (ciEvidence?.result === "fail")
    throw cell.cellCodedError("invalid_proof", `CI receipt ${ciEvidence.provenance.rawResult} reported fail.`);
  const steps: WriteReceipt[] = [],
    facadeOpId = cell.operationId(
      {
        kind: "task-complete",
        taskId,
        executionId,
        ...(ciEvidence ? { ci: ciEvidence.provenance.rawResult } : {}),
        ...(paths.length ? { paths } : {}),
        ...(factRetirementAttestations.length ? { factHolds: factRetirementAttestations } : {}),
      },
      binding,
      cell.input.repoId,
      initial.snapshot.revision,
    );
  // Read through every remaining preparation before publishing any witness or document; snapshots stay authoritative.
  const preparedContext = cell.completionContext(
    taskId,
    initial.snapshot,
    initial.packagePath,
    binding,
    currentPresetSnapshotDigest(
      cell,
      taskId,
      initial.snapshot,
      initial.packagePath,
      cell.completeRetryCommand(taskId, executionId, action),
    ),
  );
  const closeoutGates = preparedContext.closeoutGates!,
    codeDoc =
      closeoutGates.codeDoc && submittedExecution?.submission?.commitSha
        ? verifyCodeDocCommitPaths({ rootDir: cell.rootDir, commitSha: submittedExecution.submission.commitSha, paths })
        : null;
  const remaining = completionPreparationBlockers(initial.snapshot, executionId, {
    ...preparedContext,
    preparedGateIds: [
      ...(ciEvidence?.result === "pass" ? ["ci"] : []),
      ...(codeDoc?.ok ? ["code-doc-reconciliation"] : []),
    ],
    ...(codeDoc && !codeDoc.ok
      ? {
          invalidDocument: {
            path: preparedContext.closeoutPath,
            reason:
              `Submitted commit ${codeDoc.commitSha}: ${codeDoc.code}; ` + `paths: ${codeDoc.missingPaths.join(", ")}.`,
          },
        }
      : {}),
  })[0];
  if (remaining && remaining.code !== "doc_sync_required")
    return cell.completionStopped(facadeOpId, initial.snapshot, executionId, remaining, []);
  const retirement = factRetirementAssessment(cell, taskId, factRetirementAttestations);
  if (closeoutGates.factDisposition && !retirement.ready)
    return cell.completionStopped(
      facadeOpId,
      initial.snapshot,
      executionId,
      factRetirementBlocker(initial.snapshot, executionId, retirement),
      [],
    );
  let presetSnapshotDigest: string | null = null;
  for (let dispatch = 0; dispatch < 5; dispatch += 1) {
    const current = await cell.service.read(taskId),
      completed = cell.projection.readTaskCompletion(taskId, executionId);
    if (completed) {
      const publication = cell.publicPublication(cell.store.publication(completed));
      return cell.completionApplied(
        cell.lifecycleReceipt(completed, current.snapshot, publication, cell.receiptProof(completed, publication)),
        current.snapshot,
        executionId,
        steps,
      );
    }
    // The package digest is stable for the whole request; per-retry compilation re-hashes the catalog identically.
    if (presetSnapshotDigest === null)
      presetSnapshotDigest = currentPresetSnapshotDigest(
        cell,
        taskId,
        current.snapshot,
        current.packagePath,
        cell.completeRetryCommand(taskId, executionId, action),
      );
    const completion = cell.completionContext(
      taskId,
      current.snapshot,
      current.packagePath,
      binding,
      presetSnapshotDigest,
    );
    const blocker = completionBlockersForAction(current.snapshot, executionId, completion, action.consent)[0];
    if (!blocker) {
      const retirement = factRetirementAssessment(cell, taskId, factRetirementAttestations);
      if (completion.closeoutGates?.factDisposition && !retirement.ready)
        return cell.completionStopped(
          facadeOpId,
          current.snapshot,
          executionId,
          factRetirementBlocker(current.snapshot, executionId, retirement),
          steps,
        );
      let completed: WriteReceipt;
      try {
        completed = await cell.lifecycleAction(
          {
            kind: "task-complete",
            taskId,
            executionId,
            ...(factRetirementAttestations.length ? { factRetirementAttestations } : {}),
          },
          binding,
        );
      } catch (error) {
        const published = cell.projection.readTaskCompletion(taskId, executionId);
        if (!published) throw error;
        const unknown = cell.failed(
          published.opId,
          cell.cellCodedError(
            "publication_indeterminate",
            `publication result is unknown; run ha receipt show ${published.opId} before retrying`,
          ),
        );
        return cell.completionSettlement(
          unknown,
          (await cell.service.read(taskId)).snapshot,
          executionId,
          [...steps, unknown],
          "complete-settlement",
        );
      }
      return completed.outcome === "applied"
        ? cell.completionApplied(completed, cell.projection.read(taskId).snapshot, executionId, [...steps, completed])
        : cell.completionSettlement(completed, current.snapshot, executionId, steps, "complete-settlement");
    }
    if (blocker.code === "review_missing") {
      const execution = current.snapshot.executions.find(
        (value) => value.executionId === executionId && value.submission,
      );
      if (!execution?.submission || !current.packagePath)
        return cell.completionStopped(facadeOpId, current.snapshot, executionId, blocker, steps);
      return dispatchCompletionReview(
        cell,
        current.snapshot,
        execution,
        current.packagePath,
        binding,
        facadeOpId,
        steps,
      );
    }
    if (blocker.code === "consent_missing" && consentReview) {
      const execution = current.snapshot.executions.find(
          (value) => value.executionId === executionId && value.submission,
        ),
        reviews = execution?.submission ? approvedReviewsForExecution(current.snapshot.reviews, execution) : [];
      const latest = latestApprovedReview(cell, reviews);
      if (!latest || reviewDigest(latest) !== reviewDigest(consentReview))
        return cell.completionStopped(facadeOpId, current.snapshot, executionId, blocker, steps);
      const step = await cell.lifecycleAction(
        { kind: "task-review-consent", taskId, executionId, reviewId: consentReview.reviewId },
        binding,
      );
      steps.push(step);
      if (step.outcome !== "applied")
        return cell.completionSettlement(step, current.snapshot, executionId, steps, "consent-settlement");
      continue;
    }
    if (blocker.code === "ci_missing" && ciEvidence !== null) {
      const step = cell.publishCiWitness(
        taskId,
        executionId,
        current.snapshot,
        current.packagePath,
        binding,
        ciEvidence,
      );
      steps.push(step);
      continue;
    }
    // A missing code/doc witness stops completion with the reconcile command; complete never
    // writes another Action's witness under its own declaration.
    if (blocker.code === "doc_sync_required") {
      let step: WriteReceipt;
      try {
        step = await runDocAction({
          action: { kind: "doc-submit", taskId },
          binding,
          workspaceId: cell.input.repoId,
          rootDir: cell.rootDir,
          store: cell.store,
          projection: cell.projection,
          now: cell.now,
          killpoint: cell.input.killpoint,
        });
      } catch (error) {
        step = cell.failed(cell.errorOperationId(error) ?? facadeOpId, error);
        consumeKnownError(error);
      }
      steps.push(step);
      if (step.outcome === "applied" || step.code === "no_changes") continue;
      return cell.completionSettlement(step, current.snapshot, executionId, steps, "doc-sync-settlement");
    }
    return cell.completionStopped(facadeOpId, current.snapshot, executionId, blocker, steps);
  }
  return cell.completionSettlement(
    cell.rejected(facadeOpId, "facade_replay_exhausted"),
    (await cell.service.read(taskId)).snapshot,
    executionId,
    steps,
    "re-dispatch",
  );
}

function stillHoldsAttestations(
  cell: RepoCellOperationalContext,
  value: unknown,
): readonly FactStillHoldsAttestation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((attestation) => !validFactStillHoldsAttestation(attestation)))
    throw cell.cellCodedError(
      "invalid_command",
      "Each --fact-holds value requires one canonical Fact ref and a non-empty rationale of at most 199 characters.",
    );
  const attestations = value.map((attestation) => ({
      factRef: String((attestation as FactStillHoldsAttestation).factRef),
      rationale: String((attestation as FactStillHoldsAttestation).rationale).trim(),
    })),
    facts = new Set(attestations.map(({ factRef }) => factRef));
  if (facts.size !== attestations.length)
    throw cell.cellCodedError("invalid_command", "Complete accepts at most one --fact-holds rationale per Fact.");
  return Object.freeze(attestations);
}

function factRetirementAssessment(
  cell: RepoCellOperationalContext,
  taskId: string,
  stillHoldsAttestations: readonly FactStillHoldsAttestation[],
): FactRetirementAssessment {
  const taskRef = `task/${taskId}`,
    taskRelationReads = [
      cell.projection.readRelationQuery({ source: taskRef, state: "active", limit: 500 }),
      cell.projection.readRelationQuery({ target: taskRef, state: "active", limit: 500 }),
    ];
  if (taskRelationReads.some((read) => read.page?.nextCursor))
    throw cell.cellCodedError("content_not_ready", `Task ${taskId} exceeds the 500-edge Fact retirement budget.`);
  const relationRead = {
      ...taskRelationReads[0],
      rows: [
        ...new Map(taskRelationReads.flatMap((read) => read.rows).map((edge) => [edge.relationId, edge])).values(),
      ],
    },
    relationReady = taskRelationReads.every((read) => read.status === "ready");
  if (!relationReady)
    throw cell.cellCodedError(
      "content_not_ready",
      `Relation projection is not ready for Fact retirement assessment on Task ${taskId}.`,
    );
  const decisionIds = [
      ...new Set(
        relationRead.rows.flatMap((edge) => {
          if (
            edge.state !== "active" ||
            edge.relationType !== "derives" ||
            edge.targetRef !== taskRef ||
            typeof edge.sourceRef !== "string"
          )
            return [];
          const source = /^decision\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)?$/u.exec(
            edge.sourceRef,
          );
          return source?.[1] ? [source[1]] : [];
        }),
      ),
    ],
    decisionRead = cell.projection.readDecisions(decisionIds),
    decisionReady = decisionRead.status === "ready";
  if (!decisionReady)
    throw cell.cellCodedError(
      "content_not_ready",
      `Decision projection is not ready for Fact retirement assessment on Task ${taskId}.`,
    );
  const claimRefs = decisionRead.decisions.flatMap((decision) =>
      decision.claims
        .filter((claim) => claim.loadBearing)
        .map((claim) => `decision/${decision.decisionId}/${claim.id}`),
    ),
    producedFactRefs = relationRead.rows
      .filter((edge) => edge.relationType === "produces" && edge.sourceRef === taskRef)
      .map((edge) => edge.targetRef),
    narrowReads = [...claimRefs, ...producedFactRefs].map((source) =>
      cell.projection.readRelationQuery({ source, state: "active", limit: 500 }),
    );
  if (narrowReads.some((read) => read.status !== "ready" || read.page?.nextCursor))
    throw cell.cellCodedError(
      "content_not_ready",
      `Task ${taskId} Fact retirement neighborhood is not ready or exceeds budget.`,
    );
  const upstreamFactRefs = narrowReads
      .flatMap((read) => read.rows)
      .filter((edge) => edge.relationType === "evidenced-by")
      .map((edge) => edge.targetRef),
    livenessReads = upstreamFactRefs.map((target) =>
      cell.projection.readRelationQuery({ target, relationType: "supersedes-fact", state: "active", limit: 500 }),
    );
  if (livenessReads.some((read) => read.status !== "ready" || read.page?.nextCursor))
    throw cell.cellCodedError(
      "content_not_ready",
      `Task ${taskId} Fact liveness neighborhood is not ready or exceeds budget.`,
    );
  return assessFactRetirement({
    taskId,
    decisions: decisionRead.decisions,
    relations: [
      ...relationRead.rows,
      ...narrowReads.flatMap((read) => read.rows),
      ...livenessReads.flatMap((read) => read.rows),
    ],
    stillHoldsAttestations,
  });
}

function factRetirementBlocker(snapshot: Snapshot, executionId: string, assessment: FactRetirementAssessment) {
  const details = assessment.undischarged
      .map(({ factRef, viaClaim, viaDecision }) => `- ${factRef} via ${viaClaim} (${viaDecision})`)
      .join("\n"),
    first = assessment.undischarged[0]!.factRef;
  return {
    code: assessment.code,
    gate: "fact-retirement",
    next: completionGuidance(
      snapshot,
      executionId,
      `Record the disposition of ${first} in the task closeout: superseding observation or why it still holds.`,
      "Standing upstream evidencing Facts lack an explicit retirement disposition:\n" + details,
    ),
  } as const;
}

function currentPresetSnapshotDigest(
  cell: RepoCellOperationalContext,
  taskId: string,
  snapshot: Snapshot,
  packagePath: string | null,
  retryCommand: string,
): string {
  if (!packagePath || !snapshot.task?.presetSnapshotDigest)
    throw cell.cellCodedError(
      "content_not_ready",
      `Task ${taskId} package metadata is not ready; run ha daemon projection rebuild, then retry ${retryCommand}.`,
    );
  const contractDocument = cell.projection.readDocument(`${packagePath}/task-contract.json`).document;
  if (!contractDocument)
    throw cell.cellCodedError(
      "content_not_ready",
      `Task ${taskId} contract projection is not ready; run ha daemon projection rebuild, then retry ${retryCommand}.`,
    );
  const contract = JSON.parse(contractDocument.body) as Record<string, unknown>,
    current = compileRepoTaskPackage({
      rootDir: cell.rootDir,
      settings: cell.settings.read(),
      taskId,
      action: {
        kind: "task-create",
        title: contract.title,
        presetId: contract.presetId,
        verticalId: contract.verticalId,
        profileId: contract.profileId,
        locale: contract.locale,
        taskClass: contract.taskClass,
      },
    });
  return current.snapshot.digest;
}

export function isPresetSnapshotCurrent(
  cell: RepoCellOperationalContext,
  taskId: string,
  snapshot: Snapshot,
  packagePath: string | null,
  retryCommand: string,
): boolean {
  return (
    currentPresetSnapshotDigest(cell, taskId, snapshot, packagePath, retryCommand) ===
    snapshot.task?.presetSnapshotDigest
  );
}

export function completionContext(
  cell: RepoCellOperationalContext,
  taskId: string,
  snapshot: Snapshot,
  packagePath: string | null,
  binding: RepoCellBinding,
  presetSnapshotDigest: string,
): CompletionReadinessContext {
  if (presetSnapshotDigest !== snapshot.task?.presetSnapshotDigest)
    throw cell.cellCodedError("preset_snapshot_mismatch", `Run ha preset upgrade ${taskId} before completion.`);
  const canonical = readCompletionContext(cell.projection, taskId, snapshot, "ready"),
    scan = scanDocCandidates({
      rootDir: cell.rootDir,
      workspaceId: cell.input.repoId,
      store: cell.store,
      projection: cell.projection,
      actor: binding.actor,
      source: binding.source,
      now: cell.now(),
      taskId,
    }),
    eligible = scan.rows.filter((row) => row.state === "eligible"),
    closeoutCandidate = eligible.find((row) => row.path === canonical.closeoutPath),
    assessment = closeoutCandidate?.bytes
      ? assessTransitionDocument(
          requireTransitionDocumentKind("task.complete"),
          Buffer.from(closeoutCandidate.bytes).toString("utf8"),
        )
      : null,
    invalid = scan.rows.find((row) => row.state === "blocked" || row.state === "conflict" || row.state === "deletion");
  return {
    ...canonical,
    closeoutGates: effectiveCloseoutGates(cell.settings.readRepository().closeout, snapshot.task?.completionGateIds),
    ...(assessment
      ? {
          closeout: assessment.ready ? ("ready" as const) : ("placeholder" as const),
          closeoutMissingSections: assessment.missingSections,
        }
      : {}),
    eligibleDirtyPaths: eligible.map((row) => row.path),
    ...(invalid ? { invalidDocument: { path: invalid.path, reason: invalid.reason ?? invalid.state } } : {}),
  };
}
