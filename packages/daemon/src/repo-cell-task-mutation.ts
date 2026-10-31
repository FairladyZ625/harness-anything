import {
  compareRuntimeActivity,
  isSameExecution,
  isSamePerson,
  isTerminalStatus,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionSemanticState,
  runtimeSessionIdFromActor,
  sameWriteSource,
  taskClasses,
  type AuthorizationDecision,
  type LeaseV1,
  type RuntimeSession,
  type TaskBoundRuntimeBinding,
  type TaskEventV1,
  type TaskV2,
} from "@harness-anything/kernel";
import { readDispatchLiveIndex, readDispatchStreamHeaders, readDispatchStreamSummary } from "./dispatch-stream.ts";
import { isProviderFailureClassification } from "./runtime-fallback-contract.ts";
import { runtimePidIsAlive } from "./runtime-process-liveness.ts";
import { reconcileProcessGroup } from "./runtime/process-group-reconciler.ts";
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
  const forceTakeover = action.kind === "task-release" && action.forceTakeover === true,
    reason = forceTakeover
      ? `Owner forced takeover: ${cell.requiredCellText(action.reason, "reason")}`
      : typeof action.reason === "string" && action.reason.trim()
        ? action.reason.trim()
        : "Authenticated holder released the lease.",
    activeLease = snapshot.lease,
    amendPatches = action.kind === "task-amend" && Array.isArray(action.patches) ? action.patches : [],
    metadataFreeAmend =
      amendPatches.length > 0 &&
      amendPatches.every((raw) => {
        const field = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>).field : null;
        return field === "reviewer" || field === "pinned";
      });
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
    if (proofRuntimeSessionId !== null) {
      const verdict = terminalRuntimeStopProof(
        cell,
        task.taskId,
        terminalExecutionId ?? activeLease.executionId,
        proofRuntimeSessionId,
        action.terminalProcessGroupPid,
        binding.source,
      );
      if (verdict !== "proven_stopped")
        throw cell.cellCodedError(
          "runtime_process_group_unproven",
          `Runtime process group for ${proofRuntimeSessionId} is ${verdict}; lease release waits for a stop proof.`,
        );
    }
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
      else if (field === "reviewer" && /^[A-Za-z0-9_-]{1,96}$/u.test(value)) changed = { ...changed, reviewer: value };
      else
        throw cell.cellCodedError(
          "invalid_amend",
          [
            "Amend title, parentTaskId, workKind, urgency, ",
            "taskClass, reviewer (agent id), or pinned (true/false); use task contract ",
            "migrate for contract shape changes.",
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
    return {
      type: "task_contract_migrated",
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
    };
  }
  throw cell.cellCodedError("unsupported_command", `No task mutation contract exists for ${action.kind}.`);
}

