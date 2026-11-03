import { createHash } from "node:crypto";
import {
  canStartExecution,
  compileTaskProgress,
  completionBlockers,
  completionPreparationBlockers,
  taskCompletionNext,
  completionGuidance,
  consumeKnownError,
  isTaskProgressEvent,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
  stableStringify,
  closeoutReadiness,
  taskProgressWritePlan,
  validFactStillHoldsAttestation,
  type CompletionReadinessContext,
  type FactRetirementAssessment,
  type FactStillHoldsAttestation,
  type TaskProgressEventV1,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { runDocAction } from "./doc-sync-actions.ts";
import { scanDocCandidates } from "./doc-sync-candidate-scanner.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import {
  readCompletionContext,
  readCompletionDeliveryStatus,
  factRetirementAssessment,
} from "./task-completion-read.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { archiveTaskOnComplete } from "./repo-cell-task-auto-archive.ts";
import { readEffectiveCloseoutGates } from "./repo-cell-settings-state.ts";

export function appendProgress(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  carried: {
    readonly changes: readonly import("@harness-anything/kernel").DocEventChange[];
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
    executionId =
      typeof action.executionId === "string"
        ? action.executionId
        : (lease?.executionId ??
          task.snapshot.executions.findLast((value) => value.iteration === task.snapshot.task?.iteration)
            ?.executionId ??
          ""),
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
    asOwner: action.asOwner === true,
    taskCreatedBy: task.snapshot.task.createdBy,
    taskClass: task.snapshot.task.taskClass,
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
  cell.input.killpoint?.("after_store_commit");
  cell.projection.apply(event, plan);
  const receipt = cell.progressReceipt(event, cell.publicPublication(appended));
  cell.input.killpoint?.("before_response_write");
  cell.input.killpoint?.("after_response_write");
  return receipt;
}

export async function completeTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    initial = await cell.service.read(taskId),
    allowed = [
      "kind",
      "taskId",
      "executionId",
      "verb",
      "commandType",
      "factHolds",
      "resolvedBy",
      "resolutionRationale",
      "resolutionFact",
    ],
    initialOpId = cell.operationId(action, binding, cell.input.repoId, initial.snapshot.revision);
  if (Object.keys(action).some((field) => !allowed.includes(field)))
    throw cell.cellCodedError("invalid_command", "Complete derives CI evidence from the submitted cut.");
  if (
    action.resolvedBy === undefined &&
    (action.resolutionRationale !== undefined || action.resolutionFact !== undefined)
  )
    throw cell.cellCodedError("invalid_command", "Resolution rationale and Fact require --resolved-by.");
  if (action.resolvedBy !== undefined && (action.executionId !== undefined || action.factHolds !== undefined))
    throw cell.cellCodedError(
      "invalid_command",
      "Sibling resolution cannot select an execution or attest its Fact retirement.",
    );
  if (action.resolvedBy !== undefined) {
    const sourceTaskId = String(action.resolvedBy),
      rationale = String(action.resolutionRationale ?? "").trim(),
      factRef = String(action.resolutionFact ?? "").trim();
    if (!rationale || !factRef || !factRef.startsWith("fact/"))
      throw cell.cellCodedError(
        "invalid_command",
        "Sibling resolution requires --resolution-rationale and a canonical --resolution-fact fact/<id>.",
      );
    const previous = cell.projection.readTaskCompletion(taskId, null);
    if (previous?.type === "task_completed") {
      if (stableStringify(previous.payload.siblingResolution) !== stableStringify({ sourceTaskId, rationale, factRef }))
        throw cell.cellCodedError("invalid_command", "Task already completed with a different sibling resolution.");
      const publication = cell.publicPublication(cell.store.publication(previous));
      return cell.completionApplied(
        cell.lifecycleReceipt(previous, initial.snapshot, publication, cell.receiptProof(previous, publication)),
        initial.snapshot,
        "",
        [],
      );
    }
    const fact = cell.projection.readFact(factRef.slice("fact/".length));
    if (!fact.fact)
      throw cell.cellCodedError("invalid_command", `Resolution Fact ${factRef} does not exist in the projection.`);
    const source = await cell.service.read(sourceTaskId),
      sourceReadiness = closeoutReadiness(
        source.snapshot,
        undefined,
        readEffectiveCloseoutGates(cell.projection, source.snapshot),
        readCompletionDeliveryStatus(cell.projection, source.snapshot, cell.rootDir),
      );
    if (source.snapshot.task?.status !== "done" || sourceReadiness.readiness !== "passed")
      return cell.completionStopped(
        initialOpId,
        initial.snapshot,
        "",
        {
          code: "not_in_review",
          gate: "sibling-resolution",
          next: {
            action: `Wait for ${sourceTaskId} to complete review, consent, and its configured delivery gates, then retry ha task complete ${taskId} --resolved-by ${sourceTaskId}.`,
            reason: `Sibling task ${sourceTaskId} is not fully accepted (readiness: ${sourceReadiness.readiness}).`,
            authority: "task owner",
            readCut: { revision: initial.snapshot.revision, iteration: null, executionId: null },
          },
        },
        [],
      );
    const completed = await cell.lifecycleAction(
      {
        kind: "task-complete",
        taskId,
        resolvedBy: sourceTaskId,
        resolutionRationale: rationale,
        resolutionFact: factRef,
      },
      binding,
    );
    if (completed.outcome !== "applied") return completed;
    const settled = cell.projection.read(taskId).snapshot,
      archive = archiveTaskOnComplete(cell, taskId, settled, binding),
      applied = cell.completionApplied(completed, settled, "", archive.receipt ? [archive.receipt] : []);
    return archive.warning ? { ...applied, warnings: [...(applied.warnings ?? []), archive.warning] } : applied;
  }
  const initialContext = readCompletionContext(cell.projection, taskId, initial.snapshot, initial.status, cell.rootDir),
    decision = taskCompletionNext(
      initial.snapshot,
      { ...initialContext, authorization: binding.authorizationDecision?.outcome === "allowed" ? "allowed" : "denied" },
      typeof action.executionId === "string" ? action.executionId : undefined,
    ),
    executionId = decision.executionId ?? "",
    factRetirementAttestations = stillHoldsAttestations(cell, action.factHolds);
  if (
    !decision.executionId ||
    decision.blocker?.code === "projection_unknown" ||
    decision.blocker?.code === "execution_ambiguous"
  )
    return cell.completionStopped(initialOpId, initial.snapshot, executionId, decision.blocker!, []);
  const completedEvent = cell.projection.readTaskCompletion(taskId, executionId);
  if (completedEvent) {
    const publication = cell.publicPublication(cell.store.publication(completedEvent)),
      archive = archiveTaskOnComplete(cell, taskId, initial.snapshot, binding),
      receipt = cell.completionApplied(
        cell.lifecycleReceipt(
          completedEvent,
          initial.snapshot,
          publication,
          cell.receiptProof(completedEvent, publication),
        ),
        initial.snapshot,
        executionId,
        archive.receipt ? [archive.receipt] : [],
      );
    return archive.warning ? { ...receipt, warnings: [...(receipt.warnings ?? []), archive.warning] } : receipt;
  }
  const steps: WriteReceipt[] = [],
    facadeOpId = cell.operationId(
      {
        kind: "task-complete",
        taskId,
        executionId,
        ...(factRetirementAttestations.length ? { factHolds: factRetirementAttestations } : {}),
      },
      binding,
      cell.input.repoId,
      initial.snapshot.revision,
    );
  const refreshed = initial;
  const preparedContext = cell.completionContext(
    taskId,
    refreshed.snapshot,
    refreshed.packagePath,
    binding,
    refreshed.snapshot.task!.presetSnapshotDigest!,
  );
  const closeoutGates = preparedContext.closeoutGates!,
    remaining = completionPreparationBlockers(refreshed.snapshot, executionId, preparedContext)[0];
  if (remaining && remaining.code !== "doc_sync_required")
    return cell.completionStopped(facadeOpId, refreshed.snapshot, executionId, remaining, []);
  const retirement = factRetirementAssessment(cell.projection, taskId, factRetirementAttestations);
  if (closeoutGates.factDisposition && !retirement.ready)
    return cell.completionStopped(
      facadeOpId,
      initial.snapshot,
      executionId,
      factRetirementBlocker(initial.snapshot, executionId, retirement),
      [],
    );
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
    const completion = cell.completionContext(
      taskId,
      current.snapshot,
      current.packagePath,
      binding,
      current.snapshot.task!.presetSnapshotDigest!,
    );
    const blocker = completionBlockers(current.snapshot, executionId, completion)[0];
    if (!blocker) {
      const retirement = factRetirementAssessment(cell.projection, taskId, factRetirementAttestations);
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
      if (completed.outcome !== "applied")
        return cell.completionSettlement(completed, current.snapshot, executionId, steps, "complete-settlement");
      const settled = cell.projection.read(taskId).snapshot,
        archive = archiveTaskOnComplete(cell, taskId, settled, binding),
        applied = cell.completionApplied(completed, settled, executionId, [
          ...steps,
          completed,
          ...(archive.receipt ? [archive.receipt] : []),
        ]);
      return archive.warning ? { ...applied, warnings: [...(applied.warnings ?? []), archive.warning] } : applied;
    }
    // Review and consent blockers are hard stops: the
    // verdict and consent belong to the owner's explicit actions, never to a complete that
    // would otherwise dispatch reviewers or write consent inline on someone's behalf.
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

function factRetirementBlocker(snapshot: Snapshot, executionId: string, assessment: FactRetirementAssessment) {
  const details = assessment.undischarged
      .map(
        ({ factRef, viaClaim, viaDecision }) =>
          `- ${factRef} via ${viaClaim} (${viaDecision}): still holds → --fact-holds "${factRef}:<rationale>"; ` +
          "superseded → record a task Fact with a supersedes-fact relation to it",
      )
      .join("\n"),
    // One Fact can reach the task through several claims, but complete takes one disposition per Fact.
    holdsFlags = [...new Set(assessment.undischarged.map(({ factRef }) => factRef))]
      .map((factRef) => `--fact-holds "${factRef}:<rationale>"`)
      .join(" ");
  return {
    code: assessment.code,
    gate: "fact-retirement",
    next: completionGuidance(
      snapshot,
      executionId,
      `Declare every standing upstream Fact's disposition: ha task complete ${holdsFlags} ` +
        "for each that still holds, or record task Facts with supersedes-fact relations for superseded ones; " +
        "closeout prose only records and does not discharge.",
      "Standing upstream evidencing Facts lack an explicit retirement disposition:\n" + details,
    ),
  } as const;
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
  const canonical = readCompletionContext(cell.projection, taskId, snapshot, "ready", cell.rootDir),
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
    invalid = scan.rows.find((row) => row.state === "blocked" || row.state === "conflict" || row.state === "deletion");
  return {
    ...canonical,
    closeoutGates: readEffectiveCloseoutGates(cell.projection, snapshot),
    eligibleDirtyPaths: eligible.map((row) => row.path),
    ...(invalid ? { invalidDocument: { path: invalid.path, reason: invalid.reason ?? invalid.state } } : {}),
  };
}
