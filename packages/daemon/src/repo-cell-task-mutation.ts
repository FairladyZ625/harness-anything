import { taskMutationDraft } from "@harness-anything/kernel";
import {
  isSameExecution,
  isSamePerson,
  isTerminalStatus,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
  supersededTaskState,
  taskClasses,
  taskAmendment,
  type AuthorizationDecision,
  type LeaseV1,
  type TaskBoundRuntimeBinding,
  type TaskEventV1,
  type TaskV2,
} from "@harness-anything/kernel";
import { readDispatchLiveIndex } from "./dispatch-stream.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RuntimeLeaseReleasePending } from "./runtime-spawn-types.ts";

interface TaskMutation {
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
}

export function taskMutation(
  cell: RepoCellActionContext,
  action: RepoTaskAction,
  task: TaskV2,
  snapshot: Snapshot,
  binding: RepoCellBinding,
): TaskMutation {
  return taskMutationWithStopResult(cell, action, task, snapshot, binding, false);
}

export function taskMutationForRuntimeTerminal(
  cell: RepoCellActionContext,
  action: RepoTaskAction,
  task: TaskV2,
  snapshot: Snapshot,
  binding: RepoCellBinding,
): TaskMutation | RuntimeLeaseReleasePending {
  return taskMutationWithStopResult(cell, action, task, snapshot, binding, true);
}

