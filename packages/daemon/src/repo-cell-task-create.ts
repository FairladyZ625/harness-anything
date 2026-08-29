import { createHash } from "node:crypto";
import { sessionProvenance, taskBootstrapWritePlan, type WriteReceipt } from "../../kernel/src/index.ts";
import { compileRepoPresetSnapshotUpgrade, compileRepoTaskBootstrap } from "../../preset/src/index.ts";
import type { RepoCellBinding, RepoTaskAction, TaskCreateReceipt } from "./repo-cell-types.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";

export function readResult(
  cell: RepoCellOperationalContext,
  opId: string,
  value: object,
  revision: number,
  worktreeVisible: boolean | null,
): WriteReceipt {
  const cut = cell.projection.list(),
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
        nextAction: [
          "Retry after the task projection catches up from revision ",
          `${cut.watermark}`,
          " to ",
          `${cut.sourceRevision}`,
          ".",
        ].join(""),
      };
}

export function previewResult(
  cell: RepoCellOperationalContext,
  opId: string,
  value: object,
  revision: number,
  nextAction: string,
): WriteReceipt {
  const cut = cell.projection.list();
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
    nextAction,
  };
}

export function withLayoutAdvisory(cell: RepoCellOperationalContext, receipt: WriteReceipt): WriteReceipt {
  if (receipt.outcome !== "applied" || cell.store.layout() !== "flat/v1") return receipt;
  const advisory = [
    "This ledger still uses the legacy flat/v1 object layout; run ha migrate ",
    "ledger to migrate it to sharded-sha256-2/v1.",
  ].join("");
  const summary = (
    receipt as {
      readonly summary?: unknown;
    }
  ).summary;
  return {
    ...receipt,
    summary: typeof summary === "string" && summary.length > 0 ? `${summary}\n${advisory}` : advisory,
  } as WriteReceipt;
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

export function dependencyPath(cell: RepoCellOperationalContext, start: string, goal: string): boolean {
  const graph = new Map<string, string[]>();
  for (const edge of cell.queryRead().relationGraph().edges)
    if (edge.state === "active" && edge.relationType === "depends-on")
      graph.set(edge.sourceRef, [...(graph.get(edge.sourceRef) ?? []), edge.targetRef]);
  const queue = [start],
    seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === goal) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(graph.get(current) ?? []));
  }
  return false;
}

export function relationEndpointExists(cell: RepoCellOperationalContext, ref: string): boolean {
  const task = /^task\/([^/]+)$/u.exec(ref)?.[1];
  if (task) return cell.projectedTaskIds().has(task);
  const decision = /^decision\/([^/]+)/u.exec(ref)?.[1];
  if (decision) return cell.projection.readDecision(decision).decision !== null;
  const fact = /^fact\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(ref);
  return fact ? cell.projection.readFact(fact[1]!).fact !== null : false;
}

export function createTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const dryRun = action.dryRun === true,
    canonicalAction = cell.withoutDryRun(action),
    canonicalOpId = cell.operationId(canonicalAction, binding, cell.input.repoId, 0),
    opId = dryRun ? `preview:${createHash("sha256").update(canonicalOpId).digest("hex")}` : canonicalOpId,
    existing = dryRun ? null : cell.store.readEvent(opId);
  if (existing) {
    cell.projection.list();
    return cell.receiptForOperation(opId, binding);
  }
  const idempotent =
    !dryRun && typeof canonicalAction.idempotencyKey === "string"
      ? cell.projection
          .list()
          .rows.find((row) => row.snapshot.task?.metadata?.idempotencyKey === canonicalAction.idempotencyKey)
      : undefined;
  if (idempotent?.snapshot.task) {
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
      status: idempotent.snapshot.task.status,
      packagePath: current.packagePath,
      summary: `reused task ${idempotent.taskId} for the supplied idempotency key`,
    } as WriteReceipt;
  }
  const taskId = cell.createTaskId(canonicalAction, binding, cell.input.repoId),
    taskIds = cell.projectedTaskIds();
  if (taskIds.has(taskId))
    return cell.rejected(
      opId,
      "task_exists",
      `Task ${taskId} already exists; choose a different --id or retry the original idempotent request.`,
    );
  if (typeof canonicalAction.parentTaskId === "string" && !taskIds.has(canonicalAction.parentTaskId))
    return cell.rejected(
      opId,
      "parent_not_found",
      [
        "Create parent task ",
        `${canonicalAction.parentTaskId}`,
        " first, then retry with --parent ",
        `${canonicalAction.parentTaskId}`,
        ".",
      ].join(""),
    );
  for (const relation of Array.isArray(canonicalAction.relations) ? canonicalAction.relations : []) {
    const target =
      relation && typeof relation === "object" ? String((relation as Record<string, unknown>).target ?? "") : "";
    if (target && !cell.relationEndpointExists(target))
      return cell.rejected(
        opId,
        "relation_target_not_found",
        `Create or restore relation target ${target}, then retry the same --relation.`,
      );
  }
  const currentRevision = cell.store.readHead()?.revision ?? 0,
    workspaceRevision = currentRevision + 1,
    eventId = `event-${createHash("sha256").update(opId).digest("hex")}`,
    occurredAt = cell.now(),
    baseCompiled = compileRepoTaskBootstrap({
      rootDir: cell.rootDir,
      settings: cell.settingsActions.read(),
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
    common = {
      taskId,
      status: "planned" as const,
      packagePath: compiled.packagePath,
      generatedPaths: compiled.documents.map((document) => document.path),
      presetDigest: compiled.snapshot.digest,
      scaffoldDigest: compiled.scaffoldDigest,
      presetId: compiled.snapshot.identity.id,
      profileId: compiled.snapshot.profile.id,
      outputShape: compiled.snapshot.profile.outputShape,
      completionGates: compiled.snapshot.profile.completionGateIds,
      dryRun,
    };
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
      commitSha: null,
      summary: `would create task ${taskId} at ${compiled.packagePath}`,
      nextAction: "remove --dry-run to publish this exact resolved scaffold",
    };
    return preview;
  }
  const appended = cell.store.append({
      event: compiled.event,
      plan: compiled.plan,
      blobs: compiled.blobs,
    }),
    publication = cell.publicPublication(appended),
    proof = cell.receiptProof(compiled.event, publication);
  cell.projection.apply(compiled.event, compiled.plan);
  taskIds.add(taskId);
  cell.input.killpoint?.("after_sqlite_commit");
  const receipt: TaskCreateReceipt = {
    outcome: proof.canonicalVisible ? "applied" : "pending",
    opId,
    revision: appended.revision,
    evidence: `event-object:${opId}`,
    visibility: "center",
    proof,
    ...common,
    commitSha: publication.commitSha,
    cut: publication.cut,
    summary: proof.canonicalVisible
      ? `created task ${taskId} at ${compiled.packagePath}`
      : `task ${taskId} is awaiting exact canonical settlement`,
    nextAction: proof.canonicalVisible
      ? `edit ${compiled.packagePath}/task_plan.md, then run ha task start ${taskId} --execution-id <id>`
      : `ha receipt show ${opId}`,
  };
  cell.input.killpoint?.("before_response_write");
  cell.input.killpoint?.("after_response_write");
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
      settings: cell.settingsActions.read(),
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
        nextAction: [
          "Run ha preset check ",
          `${compiled.snapshot.identity.id}`,
          " --snapshot-digest ",
          `${compiled.snapshot.digest}`,
          ".",
        ].join(""),
      }
    : {
        outcome: "pending",
        ...base,
        nextAction: `Retry after preset upgrade event ${opId} reaches the exact canonical and projection cuts.`,
      };
}
