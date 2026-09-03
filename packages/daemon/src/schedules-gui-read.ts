import { readFileSync } from "node:fs";
import path from "node:path";
import {
  nextScheduleOccurrence,
  validateScheduleV1,
  type DaemonRepoMode,
  type ScheduleV1,
} from "../../kernel/src/index.ts";
import type { AgentRuntimeInstanceDto } from "./agent-runtime-contract.ts";
import { parseAgentDeclarationV1 } from "../../kernel/src/index.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { parseFleetRoster, type FleetRoster } from "./fleet-center-admission.ts";
import { scheduleReasoningEfforts } from "./protocol/daemon-protocol-commands-runtime-fleet.ts";
import { commandDescriptorForAction } from "./protocol/daemon-protocol-commands.ts";
import type {
  ScheduleExecutionAvailability,
  ScheduleGuiAgentOptionDto,
  ScheduleGuiActionFacet,
  ScheduleGuiInvalidRowDto,
  ScheduleGuiListRowDto,
  ScheduleGuiOptionsDto,
  ScheduleGuiRowDto,
  ScheduleGuiTriggerDto,
  SchedulesListResult,
} from "./protocol/schedules-gui-contract.ts";
import { isAvailableScheduleGuiAgentOption } from "./protocol/schedules-gui-contract.ts";
import { admitRepoMode } from "./repo-mode.ts";
import { makeGitReadinessSource } from "./process-port.ts";

/** Schedule GUI 读侧 join(S4)。上游事实全部来自已合入面:S1 的 ScheduleV1 领域形状与
 * nextScheduleOccurrence、S3 的投影/action 语义、dec_9C393CDA 的 residency 拆分。
 * renderer 只格式化 DTO;nextRun/DST/mode/node/provider 的判断都在这里,一次 read
 * 返回完整列表,页面不做 N+1。 */
export interface SchedulesGuiReadContext {
  readonly mode: DaemonRepoMode | null;
  readonly rootDir: string;
  readonly now: () => string;
  readonly input: {
    readonly repoId: string;
    readonly runtimeInstances?: () => readonly AgentRuntimeInstanceDto[];
  };
  readonly projection: {
    readonly listEntities: (entityKind: string) => readonly {
      readonly id?: string;
      readonly value: unknown;
      readonly workspaceRevision: number;
      readonly freshness?: "current" | "orphaned" | "unknown";
    }[];
    readonly readTaskStatuses: () => {
      readonly status: "ready" | "pending";
      readonly watermark: number;
      readonly sourceRevision: number;
    };
  };
  /** remote-center daemon 在 startFleetCenterAdmission 后保留的 roster;缺省视为不可解析。 */
  readonly fleetRoster?: FleetRoster | null;
}

interface RosterAssignment {
  readonly assignmentId: string;
  readonly nodeId: string;
}

function triggerDtoOf(schedule: ScheduleV1): ScheduleGuiTriggerDto {
  const trigger = schedule.spec.trigger;
  if (trigger.kind === "interval")
    return {
      kind: "interval",
      everyMs: trigger.everyMs,
      expression: null,
      timezone: null,
      summary: `every ${formatEveryMs(trigger.everyMs)}`,
    };
  return {
    kind: "cron",
    everyMs: null,
    expression: trigger.expression,
    timezone: trigger.timezone,
    summary: `${trigger.expression} (${trigger.timezone})`,
  };
}

function formatEveryMs(everyMs: number): string {
  const units: readonly [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
  ];
  for (const [size, suffix] of units) if (everyMs >= size && everyMs % size === 0) return `${everyMs / size}${suffix}`;
  return `${Math.max(1, Math.round(everyMs / 1000))}s`;
}

function viewerNodeIdOf(mode: DaemonRepoMode, rootDir: string): string | null {
  if (mode === "local") return "local";
  if (mode !== "remote-edge") return null;
  const config = readFleetEdgeConfig(rootDir);
  if (!config) throw new Error("A remote-edge Schedule read requires fleet-edge.json.");
  return config.nodeId;
}

