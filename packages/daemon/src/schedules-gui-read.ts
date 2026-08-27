import { readFileSync } from "node:fs";
import path from "node:path";
import { nextScheduleOccurrence, type DaemonRepoMode, type ScheduleV1 } from "../../kernel/src/index.ts";
import type { AgentRuntimeInstanceDto } from "./agent-runtime-contract.ts";
import { parseAgentDeclarationV1 } from "../../kernel/src/domain/agent-squad-schema.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { parseFleetRoster, type FleetRoster } from "./fleet-center-admission.ts";
import { scheduleReasoningEfforts } from "./protocol/daemon-protocol-commands-runtime-fleet.ts";
import { commandDescriptorForAction } from "./protocol/daemon-protocol-commands.ts";
import type {
  ScheduleExecutionAvailability,
  ScheduleGuiActionFacet,
  ScheduleGuiOptionsDto,
  ScheduleGuiRowDto,
  ScheduleGuiTriggerDto,
  SchedulesListResult,
} from "./protocol/schedules-gui-contract.ts";
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
      readonly value: unknown;
      readonly workspaceRevision: number;
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
  const trigger = schedule.spec.trigger as Readonly<Record<string, unknown>>,
    everyMs = trigger.everyMs;
  if (trigger.kind === "interval" && typeof everyMs === "number" && Number.isSafeInteger(everyMs) && everyMs >= 60_000)
    return {
      kind: "interval",
      everyMs,
      timezone: null,
      summary: `every ${formatEveryMs(everyMs)}`,
    };
  // Kernel ScheduleTriggerV1 only defines interval triggers, so anything else means
  // the ledger entity escaped its write-side schema; refuse to recast it as a
  // fabricated cadence (nextScheduleOccurrence below throws the same way).
  throw new Error(`schedule ${schedule.scheduleId} has a trigger the interval contract does not define`);
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
  return admission.ok
    ? { available: true, code: null, nextAction: null }
    : { available: false, code: admission.code, nextAction: admission.nextAction };
}

function deleteFacet(mode: DaemonRepoMode, active: ScheduleV1["status"]["activeRun"]): ScheduleGuiActionFacet {
  const admission = admissionFacet("schedule-delete", mode);
  if (!admission.available) return admission;
  return active === null
    ? admission
    : {
        available: false,
        code: "schedule_single_flight_active",
        nextAction: `Occurrence ${active.occurrenceId} must settle before deleting the Schedule.`,
      };
}

function runNowFacet(input: {
  readonly mode: DaemonRepoMode;
  readonly state: "armed" | "paused";
  readonly availability: ScheduleExecutionAvailability;
  readonly active: { readonly occurrenceId: string; readonly nodeId: string } | null;
  readonly claimNodeId: string | null;
}): ScheduleGuiActionFacet {
  const admission = admissionFacet("schedule-run-now", input.mode);
  if (!admission.available) return admission;
  if (input.state === "paused")
    return {
      available: false,
      code: "schedule_paused",
      nextAction: "Enable the Schedule before claiming a manual occurrence.",
    };
  if (input.active)
    return {
      available: false,
      code: "schedule_single_flight_active",
      nextAction: `Occurrence ${input.active.occurrenceId} is already claimed by node ${input.active.nodeId}.`,
    };
  if (input.availability === "local") return { available: true, code: null, nextAction: null };
  const nextAction =
    input.availability === "claimed-elsewhere"
      ? "The active claim is owned by another node; watch its run projection here."
      : input.availability === "unassigned"
        ? "No fleet edge holds this Schedule; add a schedule assignment to the roster before expecting runs."
        : `Execution belongs to node ${input.claimNodeId ?? "another node"}; run it there.`;
  return { available: false, code: "not_execution_node", nextAction };
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
  return state === wanted
    ? admission
    : {
        available: false,
        code: "no_changes",
        nextAction:
          actionKind === "schedule-enable" ? "The Schedule is already armed." : "The Schedule is already paused.",
      };
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
  const mode = context.mode ?? "local",
    now = context.now(),
    viewerNodeId = viewerNodeIdOf(mode, context.rootDir),
    roster = rosterOf(mode, context.rootDir, context.fleetRoster),
    cut = context.projection.readTaskStatuses();
  const schedules = context.projection
    .listEntities("schedule")
    .map((row): ScheduleGuiRowDto => {
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
        assignment = scheduleAssignmentOf(roster, context.input.repoId, schedule.scheduleId, now);
      return {
        scheduleId: schedule.scheduleId,
        name: schedule.name,
        state: schedule.state,
        definitionResidency: "ledger",
        definitionRevision: row.workspaceRevision,
        trigger: triggerDtoOf(schedule),
        target: {
          agentId: schedule.spec.target.agentId,
          runtimeInstanceId: schedule.spec.target.runtimeInstanceId,
          model: schedule.spec.target.model ?? null,
          reasoningEffort: schedule.spec.target.reasoningEffort ?? null,
          cwd: schedule.spec.target.cwd ?? null,
        },
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
          runNow: runNowFacet({
            mode,
            state: schedule.state,
            availability,
            active: schedule.status.activeRun
              ? { occurrenceId: schedule.status.activeRun.occurrenceId, nodeId: schedule.status.activeRun.nodeId }
              : null,
            claimNodeId: assignment?.nodeId ?? null,
          }),
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
    options: scheduleOptions(context, schedules),
    schedules,
    watermark: cut.watermark,
    sourceRevision: cut.sourceRevision,
  };
}

function scheduleOptions(
  context: SchedulesGuiReadContext,
  schedules: readonly ScheduleGuiRowDto[],
): ScheduleGuiOptionsDto {
  const agents = context.projection.listEntities("agent").map(({ value }) => {
      const agent = parseAgentDeclarationV1(value);
      return { agentId: agent.id, name: agent.name, runtimeType: agent.runtime_type };
    }),
    instances = (context.input.runtimeInstances?.() ?? [])
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
  for (const schedule of schedules) if (schedule.target.cwd) cwd.add(schedule.target.cwd);
  return {
    agents: agents.sort((left, right) => left.agentId.localeCompare(right.agentId)),
    instances: instances.sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
    cwd: [...cwd].sort((left, right) => (left === "." ? -1 : right === "." ? 1 : left.localeCompare(right))),
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