function taskMutationWithStopResult(
  cell: RepoCellActionContext,
  action: RepoTaskAction,
  task: TaskV2,
  snapshot: Snapshot,
  binding: RepoCellBinding,
  returnUnprovenStop: false,
): TaskMutation;
function taskMutationWithStopResult(
  cell: RepoCellActionContext,
  action: RepoTaskAction,
  task: TaskV2,
  snapshot: Snapshot,
  binding: RepoCellBinding,
  returnUnprovenStop: true,
): TaskMutation | RuntimeLeaseReleasePending;
function taskMutationWithStopResult(
  cell: RepoCellActionContext,
  action: RepoTaskAction,
  task: TaskV2,
  snapshot: Snapshot,
  binding: RepoCellBinding,
  returnUnprovenStop: boolean,
): TaskMutation | RuntimeLeaseReleasePending {
  const forceTakeover = action.kind === "task-release" && action.forceTakeover === true,
    reason = forceTakeover
      ? `Owner forced lease release: ${cell.requiredCellText(action.reason, "reason")}`
      : typeof action.reason === "string" && action.reason.trim()
        ? action.reason.trim()
        : "Authenticated holder released the lease.",
    activeLease = snapshot.lease,
    amendPatches = action.kind === "task-amend" && Array.isArray(action.patches) ? action.patches : [],
    metadataFreeAmend =
      amendPatches.length > 0 &&
      amendPatches.every((raw) => {
        const field = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).field : null;
        return (
          field === "reviewer" ||
          field === "pinned" ||
          field === "reviewDispatchIntent" ||
          field === "reviewDispatchFailure"
        );
      });
  if (action.kind === "task-release") {
    if (!activeLease)
      throw cell.cellCodedError("lease_not_found", `Start task ${task.taskId} before releasing its lease.`);
    if (action.claimOpId !== undefined) {
      const claim = cell.store.readEvent(cell.requiredCellText(action.claimOpId, "claimOpId"));
      if (
        claim?.schema !== "task-event/v1" ||
        claim.type !== "execution_started" ||
        claim.taskId !== task.taskId ||
        claim.payload.lease.executionId !== activeLease.executionId ||
        claim.payload.lease.version !== activeLease.version
      )
        throw cell.cellCodedError(
          "runtime_terminal_superseded",
          "The failed runtime spawn no longer owns this task lease generation.",
        );
    }
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
      sameHolder =
        isSameExecution(activeLease.actor, binding.actor) &&
        JSON.stringify(activeLease.source) === JSON.stringify(binding.source),
      samePrincipalRecovery =
        isSamePerson(activeLease.actor, binding.actor) &&
        (activeLease.phase === "orphaned" || execution === undefined || terminalRuntimeBinding !== null),
      sessionHandoff =
        isSamePerson(activeLease.actor, binding.actor) &&
        activeLease.actor.executor?.kind === "agent" &&
        runtimeSessionIdFromActor(activeLease.actor) === null &&
        optionalReleaseText(action.reason) !== null,
      ownerRecovery =
        isSamePerson(task.createdBy, binding.actor) &&
        (activeLease.phase === "orphaned" || terminalRuntimeBinding !== null),
      ownerForcedTakeover = forceTakeover && isSamePerson(task.createdBy, binding.actor);
    if (!authorizationDecision || authorizationDecision.outcome !== "allowed")
      throw cell.cellCodedError(
        "authorization_missing",
        "Release criteria require the center AuthorizationPort decision.",
      );
    if (!sameHolder && !samePrincipalRecovery && !sessionHandoff && !ownerRecovery && !ownerForcedTakeover)
      throw cell.cellCodedError(
        "lease_conflict",
        [
          "The current holder, or the same principal reclaiming an orphaned lease or reservation, must run ",
          "ha task release ",
          `${task.taskId}`,
          ". For a same-person agent session handoff, supply --reason <handoff-reason>; " +
            "a live runtime holder must stop before recovery.",
        ].join(""),
      );
    const proofRuntimeSessionId =
      terminalRuntimeSessionId ??
      (terminalRuntimeBinding !== null ? runtimeSessionIdFromActor(activeLease.actor) : null);
    if (proofRuntimeSessionId !== null && terminalRuntimeBinding === null) {
      const lifecycle = cell.projection.readDispatchLifecycle({
          by: "session",
          runtimeSessionId: proofRuntimeSessionId,
        }),
        row = lifecycle.status === "ready" ? lifecycle.rows[0] : undefined,
        matchingTask =
          row?.attempt.task?.taskId === task.taskId && row.attempt.task.executionId === activeLease.executionId,
        acceptedStopProof = matchingTask && row?.attempt.stopProof === "proven_stopped",
        code = matchingTask ? "runtime_process_group_unproven" : "runtime_terminal_superseded",
        reason =
          code === "runtime_process_group_unproven"
            ? `Runtime process group for ${proofRuntimeSessionId} has no accepted stop proof; lease release waits for the lifecycle projection.`
            : `Runtime session ${proofRuntimeSessionId} does not own execution ${terminalExecutionId ?? activeLease.executionId}.`;
      if (!acceptedStopProof) {
        if (returnUnprovenStop && code === "runtime_process_group_unproven")
          return { outcome: "lease_unproven", code, reason };
        throw cell.cellCodedError(code, reason);
      }
    }
    return taskMutationDraft({
      task,
      ...(execution === undefined ? {} : { execution }),
      releasedLease: activeLease,
      authorizationDecision,
      audit: {
        command: "release",
        reason,
        fields: ["lease"],
      },
    });
  }
  // An orphaned lease's holder is gone; it fences nothing (start already takes it over via the
  // reservation CAS), so only a live reservation or hold keeps task-level mutations out. A live
  // lease also never fences a pure parentTaskId amend (`ha task move`): re-hanging the task changes
  // only where it is grouped — dispatch history, delivery, and the holder's own writes stay keyed to
  // the task id, and the single write queue serializes the patch against the holder. Every other
  // mutation waits for release. Release above still needs the orphaned record itself to settle it.
  const liveLease = activeLease !== null && ["reserving", "held"].includes(activeLease.phase),
    ownershipAmendOnly =
      action.kind === "task-amend" &&
      amendPatches.length > 0 &&
      amendPatches.every((patch) => patch !== null && typeof patch === "object" && patch.field === "parentTaskId");
  if (liveLease && action.kind !== "task-contract-migrate" && !ownershipAmendOnly)
    throw cell.cellCodedError("active_lease", `Run ha task release ${task.taskId} before ${action.kind}.`);
  if (action.kind === "task-amend") {
    const patches = amendPatches,
      metadata = task.metadata;
    if (!patches.length || (!metadata && !metadataFreeAmend))
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
      else if (field === "parentTaskId") {
        if (!cell.projectedTaskIds().has(value))
          throw cell.cellCodedError("parent_not_found", `Create parent task ${value} before amending parentTaskId.`);
        if (parentChainReaches(cell, value, task.taskId))
          throw cell.cellCodedError(
            "parent_cycle",
            [
              `Moving ${task.taskId} under ${value} would make its parent chain cyclic; `,
              `choose a parent outside ${task.taskId}'s own subtree.`,
            ].join(""),
          );
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
      else if (field === "urgency" && ["low", "medium", "high"].includes(value))
        changed = {
          ...changed,
          metadata: { ...changed.metadata!, [field]: value as NonNullable<TaskV2["metadata"]>["urgency"] },
        };
      else if (field === "taskClass" && (taskClasses as readonly string[]).includes(value))
        changed = { ...changed, taskClass: value as TaskV2["taskClass"] };
      else if (field === "surfaces") {
        let surfaces: unknown;
        try {
          surfaces = JSON.parse(value);
        } catch {
          throw cell.cellCodedError(
            "invalid_amend",
            `Set surfaces to a JSON string array, for example --set 'surfaces:["harness/skills/example/**"]'.`,
          );
        }
        if (
          !Array.isArray(surfaces) ||
          surfaces.some((surface) => typeof surface !== "string" || surface.trim().length === 0)
        )
          throw cell.cellCodedError(
            "invalid_amend",
            `Set surfaces to a JSON string array, for example --set 'surfaces:["harness/skills/example/**"]'.`,
          );
        changed = { ...changed, metadata: { ...changed.metadata!, surfaces } };
      } else if (field === "reviewer" && /^[A-Za-z0-9_-]{1,96}$/u.test(value))
        changed = { ...changed, reviewer: value };
      else if (field === "reviewDispatchIntent") {
        let intent: unknown;
        try {
          intent = JSON.parse(value);
        } catch {
          throw cell.cellCodedError("invalid_amend", "reviewDispatchIntent must be a JSON object.");
        }
        if (!intent || typeof intent !== "object" || Array.isArray(intent))
          throw cell.cellCodedError("invalid_amend", "reviewDispatchIntent must be a JSON object.");
        changed = { ...changed, reviewDispatchIntent: intent as TaskV2["reviewDispatchIntent"] };
      } else if (field === "reviewDispatchFailure") {
        let failure: unknown;
        try {
          failure = JSON.parse(value);
        } catch {
          throw cell.cellCodedError("invalid_amend", "reviewDispatchFailure must be a JSON object or null.");
        }
        if (failure === null) {
          const { reviewDispatchFailure: _cleared, ...withoutFailure } = changed;
          changed = withoutFailure;
        } else if (failure && typeof failure === "object" && !Array.isArray(failure))
          changed = { ...changed, reviewDispatchFailure: failure as TaskV2["reviewDispatchFailure"] };
        else throw cell.cellCodedError("invalid_amend", "reviewDispatchFailure must be a JSON object or null.");
      } else
        throw cell.cellCodedError(
          "invalid_amend",
          [
            "Amend title, parentTaskId, workKind, urgency, surfaces, ",
            "taskClass, reviewer (agent id), reviewDispatchIntent/reviewDispatchFailure (internal), or pinned (true/false); use task contract ",
            "migrate for contract shape changes.",
          ].join(""),
        );
      fields.push(field);
    }
    return taskAmendment(changed, "Declared task metadata amendment", fields);
  }
  if (action.kind === "task-archive") {
    if ((task.packageDisposition ?? "active") !== "active")
      throw cell.cellCodedError("invalid_disposition", `Reopen task ${task.taskId} before archiving it again.`);
    return taskMutationDraft({
      task: { ...task, packageDisposition: "archived" },
      audit: {
        command: "archive",
        reason: cell.requiredCellText(action.reason, "reason"),
        fields: ["packageDisposition", ...(typeof action.archivedBy === "string" ? ["archivedBy"] : [])],
      },
    });
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
    return taskMutationDraft({
      task: { ...task, packageDisposition: "active", supersededBy: null },
      audit: {
        command: "reopen",
        reason: cell.requiredCellText(action.reason, "reason"),
        fields: ["packageDisposition"],
      },
    });
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
    const unsettled = unsettledTaskDispatch(cell, task.taskId);
    if (unsettled !== null)
      throw cell.cellCodedError(
        "unsettled_dispatch",
        `Task ${task.taskId} still has unsettled dispatch ${unsettled.dispatchId}; run ` +
          `ha runtime cancel ${unsettled.runtimeSessionId}, then retry ha task supersede ${task.taskId} ` +
          `--by ${byTaskId} --confirm ${task.taskId}.`,
      );
    return taskMutationDraft({
      task: supersededTaskState(task, byTaskId),
      audit: {
        command: "supersede",
        reason:
          typeof action.reason === "string" && action.reason.trim()
            ? action.reason.trim()
            : `Task superseded by ${byTaskId}`,
        fields: ["status", "supersededBy"],
      },
    });
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
    return taskMutationDraft({
      task: { ...task, packageDisposition: "tombstoned" },
      audit: {
        command: "delete",
        reason: cell.requiredCellText(action.reason, "reason"),
        fields: ["packageDisposition"],
      },
    });
  }
  if (action.kind === "task-contract-migrate") {
    const repairedDigest =
        typeof action.repairPresetSnapshotDigest === "string" &&
        /^sha256:[0-9a-f]{64}$/u.test(action.repairPresetSnapshotDigest)
          ? (action.repairPresetSnapshotDigest as `sha256:${string}`)
          : null,
      repairedBody = typeof action.repairTaskContractBody === "string" ? action.repairTaskContractBody : null,
      repairedTaskClass = (taskClasses as readonly unknown[]).includes(action.repairTaskClass)
        ? (action.repairTaskClass as TaskV2["taskClass"])
        : null,
      repairedPresetId =
        typeof action.repairPresetId === "string" && action.repairPresetId.trim() ? action.repairPresetId.trim() : null,
      repairedMetadata =
        repairedPresetId === null || !task.metadata ? task.metadata : { ...task.metadata, presetId: repairedPresetId },
      fields = [
        "contractVersion",
        ...(repairedDigest === null ? [] : ["presetSnapshotDigest"]),
        ...(repairedTaskClass === null || repairedTaskClass === task.taskClass ? [] : ["taskClass"]),
        ...(repairedPresetId === null || repairedPresetId === task.metadata?.presetId ? [] : ["presetId"]),
      ];
    if (
      (task.contractVersion ?? 0) >= 1 &&
      repairedDigest === null &&
      repairedBody === null &&
      (repairedTaskClass === null || repairedTaskClass === task.taskClass)
    )
      throw cell.cellCodedError(
        "contract_current",
        `Task ${task.taskId} already has task-contract/v1; run ha task show ${task.taskId} to inspect it.`,
      );
    return taskMutationDraft({
      task: {
        ...task,
        contractVersion: 1,
        ...(repairedDigest === null ? {} : { presetSnapshotDigest: repairedDigest }),
        ...(repairedTaskClass === null ? {} : { taskClass: repairedTaskClass }),
        ...(repairedMetadata === undefined ? {} : { metadata: repairedMetadata }),
      },
      audit: {
        command: "contract-migrate",
        reason:
          repairedDigest !== null
            ? "Repaired migrated task preset digest and canonical task-contract package path"
            : repairedBody !== null && (repairedTaskClass === null || repairedTaskClass === task.taskClass)
              ? "Backfilled document slots the package compiler adds that this contract predates"
              : (task.contractVersion ?? 0) >= 1
                ? "Restated a retired task class onto its dec_5F7E74F1 successor"
                : "Backfilled immutable task-contract/v1 from unambiguous L1 task truth",
        fields,
      },
    });
  }
  throw cell.cellCodedError("unsupported_command", `No task mutation contract exists for ${action.kind}.`);
}

