import { createHash } from "node:crypto";
import {
  sessionProvenance,
  taskBootstrapWritePlan,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { compileRepoPresetSnapshotUpgrade, compileRepoTaskBootstrap } from "../../preset/src/index.ts";
import type { PublicPublication, RepoCellBinding, RepoTaskAction, TaskCreateReceipt } from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { taskCreateGuidance } from "./receipt-guidance.ts";

export function readResult(
  cell: RepoCellOperationalContext,
  opId: string,
  value: object,
  revision: number,
  worktreeVisible: boolean | null,
  projectedCut?: { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number },
): WriteReceipt {
  const cut = projectedCut ?? cell.projection.readCut(),
    ready = cut.status === "ready",
    base = {
      opId,
      revision,
      evidence: JSON.stringify({
        ...value,
        status: cut.status,
        watermark: cut.watermark,
        sourceRevision: cut.sourceRevision,
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: revision,
        appliedCut: cut.watermark,
        durable: true,
        canonicalVisible: ready,
        worktreeVisible,
      },
    };
  return ready
    ? { outcome: "applied", ...base }
    : {
        outcome: "pending",
        ...base,
      };
}

export function previewResult(
  cell: RepoCellOperationalContext,
  opId: string,
  value: object,
  revision: number,
  command: string,
): WriteReceipt {
  const cut = cell.projection.readCut();
  return {
    outcome: "pending",
    opId,
    revision,
    evidence: JSON.stringify({
      ...value,
      status: cut.status,
      watermark: cut.watermark,
      sourceRevision: cut.sourceRevision,
    }),
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: cut.watermark,
      durable: false,
      canonicalVisible: false,
      worktreeVisible: false,
    },
    guidance: [{ kind: "remove-dry-run", args: { command } }],
  };
}

export function withHumanSummary(cell: RepoCellOperationalContext, receipt: WriteReceipt): WriteReceipt {
  if (
    typeof (
      receipt as {
        readonly summary?: unknown;
      }
    ).summary === "string" ||
    typeof receipt.evidence !== "string"
  )
    return receipt;
  const payload = cell.decodeEvidencePayload(receipt.evidence);
  return payload === undefined
    ? receipt
    : ({
        ...receipt,
        summary: cell.renderEvidencePayload(payload),
      } as WriteReceipt);
}

export function createTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const prepared = prepareTaskCreateAt(cell, action, binding);
  if (!("compiled" in prepared)) return prepared;
  const appended = cell.store.append(prepared.compiled),
    publication = cell.publicPublication(appended);
  applyPreparedTaskCreate(cell, prepared);
  cell.input.killpoint?.("after_sqlite_commit");
  const receipt = preparedTaskCreateReceipt(cell, prepared, publication);
  cell.input.killpoint?.("before_response_write");
  cell.input.killpoint?.("after_response_write");
  return receipt;
}

type PreparedTaskCreateFields = Pick<
  TaskCreateReceipt,
  | "taskId"
  | "taskStatus"
  | "packagePath"
  | "generatedPaths"
  | "presetDigest"
  | "scaffoldDigest"
  | "presetId"
  | "profileId"
  | "outputShape"
  | "completionGates"
  | "dryRun"
>;

export interface PreparedTaskCreate {
  readonly compiled: ReturnType<typeof compileRepoTaskBootstrap> & {
    readonly plan: ReturnType<typeof taskBootstrapWritePlan>;
  };
  readonly fields: PreparedTaskCreateFields;
}

