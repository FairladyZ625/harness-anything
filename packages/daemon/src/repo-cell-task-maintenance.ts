import { createHash } from "node:crypto";
import { createEntityStore, requireEntityStoreKindContract, type WriteReceipt } from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction, TaskCreateReceipt } from "./repo-cell-types.ts";

export function archiveTasks(cell: any, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const selected = [
    ...new Set(
      Array.isArray(action.taskIds)
        ? cell.cellStringList(action.taskIds)
        : cell.queryRead
            .guiTasks()
            .rows.filter((row: any) => {
              const state = /^state:(.+)$/u.exec(String(action.filter ?? ""))?.[1],
                before = typeof action.before === "string" ? Date.parse(action.before) : Number.NaN;
              if (action.before && Number.isNaN(before))
                throw cell.cellCodedError(
                  "invalid_command",
                  "Use an ISO-compatible --before date, then retry task archive.",
                );
              return (
                (!state || row.snapshot.task?.status === state) &&
                (!action.before || Date.parse(row.updatedAt) < before)
              );
            })
            .map((row: any) => row.taskId),
    ),
  ];
  if (!selected.length)
    throw cell.cellCodedError(
      "empty_selection",
      "Adjust --ids, --filter, or --before so task archive selects at least one Task.",
    );
  const { taskIds: _ids, filter: _filter, before: _before, ...single } = action;
  for (const taskId of selected) {
    const current = cell.projection.read(taskId);
    if (!cell.projectionReady(current) || !current.snapshot.task)
      throw cell.cellCodedError("task_not_found", `Create or import task ${taskId} before running task-archive.`);
    cell.taskMutation({ ...single, taskId }, current.snapshot.task, current.snapshot, binding);
  }
  const steps = selected.map((taskId) => cell.taskSurfaceWrite({ ...single, taskId }, binding));
  return {
    ...steps.at(-1)!,
    opId: cell.operationId(action, binding, cell.input.repoId, cell.store.readHead()?.revision ?? 0),
    evidence: JSON.stringify({ archived: selected }),
    steps,
  } as WriteReceipt;
}

export function supersedeWithNewTask(cell: any, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const oldTaskId = cell.requiredCellText(action.oldTaskId, "oldTaskId"),
    old = cell.projection.read(oldTaskId);
  if (!cell.projectionReady(old) || !old.snapshot.task)
    throw cell.cellCodedError(
      "task_not_found",
      `Run ha task list, choose an existing old task id, then retry task supersede.`,
    );
  if (old.snapshot.lease)
    throw cell.cellCodedError("active_lease", `Run ha task release ${oldTaskId} before task-supersede.`);
  if ((old.snapshot.task.packageDisposition ?? "active") !== "active" || old.snapshot.task.supersededBy)
    throw cell.cellCodedError(
      "invalid_disposition",
      `Use ha task show ${oldTaskId}; only active, non-superseded tasks can be superseded.`,
    );
  const metadata = old.snapshot.task.metadata,
    created = cell.createTask(
      {
        kind: "task-create",
        title: action.title,
        ...(typeof action.slug === "string" ? { slug: action.slug } : {}),
        ...(metadata
          ? {
              parentTaskId: metadata.parentTaskId ?? undefined,
              workKind: metadata.workKind,
              riskTier: metadata.riskTier,
              urgency: metadata.urgency,
              verticalId: metadata.verticalId,
              presetId: metadata.presetId,
              profileId: metadata.profileId,
              moduleKey: metadata.moduleKey,
              surfaces: metadata.surfaces,
            }
          : {}),
      },
      binding,
    ) as TaskCreateReceipt;
  if (created.outcome !== "applied") return created;
  const replaced = cell.taskSurfaceWrite(
    {
      kind: "task-supersede",
      oldTaskId,
      byTaskId: created.taskId,
      confirm: oldTaskId,
      reason: action.reason,
      allowOpenFindings: action.allowOpenFindings,
    },
    binding,
  );
  return {
    ...replaced,
    replacementTaskId: created.taskId,
    steps: [created, replaced],
  } as WriteReceipt;
}

