import { createHash } from "node:crypto";
import {
  createEntityStore,
  isMigrationImportEvent,
  requireEntityStoreKindContract,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import {
  compileRestatedTaskContract,
  restateTaskContractBody,
  type RestatedTaskContract,
} from "./migration-import-task-restatement.ts";
import type { RepoCellBinding, RepoTaskAction, TaskCreateReceipt } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import {
  acceptPreparedTaskSurfaceWrites,
  prepareTaskSurfaceWriteAt,
  type PreparedTaskSurfaceWrite,
} from "./repo-cell-task-command-docs.ts";

export function archiveTasks(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const selected = [
    ...new Set(
      Array.isArray(action.taskIds)
        ? cell.cellStringList(action.taskIds)
        : cell
            .queryRead()
            .guiTasks()
            .rows.filter((row) => {
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
            .map((row) => row.taskId),
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
  const headRevision = cell.store.readHead()?.revision ?? 0,
    outerOpId = cell.operationId(action, binding, cell.input.repoId, headRevision),
    prepared = selected.map((taskId, index) =>
      requirePrepared(
        prepareTaskSurfaceWriteAt(cell, { ...single, taskId }, binding, cell.now(), {
          workspaceRevision: headRevision + index + 1,
          ...(index === selected.length - 1 ? { opId: outerOpId } : {}),
        }),
      ),
    ),
    steps = acceptPreparedTaskSurfaceWrites(cell, prepared);
  return {
    ...steps.at(-1)!,
    evidence: JSON.stringify({ archived: selected }),
    steps,
  } as WriteReceipt;
}

export function supersedeWithNewTask(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
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

export function migrateTaskContracts(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const migratedTaskIds = new Set(
      cell.store
        .read()
        .events.filter(isMigrationImportEvent)
        .flatMap((event) => (event.payload.entity.kind === "task" ? [event.payload.entity.task.taskId] : [])),
    ),
    candidates = typeof action.taskId === "string" ? [action.taskId] : [...cell.projectedTaskIds()],
    repairs = new Map<string, RestatedTaskContract>(),
    report = candidates.map((taskId) => {
      const current = cell.projection.read(taskId),
        task = current.snapshot.task;
      if (!task) return { taskId, status: "manual", reason: "task_not_found" };
      if (migratedTaskIds.has(taskId) && current.packagePath) {
        const projected = cell.projection.readDocument(`${current.packagePath}/task-contract.json`);
        if (!cell.projectionReady(projected))
          return { taskId, status: "manual", reason: "contract_projection_pending" };
        let restated: RestatedTaskContract,
          packagePathBefore: string | null = null;
        try {
          const fallback = {
            title: task.title,
            taskClass: task.taskClass,
            verticalId: task.metadata?.verticalId,
            presetId: task.metadata?.presetId,
            profileId: task.metadata?.profileId,
            slug: task.metadata?.slug,
          };
          if (projected.document) {
            restated = restateTaskContractBody({
              sourceRoot: cell.rootDir,
              sourcePath: `${current.packagePath}/task-contract.json`,
              body: projected.document.body,
              targetTaskId: taskId,
              targetPackagePath: current.packagePath,
              fallback,
            });
            const contract = JSON.parse(projected.document.body) as Record<string, unknown>;
            packagePathBefore = typeof contract.packagePath === "string" ? contract.packagePath : null;
          } else
            restated = compileRestatedTaskContract({
              sourceRoot: cell.rootDir,
              sourcePath: `${current.packagePath}/task-contract.json`,
              targetTaskId: taskId,
              targetPackagePath: current.packagePath,
              fallback,
            });
        } catch (error) {
          return {
            taskId,
            status: "manual",
            reason: "contract_digest_not_derivable",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        const digestBefore = task.presetSnapshotDigest;
        if (digestBefore !== null && digestBefore !== restated.presetSnapshotDigest)
          return {
            taskId,
            status: "manual",
            reason: "contract_digest_conflict",
            presetSnapshotDigest: digestBefore,
            contractPresetSnapshotDigest: restated.presetSnapshotDigest,
          };
        if (digestBefore === null || packagePathBefore !== current.packagePath || (task.contractVersion ?? 0) < 1) {
          repairs.set(taskId, restated);
          return {
            taskId,
            status: "repair",
            presetSnapshotDigestBefore: digestBefore,
            presetSnapshotDigestAfter: restated.presetSnapshotDigest,
            packagePathBefore,
            packagePathAfter: current.packagePath,
            digestSource: restated.source,
            ...(restated.repair
              ? {
                  disposition: restated.repair.disposition,
                  presetIdBefore: task.metadata?.presetId ?? null,
                  presetIdAfter: restated.repair.presetId,
                  taskClassBefore: task.taskClass,
                  taskClassAfter: restated.repair.taskClass,
                }
              : {}),
          };
        }
        return { taskId, status: "current" };
      }
      return (task.contractVersion ?? 0) >= 1
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
      "task-contract-migrate",
    );
  const backfills = report.filter((row) => row.status === "backfill" || row.status === "repair");
  if (backfills.length === 0)
    return {
      outcome: "no_changes",
      opId: cell.operationId(action, binding, cell.input.repoId, cell.store.readHead()?.revision ?? 0),
      revision: cell.store.readHead()?.revision ?? 0,
      code: "no_changes",
      origin: "task-contract-migrate",
      evidence: JSON.stringify({ report, applied: false, migrated: [], steps: [] }),
      visibility: "center",
      proof: {
        committedRevision: cell.store.readHead()?.revision ?? 0,
        appliedCut: cell.store.readHead()?.revision ?? 0,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: true,
      },
      report,
      applied: false,
      migrated: [],
      steps: [],
    } as WriteReceipt;
  const headRevision = cell.store.readHead()?.revision ?? 0,
    outerOpId = cell.operationId(action, binding, cell.input.repoId, headRevision),
    prepared = backfills.map(({ taskId }, index) =>
      requirePrepared(
        prepareTaskSurfaceWriteAt(
          cell,
          {
            kind: "task-contract-migrate",
            taskId,
            ...(repairs.has(taskId) ? { repairPresetSnapshotDigest: repairs.get(taskId)!.presetSnapshotDigest } : {}),
            ...(repairs.has(taskId) ? { repairTaskContractBody: repairs.get(taskId)!.body } : {}),
            ...(repairs.get(taskId)?.repair
              ? {
                  repairPresetId: repairs.get(taskId)!.repair!.presetId,
                  repairTaskClass: repairs.get(taskId)!.repair!.taskClass,
                }
              : {}),
          },
          binding,
          cell.now(),
          {
            workspaceRevision: headRevision + index + 1,
            ...(index === backfills.length - 1 ? { opId: outerOpId } : {}),
          },
        ),
      ),
    ),
    steps = acceptPreparedTaskSurfaceWrites(cell, prepared);
  return cell.readResult(
    outerOpId,
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

function requirePrepared(value: WriteReceipt | PreparedTaskSurfaceWrite): PreparedTaskSurfaceWrite {
  if (!("compiled" in value)) throw new Error("bulk task mutation unexpectedly completed during preparation");
  return value;
}

export function upsertEntity(
  cell: RepoCellOperationalContext,
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
      };
}
