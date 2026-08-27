import { createHash } from "node:crypto";
import {
  canStartExecution,
  compileTaskProgress,
  completionBlockers,
  consumeKnownError,
  isTaskProgressEvent,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
  stableStringify,
  taskProgressWritePlan,
  type CompletionReadinessContext,
  type TaskProgressEventV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { compileRepoTaskPackage } from "../../preset/src/index.ts";
import { runDocAction } from "./doc-sync-actions.ts";
import { scanDocCandidates } from "./doc-sync-candidate-scanner.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";

export function appendProgress(
  cell: any,
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
        (value: any) => value.iteration === task.snapshot.task?.iteration && value.state === "active",
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

export async function completeTask(cell: any, action: RepoTaskAction, binding: RepoCellBinding): Promise<WriteReceipt> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    initial = await cell.service.read(taskId),
    executionId = cell.completeExecutionId(action, initial.snapshot, taskId),
    allowed = ["kind", "taskId", "executionId", "verb", "commandType", "ci", "paths"],
    paths = cell.cellStringList(action.paths);
  if (
    Object.keys(action).some((field) => !allowed.includes(field)) ||
    (action.ci !== undefined && action.ci !== "passed") ||
    (action.paths !== undefined && (!Array.isArray(action.paths) || paths.length !== action.paths.length))
  )
    throw cell.cellCodedError(
      "invalid_command",
      [
        "Complete accepts --ci passed and optional canonical --path values only; ",
        "the submitted commit and iteration are derived automatically.",
      ].join(""),
    );
  const steps: WriteReceipt[] = [],
    facadeOpId = cell.operationId(
      {
        kind: "task-complete",
        taskId,
        executionId,
        ...(action.ci === "passed" ? { ci: "passed" } : {}),
        ...(paths.length ? { paths } : {}),
      },
      binding,
      cell.input.repoId,
      initial.snapshot.revision,
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
        cell.completeRetryCommand(taskId, executionId, action),
      ),
      blocker = completionBlockers(current.snapshot, executionId, completion)[0];
    if (!blocker) {
      let completed: WriteReceipt;
      try {
        completed = await cell.lifecycleAction({ kind: "task-complete", taskId, executionId }, binding);
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
    if (blocker.code === "ci_missing" && action.ci === "passed") {
      const step = cell.publishCiWitness(taskId, executionId, current.snapshot, current.packagePath, binding);
      steps.push(step);
      continue;
    }
    if (blocker.code === "code_doc_missing" && paths.length) {
      const submitted = current.snapshot.executions.find(
        (candidate: any) =>
          candidate.executionId === executionId && candidate.iteration === current.snapshot.task?.iteration,
      );
      if (!submitted?.submission)
        throw cell.cellCodedError(
          "invalid_transition",
          "Complete requires a submitted execution before code-doc reconciliation.",
        );
      const step = await cell.lifecycleAction(
        {
          kind: "task-code-doc-reconcile",
          taskId,
          executionId,
          commitSha: submitted.submission.commitSha,
          iteration: submitted.iteration,
          paths,
        },
        binding,
      );
      steps.push(step);
      if (step.outcome === "applied") continue;
      return cell.completionSettlement(step, current.snapshot, executionId, steps, "code-doc-settlement");
    }
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
    cell.rejected(facadeOpId, "facade_replay_exhausted", `ha receipt show ${facadeOpId}`),
    (await cell.service.read(taskId)).snapshot,
    executionId,
    steps,
    "re-dispatch",
  );
}

export function completionContext(
  cell: any,
  taskId: string,
  snapshot: Snapshot,
  packagePath: string | null,
  binding: RepoCellBinding,
  retryCommand: string,
): CompletionReadinessContext {
  if (!packagePath || !snapshot.task?.presetSnapshotDigest)
    throw cell.cellCodedError(
      "content_not_ready",
      `Task ${taskId} package metadata is not ready; run ha daemon projection rebuild, then retry ${retryCommand}.`,
    );
  const presetRead = cell.projection.readPresetSnapshot(snapshot.task.presetSnapshotDigest),
    presetReady = presetRead.status === "ready",
    preset = presetRead.snapshot as {
      readonly templates?: readonly {
        readonly slot: string;
        readonly path: string;
        readonly content: {
          readonly sha256: string;
        };
      }[];
    } | null;
  if (!presetReady || !preset)
    throw cell.cellCodedError(
      "content_not_ready",
      [
        "Task ",
        `${taskId}`,
        " closeout preset projection is not ready; run ha daemon projection ",
        "rebuild, then retry ",
        `${retryCommand}`,
        ".",
      ].join(""),
    );
  const template = preset.templates?.find((value) => value.slot === "task.closeout");
  if (!template)
    throw cell.cellCodedError(
      "content_not_ready",
      [
        "Task ",
        `${taskId}`,
        " preset has no task.closeout template; run ha preset upgrade ",
        `${taskId}`,
        ", then retry ",
        `${retryCommand}`,
        ".",
      ].join(""),
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
      settings: cell.settingsActions.read(),
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
  if (current.snapshot.digest !== snapshot.task.presetSnapshotDigest)
    throw cell.cellCodedError("preset_snapshot_mismatch", `Run ha preset upgrade ${taskId} before completion.`);
  const closeoutPath = `${packagePath}/${template.path}`,
    projected = cell.projection.readDocument(closeoutPath),
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
    eligibleDirtyPaths = scan.rows.filter((row) => row.state === "eligible").map((row) => row.path),
    closeout = eligibleDirtyPaths.includes(closeoutPath)
      ? "dirty_eligible"
      : projected.document === null
        ? "missing"
        : projected.document.blobSha256 === template.content.sha256
          ? "placeholder"
          : "ready";
  const producesFactCount = cell.projection
    .readFactGraph()
    .edges.filter(
      (row: {
        readonly sourceRef: string;
        readonly targetRef: string;
        readonly relationType: string;
        readonly state: string;
      }) =>
        row.sourceRef === `task/${taskId}` &&
        row.relationType === "produces" &&
        row.state === "active" &&
        row.targetRef.startsWith("fact/"),
    ).length;
  return { closeout, closeoutPath, eligibleDirtyPaths, producesFactCount };
}