export function migrateTaskContracts(cell: any, action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt {
  const candidates = typeof action.taskId === "string" ? [action.taskId] : [...cell.projectedTaskIds()],
    report = candidates.map((taskId) => {
      const current = cell.projection.read(taskId),
        task = current.snapshot.task;
      return !task
        ? { taskId, status: "manual", reason: "task_not_found" }
        : (task.contractVersion ?? 0) >= 1
          ? { taskId, status: "current" }
          : !task.metadata || !task.presetSnapshotDigest || !current.packagePath
            ? {
                taskId,
                status: "manual",
                reason: "contract_metadata_incomplete",
              }
            : { taskId, status: "backfill" };
    });
  if (action.mode === "dry-run")
    return cell.previewResult(
      cell.operationId(action, binding, cell.input.repoId, cell.store.readHead()?.revision ?? 0),
      {
        report,
        applied: false,
        manual: report.filter((row) => row.status === "manual"),
      },
      cell.store.readHead()?.revision ?? 0,
      "Run task contract migrate --apply to publish the eligible backfill events.",
    );
  const backfills = report.filter((row) => row.status === "backfill"),
    steps = backfills.map(({ taskId }) => cell.taskSurfaceWrite({ kind: "task-contract-migrate", taskId }, binding));
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, cell.store.readHead()?.revision ?? 0),
    {
      report,
      applied: true,
      migrated: backfills.map((row) => row.taskId),
      steps,
    },
    cell.store.readHead()?.revision ?? 0,
    steps.length > 0,
  );
}

export function upsertEntity(
  cell: any,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  prepared: {
    readonly entityKind: string;
    readonly entity: unknown;
    readonly report: Readonly<Record<string, unknown>>;
  },
): WriteReceipt {
  const contract = requireEntityStoreKindContract(prepared.entityKind),
    currentRevision = cell.store.readHead()?.revision ?? 0,
    canonicalAction = cell.withoutDryRun(action),
    canonicalOpId = cell.operationId(canonicalAction, binding, cell.input.repoId, currentRevision);
  if (action.dryRun === true)
    return {
      outcome: "pending",
      opId: `preview:${canonicalOpId}`,
      revision: currentRevision,
      evidence: JSON.stringify(prepared.report),
      visibility: "center",
      proof: {
        committedRevision: currentRevision,
        appliedCut: currentRevision,
        durable: false,
        canonicalVisible: false,
        worktreeVisible: false,
      },
      nextAction: "Remove --dry-run to publish this declaration through the canonical event stream.",
    };
  const compiled = createEntityStore(cell.store).upsert({
      entityKind: prepared.entityKind,
      entity: prepared.entity,
      eventId: `event-${createHash("sha256").update(canonicalOpId).digest("hex")}`,
      opId: canonicalOpId,
      workspaceRevision: currentRevision + 1,
      actor: binding.actor,
      source: binding.source,
      occurredAt: cell.now(),
    }),
    appended = cell.store.append(compiled);
  cell.projection.apply(compiled.event, compiled.plan);
  cell.input.killpoint?.("after_sqlite_commit");
  const applied = cell.projection.readOperation(compiled.event.opId),
    visible = !!applied && applied.watermark >= compiled.event.workspaceRevision,
    proof = {
      committedRevision: compiled.event.workspaceRevision,
      appliedCut: applied?.watermark ?? 0,
      durable: true,
      canonicalVisible: visible,
      worktreeVisible: true,
    },
    publication = cell.publicPublication(appended),
    receipt = {
      opId: compiled.event.opId,
      revision: compiled.event.workspaceRevision,
      evidence: JSON.stringify({
        report: prepared.report,
        event: {
          schema: compiled.event.schema,
          eventId: compiled.event.eventId,
          opId: compiled.event.opId,
          path: compiled.event.payload.declarationDocumentClaim.path,
        },
        commitSha: publication.commitSha,
        cut: publication.cut,
      }),
      visibility: "center" as const,
      proof,
      detail: {
        kind: "entity_upsert" as const,
        entityKind: compiled.event.payload.entityKind,
        entityId: compiled.event.payload.entityId,
        schemaId: contract.schema.$id,
        path: compiled.event.payload.declarationDocumentClaim.path,
      },
      ...publication,
    };
  cell.input.killpoint?.("before_response_write");
  cell.input.killpoint?.("after_response_write");
  return visible
    ? { outcome: "applied", ...receipt }
    : {
        outcome: "pending",
        ...receipt,
        nextAction: `Retry after the projection records declaration event ${compiled.event.opId}.`,
      };
}
