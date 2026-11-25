import {
  nextScheduleOccurrence,
  validateScheduleV1,
  type CanonicalEventV1,
  type DaemonRepoMode,
  type ScheduleV1,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import type * as ClientStatus from "@harness-anything/kernel/internal/domain/client-view-status.ts";
import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import type { ScheduleState } from "@harness-anything/kernel/internal/domain/schedule.ts";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import { readProjectedAgentDeclarationOutcome } from "./agent-declaration-read.ts";
import {
  emptyScheduleHealthRollup,
  scheduleHealthRollupsFromEvents,
  type InspectedScheduleProjection,
} from "./schedule-projection.ts";

export type ScheduleExecutionAvailability = OperationalStatus.ScheduleExecutionAvailability;

export type ScheduleGuiTriggerDto =
  | {
      readonly kind: "interval";
      readonly everyMs: number;
      readonly expression: null;
      readonly timezone: null;
      readonly summary: string;
    }
  | {
      readonly kind: "cron";
      readonly everyMs: null;
      readonly expression: string;
      readonly timezone: string;
      readonly summary: string;
    };

export interface ScheduleGuiActionFacet {
  readonly available: boolean;
  readonly code: string | null;
  readonly nextAction: string | null;
}

export type ScheduleGuiAgentOptionDto =
  | {
      readonly agentId: string;
      readonly name: string;
      readonly runtimes: readonly { readonly type: string; readonly model?: string }[];
    }
  | {
      readonly agentId: string;
      readonly state: ClientStatus.DegradedEntityState;
      readonly error: { readonly code: string; readonly hint: string };
    };

export function isAvailableScheduleGuiAgentOption(
  option: ScheduleGuiAgentOptionDto,
): option is Extract<ScheduleGuiAgentOptionDto, { readonly name: string }> {
  return !("state" in option);
}

export interface ScheduleGuiRuntimeInstanceOption {
  readonly instanceId: string;
  readonly name: string;
  readonly kindId: string;
  readonly models: readonly string[];
  readonly efforts: readonly string[];
}

export interface ScheduleGuiOptionsDto {
  readonly agents: readonly ScheduleGuiAgentOptionDto[];
  readonly instances: readonly ScheduleGuiRuntimeInstanceOption[];
}

export interface ScheduleGuiHealthDto {
  readonly recent: readonly ("running" | "succeeded" | "failed" | "missed" | "cancelled" | "unknown")[];
  readonly bucket: "degraded" | "clean";
  readonly failedCount: number;
  readonly lastFailureDetail: string | null;
}

export interface ScheduleGuiRowDto {
  readonly scheduleId: string;
  readonly name: string;
  readonly state: ScheduleState;
  readonly mode: "detect" | "remediate";
  readonly systemPresetId: string | null;
  readonly definitionResidency: "ledger";
  readonly definitionRevision: number;
  readonly trigger: ScheduleGuiTriggerDto;
  readonly target:
    | {
        readonly kind: "agent";
        readonly agentId: string;
        readonly runtimes: readonly { readonly type: string; readonly model?: string }[];
        readonly reasoningEffort: string | null;
        readonly fast: boolean;
        readonly cwd: null;
      }
    | { readonly kind: "squad"; readonly squadId: string }
    | {
        readonly kind: "builtin";
        readonly builtinId: string;
        readonly keepDays: number;
        readonly keepMonthly: boolean;
      }
    | { readonly kind: "agent-unconfigured" };
  readonly targetState?: ClientStatus.DegradedEntityState;
  readonly targetError?: { readonly code: string; readonly hint: string };
  readonly mission: string;
  readonly executionAvailability: ScheduleExecutionAvailability;
  readonly claim: { readonly nodeId: string | null; readonly claimFence: string | null };
  readonly health: ScheduleGuiHealthDto;
  readonly nextRunAt: string | null;
  readonly actions: {
    readonly edit: ScheduleGuiActionFacet;
    readonly delete: ScheduleGuiActionFacet;
    readonly enable: ScheduleGuiActionFacet;
    readonly disable: ScheduleGuiActionFacet;
    readonly runNow: ScheduleGuiActionFacet;
  };
  readonly activeRun: {
    readonly occurrenceId: string;
    readonly kind: "scheduled" | "manual";
    readonly scheduledFor: string;
    readonly claimedAt: string;
    readonly nodeId: string;
    readonly claimFence: string;
    readonly attemptIndex: number;
    readonly dispatchId: string | null;
    readonly runtimeSessionId: string | null;
  } | null;
  readonly lastRun: {
    readonly occurrenceId: string;
    readonly scheduledFor: string;
    readonly endedAt: string;
    readonly outcome: string;
    readonly nodeId: string;
    readonly claimFence: string;
    readonly attemptIndex: number;
    readonly dispatchId: string | null;
    readonly runtimeSessionId: string | null;
    readonly detail: string | null;
    readonly runtime: { readonly instanceId: string; readonly kindId: string; readonly model: string } | null;
  } | null;
  readonly missed: {
    readonly count: number;
    readonly lastMissedAt: string | null;
    readonly lastMissedReason: string | null;
  };
  readonly automaticEvaluatedThrough: string;
  readonly updatedAt: string;
}

export interface ScheduleGuiInvalidRowDto {
  readonly scheduleId: string;
  readonly state: "invalid";
  readonly invalidReason: string;
  readonly definitionRevision: number;
}

export type ScheduleGuiListRowDto = ScheduleGuiRowDto | ScheduleGuiInvalidRowDto;

export interface SchedulesListResult {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly repoId: string;
  readonly repoMode: "local" | "remote-center" | "remote-edge";
  readonly viewerNodeId: string | null;
  readonly actions: { readonly create: ScheduleGuiActionFacet };
  readonly options: ScheduleGuiOptionsDto;
  readonly schedules: readonly ScheduleGuiListRowDto[];
  readonly watermark: number;
  readonly sourceRevision: number;
}

export type ScheduleGuiActionKind =
  | "schedule-create"
  | "schedule-update"
  | "schedule-delete"
  | "schedule-enable"
  | "schedule-disable"
  | "schedule-run-now";

export interface SchedulesGuiReadPorts {
  readonly admitAction: (actionKind: ScheduleGuiActionKind, mode: DaemonRepoMode) => ScheduleGuiActionFacet;
  readonly resolveEdgeNodeId?: () => string;
  readonly runtimeInstances?: () => readonly ScheduleGuiRuntimeInstanceOption[];
  readonly formatDuration?: (everyMs: number) => string;
  readonly defaultBackupRetention: { readonly keepDays: number; readonly keepMonthly: boolean };
}

export interface SchedulesGuiReadInput {
  readonly mode: DaemonRepoMode | null;
  readonly repoId: string;
  readonly now: () => string;
  readonly projection: Pick<TaskProjectionQueries, "readRuntimeSession" | "readRuntimeDispatch"> & {
    readonly listEntities: (entityKind: string) => readonly {
      readonly id?: string;
      readonly value: unknown;
      readonly workspaceRevision: number;
      readonly freshness?: "current" | "orphaned" | "unknown";
    }[];
    readonly readTaskStatuses: (taskIds?: readonly string[]) => {
      readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
      readonly watermark: number;
      readonly sourceRevision: number;
    };
    readonly readScheduleEvents: () => {
      readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
      readonly events: readonly CanonicalEventV1[];
      readonly watermark: number;
      readonly sourceRevision: number;
    };
  };
  readonly ports: SchedulesGuiReadPorts;
}

/** Topology hint only: action admission and center authorization remain authoritative. */
export function deriveScheduleExecutionAvailability(input: {
  readonly mode: DaemonRepoMode;
  readonly targetKind: ScheduleV1["spec"]["target"]["kind"];
  readonly viewerNodeId: string | null;
  readonly activeNodeId: string | null;
}): ScheduleExecutionAvailability {
  if (input.targetKind === "builtin") return input.mode === "remote-edge" ? "not-on-this-node" : "local";
  if (input.activeNodeId !== null) return input.activeNodeId === input.viewerNodeId ? "local" : "claimed-elsewhere";
  return "local";
}

export function readSchedulesGui(
  context: SchedulesGuiReadInput,
  selected?: readonly InspectedScheduleProjection[],
): SchedulesListResult {
  const repoMode = context.mode ?? "local";
  if (repoMode === "remote-proxy")
    throw new Error("Schedule GUI reads for remote-proxy repositories must be routed to the remote daemon.");
  const mode = repoMode,
    now = context.now(),
    viewerNodeId = viewerNodeIdOf(mode, context.ports),
    cut = context.projection.readTaskStatuses([]),
    agentOptions = scheduleAgentOptions(context),
    agentsById = new Map(agentOptions.map((agent) => [agent.agentId, agent])),
    healthRollups = scheduleHealthRollupsFromEvents(context.projection.readScheduleEvents().events),
    healthRollupOf = (scheduleId: string): ScheduleGuiHealthDto =>
      healthRollups.get(scheduleId) ?? emptyScheduleHealthRollup(),
    formatDuration = context.ports.formatDuration ?? formatIntervalDuration;
  const schedules = (selected ?? context.projection.listEntities("schedule").map(inspectGuiSchedule))
    .map((row): ScheduleGuiListRowDto => {
      if (!row.valid) return row.invalid;
      const schedule = row.schedule,
        active = activeRunDtoOf(schedule),
        health = healthRollupOf(schedule.scheduleId),
        availability = deriveScheduleExecutionAvailability({
          mode,
          targetKind: schedule.spec.target.kind,
          viewerNodeId,
          activeNodeId: schedule.status.activeRun?.nodeId ?? null,
        }),
        targetProjection =
          schedule.spec.target.kind === "agent"
            ? scheduleTargetProjection(schedule.spec.target.agentId, agentsById.get(schedule.spec.target.agentId))
            : null,
        runNow = runNowFacet({
          mode,
          state: schedule.state,
          availability,
          active: schedule.status.activeRun
            ? { occurrenceId: schedule.status.activeRun.occurrenceId, nodeId: schedule.status.activeRun.nodeId }
            : null,
          targetKind: schedule.spec.target.kind,
          admitAction: context.ports.admitAction,
        });
      return {
        scheduleId: schedule.scheduleId,
        name: schedule.name,
        state: schedule.state,
        mode: schedule.mode,
        systemPresetId: schedule.systemPresetId ?? null,
        definitionResidency: "ledger",
        definitionRevision: row.revision,
        trigger: triggerDtoOf(schedule, formatDuration),
        target: targetDtoOf(
          schedule,
          schedule.spec.target.kind === "agent" ? agentsById.get(schedule.spec.target.agentId) : undefined,
          context.ports.defaultBackupRetention,
        ),
        ...(targetProjection ? { targetState: targetProjection.state, targetError: targetProjection.error } : {}),
        mission: schedule.spec.mission,
        executionAvailability: availability,
        claim: active ? { nodeId: active.nodeId, claimFence: active.claimFence } : { nodeId: null, claimFence: null },
        health,
        nextRunAt: schedule.state === "armed" ? nextScheduleOccurrence(schedule.spec.trigger, now) : null,
        actions: {
          edit: context.ports.admitAction("schedule-update", mode),
          delete: deleteFacet(mode, schedule.status.activeRun, schedule.systemPresetId, context.ports.admitAction),
          enable: stateFacet(
            "schedule-enable",
            mode,
            schedule.state,
            context.ports.admitAction,
            schedule.spec.target.kind,
          ),
          disable: stateFacet("schedule-disable", mode, schedule.state, context.ports.admitAction),
          runNow:
            targetProjection && runNow.available
              ? {
                  available: false,
                  code: "schedule_target_unavailable",
                  nextAction: targetProjection.error.hint,
                }
              : runNow,
        },
        activeRun: active,
        lastRun: lastRunDtoOf(schedule, context),
        missed: {
          count: schedule.status.missedCount,
          lastMissedAt: schedule.status.lastMissedAt,
          lastMissedReason: schedule.status.lastMissedReason,
        },
        automaticEvaluatedThrough: schedule.status.automaticEvaluatedThrough,
        updatedAt: schedule.updatedAt,
      };
    })
    .sort((left, right) => left.scheduleId.localeCompare(right.scheduleId));
  return {
    ok: true,
    status: cut.status,
    repoId: context.repoId,
    repoMode: mode,
    viewerNodeId,
    actions: { create: context.ports.admitAction("schedule-create", mode) },
    options: {
      agents: [...agentOptions].sort((left, right) => left.agentId.localeCompare(right.agentId)),
      instances: [...(context.ports.runtimeInstances?.() ?? [])].sort((left, right) =>
        left.instanceId.localeCompare(right.instanceId),
      ),
    },
    schedules,
    watermark: cut.watermark,
    sourceRevision: cut.sourceRevision,
  };
}

function targetDtoOf(
  schedule: ScheduleV1,
  agent: ScheduleGuiAgentOptionDto | undefined,
  defaultRetention: { readonly keepDays: number; readonly keepMonthly: boolean },
): ScheduleGuiRowDto["target"] {
  const target = schedule.spec.target;
  if (target.kind === "agent")
    return {
      kind: "agent",
      agentId: target.agentId,
      runtimes:
        agent && isAvailableScheduleGuiAgentOption(agent)
          ? agent.runtimes.map(({ type, model }) => ({ type, ...(model === undefined ? {} : { model }) }))
          : [],
      reasoningEffort: target.reasoningEffort ?? null,
      fast: target.fast ?? false,
      cwd: null,
    };
  if (target.kind === "builtin")
    return {
      kind: "builtin",
      builtinId: target.builtinId,
      keepDays: target.params?.keepDays ?? defaultRetention.keepDays,
      keepMonthly: target.params?.keepMonthly ?? defaultRetention.keepMonthly,
    };
  if (target.kind === "agent-unconfigured") return { kind: "agent-unconfigured" };
  return { kind: "squad", squadId: target.squadId };
}

function triggerDtoOf(schedule: ScheduleV1, formatDuration: (everyMs: number) => string): ScheduleGuiTriggerDto {
  const trigger = schedule.spec.trigger;
  if (trigger.kind === "interval")
    return {
      kind: "interval",
      everyMs: trigger.everyMs,
      expression: null,
      timezone: null,
      summary: `every ${formatDuration(trigger.everyMs)}`,
    };
  return {
    kind: "cron",
    everyMs: null,
    expression: trigger.expression,
    timezone: trigger.timezone,
    summary: `${trigger.expression} (${trigger.timezone})`,
  };
}

function viewerNodeIdOf(mode: DaemonRepoMode, ports: SchedulesGuiReadPorts): string | null {
  if (mode === "local" || mode === "remote-center") return "local";
  if (mode !== "remote-edge") return null;
  if (!ports.resolveEdgeNodeId) throw new Error("A remote-edge Schedule read requires fleet-edge.json.");
  return ports.resolveEdgeNodeId();
}

function deleteFacet(
  mode: DaemonRepoMode,
  active: ScheduleV1["status"]["activeRun"],
  systemPresetId: string | undefined,
  admitAction: SchedulesGuiReadPorts["admitAction"],
): ScheduleGuiActionFacet {
  const admission = admitAction("schedule-delete", mode);
  if (!admission.available) return admission;
  if (systemPresetId) return scheduleActionFacet(false, "schedule_builtin_protected");
  return active === null ? admission : scheduleActionFacet(false, "schedule_single_flight_active");
}

function runNowFacet(input: {
  readonly mode: DaemonRepoMode;
  readonly state: ScheduleV1["state"];
  readonly availability: ScheduleExecutionAvailability;
  readonly active: { readonly occurrenceId: string; readonly nodeId: string } | null;
  readonly targetKind: "agent" | "agent-unconfigured" | "squad" | "builtin";
  readonly admitAction: SchedulesGuiReadPorts["admitAction"];
}): ScheduleGuiActionFacet {
  const admission = input.admitAction("schedule-run-now", input.mode);
  if (!admission.available) return admission;
  if (input.targetKind === "agent-unconfigured") return scheduleActionFacet(false, "schedule_target_unconfigured");
  if (input.targetKind === "squad") return scheduleActionFacet(false, "schedule_target_unavailable");
  if (input.state === "paused") return scheduleActionFacet(false, "schedule_paused");
  if (input.active) return scheduleActionFacet(false, "schedule_single_flight_active");
  return scheduleActionFacet(
    input.availability === "local",
    input.availability === "local" ? null : "not_execution_node",
  );
}

function stateFacet(
  actionKind: "schedule-enable" | "schedule-disable",
  mode: DaemonRepoMode,
  state: ScheduleV1["state"],
  admitAction: SchedulesGuiReadPorts["admitAction"],
  targetKind?: ScheduleV1["spec"]["target"]["kind"],
): ScheduleGuiActionFacet {
  const admission = admitAction(actionKind, mode);
  if (!admission.available) return admission;
  if (actionKind === "schedule-enable" && targetKind === "agent-unconfigured")
    return scheduleActionFacet(false, "schedule_target_unconfigured");
  const wanted = actionKind === "schedule-enable" ? "paused" : "armed";
  return state === wanted ? admission : scheduleActionFacet(false, "no_changes");
}

export function scheduleActionFacet(available: boolean, code: string | null): ScheduleGuiActionFacet {
  const nextAction = code;
  return { available, code, nextAction };
}

function activeRunDtoOf(schedule: ScheduleV1): ScheduleGuiRowDto["activeRun"] {
  const active = schedule.status.activeRun;
  if (!active) return null;
  return {
    occurrenceId: active.occurrenceId,
    kind: active.kind,
    scheduledFor: active.scheduledFor,
    claimedAt: active.claimedAt,
    nodeId: active.nodeId,
    claimFence: active.claimFence,
    attemptIndex: active.attemptIndex,
    dispatchId: active.dispatchId ?? null,
    runtimeSessionId: active.runtimeSessionId ?? null,
  };
}

function lastRunDtoOf(schedule: ScheduleV1, context: SchedulesGuiReadInput): ScheduleGuiRowDto["lastRun"] {
  const last = schedule.status.lastRun;
  if (!last) return null;
  const session = last.runtimeSessionId ? context.projection.readRuntimeSession(last.runtimeSessionId) : null,
    dispatch = session
      ? context.projection.readRuntimeDispatch(session.runtimeSessionId, session.definitionSnapshotRef)
      : null,
    definition = dispatch?.payload.definitionSnapshot;
  return {
    runtime: definition
      ? { instanceId: definition.instanceId, kindId: definition.kindId, model: definition.model }
      : null,
    occurrenceId: last.occurrenceId,
    scheduledFor: last.scheduledFor,
    endedAt: last.endedAt,
    outcome: last.outcome,
    nodeId: last.nodeId,
    claimFence: last.claimFence,
    attemptIndex: last.attemptIndex,
    dispatchId: last.dispatchId ?? null,
    runtimeSessionId: last.runtimeSessionId ?? null,
    detail: last.detail ?? null,
  };
}

function inspectGuiSchedule(row: {
  readonly id?: string;
  readonly value: unknown;
  readonly workspaceRevision: number;
}):
  | Extract<InspectedScheduleProjection, { readonly valid: true }>
  | { readonly valid: false; readonly invalid: ScheduleGuiInvalidRowDto } {
  const errors = validateScheduleV1(row.value);
  if (errors.length === 0) return { valid: true, schedule: row.value as ScheduleV1, revision: row.workspaceRevision };
  const value = row.value as { readonly scheduleId?: unknown } | null;
  const id = row.id ?? (typeof value?.scheduleId === "string" && value.scheduleId ? value.scheduleId : "unknown");
  return {
    valid: false,
    invalid: {
      scheduleId: id,
      state: "invalid",
      invalidReason: errors.join("; "),
      definitionRevision: row.workspaceRevision,
    },
  };
}

function scheduleAgentOptions(context: SchedulesGuiReadInput): readonly ScheduleGuiAgentOptionDto[] {
  return context.projection.listEntities("agent").map((row) => {
    const agentId = row.id ?? projectedAgentId(row.value);
    if (row.freshness === "orphaned")
      return {
        agentId,
        state: "missing",
        error: { code: "agent_not_found", hint: `${agentId} is not an installed agent.` },
      };
    if (row.freshness === "unknown") {
      let hint = `Agent projection ${agentId} is not current.`;
      const uninterpretable = readProjectedAgentDeclarationOutcome(agentId, row.value);
      if (uninterpretable.kind === "invalid") hint = uninterpretable.error.message;
      return { agentId, state: "invalid", error: { code: "invalid_entity_projection", hint } };
    }
    const outcome = readProjectedAgentDeclarationOutcome(agentId, row.value);
    if (outcome.kind === "ok") {
      const agent = outcome.value;
      return {
        agentId: agent.id,
        name: agent.name,
        runtimes: agent.runtimes.map(({ type, model }) => ({ type, ...(model === undefined ? {} : { model }) })),
      };
    }
    return {
      agentId,
      state: "invalid",
      error: {
        code: "invalid_entity_contract",
        hint: outcome.kind === "invalid" ? outcome.error.message : `${agentId} is not an installed agent.`,
      },
    };
  });
}

function projectedAgentId(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "unknown";
  const id = (value as Readonly<Record<string, unknown>>).id;
  return typeof id === "string" && id ? id : "unknown";
}

function scheduleTargetProjection(
  agentId: string,
  option: ScheduleGuiAgentOptionDto | undefined,
): Extract<ScheduleGuiAgentOptionDto, { readonly state: ClientStatus.DegradedEntityState }> | null {
  if (option === undefined)
    return {
      agentId,
      state: "missing",
      error: { code: "agent_not_found", hint: `${agentId} is not an installed agent.` },
    };
  return isAvailableScheduleGuiAgentOption(option) ? null : option;
}

const intervalDurationUnits = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
  ["ms", 1],
] as const;

function formatIntervalDuration(everyMs: number): string {
  for (const [unit, unitMs] of intervalDurationUnits) if (everyMs % unitMs === 0) return `${everyMs / unitMs}${unit}`;
  return `${everyMs}ms`;
}