function terminalRuntimeStopProof(
  cell: Pick<RepoCellActionContext, "rootDir" | "projection">,
  taskId: string,
  executionId: string,
  runtimeSessionId: string,
  suppliedPid: unknown,
  source: RepoCellBinding["source"],
): ReturnType<typeof reconcileProcessGroup> {
  const matchingHeaders = readDispatchStreamHeaders(cell.rootDir, true).filter(
    (candidate) => candidate.taskId === taskId && candidate.runtimeSessionId === runtimeSessionId,
  );
  // Terminal settlement may release a newer lease generation than the dispatch that reached its
  // terminal state. Prefer the exact execution when retained, then fall back to this runtime
  // session's historical dispatch; the session identity remains the proof binding.
  const candidates = matchingHeaders
    .map((header) => ({ header, process: readDispatchStreamSummary(cell.rootDir, header.dispatchId)?.process }))
    .filter(
      (candidate): candidate is typeof candidate & { readonly process: NonNullable<typeof candidate.process> } =>
        candidate.process !== null && candidate.process !== undefined,
    );
  if (!candidates.length) {
    const exactHeaders = matchingHeaders.filter((header) => header.executionId === executionId),
      eligibleHeaders = exactHeaders.length ? exactHeaders : matchingHeaders,
      processStartRejected =
        eligibleHeaders.length === 1 &&
        (() => {
          const records = readDispatchStreamSummary(cell.rootDir, eligibleHeaders[0]!.dispatchId)?.records ?? [];
          return (
            records.some((record) => record.kind === "process_start_rejected") &&
            !records.some((record) => ["process_started", "process_exit", "process_lost"].includes(String(record.kind)))
          );
        })();
    const events = cell.projection.readRuntimeSessionEvents(runtimeSessionId, 0, Number.MAX_SAFE_INTEGER),
      started = events.find(
        (event) =>
          event.type === "runtime_session_started" &&
          event.payload.runtimeSessionId === runtimeSessionId &&
          (event.payload.taskBinding === undefined ||
            (event.payload.taskBinding.taskId === taskId && event.payload.taskBinding.executionId === executionId)) &&
          sameWriteSource(event.source, source),
      ),
      pids = [
        ...new Set(
          events.flatMap((event) =>
            event.type === "runtime_session_liveness_changed" &&
            sameWriteSource(event.source, source) &&
            Number.isSafeInteger(event.payload.processGroupPid) &&
            Number(event.payload.processGroupPid) > 1
              ? [Number(event.payload.processGroupPid)]
              : [],
          ),
        ),
      ],
      suppliedProcessGroupPid =
        Number.isSafeInteger(suppliedPid) && Number(suppliedPid) > 1 ? Number(suppliedPid) : null,
      ended = events.some(
        (event) =>
          event.type === "runtime_session_exited" &&
          event.payload.runtimeSessionId === runtimeSessionId &&
          sameWriteSource(event.source, source),
      ),
      edgeProcessGroup = typeof source === "object" && source.kind === "node";
    if (suppliedPid !== undefined && suppliedProcessGroupPid === null) return "unknown_unreachable";
    if (pids.length > 1) return "unknown_unreachable";
    if (pids.length === 0 && suppliedPid === undefined && (ended || processStartRejected)) return "proven_stopped";
    if (!started) return "unknown_unreachable";
    if (pids.length === 1) {
      if (suppliedProcessGroupPid !== null && suppliedProcessGroupPid !== pids[0]) return "unknown_unreachable";
      if (edgeProcessGroup) return suppliedProcessGroupPid !== null ? "proven_stopped" : "unknown_unreachable";
      return reconcileProcessGroup({ pid: pids[0]!, pgid: pids[0]! });
    }
    if (edgeProcessGroup && suppliedProcessGroupPid !== null) return "proven_stopped";
    if (ended) return "proven_stopped";
    return "unknown_unreachable";
  }
  const exact = candidates.filter((candidate) => candidate.header.executionId === executionId),
    eligible = exact.length ? exact : candidates,
    matched =
      eligible.length !== 1
        ? null
        : suppliedPid === undefined
          ? eligible[0]
          : Number.isSafeInteger(suppliedPid) && eligible[0]!.process.pid === Number(suppliedPid)
            ? eligible[0]
            : null;
  if (!matched) return "unknown_unreachable";
  if (suppliedPid !== undefined && Number(suppliedPid) !== matched.process.pid) return "unknown_unreachable";
  return reconcileProcessGroup({ pid: matched.process.pid, pgid: matched.process.pid });
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
  if (typeof cell.projection?.readRuntimeSessionsForTask !== "function") return null;
  const inferredTerminalSessionIds =
    runtimeSessionId === null
      ? new Set(
          readDispatchLiveIndex(cell.rootDir, [lease.taskId])
            .entries.map((entry) => readDispatchStreamSummary(cell.rootDir, entry.dispatchId))
            .filter((stream) => stream?.header.runtimeSessionId === runtimeSessionIdFromActor(lease.actor))
            .filter(
              (stream) =>
                stream !== null && (dispatchReachedTerminalAttempt(stream) || dispatchProcessIsOrphaned(stream)),
            )
            .map((stream) => stream!.header.runtimeSessionId),
        )
      : null;
  const taskSessions = cell.projection.readRuntimeSessionsForTask(lease.taskId) as readonly RuntimeSession[];
  const sessions = [...taskSessions].sort((left, right) =>
    compareRuntimeActivity(right.lastObservedAt, left.lastObservedAt),
  );
  for (const session of sessions) {
    if (session.runtimeSessionId !== runtimeSessionIdFromActor(lease.actor)) continue;
    if (runtimeSessionId !== null && session.runtimeSessionId !== runtimeSessionId) continue;
    if (
      (session.liveness !== "exited" || runtimeSessionSemanticState(session) === "running") &&
      !inferredTerminalSessionIds?.has(session.runtimeSessionId)
    )
      continue;
    const binding = resolveTaskBoundRuntimeBinding(session, lease.taskId, lease.executionId);
    if (binding) return binding;
  }
  return null;
}

function dispatchReachedTerminalAttempt(stream: NonNullable<ReturnType<typeof readDispatchStreamSummary>>): boolean {
  return (
    stream.attemptOutcome !== null &&
    stream.attemptOutcome !== undefined &&
    (!isProviderFailureClassification(stream.attemptOutcome.classification) ||
      stream.header.fallbackAttempt === undefined ||
      stream.fallbackState === "exhausted")
  );
}

function dispatchProcessIsOrphaned(stream: NonNullable<ReturnType<typeof readDispatchStreamSummary>>): boolean {
  return (
    stream.fallbackState !== "scheduled" &&
    stream.process !== null &&
    stream.process !== undefined &&
    (stream.process.exited || !runtimePidIsAlive(stream.process.pid))
  );
}
