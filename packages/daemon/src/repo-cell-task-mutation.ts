import {
  isSameExecution,
  isSamePerson,
  isTerminalStatus,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionSemanticState,
  taskClasses,
  type AuthorizationDecision,
  type LeaseV1,
  type RuntimeSession,
  type TaskBoundRuntimeBinding,
  type TaskEventV1,
  type TaskV2,
} from "../../kernel/src/index.ts";
import { readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";

export function taskMutation(
  cell: RepoCellActionContext,
  action: RepoTaskAction,
  task: TaskV2,
  snapshot: Snapshot,
  binding: RepoCellBinding,
): {
  readonly type: TaskEventV1["type"];
  readonly task: TaskV2;
  readonly audit: {
    readonly command: "release" | "amend" | "archive" | "supersede" | "delete" | "reopen" | "contract-migrate";
    readonly reason: string;
    readonly fields: readonly string[];
  };
  readonly execution?: Snapshot["executions"][number];
  readonly releasedLease?: NonNullable<Snapshot["lease"]>;
  readonly authorizationDecision?: AuthorizationDecision;
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
    const terminalExecutionId = optionalReleaseText(action.terminalExecutionId),
      terminalRuntimeSessionId = optionalReleaseText(action.terminalRuntimeSessionId);
    if ((terminalExecutionId === null) !== (terminalRuntimeSessionId === null))
      throw cell.cellCodedError(
        "invalid_command",
        "Runtime terminal lease settlement requires both terminal execution and RuntimeSession identities.",
      );
    if (terminalExecutionId !== null && terminalExecutionId !== activeLease.executionId)
      throw cell.cellCodedError(
        "runtime_terminal_superseded",
        `Runtime terminal settlement belongs to ${terminalExecutionId}; ` +
          `${activeLease.executionId} now holds the lease.`,
      );
    const execution = snapshot.executions.find((value) => value.executionId === activeLease.executionId),
      terminalRuntimeBinding =
        terminalRuntimeSessionId !== null || !isSameExecution(activeLease.actor, binding.actor)
          ? terminalExecutionRuntimeBinding(cell, activeLease, terminalRuntimeSessionId)
          : null,
      authorizationDecision = binding.authorizationDecision,
      sameHolder = isSameExecution(activeLease.actor, binding.actor),
      samePrincipalRecovery =
        isSamePerson(activeLease.actor, binding.actor) &&
        (activeLease.phase === "orphaned" || execution === undefined || terminalRuntimeBinding !== null),
      ownerRecovery =
        isSamePerson(task.createdBy, binding.actor) &&
        (activeLease.phase === "orphaned" || terminalRuntimeBinding !== null);
    if (!authorizationDecision || authorizationDecision.outcome !== "allowed")
      throw cell.cellCodedError(
        "authorization_missing",
        "Release criteria require the center AuthorizationPort decision.",
      );
    if (!sameHolder && !samePrincipalRecovery && !ownerRecovery)
      throw cell.cellCodedError(
        "lease_conflict",
        [
          "The current holder, or the same principal reclaiming an orphaned lease or reservation, must run ",
          "ha task release ",
          `${task.taskId}`,
          ".",
        ].join(""),
      );
    return {
      type: "lease_released",
      task,
      ...(execution === undefined ? {} : { execution }),
      releasedLease: activeLease,
      authorizationDecision,
      audit: {
        command: "release",
        reason,
        fields: ["lease"],
      },
    };
  }
  if (activeLease && !pinOnlyAmend && action.kind !== "task-contract-migrate")
    throw cell.cellCodedError("active_lease", `Run ha task release ${task.taskId} before ${action.kind}.`);
  if (action.kind === "task-amend") {
    const patches = amendPatches,
      metadata = task.metadata;
    if (!patches.length || (!metadata && !pinOnlyAmend))
      throw cell.cellCodedError(
        "invalid_amend",
        `Use ha task amend ${task.taskId} --set <field>:<value> on a task with a current contract.`,
      );
    let changed: TaskV2 = task;
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
            workKind: value as NonNullable<TaskV2["metadata"]>["workKind"],
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
        changed = { ...changed, taskClass: value as TaskV2["taskClass"] };
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
  if (action.kind === "task-archive") {
    if ((task.packageDisposition ?? "active") !== "active")
      throw cell.cellCodedError("invalid_disposition", `Reopen task ${task.taskId} before archiving it again.`);
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
    const repairedDigest =
      typeof action.repairPresetSnapshotDigest === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(action.repairPresetSnapshotDigest)
        ? (action.repairPresetSnapshotDigest as `sha256:${string}`)
        : null;
    if ((task.contractVersion ?? 0) >= 1 && repairedDigest === null)
      throw cell.cellCodedError(
        "contract_current",
        `Task ${task.taskId} already has task-contract/v1; run ha task show ${task.taskId} to inspect it.`,
      );
    return {
      type: "task_contract_migrated",
      task: {
        ...task,
        contractVersion: 1,
        ...(repairedDigest === null ? {} : { presetSnapshotDigest: repairedDigest }),
      },
      audit: {
        command: "contract-migrate",
        reason:
          repairedDigest === null
            ? "Backfilled immutable task-contract/v1 from unambiguous L1 task truth"
            : "Repaired migrated task preset digest and canonical task-contract package path",
        fields: repairedDigest === null ? ["contractVersion"] : ["contractVersion", "presetSnapshotDigest"],
      },
    };
  }
  throw cell.cellCodedError("unsupported_command", `No task mutation contract exists for ${action.kind}.`);
}

function optionalReleaseText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function terminalExecutionRuntimeBinding(
  cell: RepoCellActionContext,
  lease: LeaseV1,
  runtimeSessionId: string | null,
): TaskBoundRuntimeBinding | null {
  if (typeof cell.projection?.readRuntimeSessionsForTask !== "function") return null;
  const inferredTerminalSessionIds =
    runtimeSessionId === null
      ? new Set(
          readDispatchStreamHeaders(cell.rootDir)
            .filter((header) => header.taskId === lease.taskId && header.executionId === lease.executionId)
            .map((header) => readDispatchStreamSummary(cell.rootDir, header.dispatchId))
            .filter(
              (stream) =>
                stream?.attemptOutcome !== null &&
                stream?.attemptOutcome !== undefined &&
                (stream.attemptOutcome.classification !== "provider_fault" ||
                  stream.header.fallbackAttempt === undefined ||
                  stream.fallbackState === "exhausted"),
            )
            .map((stream) => stream!.header.runtimeSessionId),
        )
      : null;
  const taskSessions = cell.projection.readRuntimeSessionsForTask(lease.taskId) as readonly RuntimeSession[];
  const sessions = [...taskSessions].sort((left, right) => right.lastObservedAt.localeCompare(left.lastObservedAt));
  for (const session of sessions) {
    if (runtimeSessionId !== null && session.runtimeSessionId !== runtimeSessionId) continue;
    if (inferredTerminalSessionIds !== null && !inferredTerminalSessionIds.has(session.runtimeSessionId)) continue;
    if (session.liveness !== "exited" || runtimeSessionSemanticState(session) === "running") continue;
    const binding = resolveTaskBoundRuntimeBinding(session, lease.taskId, lease.executionId);
    if (binding) return binding;
  }
  return null;
}
