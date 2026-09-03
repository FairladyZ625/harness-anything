import {
  getExecutableEntityAction,
  isScheduleEvent,
  nextScheduleOccurrence,
  type EntityActionCompileInput,
  type ScheduleActionDraft,
  type ScheduleV1,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import {
  scheduleDeleteJsonAllowedFields,
  scheduleDeleteJsonFields,
  scheduleShowJsonAllowedFields,
  scheduleShowJsonFields,
  scheduleUpdateJsonAllowedFields,
  scheduleUpdateJsonFields,
} from "./protocol/daemon-protocol-commands-runtime-fleet.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { resolvePacketAction, type PacketActionContract } from "./repo-cell-action-parse.ts";
import type { RepoCellRuntimeContext } from "./repo-cell-action-context.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import type { EntityActionCatalogRunner } from "./entity-action-catalog-executor.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { TrustedScheduleSpawn } from "./runtime-spawn.ts";
import { readScheduleRuns } from "./schedule-runs-read.ts";
import { inspectScheduleProjection } from "./schedule-projection.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";

type ScheduleSpawnReceipt = {
  readonly outcome: string;
  readonly dispatchId?: string;
  readonly runtimeSessionId?: string;
};

const packetContracts: Readonly<Record<string, PacketActionContract>> = Object.freeze({
  "schedule-show": packetContract(scheduleShowJsonFields, scheduleShowJsonAllowedFields),
  "schedule-update": packetContract(scheduleUpdateJsonFields, scheduleUpdateJsonAllowedFields),
  "schedule-delete": packetContract(scheduleDeleteJsonFields, scheduleDeleteJsonAllowedFields),
});

export function makeScheduleActionRuntime(cell: RepoCellRuntimeContext): EntityActionCatalogRunner {
  const replay = (action: RepoTaskAction, binding: RepoCellBinding): WriteReceipt | null => {
    const opId = cell.operationId(action, binding, cell.input.repoId, 0),
      existing = cell.store.readEvent(opId);
    if (!existing) return null;
    const receipt = cell.receiptForOperation(opId, binding);
    if (!isScheduleEvent(existing)) return receipt;
    const schedule = cell.projection.getEntity("schedule", existing.entity.id)?.value ?? existing.payload.schedule;
    return { ...receipt, scheduleId: existing.entity.id, schedule } as WriteReceipt;
  };
  const runInternal = async (action: RepoTaskAction, binding: RepoCellBinding): Promise<WriteReceipt> => {
    const contract = getExecutableEntityAction(action.kind);
    if (!contract?.execution || contract.execution.implementation !== "catalog-runtime")
      throw cell.cellCodedError("unsupported_command", `No Schedule action exists for ${action.kind}.`);
    const revision = cell.store.readHead()?.revision ?? 0,
      actionId = cell.operationId(action, binding, cell.input.repoId, revision),
      { authorizationDecision: _previousDecision, ...unframed } = binding,
      authorizationDecision = authorizeRepoCellAction({
        action,
        binding: unframed,
        actionId,
        revision,
        now: cell.now(),
      });
    if (authorizationDecision.outcome === "denied")
      throw cell.cellCodedError(
        "authorization_denied",
        authorizationDecision.nextActions.join(" ") || `${action.kind} requires repository write authority.`,
      );
    return cell.entityActionExecutor.run(action, { ...unframed, authorizationDecision }, actionId, {
      entity: { schedule: runtime },
    }) as Promise<WriteReceipt>;
  };
  const runtime: EntityActionCatalogRunner = async (contract, rawAction, binding): Promise<WriteReceipt> => {
    const action = resolveScheduleAction(cell.rootDir, rawAction);
    if (contract.execution.read) return readScheduleAction(cell, action, binding);
    if (binding.authorizationDecision?.outcome !== "allowed")
      throw cell.cellCodedError("actor_unauthorized", "Schedule Action execution requires AuthorizationPort approval.");
    const scheduleId = cell.requiredCellText(action.scheduleId, "scheduleId"),
      idempotencyKey =
        typeof action.idempotencyKey === "string" && action.idempotencyKey.trim()
          ? action.idempotencyKey
          : `${action.kind}:${scheduleId}:${cell.store.readHead()?.revision ?? 0}`,
      prepared = { ...action, scheduleId, idempotencyKey },
      operationAction = scheduleOperationAction(prepared),
      replayed = replay(operationAction, binding);
    if (replayed)
      return contract.id === "run-now"
        ? dispatchClaimedReceipt(cell, replayed, idempotencyKey, binding, runInternal)
        : replayed;
    const row = cell.projection.getEntity("schedule", scheduleId),
      document = row ? cell.projection.readDocument(`schedules/${scheduleId}.json`).document : null,
      compile = contract.execution.compile;
    if (!compile) throw cell.cellCodedError("invalid_command", `${action.kind} has no Schedule event compiler.`);
    const opId = cell.operationId(operationAction, binding, cell.input.repoId, 0),
      compiled = compile({
        action: prepared,
        actor: binding.actor,
        source: binding.source,
        session: resolveWriteSessionIdentity(binding, cell.projection),
        opId,
        occurredAt: cell.now(),
        workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
        currentEntity: row?.value ?? null,
        entityRevision: row?.workspaceRevision ?? 0,
        currentDocumentBlobSha256: document?.blobSha256 ?? null,
      } satisfies EntityActionCompileInput);
    if (compiled.kind !== "schedule")
      throw cell.cellCodedError("invalid_store", `${action.kind} compiled a non-Schedule action draft.`);
    const receipt = publishScheduleDraft(cell, operationAction, compiled.result, binding);
    return contract.id === "run-now"
      ? dispatchClaimedReceipt(cell, receipt, idempotencyKey, binding, runInternal)
      : receipt;
  };
  return runtime;
}

async function dispatchClaimedReceipt(
  cell: RepoCellRuntimeContext,
  claimed: WriteReceipt,
  idempotencyKey: string,
  binding: RepoCellBinding,
  runInternal: (action: RepoTaskAction, binding: RepoCellBinding) => Promise<WriteReceipt>,
): Promise<WriteReceipt> {
  const schedule = (claimed as WriteReceipt & { readonly schedule?: ScheduleV1 }).schedule,
    active = schedule?.status.activeRun;
  if (claimed.outcome !== "applied" || !schedule || !active || cell.mode === "remote-center") return claimed;
  if (active.dispatchId && active.runtimeSessionId) return claimed;
  const dispatched = await dispatchClaimedSchedule<WriteReceipt, JsonObject & ScheduleSpawnReceipt & WriteReceipt>({
    schedule,
    idempotencyKey,
    now: cell.now,
    spawn: async (scheduled) => {
      const receipt = await cell.runtimeSpawner.spawnScheduled(scheduled, binding);
      if (!isScheduleSpawnWriteReceipt(receipt))
        throw cell.cellCodedError("invalid_runtime_receipt", "Scheduled runtime returned an invalid receipt.");
      return receipt;
    },
    linkDispatch: (linked) => runInternal({ kind: "schedule-dispatch-link", ...linked }, binding),
    settleFailure: (failed) => runInternal({ kind: "schedule-settle", ...failed }, binding),
  });
  if (dispatched.kind === "spawn-failed") return { ...dispatched.receipt, code: "schedule_dispatch_failed" };
  if (dispatched.kind === "spawn-unapplied")
    return {
      ...dispatched.receipt,
      scheduleId: schedule.scheduleId,
      schedule,
      claimFence: active.claimFence,
    } as WriteReceipt;
  return dispatched.receipt;
}

function publishScheduleDraft(
  cell: RepoCellRuntimeContext,
  action: RepoTaskAction,
  result: ScheduleActionDraft,
  binding: RepoCellBinding,
): WriteReceipt {
  if (result.kind === "no-changes")
    return {
      outcome: "no_changes",
      opId: cell.operationId(action, binding, cell.input.repoId, 0),
      revision: result.revision,
      evidence: `schedule:${result.schedule.scheduleId}:unchanged`,
      schedule: result.schedule,
      scheduleId: result.schedule.scheduleId,
    } as WriteReceipt;
  const compiled = result.bundle,
    appended = cell.store.append(compiled),
    publication = cell.publicPublication(appended);
  cell.projection.apply(compiled.event, compiled.plan);
  const applied = cell.projection.readOperation(compiled.event.opId),
    canonicalVisible =
      publication.cut.opId === compiled.event.opId &&
      publication.cut.revision === appended.revision &&
      applied !== null &&
      applied.watermark >= appended.revision,
    schedule = compiled.event.payload.schedule,
    worktreeVisible = [
      "schedule_created",
      "schedule_updated",
      "schedule_deleted",
      "schedule_enabled",
      "schedule_disabled",
    ].includes(compiled.event.type)
      ? true
      : null,
    base = {
      opId: compiled.event.opId,
      revision: appended.revision,
      evidence: `event-object:${compiled.event.opId}`,
      visibility: "center" as const,
      proof: {
        committedRevision: appended.revision,
        appliedCut: applied?.watermark ?? 0,
        durable: true,
        canonicalVisible,
        worktreeVisible,
      },
      ...publication,
      schedule,
      scheduleId: schedule.scheduleId,
      summary: `${compiled.event.type.replaceAll("_", " ")} ${schedule.scheduleId}`,
    };
  return canonicalVisible
    ? ({ outcome: "applied", ...base } as WriteReceipt)
    : ({
        outcome: "pending",
        ...base,
      } as WriteReceipt);
}

function readScheduleAction(
  cell: RepoCellRuntimeContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  if (action.kind === "schedule-list") {
    const revision = cell.store.readHead()?.revision ?? 0,
      assignmentScheduleId =
        binding.assignmentScope?.scope.kind === "schedule" ? binding.assignmentScope.scope.scheduleId : null,
      schedules = cell.projection
        .listEntities("schedule")
        .filter((row) => assignmentScheduleId === null || row.id === assignmentScheduleId)
        .map((row) => {
          const projection = inspectScheduleProjection(row);
          if (!projection.valid) return projection.invalid;
          const schedule = projection.schedule;
          return {
            ...schedule,
            definitionRevision: row.workspaceRevision,
            nextRunAt: schedule.state === "armed" ? nextScheduleOccurrence(schedule.spec.trigger, cell.now()) : null,
          };
        }),
      opId = cell.operationId(action, binding, cell.input.repoId, revision);
    return scheduleReadReceipt(opId, revision, JSON.stringify({ schema: "schedule-list/v1", schedules }), {
      schedules,
      summary: schedules.length ? `${schedules.length} schedule(s)` : "No schedules.",
    });
  }
  const resolved = resolveScheduleAction(cell.rootDir, action),
    scheduleId = cell.requiredCellText(resolved.scheduleId, "scheduleId");
  if (resolved.kind === "schedule-runs") {
    const result = readScheduleRuns(cell, scheduleId, resolved.limit === undefined ? 50 : Number(resolved.limit));
    return scheduleReadReceipt(
      cell.operationId(resolved, binding, cell.input.repoId, result.watermark),
      result.watermark,
      JSON.stringify({ schema: "schedule-runs/v1", ...result }),
      { scheduleId, summary: `${result.runs.length} of ${result.totals.runs} Schedule occurrence(s)` },
    );
  }
  const row = cell.projection.getEntity("schedule", scheduleId);
  if (!row) throw cell.cellCodedError("entity_not_found", `Schedule ${scheduleId} does not exist.`);
  const projection = inspectScheduleProjection(row),
    opId = cell.operationId(resolved, binding, cell.input.repoId, projection.revision);
  if (!projection.valid)
    return {
      outcome: "applied",
      opId,
      revision: projection.revision,
      evidence: `schedule:${scheduleId}:${projection.revision}:invalid`,
      schedule: projection.invalid,
      scheduleId,
      definitionRevision: projection.revision,
      nextRunAt: null,
      summary: `Schedule ${scheduleId} is invalid: ${projection.invalid.invalidReason}`,
    } as WriteReceipt;
  const schedule = projection.schedule;
  return {
    outcome: "applied",
    opId,
    revision: projection.revision,
    evidence: `schedule:${scheduleId}:${projection.revision}`,
    schedule,
    scheduleId,
    definitionRevision: projection.revision,
    nextRunAt: schedule.state === "armed" ? nextScheduleOccurrence(schedule.spec.trigger, cell.now()) : null,
    summary: `Schedule ${scheduleId}`,
  } as WriteReceipt;
}

function scheduleReadReceipt(
  opId: string,
  revision: number,
  evidence: string,
  fields: Readonly<Record<string, unknown>>,
): WriteReceipt {
  return {
    outcome: "applied",
    opId,
    revision,
    evidence,
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: revision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: null,
    },
    ...fields,
  } as WriteReceipt;
}