function rosterOf(
  mode: DaemonRepoMode,
  rootDir: string,
  fleetRoster: FleetRoster | null | undefined,
): FleetRoster | null {
  if (mode === "remote-center") {
    if (!fleetRoster) throw new Error("A remote-center Schedule read requires an admitted fleet roster.");
    return fleetRoster;
  }
  if (mode !== "remote-edge") return null;
  const config = readFleetEdgeConfig(rootDir);
  if (!config) throw new Error("A remote-edge Schedule read requires fleet-edge.json.");
  if (!config.rosterPath) throw new Error("A remote-edge Schedule read requires fleet-edge.json rosterPath.");
  return parseFleetRoster(JSON.parse(readFileSync(config.rosterPath, "utf8")));
}

function scheduleAssignmentOf(
  roster: FleetRoster | null,
  repoId: string,
  scheduleId: string,
  now: string,
): RosterAssignment | null {
  if (!roster) return null;
  return (
    roster.assignments.find(
      (assignment) =>
        assignment.repoId === repoId &&
        assignment.scope.kind === "schedule" &&
        assignment.scope.scheduleId === scheduleId &&
        Date.parse(assignment.expiresAt) > Date.parse(now),
    ) ?? null
  );
}

/** Availability 是 daemon 侧判断,renderer 不复算:active claim 的 owner 优先;
 * 空闲时 local 恒可执行,edge/center 按 roster 分辨 unassigned 与 not-on-this-node。 */
export function deriveScheduleExecutionAvailability(input: {
  readonly mode: DaemonRepoMode;
  readonly viewerNodeId: string | null;
  readonly roster: FleetRoster | null;
  readonly repoId: string;
  readonly scheduleId: string;
  readonly activeNodeId: string | null;
  readonly now: string;
}): ScheduleExecutionAvailability {
  const { mode, viewerNodeId, roster, repoId, scheduleId, activeNodeId, now } = input;
  if (activeNodeId !== null) return activeNodeId === viewerNodeId ? "local" : "claimed-elsewhere";
  if (mode === "local") return "local";
  if (!roster) throw new Error(`A ${mode} Schedule availability read requires a fleet roster.`);
  const assignment = scheduleAssignmentOf(roster, repoId, scheduleId, now);
  if (assignment === null) return "unassigned";
  return assignment.nodeId === viewerNodeId ? "local" : "not-on-this-node";
}

function admissionFacet(
  actionKind:
    | "schedule-create"
    | "schedule-update"
    | "schedule-delete"
    | "schedule-enable"
    | "schedule-disable"
    | "schedule-run-now",
  mode: DaemonRepoMode,
): ScheduleGuiActionFacet {
  const admission = admitRepoMode(mode, commandDescriptorForAction(actionKind), "local");
  return scheduleActionFacet(admission.ok, admission.ok ? null : admission.code);
}

function deleteFacet(mode: DaemonRepoMode, active: ScheduleV1["status"]["activeRun"]): ScheduleGuiActionFacet {
  const admission = admissionFacet("schedule-delete", mode);
  if (!admission.available) return admission;
  return active === null ? admission : scheduleActionFacet(false, "schedule_single_flight_active");
}

function runNowFacet(input: {
  readonly mode: DaemonRepoMode;
  readonly state: "armed" | "paused";
  readonly availability: ScheduleExecutionAvailability;
  readonly active: { readonly occurrenceId: string; readonly nodeId: string } | null;
  readonly claimNodeId: string | null;
  readonly targetKind: "agent" | "squad";
}): ScheduleGuiActionFacet {
  const admission = admissionFacet("schedule-run-now", input.mode);
  if (!admission.available) return admission;
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
  state: "armed" | "paused",
): ScheduleGuiActionFacet {
  const admission = admissionFacet(actionKind, mode);
  if (!admission.available) return admission;
  // Domain no-op guard: the GUI never offers an action the cell would answer no_changes.
  const wanted = actionKind === "schedule-enable" ? "paused" : "armed";
  return state === wanted ? admission : scheduleActionFacet(false, "no_changes");
}

