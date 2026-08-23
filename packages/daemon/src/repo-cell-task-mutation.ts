import {
  canReclaim,
  deriveRelationId,
  isSameExecution,
  isTerminalStatus,
  taskClasses,
  validateRelationRecordsForHost,
  type EntityRelationRecord,
  type TaskEventV1,
  type TaskV1,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";

export function taskMutation(
  cell: any,
  action: RepoTaskAction,
  task: TaskV1,
  snapshot: Snapshot,
  binding: RepoCellBinding,
): {
  readonly type: TaskEventV1["type"];
  readonly task: TaskV1;
  readonly audit: {
    readonly command:
      | "release"
      | "amend"
      | "archive"
      | "supersede"
      | "delete"
      | "reopen"
      | "contract-migrate"
      | "relate";
    readonly reason: string;
    readonly fields: readonly string[];
  };
  readonly execution?: Snapshot["executions"][number];
  readonly releasedLease?: NonNullable<Snapshot["lease"]>;
} {
  const reason =
      typeof action.reason === "string" && action.reason.trim()
        ? action.reason.trim()
        : "Authenticated holder released the lease.",
    activeLease = snapshot.lease,
    amendPatches = action.kind === "task-amend" && Array.isArray(action.patches) ? action.patches : [],
    pinOnlyAmend =
      amendPatches.length > 0 &&
      amendPatches.every(
        (raw) => raw !== null && typeof raw === "object" && (raw as Record<string, unknown>).field === "pinned",
      );
  if (action.kind === "task-release") {
    if (!activeLease)
      throw cell.cellCodedError("lease_not_found", `Start task ${task.taskId} before releasing its lease.`);
    if (!isSameExecution(activeLease.actor, binding.actor) && !canReclaim(activeLease, binding.actor, cell.now()))
      throw cell.cellCodedError(
        "lease_conflict",
        [
          "The current holder, or the same principal after the lease becomes ",
          "orphaned, must run ha task release ",
          `${task.taskId}`,
          ".",
        ].join(""),
      );
    const execution = snapshot.executions.find((value) => value.executionId === activeLease.executionId);
    if (!execution)
      throw cell.cellCodedError(
        "orphaned_reservation",
        [
          "Lease ",
          `${activeLease.executionId}`,
          " is an in-flight reservation with no published execution behind it; wait ",
          "for the holder to publish it or for the reservation to lapse at ",
          `${activeLease.expiresAt}`,
          ", then rerun ha task release ",
          `${task.taskId}`,
          ".",
        ].join(""),
      );
    return {
      type: "lease_released",
      task,
      execution,
      releasedLease: activeLease,
      audit: { command: "release", reason, fields: ["lease"] },
    };
  }
  if (activeLease && !pinOnlyAmend)
    throw cell.cellCodedError("active_lease", `Run ha task release ${task.taskId} before ${action.kind}.`);
  if (action.kind === "task-amend") {
    const patches = amendPatches,
      metadata = task.metadata;
    if (!patches.length || (!metadata && !pinOnlyAmend))
      throw cell.cellCodedError(
        "invalid_amend",
        `Use ha task amend ${task.taskId} --set <field>:<value> on a task with a current contract.`,
      );
    let changed: TaskV1 = task;
    const fields: string[] = [];
    for (const raw of patches) {
      if (!raw || typeof raw !== "object")
        throw cell.cellCodedError("invalid_amend", "Each --set must use field:value.");
      const patch = raw as Record<string, unknown>,
        field = cell.requiredCellText(patch.field, "patch.field"),
        value = cell.requiredCellText(patch.value, "patch.value");
      if (field === "title") changed = { ...changed, title: value };
      else if (field === "pinned" && (value === "true" || value === "false"))
        changed = { ...changed, pinned: value === "true" };
      else if (field === "parentTaskId") {
        if (!cell.projectedTaskIds().has(value))
          throw cell.cellCodedError("parent_not_found", `Create parent task ${value} before amending parentTaskId.`);
        changed = {
          ...changed,
          metadata: { ...changed.metadata!, parentTaskId: value },
        };
      } else if (field === "workKind" && ["feat", "fix", "refactor", "docs", "test", "chore"].includes(value))
        changed = {
          ...changed,
          metadata: {
            ...changed.metadata!,
            workKind: value as NonNullable<TaskV1["metadata"]>["workKind"],
          },
        };
      else if ((field === "riskTier" || field === "urgency") && ["low", "medium", "high"].includes(value))
        changed = {
          ...changed,
          metadata: { ...changed.metadata!, [field]: value },
        };
      else if (field === "moduleKey")
        changed = {
          ...changed,
          metadata: { ...changed.metadata!, moduleKey: value },
        };
      else if (field === "taskClass" && (taskClasses as readonly string[]).includes(value))
        changed = { ...changed, taskClass: value as TaskV1["taskClass"] };
      else
        throw cell.cellCodedError(
          "invalid_amend",
          [
            "Amend title, parentTaskId, workKind, riskTier, urgency, moduleKey, ",
            "taskClass, or pinned (true/false); use task contract migrate for ",
            "contract shape changes.",
          ].join(""),
        );
      fields.push(field);
    }
    return {
      type: "task_amended",
      task: changed,
      audit: {
        command: "amend",
        reason: "Declared task metadata amendment",
        fields,
      },
    };
  }
  if (action.kind === "task-relate") {
    const target = cell.requiredCellText(action.target, "target"),
      targetTask = /^task\/([^/]+)$/u.exec(target)?.[1];
    if (action.relationType !== "depends-on" || !targetTask)
      throw cell.cellCodedError(
        "invalid_relation",
        "Use ha task relate <task-id> --depends-on <task-id> --rationale <text>.",
      );
    if (!cell.projectedTaskIds().has(targetTask))
      throw cell.cellCodedError(
        "relation_target_not_found",
        `Create relation target ${targetTask} before adding the dependency.`,
      );
    const basis = {
        source: `task/${task.taskId}`,
        target,
        type: "depends-on" as const,
        direction: "directed" as const,
      },
      relation: EntityRelationRecord = {
        relation_id: deriveRelationId(basis),
        ...basis,
        strength: "strong",
        origin: "declared",
        rationale: cell.requiredCellText(action.rationale, "rationale"),
        state: "active",
      },
      relations = [...(task.relations ?? [])];
    if (relations.some((value) => value.relation_id === relation.relation_id))
      throw cell.cellCodedError(
        "relation_exists",
        `Use ha relation list --entity task/${task.taskId} to inspect the existing dependency.`,
      );
    const issues = validateRelationRecordsForHost(`task/${task.taskId}`, [...relations, relation]);
    if (issues.length)
      throw cell.cellCodedError("invalid_relation", `${issues[0]!.message}; fix the endpoints or rationale and retry.`);
    if (cell.dependencyPath(target, `task/${task.taskId}`))
      throw cell.cellCodedError(
        "relation_cycle",
        `Remove the dependency path from ${target} to task/${task.taskId} before adding this edge.`,
      );
    return {
      type: "task_relation_added",
      task: { ...task, relations: [...relations, relation] },
      audit: {
        command: "relate",
        reason: relation.rationale,
        fields: [relation.relation_id],
      },
    };
  }
  if (action.kind === "task-archive") {
    if ((task.packageDisposition ?? "active") !== "active")
      throw cell.cellCodedError("invalid_disposition", `Reopen task ${task.taskId} before archiving it again.`);
    const unresolved = (task.relations ?? []).filter(
      (relation) => relation.state === "active" && !cell.relationEndpointExists(relation.target),
    );
    if (unresolved.length)
      throw cell.cellCodedError(
        "archive_reference_unresolved",
        [
          "Repair or retire ",
          `${unresolved.map((relation) => relation.relation_id).join(", ")}`,
          "; inspect them with ha relation list --entity task/",
          `${task.taskId}`,
          ".",
        ].join(""),
      );
    return {
      type: "task_archived",
      task: { ...task, packageDisposition: "archived" },
      audit: {
        command: "archive",
        reason: cell.requiredCellText(action.reason, "reason"),
        fields: ["packageDisposition", ...(typeof action.archivedBy === "string" ? ["archivedBy"] : [])],
      },
    };
  }
  if (action.kind === "task-reopen") {
    if (isTerminalStatus(task.status))
      throw cell.cellCodedError(
        "terminal_reopen_requires_supersede",
        `Run ha task supersede ${task.taskId} --title <follow-up-title>; terminal history cannot be reopened.`,
      );
    if (task.packageDisposition !== "archived" && task.packageDisposition !== "tombstoned")
      throw cell.cellCodedError(
        "invalid_disposition",
        `Archive or soft-delete task ${task.taskId} before reopening it.`,
      );
    return {
      type: "task_reopened",
      task: { ...task, packageDisposition: "active", supersededBy: null },
      audit: {
        command: "reopen",
        reason: cell.requiredCellText(action.reason, "reason"),
        fields: ["packageDisposition"],
      },
    };
  }
  if (action.kind === "task-supersede") {
    const byTaskId = cell.requiredCellText(action.byTaskId, "byTaskId");
    if (action.confirm !== task.taskId)
      throw cell.cellCodedError(
        "confirmation_required",
        `Retry with --confirm ${task.taskId} after verifying the replacement.`,
      );
    if ((task.packageDisposition ?? "active") !== "active" || task.supersededBy)
      throw cell.cellCodedError(
        "invalid_disposition",
        `Use ha task show ${task.taskId}; only active, non-superseded tasks can be superseded.`,
      );
    if (byTaskId === task.taskId || !cell.projectedTaskIds().has(byTaskId))
      throw cell.cellCodedError(
        "replacement_not_found",
        `Create replacement task ${byTaskId} before superseding ${task.taskId}.`,
      );
    return {
      type: "task_superseded",
      task: {
        ...task,
        packageDisposition: "archived",
        supersededBy: byTaskId,
      },
      audit: {
        command: "supersede",
        reason:
          typeof action.reason === "string" && action.reason.trim()
            ? action.reason.trim()
            : `Task superseded by ${byTaskId}`,
        fields: ["packageDisposition", "supersededBy"],
      },
    };
  }
  if (action.kind === "task-delete") {
    if (action.mode !== "soft")
      throw cell.cellCodedError(
        "hard_delete_forbidden",
        [
          "Distill evidence, then run ha task archive ",
          `${task.taskId}`,
          " --reason <reason> or ha task supersede ",
          `${task.taskId}`,
          " --by <task-id> --confirm ",
          `${task.taskId}`,
          ".",
        ].join(""),
      );
    return {
      type: "task_deleted",
      task: { ...task, packageDisposition: "tombstoned" },
      audit: {
        command: "delete",
        reason: cell.requiredCellText(action.reason, "reason"),
        fields: ["packageDisposition"],
      },
    };
  }
  if (action.kind === "task-contract-migrate") {
    if ((task.contractVersion ?? 0) >= 1)
      throw cell.cellCodedError(
        "contract_current",
        `Task ${task.taskId} already has task-contract/v1; run ha task show ${task.taskId} to inspect it.`,
      );
    return {
      type: "task_contract_migrated",
      task: { ...task, contractVersion: 1 },
      audit: {
        command: "contract-migrate",
        reason: "Backfilled immutable task-contract/v1 from unambiguous L1 task truth",
        fields: ["contractVersion"],
      },
    };
  }
  throw cell.cellCodedError("unsupported_command", `No task mutation contract exists for ${action.kind}.`);
}