export function prepareTaskCreateAt(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  assigned?: { readonly workspaceRevision: number },
): WriteReceipt | PreparedTaskCreate {
  const dryRun = action.dryRun === true,
    canonicalAction = cell.withoutDryRun(action),
    canonicalOpId = cell.operationId(canonicalAction, binding, cell.input.repoId, 0),
    opId = dryRun ? `preview:${createHash("sha256").update(canonicalOpId).digest("hex")}` : canonicalOpId,
    existing = dryRun ? null : cell.store.readEvent(opId);
  if (existing) {
    return cell.receiptForOperation(opId, binding);
  }
  const idempotent =
    !dryRun && typeof canonicalAction.idempotencyKey === "string"
      ? cell.projection.readTaskByIdempotencyKey(canonicalAction.idempotencyKey)
      : null;
  if (idempotent) {
    const current = cell.projection.read(idempotent.taskId);
    return {
      ...cell.readResult(
        opId,
        {
          reused: true,
          taskId: idempotent.taskId,
          idempotencyKey: canonicalAction.idempotencyKey,
        },
        current.sourceRevision,
        true,
      ),
      taskId: idempotent.taskId,
      taskStatus: idempotent.status as TaskCreateReceipt["taskStatus"],
      packagePath: idempotent.packagePath,
      summary: `reused task ${idempotent.taskId} for the supplied idempotency key`,
    } as WriteReceipt;
  }
  const taskId = cell.createTaskId(canonicalAction, binding, cell.input.repoId);
  if (cell.projection.readTaskExists(taskId)) return cell.rejected(opId, "task_exists");
  if (typeof canonicalAction.parentTaskId === "string" && !cell.projection.readTaskExists(canonicalAction.parentTaskId))
    return cell.rejected(opId, "parent_not_found");
  const currentRevision = cell.store.readHead()?.revision ?? 0,
    workspaceRevision = assigned?.workspaceRevision ?? currentRevision + 1,
    eventId = `event-${createHash("sha256").update(opId).digest("hex")}`,
    occurredAt = cell.now(),
    baseCompiled = compileRepoTaskBootstrap({
      rootDir: cell.rootDir,
      settings: cell.settings.read(),
      action: canonicalAction,
      taskId,
      actor: binding.actor,
      source: binding.source,
      workspaceRevision,
      eventId,
      opId,
      occurredAt,
    }),
    event = {
      ...baseCompiled.event,
      payload: {
        ...baseCompiled.event.payload,
        task: {
          ...baseCompiled.event.payload.task,
          provenance: [sessionProvenance(resolveWriteSessionIdentity(binding, cell.projection), occurredAt)],
        },
      },
    },
    compiled = {
      ...baseCompiled,
      event,
      plan: taskBootstrapWritePlan(event),
    },
    commonFields = {
      taskId,
      taskStatus: "planned" as const,
      packagePath: compiled.packagePath,
      generatedPaths: compiled.documents.map((document) => document.path),
      presetDigest: compiled.snapshot.digest,
      scaffoldDigest: compiled.scaffoldDigest,
      presetId: compiled.snapshot.identity.id,
      profileId: compiled.snapshot.profile.id,
      outputShape: compiled.snapshot.profile.outputShape,
      completionGates: compiled.snapshot.profile.completionGateIds,
      dryRun,
    },
    common = commonFields;
  if (dryRun) {
    const preview: TaskCreateReceipt = {
      outcome: "pending",
      opId,
      revision: currentRevision,
      evidence: JSON.stringify(common),
      visibility: "center",
      proof: {
        committedRevision: currentRevision,
        appliedCut: currentRevision,
        durable: false,
        canonicalVisible: false,
        worktreeVisible: false,
      },
      ...common,
      guidance: taskCreateGuidance({
        taskId,
        packagePath: compiled.packagePath,
        outputShape: compiled.snapshot.profile.outputShape,
        dryRun,
        opId,
        canonicalVisible: false,
      }),
      commitSha: null,
      summary: `would create task ${taskId} at ${compiled.packagePath}`,
    };
    return preview;
  }
  return { compiled, fields: common };
}

export function applyPreparedTaskCreate(cell: RepoCellOperationalContext, prepared: PreparedTaskCreate): void {
  cell.projection.apply(prepared.compiled.event, prepared.compiled.plan);
  cell.knownTaskIds?.add(prepared.fields.taskId);
}

export function preparedTaskCreateReceipt(
  cell: RepoCellOperationalContext,
  prepared: PreparedTaskCreate,
  publication: PublicPublication,
): TaskCreateReceipt {
  const proof = cell.receiptProof(prepared.compiled.event, publication),
    { fields, compiled } = prepared;
  const receipt: TaskCreateReceipt = {
    outcome: proof.canonicalVisible ? "applied" : "pending",
    opId: compiled.event.opId,
    revision: compiled.event.workspaceRevision,
    evidence: `event-object:${compiled.event.opId}`,
    visibility: "center",
    proof,
    ...fields,
    guidance: taskCreateGuidance({
      taskId: fields.taskId,
      packagePath: compiled.packagePath,
      outputShape: compiled.snapshot.profile.outputShape,
      dryRun: fields.dryRun,
      opId: compiled.event.opId,
      canonicalVisible: proof.canonicalVisible,
    }),
    commitSha: publication.commitSha,
    cut: publication.cut,
    summary: proof.canonicalVisible
      ? `created task ${fields.taskId} at ${compiled.packagePath}`
      : `task ${fields.taskId} is awaiting exact canonical settlement`,
  };
  return receipt;
}

export function upgradePresetSnapshot(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    projected = cell.projection.read(taskId),
    taskReady = projected.status === "ready";
  if (!projected.snapshot.task || !projected.packagePath || !taskReady)
    throw cell.cellCodedError("content_not_ready", `Task ${taskId} is not ready for preset upgrade.`);
  const contract = cell.projection.readDocument(`${projected.packagePath}/task-contract.json`),
    contractReady = contract.status === "ready";
  if (!contract.document || !contractReady)
    throw cell.cellCodedError("content_not_ready", `Task ${taskId} contract is not ready for preset upgrade.`);
  const opId = cell.operationId(action, binding, cell.input.repoId, projected.snapshot.revision),
    existing = cell.store.readEvent(opId);
  if (existing) return cell.receiptForOperation(opId, binding);
  const compiled = compileRepoPresetSnapshotUpgrade({
      rootDir: cell.rootDir,
      settings: cell.settings.read(),
      task: projected.snapshot.task,
      taskContractBody: contract.document.body,
      actor: binding.actor,
      source: binding.source,
      workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      opId,
      occurredAt: cell.now(),
    }),
    appended = cell.store.append(compiled),
    publication = cell.publicPublication(appended);
  cell.projection.apply(compiled.event, compiled.plan);
  const projectedCut = cell.projection.read(taskId).watermark,
    proof = cell.receiptProof(compiled.event, publication),
    base = {
      opId,
      revision: appended.revision,
      evidence: JSON.stringify({
        taskId,
        previousDigest: compiled.event.payload.previousDigest,
        digest: compiled.snapshot.digest,
      }),
      visibility: "center" as const,
      proof,
      ...publication,
    };
  return proof.canonicalVisible && projectedCut >= compiled.event.workspaceRevision
    ? {
        outcome: "applied",
        ...base,
      }
    : {
        outcome: "pending",
        ...base,
      };
}
