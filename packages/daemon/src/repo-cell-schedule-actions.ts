import { createHash } from "node:crypto";
import {
  compileScheduleDeletedEvent,
  compileScheduleDefinitionEvent,
  compileScheduleRunEvent,
  createScheduleV1,
  isScheduleEvent,
  nextScheduleOccurrence,
  scheduleMissedReasons,
  scheduleRunOutcomes,
  timestamp,
  updateScheduleV1,
  validateScheduleV1,
  type ScheduleMissedReason,
  type ScheduleRunOutcome,
  type ScheduleV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { TrustedScheduleSpawn } from "./runtime-spawn.ts";

type ScheduleClaimKind = "scheduled" | "manual";
type ScheduleClaimInput = {
  readonly scheduleId: string;
  readonly kind: ScheduleClaimKind;
  readonly scheduledFor: string;
  readonly nodeId: string;
  readonly assignmentId: string | null;
  readonly observedDefinitionRevision?: number;
  readonly idempotencyKey: string;
};

type ScheduleSpawnReceipt = {
  readonly outcome: string;
  readonly dispatchId?: string;
  readonly runtimeSessionId?: string;
};

export async function dispatchClaimedSchedule<TReceipt>(input: {
  readonly schedule: ScheduleV1;
  readonly idempotencyKey: string;
  readonly now: () => string;
  readonly spawn: (scheduled: TrustedScheduleSpawn) => Promise<ScheduleSpawnReceipt>;
  readonly linkDispatch: (linked: {
    readonly scheduleId: string;
    readonly claimFence: string;
    readonly dispatchId: string;
    readonly runtimeSessionId: string;
    readonly idempotencyKey: string;
  }) => TReceipt | Promise<TReceipt>;
  readonly settleFailure: (failed: {
    readonly scheduleId: string;
    readonly claimFence: string;
    readonly outcome: "failed";
    readonly endedAt: string;
    readonly detail: string;
    readonly idempotencyKey: string;
  }) => TReceipt | Promise<TReceipt>;
}) {
  const active = input.schedule.status.activeRun;
  if (!active) throw new Error(`Schedule ${input.schedule.scheduleId} has no claimed occurrence to dispatch.`);
  const target = input.schedule.spec.target;
  let spawned: ScheduleSpawnReceipt;
  try {
    spawned = await input.spawn({
      scheduleId: input.schedule.scheduleId,
      claimFence: active.claimFence,
      mission: input.schedule.spec.mission,
      runtimeInstanceId: target.runtimeInstanceId,
      agentId: target.agentId,
      ...(target.model ? { model: target.model } : {}),
      ...(target.reasoningEffort ? { effort: target.reasoningEffort } : {}),
      ...(target.cwd ? { cwd: target.cwd } : {}),
    });
  } catch (error) {
    const receipt = await input.settleFailure({
      scheduleId: input.schedule.scheduleId,
      claimFence: active.claimFence,
      outcome: "failed",
      endedAt: input.now(),
      detail: error instanceof Error ? error.message : String(error),
      idempotencyKey: `${input.idempotencyKey}:dispatch-failed`,
    });
    return { kind: "spawn-failed", error, receipt } as const;
  }
  if (spawned.outcome !== "applied") return { kind: "spawn-unapplied", receipt: spawned } as const;
  const dispatchId = String(spawned.dispatchId),
    runtimeSessionId = String(spawned.runtimeSessionId),
    receipt = await input.linkDispatch({
      scheduleId: input.schedule.scheduleId,
      claimFence: active.claimFence,
      dispatchId,
      runtimeSessionId,
      idempotencyKey: `${input.idempotencyKey}:dispatch`,
    });
  return { kind: "linked", receipt, dispatchId, runtimeSessionId } as const;
}

export function makeRepoCellScheduleActions(cell: any) {
  const read = (scheduleId: string): { readonly schedule: ScheduleV1; readonly revision: number } => {
    const row = cell.projection.getEntity("schedule", scheduleId);
    if (!row) throw cell.cellCodedError("entity_not_found", `Schedule ${scheduleId} does not exist.`);
    if (validateScheduleV1(row.value).length)
      throw cell.cellCodedError("invalid_store", `Schedule ${scheduleId} projection is invalid.`);
    return { schedule: row.value as unknown as ScheduleV1, revision: row.workspaceRevision };
  };
  const replay = (action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt | null => {
    const opId = cell.operationId(action, binding, cell.input.repoId, 0),
      event = cell.store.readEvent(opId);
    if (!event) return null;
    const receipt = cell.receiptForOperation(opId, binding);
    if (!isScheduleEvent(event)) return receipt;
    const projected = cell.projection.getEntity("schedule", event.entity.id),
      schedule = projected?.value ?? event.payload.schedule;
    return { ...receipt, scheduleId: event.entity.id, schedule } as WriteReceipt;
  };
  const publish = (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    schedule: ScheduleV1,
    type:
      | "schedule_created"
      | "schedule_updated"
      | "schedule_deleted"
      | "schedule_enabled"
      | "schedule_disabled"
      | "schedule_occurrence_claimed"
      | "schedule_occurrence_dispatched"
      | "schedule_occurrences_missed"
      | "schedule_dispatch_failed"
      | "schedule_run_settled",
    options: {
      readonly expectedRevision: number;
      readonly missed?: {
        readonly from: string;
        readonly to: string;
        readonly count: number;
        readonly reason: ScheduleMissedReason;
      };
      readonly deletionReason?: string;
      readonly deletionBaseBlobSha256?: string;
    },
  ): WriteReceipt => {
    const stableRevision = typeof action.idempotencyKey === "string" ? 0 : options.expectedRevision,
      opId = cell.operationId(action, binding, cell.input.repoId, stableRevision),
      existing = cell.store.readEvent(opId);
    if (existing) return cell.receiptForOperation(opId, binding);
    const common = {
        type,
        schedule,
        eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
        opId,
        workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
        actor: binding.actor,
        source: binding.source,
        occurredAt: cell.now(),
      },
      compiled =
        type === "schedule_deleted"
          ? compileScheduleDeletedEvent({
              ...common,
              type,
              baseBlobSha256: requiredDeletionBase(options.deletionBaseBlobSha256),
              ...(options.deletionReason ? { reason: options.deletionReason } : {}),
            })
          : type === "schedule_created" ||
              type === "schedule_updated" ||
              type === "schedule_enabled" ||
              type === "schedule_disabled"
            ? compileScheduleDefinitionEvent({ ...common, type })
            : compileScheduleRunEvent({
                ...common,
                type,
                ...(options.missed ? { missed: options.missed } : {}),
              }),
      appended = cell.store.append(compiled),
      publication = cell.publicPublication(appended);
    cell.projection.apply(compiled.event, compiled.plan);
    const applied = cell.projection.readOperation(opId),
      canonicalVisible =
        publication.cut.opId === opId &&
        publication.cut.revision === appended.revision &&
        applied !== null &&
        applied.watermark >= appended.revision,
      base = {
        opId,
        revision: appended.revision,
        evidence: `event-object:${opId}`,
        visibility: "center" as const,
        proof: {
          committedRevision: appended.revision,
          appliedCut: applied?.watermark ?? 0,
          durable: true,
          canonicalVisible,
          worktreeVisible: [
            "schedule_created",
            "schedule_updated",
            "schedule_deleted",
            "schedule_enabled",
            "schedule_disabled",
          ].includes(type)
            ? true
            : null,
        },
        ...publication,
        schedule,
        scheduleId: schedule.scheduleId,
        summary: `${type.replaceAll("_", " ")} ${schedule.scheduleId}`,
      };
    return canonicalVisible
      ? ({ outcome: "applied", ...base } as WriteReceipt)
      : ({
          outcome: "pending",
          ...base,
          nextAction: `Run ha receipt show ${opId} before retrying.`,
        } as WriteReceipt);
  };

  const claimOccurrence = (input: ScheduleClaimInput, binding: RepoCellBinding): WriteReceipt => {
    const claimAction = {
        kind: "schedule-run-now",
        scheduleId: input.scheduleId,
        idempotencyKey: input.idempotencyKey,
      },
      replayed = replay(claimAction, binding);
    if (replayed) return replayed;
    const { schedule, revision } = read(input.scheduleId);
    if (schedule.state !== "armed")
      throw cell.cellCodedError(
        "schedule_paused",
        `Schedule ${input.scheduleId} is paused; enable it before claiming.`,
      );
    if (input.observedDefinitionRevision !== undefined && input.observedDefinitionRevision !== revision)
      throw cell.cellCodedError(
        "schedule_definition_stale",
        `Schedule ${input.scheduleId} changed at revision ${revision}; refresh its definition before claiming.`,
      );
    if (schedule.status.activeRun)
      throw cell.cellCodedError(
        "schedule_single_flight_active",
        `Schedule ${input.scheduleId} already has active occurrence ${schedule.status.activeRun.occurrenceId}.`,
      );
    if (!timestamp(input.scheduledFor))
      throw cell.cellCodedError("invalid_command", "Schedule occurrence time must be an ISO-8601 UTC timestamp.");
    const occurrenceHash = createHash("sha256")
        .update(`${input.scheduleId}\0${input.kind}\0${input.scheduledFor}\0${input.idempotencyKey}`)
        .digest("hex"),
      occurrenceId = `${input.kind === "manual" ? "manual" : "occurrence"}_${occurrenceHash.slice(0, 24)}`,
      claimFence = `claim_${createHash("sha256")
        .update(`${occurrenceHash}\0${revision + 1}`)
        .digest("hex")
        .slice(0, 24)}`,
      updated: ScheduleV1 = {
        ...schedule,
        status: {
          ...schedule.status,
          automaticEvaluatedThrough:
            input.kind === "scheduled" ? input.scheduledFor : schedule.status.automaticEvaluatedThrough,
          activeRun: {
            occurrenceId,
            kind: input.kind,
            scheduledFor: input.scheduledFor,
            claimedAt: cell.now(),
            nodeId: input.nodeId,
            assignmentId: input.assignmentId,
            claimFence,
            attemptIndex: 0,
          },
        },
      };
    return publish(claimAction, binding, updated, "schedule_occurrence_claimed", { expectedRevision: revision });
  };

  const linkDispatch = (
    input: {
      readonly scheduleId: string;
      readonly claimFence: string;
      readonly dispatchId: string;
      readonly runtimeSessionId: string;
      readonly idempotencyKey: string;
    },
    binding: RepoCellBinding,
  ): WriteReceipt => {
    const linkAction = {
        kind: "schedule-dispatch-link",
        scheduleId: input.scheduleId,
        idempotencyKey: input.idempotencyKey,
      },
      replayed = replay(linkAction, binding);
    if (replayed) return replayed;
    const { schedule, revision } = read(input.scheduleId),
      active = schedule.status.activeRun;
    if (!active || active.claimFence !== input.claimFence)
      throw cell.cellCodedError(
        "schedule_claim_stale",
        `Schedule ${input.scheduleId} no longer owns claim ${input.claimFence}.`,
      );
    const updated: ScheduleV1 = {
      ...schedule,
      status: {
        ...schedule.status,
        activeRun: { ...active, dispatchId: input.dispatchId, runtimeSessionId: input.runtimeSessionId },
      },
    };
    return publish(linkAction, binding, updated, "schedule_occurrence_dispatched", { expectedRevision: revision });
  };

  const settle = (
    input: {
      readonly scheduleId: string;
      readonly claimFence: string;
      readonly outcome: ScheduleRunOutcome;
      readonly endedAt: string;
      readonly detail?: string;
      readonly idempotencyKey: string;
    },
    binding: RepoCellBinding,
  ): WriteReceipt => {
    const settleAction = {
        kind: "schedule-settle",
        scheduleId: input.scheduleId,
        idempotencyKey: input.idempotencyKey,
      },
      replayed = replay(settleAction, binding);
    if (replayed) return replayed;
    const { schedule, revision } = read(input.scheduleId),
      active = schedule.status.activeRun;
    if (!active || active.claimFence !== input.claimFence)
      throw cell.cellCodedError(
        "schedule_claim_stale",
        `Schedule ${input.scheduleId} no longer owns claim ${input.claimFence}.`,
      );
    if (!scheduleRunOutcomes.includes(input.outcome) || !timestamp(input.endedAt))
      throw cell.cellCodedError(
        "invalid_command",
        "Schedule settlement requires one canonical outcome and UTC end time.",
      );
    const updated: ScheduleV1 = {
      ...schedule,
      status: {
        ...schedule.status,
        activeRun: null,
        lastRun: {
          occurrenceId: active.occurrenceId,
          scheduledFor: active.scheduledFor,
          endedAt: input.endedAt,
          outcome: input.outcome,
          nodeId: active.nodeId,
          assignmentId: active.assignmentId,
          claimFence: active.claimFence,
          attemptIndex: active.attemptIndex,
          ...(active.dispatchId ? { dispatchId: active.dispatchId } : {}),
          ...(active.runtimeSessionId ? { runtimeSessionId: active.runtimeSessionId } : {}),
          ...(input.detail ? { detail: input.detail.slice(0, 1024) } : {}),
        },
      },
    };
    return publish(settleAction, binding, updated, "schedule_run_settled", { expectedRevision: revision });
  };

  const recordMissed = (
    input: {
      readonly scheduleId: string;
      readonly from: string;
      readonly to: string;
      readonly count: number;
      readonly reason: ScheduleMissedReason;
      readonly observedDefinitionRevision?: number;
      readonly idempotencyKey: string;
    },
    binding: RepoCellBinding,
  ): WriteReceipt => {
    const missedAction = {
        kind: "schedule-missed",
        scheduleId: input.scheduleId,
        idempotencyKey: input.idempotencyKey,
      },
      replayed = replay(missedAction, binding);
    if (replayed) return replayed;
    const { schedule, revision } = read(input.scheduleId);
    if (schedule.state !== "armed")
      throw cell.cellCodedError(
        "schedule_paused",
        `Schedule ${input.scheduleId} is paused; it cannot record a timer miss.`,
      );
    if (input.observedDefinitionRevision !== undefined && input.observedDefinitionRevision !== revision)
      throw cell.cellCodedError(
        "schedule_definition_stale",
        `Schedule ${input.scheduleId} changed at revision ${revision}; refresh it before recording a timer miss.`,
      );
    if (
      !Number.isSafeInteger(input.count) ||
      input.count < 1 ||
      !timestamp(input.from) ||
      !timestamp(input.to) ||
      Date.parse(input.from) > Date.parse(input.to) ||
      !scheduleMissedReasons.includes(input.reason)
    )
      throw cell.cellCodedError(
        "invalid_command",
        "Missed occurrence evidence requires an ordered UTC range and count.",
      );
    const updated: ScheduleV1 = {
      ...schedule,
      status: {
        ...schedule.status,
        automaticEvaluatedThrough: input.to,
        missedCount: schedule.status.missedCount + input.count,
        lastMissedAt: input.to,
        lastMissedReason: input.reason,
      },
    };
    return publish(missedAction, binding, updated, "schedule_occurrences_missed", {
      expectedRevision: revision,
      missed: { from: input.from, to: input.to, count: input.count, reason: input.reason },
    });
  };

  const dispatchClaimed = async (
    claimed: WriteReceipt & { readonly schedule?: ScheduleV1 },
    idempotencyKey: string,
    binding: RepoCellBinding,
  ): Promise<WriteReceipt> => {
    const schedule = claimed.schedule,
      active = schedule?.status.activeRun;
    if (claimed.outcome !== "applied" || !schedule || !active || cell.mode === "remote-center") return claimed;
    if (active.dispatchId && active.runtimeSessionId) return claimed;
    const dispatched = await dispatchClaimedSchedule({
      schedule,
      idempotencyKey,
      now: cell.now,
      spawn: (scheduled) => cell.runtimeSpawner.spawnScheduled(scheduled, binding),
      linkDispatch: (linked) => linkDispatch(linked, binding),
      settleFailure: (failed) => settle(failed, binding),
    });
    if (dispatched.kind === "spawn-failed")
      return { ...dispatched.receipt, code: "schedule_dispatch_failed" } as WriteReceipt;
    if (dispatched.kind === "spawn-unapplied")
      return {
        ...dispatched.receipt,
        scheduleId: schedule.scheduleId,
        schedule,
        claimFence: active.claimFence,
      } as unknown as WriteReceipt;
    return dispatched.receipt;
  };

  return {
    run: async (action: RepoTaskAction, binding: RepoCellBinding): Promise<WriteReceipt> => {
      if (action.kind === "schedule-list") {
        const revision = cell.store.readHead()?.revision ?? 0,
          assignmentScheduleId =
            binding.assignmentScope?.scope.kind === "schedule" ? binding.assignmentScope.scope.scheduleId : null,
          schedules = cell.projection
            .listEntities("schedule")
            .filter((row: any) => assignmentScheduleId === null || row.value.scheduleId === assignmentScheduleId)
            .map((row: any) => {
              const schedule = row.value as ScheduleV1;
              return {
                ...schedule,
                definitionRevision: row.workspaceRevision,
                nextRunAt:
                  schedule.state === "armed" ? nextScheduleOccurrence(schedule.spec.trigger, cell.now()) : null,
              };
            }),
          opId = cell.operationId(action, binding, cell.input.repoId, revision);
        return {
          outcome: "applied",
          opId,
          revision,
          evidence: JSON.stringify({ schema: "schedule-list/v1", schedules }),
          visibility: "center",
          proof: {
            committedRevision: revision,
            appliedCut: revision,
            durable: true,
            canonicalVisible: true,
            worktreeVisible: null,
          },
          schedules,
          summary: schedules.length ? `${schedules.length} schedule(s)` : "No schedules.",
        } as WriteReceipt;
      }
      const scheduleId = cell.requiredCellText(action.scheduleId, "scheduleId"),
        idempotencyKey =
          typeof action.idempotencyKey === "string" && action.idempotencyKey.trim()
            ? action.idempotencyKey
            : `${action.kind}:${scheduleId}:${cell.store.readHead()?.revision ?? 0}`;
      if (action.kind === "schedule-show") {
        const { schedule, revision } = read(scheduleId);
        return {
          outcome: "applied",
          opId: cell.operationId(action, binding, cell.input.repoId, revision),
          revision,
          evidence: `schedule:${scheduleId}:${revision}`,
          schedule,
          scheduleId,
          definitionRevision: revision,
          nextRunAt: schedule.state === "armed" ? nextScheduleOccurrence(schedule.spec.trigger, cell.now()) : null,
          summary: `Schedule ${scheduleId}`,
        } as WriteReceipt;
      }
      if (action.kind === "schedule-create") {
        const createAction = { ...action, idempotencyKey },
          replayed = replay(createAction, binding);
        if (replayed) return replayed;
        if (cell.projection.getEntity("schedule", scheduleId))
          throw cell.cellCodedError("entity_exists", `Schedule ${scheduleId} already exists.`);
        const occurredAt = cell.now(),
          schedule = createScheduleV1({
            scheduleId,
            name: cell.requiredCellText(action.name, "name"),
            state: action.disabled === true ? "paused" : "armed",
            spec: {
              trigger: { kind: "interval", everyMs: Number(action.everyMs), anchorAt: occurredAt },
              target: {
                kind: "agent",
                agentId: cell.requiredCellText(action.agentId, "agentId"),
                runtimeInstanceId: cell.requiredCellText(action.runtimeInstanceId, "runtimeInstanceId"),
                ...(typeof action.model === "string" ? { model: action.model } : {}),
                ...(typeof action.reasoningEffort === "string" ? { reasoningEffort: action.reasoningEffort } : {}),
                ...(typeof action.cwd === "string" ? { cwd: action.cwd } : {}),
              },
              mission: cell.requiredCellText(action.mission, "mission"),
            },
            actor: binding.actor,
            occurredAt,
          });
        return publish(createAction, binding, schedule, "schedule_created", { expectedRevision: 0 });
      }
      if (action.kind === "schedule-update") {
        const updateAction = { ...action, idempotencyKey },
          replayed = replay(updateAction, binding);
        if (replayed) return replayed;
        const fields = [
          "name",
          "everyMs",
          "agentId",
          "runtimeInstanceId",
          "mission",
          "model",
          "reasoningEffort",
          "cwd",
        ];
        if (!fields.some((field) => Object.hasOwn(action, field)))
          throw cell.cellCodedError("invalid_command", "Schedule update requires at least one definition field.");
        const { schedule, revision } = read(scheduleId),
          occurredAt = cell.now(),
          everyMs = Object.hasOwn(action, "everyMs") ? Number(action.everyMs) : schedule.spec.trigger.everyMs,
          optionalTarget = (field: "model" | "reasoningEffort" | "cwd"): string | undefined =>
            Object.hasOwn(action, field)
              ? action[field] === null
                ? undefined
                : cell.requiredCellText(action[field], field)
              : schedule.spec.target[field],
          spec = {
            trigger: {
              kind: "interval" as const,
              everyMs,
              anchorAt: everyMs === schedule.spec.trigger.everyMs ? schedule.spec.trigger.anchorAt : occurredAt,
            },
            target: {
              kind: "agent" as const,
              agentId: Object.hasOwn(action, "agentId")
                ? cell.requiredCellText(action.agentId, "agentId")
                : schedule.spec.target.agentId,
              runtimeInstanceId: Object.hasOwn(action, "runtimeInstanceId")
                ? cell.requiredCellText(action.runtimeInstanceId, "runtimeInstanceId")
                : schedule.spec.target.runtimeInstanceId,
              ...(optionalTarget("model") ? { model: optionalTarget("model") } : {}),
              ...(optionalTarget("reasoningEffort") ? { reasoningEffort: optionalTarget("reasoningEffort") } : {}),
              ...(optionalTarget("cwd") ? { cwd: optionalTarget("cwd") } : {}),
            },
            mission: Object.hasOwn(action, "mission")
              ? cell.requiredCellText(action.mission, "mission")
              : schedule.spec.mission,
          },
          name = Object.hasOwn(action, "name") ? cell.requiredCellText(action.name, "name") : schedule.name;
        if (JSON.stringify({ name, spec }) === JSON.stringify({ name: schedule.name, spec: schedule.spec }))
          return {
            outcome: "no_changes",
            opId: cell.operationId(updateAction, binding, cell.input.repoId, 0),
            revision,
            evidence: `schedule:${scheduleId}:unchanged`,
            schedule,
            scheduleId,
          } as WriteReceipt;
        return publish(
          updateAction,
          binding,
          updateScheduleV1({ schedule, name, spec, occurredAt }),
          "schedule_updated",
          { expectedRevision: revision },
        );
      }
      if (action.kind === "schedule-delete") {
        const deleteAction = { ...action, idempotencyKey },
          replayed = replay(deleteAction, binding);
        if (replayed) return replayed;
        const { schedule, revision } = read(scheduleId);
        if (schedule.status.activeRun)
          throw cell.cellCodedError(
            "schedule_single_flight_active",
            `Schedule ${scheduleId} has an active occurrence; settle it before deletion.`,
          );
        const reason = action.reason === undefined ? undefined : cell.requiredCellText(action.reason, "reason"),
          document = cell.projection.readDocument(`schedules/${scheduleId}.json`).document;
        if (document === null)
          throw cell.cellCodedError("invalid_store", `Schedule ${scheduleId} has no projected declaration document.`);
        return publish(deleteAction, binding, schedule, "schedule_deleted", {
          expectedRevision: revision,
          deletionBaseBlobSha256: document.blobSha256,
          ...(reason ? { deletionReason: reason } : {}),
        });
      }
      if (action.kind === "schedule-enable" || action.kind === "schedule-disable") {
        const stateAction = { ...action, idempotencyKey },
          replayed = replay(stateAction, binding);
        if (replayed) return replayed;
        const { schedule, revision } = read(scheduleId),
          state = action.kind === "schedule-enable" ? "armed" : "paused";
        if (schedule.state === state)
          return {
            outcome: "no_changes",
            opId: cell.operationId(stateAction, binding, cell.input.repoId, 0),
            revision,
            evidence: `schedule:${scheduleId}:${state}`,
            schedule,
            scheduleId,
          } as WriteReceipt;
        return publish(
          stateAction,
          binding,
          { ...schedule, state, updatedAt: cell.now() },
          action.kind === "schedule-enable" ? "schedule_enabled" : "schedule_disabled",
          { expectedRevision: revision },
        );
      }
      if (action.kind === "schedule-settle")
        return action.phase === "dispatch-link"
          ? linkDispatch(
              {
                scheduleId,
                claimFence: cell.requiredCellText(action.claimFence, "claimFence"),
                dispatchId: cell.requiredCellText(action.dispatchId, "dispatchId"),
                runtimeSessionId: cell.requiredCellText(action.runtimeSessionId, "runtimeSessionId"),
                idempotencyKey,
              },
              binding,
            )
          : action.phase === "missed"
            ? recordMissed(
                {
                  scheduleId,
                  from: cell.requiredCellText(action.from, "from"),
                  to: cell.requiredCellText(action.to, "to"),
                  count: Number(action.count),
                  reason: action.reason as ScheduleMissedReason,
                  observedDefinitionRevision: Number(action.observedDefinitionRevision),
                  idempotencyKey,
                },
                binding,
              )
            : settle(
                {
                  scheduleId,
                  claimFence: cell.requiredCellText(action.claimFence, "claimFence"),
                  outcome: action.outcome as ScheduleRunOutcome,
                  endedAt: cell.requiredCellText(action.endedAt, "endedAt"),
                  ...(typeof action.detail === "string" ? { detail: action.detail } : {}),
                  idempotencyKey,
                },
                binding,
              );
      if (action.kind !== "schedule-run-now")
        throw cell.cellCodedError("unsupported_command", `No Schedule action exists for ${action.kind}.`);
      const scheduledFor = typeof action.scheduledFor === "string" ? action.scheduledFor : null,
        replayedClaim = replay({ kind: "schedule-run-now", scheduleId, idempotencyKey }, binding);
      if (replayedClaim)
        return dispatchClaimed(
          replayedClaim as WriteReceipt & { readonly schedule?: ScheduleV1 },
          idempotencyKey,
          binding,
        );
      const claimed = claimOccurrence(
        {
          scheduleId,
          kind: scheduledFor === null ? "manual" : "scheduled",
          scheduledFor: scheduledFor ?? cell.now(),
          nodeId:
            typeof binding.source === "object" && binding.source.kind === "assignment"
              ? binding.source.nodeId
              : "local",
          assignmentId:
            typeof binding.source === "object" && binding.source.kind === "assignment"
              ? binding.source.assignmentId
              : null,
          ...(typeof action.observedDefinitionRevision === "number"
            ? { observedDefinitionRevision: action.observedDefinitionRevision }
            : {}),
          idempotencyKey,
        },
        binding,
      ) as WriteReceipt & { readonly schedule?: ScheduleV1 };
      return dispatchClaimed(claimed, idempotencyKey, binding);
    },
    claimOccurrence,
    linkDispatch,
    recordMissed,
    settle,
  };
}

function requiredDeletionBase(value: string | undefined): string {
  if (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)) return value;
  throw new Error("Schedule deletion requires the current declaration document hash.");
}