function scheduleActionFacet(available: boolean, code: string | null): ScheduleGuiActionFacet {
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
    assignmentId: active.assignmentId,
    attemptIndex: active.attemptIndex,
    dispatchId: active.dispatchId ?? null,
    runtimeSessionId: active.runtimeSessionId ?? null,
  };
}

function lastRunDtoOf(schedule: ScheduleV1): ScheduleGuiRowDto["lastRun"] {
  const last = schedule.status.lastRun;
  if (!last) return null;
  return {
    occurrenceId: last.occurrenceId,
    scheduledFor: last.scheduledFor,
    endedAt: last.endedAt,
    outcome: last.outcome,
    nodeId: last.nodeId,
    assignmentId: last.assignmentId,
    attemptIndex: last.attemptIndex,
    dispatchId: last.dispatchId ?? null,
    runtimeSessionId: last.runtimeSessionId ?? null,
    detail: last.detail ?? null,
  };
}

export function readSchedulesGui(context: SchedulesGuiReadContext): SchedulesListResult {
  const repoMode = context.mode ?? "local";
  if (repoMode === "remote-proxy")
    throw new Error("Schedule GUI reads for remote-proxy repositories must be routed to the remote daemon.");
  const mode = repoMode,
    now = context.now(),
    viewerNodeId = viewerNodeIdOf(mode, context.rootDir),
    roster = rosterOf(mode, context.rootDir, context.fleetRoster),
    cut = context.projection.readTaskStatuses(),
    agentOptions = scheduleAgentOptions(context),
    agentsById = new Map(agentOptions.map((agent) => [agent.agentId, agent]));
  const schedules = context.projection
    .listEntities("schedule")
    .map((row): ScheduleGuiListRowDto => {
      const errors = validateScheduleV1(row.value);
      if (errors.length > 0) return invalidScheduleGuiRow(row, errors);
      const schedule = row.value as ScheduleV1,
        active = activeRunDtoOf(schedule),
        availability = deriveScheduleExecutionAvailability({
          mode,
          viewerNodeId,
          roster,
          repoId: context.input.repoId,
          scheduleId: schedule.scheduleId,
          activeNodeId: schedule.status.activeRun?.nodeId ?? null,
          now,
        }),
        assignment = scheduleAssignmentOf(roster, context.input.repoId, schedule.scheduleId, now),
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
          claimNodeId: assignment?.nodeId ?? null,
          targetKind: schedule.spec.target.kind,
        });
      return {
        scheduleId: schedule.scheduleId,
        name: schedule.name,
        state: schedule.state,
        mode: schedule.mode,
        definitionResidency: "ledger",
        definitionRevision: row.workspaceRevision,
        trigger: triggerDtoOf(schedule),
        target:
          schedule.spec.target.kind === "agent"
            ? {
                kind: "agent",
                agentId: schedule.spec.target.agentId,
                runtimeInstanceId: schedule.spec.target.runtimeInstanceId,
                model: schedule.spec.target.model ?? null,
                reasoningEffort: schedule.spec.target.reasoningEffort ?? null,
                fast: schedule.spec.target.fast ?? false,
                cwd: schedule.spec.target.cwd ?? null,
              }
            : { kind: "squad", squadId: schedule.spec.target.squadId },
        ...(targetProjection ? { targetState: targetProjection.state, targetError: targetProjection.error } : {}),
        mission: schedule.spec.mission,
        executionAvailability: availability,
        claim: active
          ? { nodeId: active.nodeId, assignmentId: active.assignmentId }
          : assignment
            ? { nodeId: assignment.nodeId, assignmentId: assignment.assignmentId }
            : { nodeId: null, assignmentId: null },
        nextRunAt: schedule.state === "armed" ? nextScheduleOccurrence(schedule.spec.trigger, now) : null,
        actions: {
          edit: admissionFacet("schedule-update", mode),
          delete: deleteFacet(mode, schedule.status.activeRun),
          enable: stateFacet("schedule-enable", mode, schedule.state),
          disable: stateFacet("schedule-disable", mode, schedule.state),
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
        lastRun: lastRunDtoOf(schedule),
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
    repoId: context.input.repoId,
    repoMode: mode,
    viewerNodeId,
    actions: { create: admissionFacet("schedule-create", mode) },
    options: scheduleOptions(context, schedules, agentOptions),
    schedules,
    watermark: cut.watermark,
    sourceRevision: cut.sourceRevision,
  };
}

function scheduleOptions(
  context: SchedulesGuiReadContext,
  schedules: readonly ScheduleGuiListRowDto[],
  agents: readonly ScheduleGuiAgentOptionDto[],
): ScheduleGuiOptionsDto {
  const instances = (context.input.runtimeInstances?.() ?? [])
      .filter(({ enabled }) => enabled)
      .map((instance) => ({
        instanceId: instance.instanceId,
        name: instance.name,
        kindId: instance.kindId,
        models: instance.models,
        efforts:
          instance.kindId === "codex"
            ? scheduleReasoningEfforts
            : instance.kindId === "agy"
              ? scheduleReasoningEfforts.filter((effort) => ["low", "medium", "high"].includes(effort))
              : [],
      })),
    cwd = new Set<string>([".", ...trackedDirectories(context.rootDir)]);
  for (const schedule of schedules)
    if (schedule.state !== "invalid" && schedule.target.kind === "agent" && schedule.target.cwd)
      cwd.add(schedule.target.cwd);
  return {
    agents: [...agents].sort((left, right) => left.agentId.localeCompare(right.agentId)),
    instances: instances.sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
    cwd: [...cwd].sort((left, right) => (left === "." ? -1 : right === "." ? 1 : left.localeCompare(right))),
  };
}

function scheduleAgentOptions(context: SchedulesGuiReadContext): readonly ScheduleGuiAgentOptionDto[] {
  return context.projection.listEntities("agent").map((row) => {
    const agentId = row.id ?? projectedAgentId(row.value);
    if (row.freshness === "orphaned")
      return {
        agentId,
        state: "missing",
        error: { code: "agent_not_found", hint: `${agentId} is not an installed agent.` },
      };
    if (row.freshness === "unknown")
      return {
        agentId,
        state: "invalid",
        error: { code: "invalid_entity_projection", hint: `Agent projection ${agentId} is not current.` },
      };
    try {
      const agent = parseAgentDeclarationV1(row.value);
      return { agentId: agent.id, name: agent.name, runtimeType: agent.runtime_type };
    } catch (error) {
      if ((error as { readonly code?: unknown })?.code !== "invalid_entity_contract") throw error;
      return {
        agentId,
        state: "invalid",
        error: { code: "invalid_entity_contract", hint: error instanceof Error ? error.message : String(error) },
      };
    }
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
): Extract<ScheduleGuiAgentOptionDto, { readonly state: "invalid" | "missing" }> | null {
  if (option === undefined)
    return {
      agentId,
      state: "missing",
      error: { code: "agent_not_found", hint: `${agentId} is not an installed agent.` },
    };
  return isAvailableScheduleGuiAgentOption(option) ? null : option;
}

function invalidScheduleGuiRow(
  row: { readonly id?: string; readonly value: unknown; readonly workspaceRevision: number },
  errors: readonly string[],
): ScheduleGuiInvalidRowDto {
  const value =
      typeof row.value === "object" && row.value !== null && !Array.isArray(row.value)
        ? (row.value as Readonly<Record<string, unknown>>)
        : null,
    scheduleId = row.id ?? (typeof value?.scheduleId === "string" && value.scheduleId ? value.scheduleId : "unknown");
  return {
    scheduleId,
    state: "invalid",
    invalidReason: errors.join("; "),
    definitionRevision: row.workspaceRevision,
  };
}

function trackedDirectories(rootDir: string): readonly string[] {
  const listed = makeGitReadinessSource().run(rootDir, ["ls-files"]);
  if (!listed.ok || !listed.stdout) return [];
  const directories = new Set<string>();
  for (const file of listed.stdout.split("\n")) {
    let directory = path.posix.dirname(file);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories];
}