function optionalReleaseText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Whether walking `parentTaskId` up from `ancestorId` reaches `taskId`: the move would close a
 *  cycle, so it is refused at the write boundary instead of being tolerated by cycle-safe reads.
 *  Each round consumes one unseen ancestor; a legacy cycle ends the walk, never hangs it. */
function parentChainReaches(
  cell: Pick<RepoCellActionContext, "projection">,
  ancestorId: string,
  taskId: string,
): boolean {
  const visited = new Set<string>();
  for (let parentId: string | null = ancestorId; parentId !== null && !visited.has(parentId); ) {
    if (parentId === taskId) return true;
    visited.add(parentId);
    parentId = cell.projection.read(parentId).snapshot.task?.metadata?.parentTaskId ?? null;
  }
  return false;
}

function terminalExecutionRuntimeBinding(
  cell: RepoCellActionContext,
  lease: LeaseV1,
  runtimeSessionId: string | null,
): TaskBoundRuntimeBinding | null {
  if (typeof cell.projection?.readRuntimeSession !== "function") return null;
  const actorRuntimeSessionId = runtimeSessionIdFromActor(lease.actor);
  if (actorRuntimeSessionId === null) return null;
  if (runtimeSessionId !== null && actorRuntimeSessionId !== runtimeSessionId) return null;
  const lifecycle = cell.projection.readDispatchLifecycle({ by: "session", runtimeSessionId: actorRuntimeSessionId });
  if (lifecycle.status !== "ready" || lifecycle.rows.length !== 1) return null;
  const row = lifecycle.rows[0]!,
    task = row.attempt.task;
  if (
    task?.taskId !== lease.taskId ||
    !row.attempt.fence.verified ||
    row.attempt.stopProof !== "proven_stopped" ||
    row.groupPhase === "waiting_backoff"
  )
    return null;
  const session = cell.projection.readRuntimeSession(actorRuntimeSessionId);
  if (session === null) return null;
  return resolveTaskBoundRuntimeBinding(session, lease.taskId, lease.executionId);
}

function unsettledTaskDispatch(
  cell: RepoCellActionContext,
  taskId: string,
): { readonly dispatchId: string; readonly runtimeSessionId: string } | null {
  for (const entry of readDispatchLiveIndex(cell.rootDir, [taskId]).entries) {
    const lifecycle = cell.projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: [entry.dispatchId] });
    // Supersede must wait for the aggregate projection to prove the whole group is closed. A
    // pending projection or missing row is treated as unsettled so it cannot race a late write.
    if (lifecycle.status !== "ready") return entry;
    const row = lifecycle.rows.find(({ attempt }) => attempt.dispatchId === entry.dispatchId);
    if (row === undefined || !row.policy.groupSettled) return entry;
  }
  return null;
}
