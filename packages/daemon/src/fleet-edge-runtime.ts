import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  openEntityStore,
  resolveHarnessLayout,
  validateScheduleV1,
  type AgentRuntimeEventV1,
  type EntityStore,
  type ScheduleV1,
} from "../../kernel/src/index.ts";
import { readAgentDeclaration, resolveSquadDispatch } from "./agent-entities.ts";
import { parseAgentDeclarationV1 } from "./agent-entities.contract.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import {
  readFleetAssignmentClient,
  readFleetReceiptClient,
  runFleetReplicaPullClient,
  runFleetRuntimeArchiveClient,
  runFleetRuntimeEventClient,
  runFleetRuntimeReadClient,
  runFleetScheduleCommandClient,
  runFleetTaskCommandClient,
  type FleetPeerOptions,
} from "./fleet/edge.ts";
import { fleetEdgeCredential } from "./fleet-edge-task.ts";
import { applyFleetMirrorCut, locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { validateAgentRuntimeOverview, type AgentRuntimeOverviewResult } from "./agent-runtime-contract.ts";
import { makeRuntimeSpawner, type RuntimeDaemonRoute, type RuntimeLauncher } from "./runtime-spawn.ts";
import type { RuntimeAgent } from "./runtime-spawn-types.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { dispatchClaimedSchedule } from "./repo-cell-schedule-actions.ts";

export interface FleetEdgeRuntimeRequest {
  readonly payload: {
    readonly host: string;
    readonly port: number;
    readonly caPath: string;
    readonly servername?: string;
    readonly nodeId: string;
    readonly credential?: string;
    readonly rosterPath?: string;
    readonly assignmentId: string;
    readonly repoId: string;
    readonly viewRoot: string;
    readonly quotaBytes: number;
    readonly workspaceRoot: string;
    readonly method:
      | "repo.agentRuntime.spawn"
      | "repo.agentRuntime.cancel"
      | "repo.agentRuntime.overview"
      | "repo.agentRuntime.sessions.read"
      | "repo.schedule.run";
    readonly action: JsonObject;
  };
}
type RuntimePorts = {
  readonly runtimeInstances: () => readonly RuntimeInstanceSummary[];
  readonly prepareRuntimeLaunch: (
    instanceId: string,
    request: {
      readonly cwd: string;
      readonly prompt: string;
      readonly model?: string;
      readonly effort?: string;
      readonly providerSessionId?: string;
      readonly permissionMode?: string;
    },
  ) => Promise<PreparedRuntimeLaunch>;
  readonly prepareWorkerGitEnvironment: (instanceId: string) => Promise<NodeJS.ProcessEnv | null>;
};
const runtimeOverviewPageLimit = 16;

export async function readFleetRuntimeSessionsPaged(readPage: (payload: JsonObject) => Promise<unknown>): Promise<
  readonly {
    readonly runtimeSessionId: string;
    readonly providerSessionId: string | null;
    readonly instanceId: string;
    readonly liveness: "live" | "stale" | "unknown" | "exited";
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | null;
  }[]
> {
  const sessions: Array<{
    readonly runtimeSessionId: string;
    readonly providerSessionId: string | null;
    readonly instanceId: string;
    readonly liveness: "live" | "stale" | "unknown" | "exited";
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | null;
  }> = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await readPage({ limit: runtimeOverviewPageLimit, ...(cursor === null ? {} : { cursor }) });
    const issues = validateAgentRuntimeOverview(result);
    if (issues.length) throw edgeRuntimeError("runtime_read_invalid", issues.join("; "));
    const overview = result as AgentRuntimeOverviewResult;
    if (!overview.page)
      throw edgeRuntimeError("runtime_read_invalid", "A paged runtime overview omitted its page receipt.");
    sessions.push(
      ...overview.sessions.map(({ runtimeSessionId, providerSessionId, instanceId, liveness, activity }) => ({
        runtimeSessionId,
        providerSessionId,
        instanceId,
        liveness,
        outcome: activity.outcome,
      })),
    );
    cursor = overview.page.nextCursor;
    if (cursor !== null && seen.has(cursor))
      throw edgeRuntimeError("runtime_read_invalid", `Runtime overview repeated cursor ${cursor}.`);
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
  return sessions;
}

export function openFleetEdgeRuntime(input: {
  readonly request: FleetEdgeRuntimeRequest["payload"];
  readonly daemonGeneration: number;
  readonly daemonRoute: RuntimeDaemonRoute;
  readonly ports: RuntimePorts;
  readonly launch?: RuntimeLauncher;
  readonly now?: () => string;
}) {
  // Provider signals already remain in the edge-local dispatch JSONL, while remote status
  // polls the canonical session read below. Forwarding stream frames would create a second,
  // non-canonical synchronization surface with no consumer or settlement contract.
  const request = input.request,
    credential = fleetEdgeCredential(request.nodeId, request.credential, request.rosterPath),
    peer: FleetPeerOptions = {
      hostname: request.host,
      port: request.port,
      ca: readFileSync(request.caPath, "utf8"),
      ...(request.servername ? { servername: request.servername } : {}),
      nodeId: request.nodeId,
      credential,
      assignmentId: request.assignmentId,
    },
    runtimeReadTimeoutMs = readFleetEdgeConfig(request.workspaceRoot)?.waitTimeoutMs,
    runtimeReadPeer: FleetPeerOptions = {
      ...peer,
      ...(runtimeReadTimeoutMs === undefined ? {} : { timeoutMs: runtimeReadTimeoutMs }),
    },
    now = input.now ?? (() => new Date().toISOString()),
    stream = { publish: () => ({}) as never };
  let entityStore: EntityStore | undefined;
  const trustedScheduleAgents = new Map<string, RuntimeAgent>();
  const getEntityStore = (): EntityStore => (entityStore ??= openEntityStore(request.workspaceRoot));
  let tail = Promise.resolve();
  const schedule = (work: () => void | Promise<void>): void => {
    tail = tail.then(work).then(
      () => undefined,
      () => undefined,
    );
  };
  const spawner = makeRuntimeSpawner({
    repoId: request.repoId,
    rootDir: request.workspaceRoot,
    daemonGeneration: input.daemonGeneration,
    runtimeDaemonRoute: input.daemonRoute,
    remote: {
      existing: async (opId) => {
        const receipt = await readFleetReceiptClient({ ...peer, opId });
        return receipt.opId === opId && ["applied", "pending"].includes(String(receipt.outcome))
          ? (receipt as JsonObject)
          : null;
      },
      taskContext: async (taskId) => {
        const assigned = await readFleetAssignmentClient(peer);
        if (assigned.repoId !== request.repoId || assigned.scope.kind !== "task" || assigned.scope.taskId !== taskId)
          throw edgeRuntimeError(
            "assignment_scope_mismatch",
            `Task ${taskId} is outside assignment ${request.assignmentId}.`,
          );
        const view = locateFleetMirrorView(request.viewRoot, request.repoId);
        const materializedRoot = resolveHarnessLayout(request.workspaceRoot).authoredRoot;
        const packagePathsFor = (logical: string): string[] => {
          const packagePath = logical.slice(0, -"/INDEX.md".length);
          const indexPath = path.join(materializedRoot, ...logical.split("/"));
          try {
            const body = readFileSync(indexPath, "utf8");
            return body.split(/\r?\n/u).some((line) => line === `task_id: ${taskId}` || line === `taskId: ${taskId}`)
              ? [packagePath]
              : [];
          } catch {
            return [];
          }
        };
        const candidates =
          view === null
            ? []
            : [...view.entries.keys()]
                .filter((logical) => logical.startsWith("tasks/") && logical.endsWith("/INDEX.md"))
                .flatMap(packagePathsFor);
        if (view === null || candidates.length !== 1)
          throw edgeRuntimeError(
            "runtime_task_package_unavailable",
            `Task ${taskId} requires exactly one current mirrored task package;` +
              " run ha daemon fleet edge sync, then retry.",
          );
        const packageRoot = path.join(materializedRoot, ...candidates[0]!.split("/"));
        const planPath = path.join(packageRoot, "task_plan.md");
        let plan: string;
        try {
          plan = readFileSync(planPath, "utf8");
        } catch {
          throw edgeRuntimeError(
            "runtime_task_package_unavailable",
            `Task ${taskId} has no readable mirrored task plan; run ha daemon fleet edge sync, then retry.`,
          );
        }
        return {
          executionId: assigned.scope.executionId,
          packageRoot,
          planPath,
          plan,
          mission: `Your task package is ${packageRoot}.\nRead task_plan.md in that package and complete the task.`,
        };
      },
      readRuntimeSessions: () =>
        readFleetRuntimeSessionsPaged((payload) =>
          runFleetRuntimeReadClient({
            ...runtimeReadPeer,
            repoId: request.repoId,
            method: "repo.agentRuntime.overview",
            payload,
          }),
        ),
      publish: async (draft) => {
        const response = await runFleetRuntimeEventClient({
          ...peer,
          repoId: request.repoId,
          opId: draft.opId,
          eventType: draft.type,
          payload: draft.payload,
          ...(draft.resultBody === undefined ? {} : { resultBody: draft.resultBody }),
        });
        return { event: response.event as unknown as AgentRuntimeEventV1, receipt: response.receipt as JsonObject };
      },
      archive: async (archive) =>
        (await runFleetRuntimeArchiveClient({
          ...peer,
          repoId: request.repoId,
          archive: archive as unknown as Readonly<Record<string, unknown>>,
        })) as { readonly outcome: string; readonly nextAction?: string },
    },
    stream,
    now,
    runtimeInstances: input.ports.runtimeInstances,
    prepareLaunch: input.ports.prepareRuntimeLaunch,
    prepareWorkerGitEnvironment: input.ports.prepareWorkerGitEnvironment,
    resolveAgent: (agentId) =>
      trustedScheduleAgents.get(agentId) ??
      readAgentDeclaration({ rootDir: request.workspaceRoot, agentId, entityStore: getEntityStore() }),
    resolveSquadDispatch: (squadId, leaderId, workerId) =>
      resolveSquadDispatch({
        rootDir: request.workspaceRoot,
        ...(squadId ? { squadId } : {}),
        leaderId,
        ...(workerId ? { workerId } : {}),
        entityStore: getEntityStore(),
      }),
    onAttemptTerminal: async (terminal) => {
      if (terminal.task) {
        const waitMs = runtimeReadTimeoutMs ?? 30_000,
          { taskId, executionId } = terminal.task,
          settled = await runFleetTaskCommandClient({
            ...peer,
            repoId: request.repoId,
            taskId,
            opId: `runtime-terminal-${terminal.runtimeSessionId}`,
            waitMs,
            action: {
              kind: "task-release",
              taskId,
              terminalExecutionId: executionId,
              terminalRuntimeSessionId: terminal.runtimeSessionId,
              reason: `Runtime session ${terminal.runtimeSessionId} reached a terminal dispatch state.`,
            },
          });
        if (
          settled.outcome !== "applied" &&
          settled.code !== "lease_not_found" &&
          settled.code !== "runtime_terminal_superseded"
        )
          throw edgeRuntimeError(
            "runtime_lease_release_failed",
            `Center rejected Runtime terminal lease settlement: ${String(settled.code ?? settled.outcome)}.`,
          );
      }
      const scheduled = terminal.schedule,
        detail = terminal.resultRef ?? terminal.reason;
      if (!scheduled) return;
      schedule(async () => {
        const response = await runFleetScheduleCommandClient({
          ...peer,
          repoId: request.repoId,
          scheduleId: scheduled.scheduleId,
          opId: `${terminal.runtimeSessionId}-schedule-attempt-terminal`,
          action: {
            kind: "schedule-settle",
            phase: "outcome",
            scheduleId: scheduled.scheduleId,
            claimFence: scheduled.claimFence,
            outcome: terminal.outcome,
            endedAt: terminal.endedAt,
            ...(detail ? { detail } : {}),
          },
        });
        if (response.outcome !== "applied")
          throw edgeRuntimeError("schedule_settlement_pending", `Center Schedule settlement was ${response.outcome}.`);
      });
    },
    ...(input.launch ? { launch: input.launch } : {}),
    schedule,
  });
  const ready = spawner.adopt();
  return {
    run: async (method: FleetEdgeRuntimeRequest["payload"]["method"], action: JsonObject): Promise<JsonObject> => {
      await ready;
      if (method === "repo.schedule.run") return runSchedule(action);
      return method === "repo.agentRuntime.spawn"
        ? spawner.spawn(action, edgeBinding())
        : method === "repo.agentRuntime.cancel"
          ? spawner.cancel(action, edgeBinding())
          : ((await runFleetRuntimeReadClient({
              ...runtimeReadPeer,
              repoId: request.repoId,
              method,
              payload: action,
            })) as JsonObject);
    },
    close: () => {
      spawner.close();
    },
  };

  async function runSchedule(action: JsonObject): Promise<JsonObject> {
    const actionKind = requiredScheduleText(action.kind, "kind"),
      assigned = await readFleetAssignmentClient(peer),
      scheduleId =
        actionKind === "schedule-list"
          ? assigned.scope.kind === "schedule"
            ? assigned.scope.scheduleId
            : ""
          : requiredScheduleText(action.scheduleId, "scheduleId");
    if (
      assigned.repoId !== request.repoId ||
      assigned.scope.kind !== "schedule" ||
      assigned.scope.scheduleId !== scheduleId
    )
      throw edgeRuntimeError(
        "assignment_scope_mismatch",
        `Schedule ${scheduleId} is outside assignment ${request.assignmentId}.`,
      );
    const operationKey =
        typeof action.idempotencyKey === "string" && action.idempotencyKey
          ? action.idempotencyKey
          : `${actionKind}:${scheduleId}:${Date.now().toString(36)}`,
      command = await runFleetScheduleCommandClient({
        ...peer,
        repoId: request.repoId,
        scheduleId,
        opId: fleetScheduleOpId(request.repoId, request.assignmentId, operationKey),
        writerEpoch: assigned.writerEpoch,
        action: { ...action, kind: actionKind, scheduleId },
      });
    if (command.outcome !== "applied") return scheduleResult(actionKind, command);
    const receipt = command.receipt as JsonObject;
    if (actionKind === "schedule-list") return scheduleResult(actionKind, command);
    if (actionKind !== "schedule-run-now") {
      await syncScheduleMirror();
      return scheduleResult(actionKind, command);
    }
    const scheduleValue = receipt.schedule;
    if (!scheduleValue || typeof scheduleValue !== "object" || Array.isArray(scheduleValue))
      throw edgeRuntimeError("schedule_claim_invalid", "Applied Schedule claim omitted its projected Schedule value.");
    if (validateScheduleV1(scheduleValue).length)
      throw edgeRuntimeError("schedule_claim_invalid", "Applied Schedule claim returned an invalid Schedule value.");
    const scheduleValueV1 = scheduleValue as unknown as ScheduleV1,
      active = scheduleValueV1.status.activeRun,
      target = scheduleValueV1.spec.target;
    if (
      !active ||
      active.nodeId !== request.nodeId ||
      active.assignmentId !== request.assignmentId ||
      typeof active.claimFence !== "string"
    )
      throw edgeRuntimeError(
        "schedule_claim_invalid",
        "Applied Schedule claim owner, fence, mission, or target is invalid.",
      );
    if (typeof active.dispatchId === "string" && typeof active.runtimeSessionId === "string")
      return {
        ...scheduleResult(actionKind, command),
        dispatchId: active.dispatchId,
        runtimeSessionId: active.runtimeSessionId,
        claimFence: active.claimFence,
      };
    let trustedAgent: RuntimeAgent;
    try {
      trustedAgent = parseAgentDeclarationV1(receipt.trustedAgent);
    } catch {
      throw edgeRuntimeError(
        "schedule_agent_invalid",
        "Applied Schedule claim omitted its center-validated Agent declaration.",
      );
    }
    if (trustedAgent.id !== target.agentId)
      throw edgeRuntimeError("schedule_agent_invalid", "Applied Schedule claim Agent does not match its target.");
    trustedScheduleAgents.set(trustedAgent.id, trustedAgent);
    const dispatched = await dispatchClaimedSchedule({
      schedule: scheduleValueV1,
      idempotencyKey: operationKey,
      now,
      spawn: async (scheduled) => {
        const spawned = await spawner.spawnScheduled(scheduled, edgeBinding());
        return {
          outcome: String(spawned.outcome),
          ...(typeof spawned.dispatchId === "string" ? { dispatchId: spawned.dispatchId } : {}),
          ...(typeof spawned.runtimeSessionId === "string" ? { runtimeSessionId: spawned.runtimeSessionId } : {}),
        };
      },
      linkDispatch: ({ idempotencyKey, ...linked }) =>
        runFleetScheduleCommandClient({
          ...peer,
          repoId: request.repoId,
          scheduleId,
          opId: fleetScheduleOpId(request.repoId, request.assignmentId, idempotencyKey),
          action: { kind: "schedule-settle", phase: "dispatch-link", ...linked },
        }),
      settleFailure: ({ idempotencyKey, ...failed }) =>
        runFleetScheduleCommandClient({
          ...peer,
          repoId: request.repoId,
          scheduleId,
          opId: fleetScheduleOpId(request.repoId, request.assignmentId, idempotencyKey),
          action: { kind: "schedule-settle", phase: "outcome", ...failed },
        }),
    });
    if (dispatched.kind === "spawn-failed") throw dispatched.error;
    if (dispatched.kind === "spawn-unapplied")
      return {
        ...dispatched.receipt,
        scheduleId,
        claimFence: active.claimFence,
      };
    return {
      ...scheduleResult(actionKind, dispatched.receipt),
      dispatchId: dispatched.dispatchId,
      runtimeSessionId: dispatched.runtimeSessionId,
      claimFence: active.claimFence,
    };
  }

  async function syncScheduleMirror(): Promise<void> {
    const pulled = await runFleetReplicaPullClient({
      ...peer,
      viewRoot: request.viewRoot,
      diskQuotaBytes: request.quotaBytes,
    });
    const materialized = applyFleetMirrorCut(request.viewRoot, request.repoId, request.workspaceRoot, "pull", {
      viewId: pulled.replica.viewId,
    });
    if (materialized.outcome === "pull_blocked")
      throw edgeRuntimeError("pull_blocked", "Schedule definition was canonical but its edge mirror is blocked.");
  }
}

function requiredScheduleText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw edgeRuntimeError("invalid_field", `${field} is required.`);
}

function fleetScheduleOpId(repoId: string, assignmentId: string, key: string): string {
  return `schedule-${createHash("sha256").update(`${repoId}\0${assignmentId}\0${key}`).digest("hex").slice(0, 32)}`;
}

function scheduleResult(
  kind: unknown,
  result: Extract<import("./fleet/contract.ts").FleetFrameV1, { schema: "fleet.schedule.result/v1" }>,
): JsonObject {
  const ok = ["applied", "pending", "no_changes"].includes(result.outcome);
  return {
    schema: "command-receipt/v2",
    ok,
    command: String(kind),
    ...result.receipt,
    outcome: result.outcome,
    ...(ok ? {} : { error: { code: result.code ?? "write_rejected", hint: "Inspect the center receipt." } }),
  };
}

function edgeBinding() {
  return { actor: { principal: { personId: "fleet-edge" }, executor: null }, source: "local" as const };
}
function edgeRuntimeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