export async function dispatchClaimedSchedule<
  TReceipt,
  TSpawnReceipt extends ScheduleSpawnReceipt = ScheduleSpawnReceipt,
>(input: {
  readonly schedule: ScheduleV1;
  readonly idempotencyKey: string;
  readonly now: () => string;
  readonly spawn: (scheduled: TrustedScheduleSpawn) => Promise<TSpawnReceipt>;
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
  if (target.kind !== "agent") {
    const receipt = await input.settleFailure({
      scheduleId: input.schedule.scheduleId,
      claimFence: active.claimFence,
      outcome: "failed",
      endedAt: input.now(),
      detail: `Schedule target ${target.kind} is declared but has no dispatch route.`,
      idempotencyKey: `${input.idempotencyKey}:dispatch-unsupported`,
    });
    return { kind: "spawn-failed", error: new Error("schedule target has no dispatch route"), receipt } as const;
  }
  let spawned: TSpawnReceipt;
  try {
    spawned = await input.spawn({
      scheduleId: input.schedule.scheduleId,
      claimFence: active.claimFence,
      mission: input.schedule.spec.mission,
      runtimeInstanceId: target.runtimeInstanceId,
      agentId: target.agentId,
      ...(target.model ? { model: target.model } : {}),
      ...(target.reasoningEffort ? { effort: target.reasoningEffort } : {}),
      ...(target.fast === undefined ? {} : { fast: target.fast }),
      ...(target.cwd ? { cwd: target.cwd } : {}),
      mode: input.schedule.mode,
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

function resolveScheduleAction(rootDir: string, action: RepoTaskAction): RepoTaskAction {
  const contract = packetContracts[action.kind];
  return contract ? resolvePacketAction(rootDir, action, contract) : action;
}

function scheduleOperationAction(action: RepoTaskAction): RepoTaskAction {
  if (action.kind === "schedule-claim")
    return { kind: "schedule-run-now", scheduleId: action.scheduleId, idempotencyKey: action.idempotencyKey };
  if (["schedule-run-now", "schedule-dispatch-link", "schedule-missed", "schedule-settle"].includes(action.kind))
    return { kind: action.kind, scheduleId: action.scheduleId, idempotencyKey: action.idempotencyKey };
  return action;
}

function packetContract(required: readonly string[], allowed: readonly string[]): PacketActionContract {
  return {
    required,
    allowed,
    invalid: (message) => Object.assign(new Error(message), { code: "invalid_command" }),
    messages: {
      parse: "Schedule input must be one UTF-8 JSON object; repair the JSON and retry",
      object: "Schedule input must be one JSON object",
      unsupportedAction: (fields) => `Remove unsupported Schedule action fields: ${fields.join(", ")}`,
      unsupportedInput: (fields) => `Remove unsupported Schedule input fields: ${fields.join(", ")}`,
      missingInput: (fields) => `Add required Schedule input fields: ${fields.join(", ")}`,
    },
  };
}

function isScheduleSpawnWriteReceipt(value: JsonObject): value is JsonObject & ScheduleSpawnReceipt & WriteReceipt {
  return (
    ["applied", "pending", "no_changes", "indeterminate", "op_rejected"].includes(String(value.outcome)) &&
    typeof value.opId === "string" &&
    value.opId.length > 0 &&
    (value.dispatchId === undefined || typeof value.dispatchId === "string") &&
    (value.runtimeSessionId === undefined || typeof value.runtimeSessionId === "string")
  );
}
