import { runRuntimeHandoff } from "./runtime-handoff.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertTransitionDocumentReady,
  entitySlug,
  openEntityStore,
  readSettingsFacet,
  requireTransitionDocumentKind,
  resolveHarnessLayout,
  validateScheduleV1,
  type AgentRuntimeEventV1,
  type EntityStore,
  type ScheduleV1,
  type TaskWorktreeBindingV1,
  type TaskLifecycleSnapshot,
} from "@harness-anything/kernel";
import { selectReviewTarget } from "./review-dispatch-admission.ts";
import { resolveSquadDispatch } from "./agent-entities.ts";
import { parseAgentDeclarationV1 } from "@harness-anything/kernel";
import { readBundledAgentDeclaration } from "@harness-anything/preset";
import type { PreparedRuntimeLaunch, RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import {
  readFleetRepositoryMetadataClient,
  readFleetReceiptClient,
  runFleetReplicaPullClient,
  runFleetRuntimeArchiveClient,
  runFleetRuntimeEventClient,
  runFleetRuntimeReadClient,
  runFleetScheduleCommandClient,
  runFleetTaskCommandClient,
  type FleetPeerOptions,
} from "./fleet/edge.ts";
import { applyFleetMirrorCut, locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { transitionDocumentReadinessContract } from "./transition-document-access.ts";
import { validateAgentRuntimeOverview, type AgentRuntimeOverviewResult } from "./agent-runtime-contract.ts";
import { makeRuntimeSpawner, type RuntimeDaemonRoute, type RuntimeLauncher } from "./runtime-spawn.ts";
import type { RuntimeAgent } from "./runtime-spawn-types.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { dispatchClaimedSchedule } from "./schedule-action-runtime.ts";
import { prepareScheduleOccurrenceWorkspace, scheduleSettlementDetail } from "./schedule-occurrence-workspace.ts";
import { livingDeliverableProtocol, runtimeMissionName, taskQueryGuidance } from "./runtime-spawn-mission.ts";

export interface FleetEdgeRuntimeRequest {
  readonly payload: {
    readonly host: string;
    readonly port: number;
    readonly caPath: string;
    readonly servername?: string;
    readonly nodeId: string;
    readonly credential: string;
    readonly repoId: string;
    readonly viewRoot: string;
    readonly quotaBytes: number;
    readonly workspaceRoot: string;
    readonly method:
      | "repo.agentRuntime.spawn"
      | "repo.agentRuntime.cancel"
      | "repo.agentRuntime.handoff"
      | "repo.agentRuntime.overview"
      | "repo.agentRuntime.sessions.await"
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
    credential = request.credential,
    peer: FleetPeerOptions = {
      hostname: request.host,
      port: request.port,
      ca: readFileSync(request.caPath, "utf8"),
      ...(request.servername ? { servername: request.servername } : {}),
      nodeId: request.nodeId,
      credential,
      repoId: request.repoId,
    },
    runtimeReadTimeoutMs = readFleetEdgeConfig(request.workspaceRoot)?.waitTimeoutMs,
    runtimeReadPeer: FleetPeerOptions = {
      ...peer,
      ...(runtimeReadTimeoutMs === undefined ? {} : { timeoutMs: runtimeReadTimeoutMs }),
    },
    now = input.now ?? (() => new Date().toISOString()),
    stream = { publish: () => ({}) as never },
    // Every node reads the same Settings: the edge's materialized harness.yaml is the center's facet.
    readSettings = () =>
      readSettingsFacet(readFileSync(resolveHarnessLayout(request.workspaceRoot).configPath!, "utf8"));
  const executionCredentials = new Map<string, { credential: string; expiresAt: string }>();
  let entityStore: EntityStore | undefined;
  const trustedScheduleAgents = new Map<string, RuntimeAgent>();
  const getEntityStore = (): EntityStore => (entityStore ??= openEntityStore(request.workspaceRoot));
  let tail = Promise.resolve();
  const schedule = (work: () => void | Promise<void>): void => {
    tail = tail.then(work).then(
      () => undefined,
      (error: unknown) => {
        console.error("[fleet-edge-runtime] Pending runtime work failed:", error);
        // Durable dispatch streams remain the recovery source. The next supported request
        // re-enters adoption instead of treating failed initialization as permanent readiness.
        ready = null;
      },
    );
  };
  const spawner = makeRuntimeSpawner({
    repoId: request.repoId,
    rootDir: request.workspaceRoot,
    daemonGeneration: input.daemonGeneration,
    runtimeNode: { nodeId: request.nodeId },
    runtimeDaemonRoute: input.daemonRoute,
    remote: {
      executionCredential: (runtimeSessionId) => {
        const execution = executionCredentials.get(runtimeSessionId);
        if (!execution)
          throw edgeRuntimeError("execution_credential_rejected", "Center did not issue this dispatch credential.");
        executionCredentials.delete(runtimeSessionId);
        return execution;
      },
      existing: async (opId) => {
        const receipt = await readFleetReceiptClient({ ...peer, opId });
        return receipt.opId === opId && ["applied", "pending"].includes(String(receipt.outcome))
          ? (receipt as JsonObject)
          : null;
      },
      taskContext: async (taskId, missionName, review) => {
        const shown = await runFleetTaskCommandClient({
          ...peer,
          opId: `context_${Date.now()}`,
          taskId,
          repoId: request.repoId,
          action: { kind: "task-show", taskId },
          waitMs: 0,
        });
        if (shown.outcome !== "applied" || typeof shown.receipt?.evidence !== "string")
          throw edgeRuntimeError("task_read_failed", "Task context is unavailable.");
        const current = JSON.parse(shown.receipt.evidence) as TaskLifecycleSnapshot;
        const executionId = review
          ? selectReviewTarget(taskId, review.executionId, current, false)?.executionId
          : current.lease?.phase === "held"
            ? current.lease.executionId
            : undefined;
        if (!executionId) throw edgeRuntimeError("execution_missing", "The task has no current execution.");
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
        const packageRoot = path.join(materializedRoot, ...candidates[0]!.split("/")),
          planPath = path.join(packageRoot, "task_plan.md"),
          // The causal block, the task profile, and the worktree binding are assembled at the center's
          // canonical cut in this same round trip — a stale edge mirror is never summarized as fact,
          // and the edge has no projection to derive a binding from.
          { causalContext, profileId, worktree } = taskRuntimeContext(
            await runFleetRuntimeReadClient({
              ...runtimeReadPeer,
              repoId: request.repoId,
              method: "repo.tasks.runtimeContext.read",
              payload: { taskId },
            }),
            taskId,
          ),
          livingProtocol = livingDeliverableProtocol(profileId);
        let plan: string;
        try {
          plan = readFileSync(planPath, "utf8");
        } catch {
          throw edgeRuntimeError(
            "runtime_task_package_unavailable",
            `Task ${taskId} has no readable mirrored task plan; run ha daemon fleet edge sync, then retry.`,
          );
        }
        const planContract = mirroredPlanContract(packageRoot, taskId);
        assertTransitionDocumentReady(requireTransitionDocumentKind("runtime.run"), plan, planContract);
        const mission = missionName
            ? (() => {
                const name = runtimeMissionName(missionName),
                  logicalPath = `${candidates[0]!}/artifacts/missions/${name}.md`,
                  missionPath = path.join(packageRoot, "artifacts", "missions", `${name}.md`);
                if (!view.entries.has(logicalPath))
                  throw edgeRuntimeError(
                    "runtime_mission_unavailable",
                    `Task ${taskId} has no current mirrored mission at ${logicalPath}.`,
                  );
                let body: string;
                try {
                  body = readFileSync(missionPath, "utf8");
                } catch {
                  throw edgeRuntimeError(
                    "runtime_mission_unavailable",
                    `Task ${taskId} mission ${name} is unreadable; ` + "run ha daemon fleet edge sync, then retry.",
                  );
                }
                if (!body.trim())
                  throw edgeRuntimeError("runtime_mission_unavailable", `Task ${taskId} mission ${name} is empty.`);
                return body;
              })()
            : null,
          missionAfterPackage = [
            taskQueryGuidance(taskId),
            ...(livingProtocol === null ? [] : [livingProtocol]),
            ...(causalContext === null ? [] : [causalContext]),
            ...(mission ? [`# Mission: ${missionName}\n\n${mission.trim()}`] : []),
          ];
        return {
          executionId,
          ...(review
            ? {
                reviewerSubmission: current.executions.find((execution) => execution.executionId === executionId)!
                  .submission!,
              }
            : {}),
          packageRoot,
          profileId,
          mission: (reachedPackageRoot) =>
            [
              `Your task package is ${reachedPackageRoot}.\n` +
                "Read task_plan.md in that package and complete the task.",
              ...missionAfterPackage,
            ].join("\n\n"),
          causalContext,
          worktree,
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
          ...(draft.dispatchContext === undefined ? {} : { dispatchContext: draft.dispatchContext }),
        });
        const { executionCredential, executionExpiresAt, ...receipt } = response.receipt;
        if (
          typeof executionCredential === "string" &&
          typeof executionExpiresAt === "string" &&
          typeof draft.payload.runtimeSessionId === "string"
        )
          executionCredentials.set(draft.payload.runtimeSessionId, {
            credential: executionCredential,
            expiresAt: executionExpiresAt,
          });
        return { event: response.event as unknown as AgentRuntimeEventV1, receipt: receipt as JsonObject };
      },
      archive: async (archive) =>
        (await runFleetRuntimeArchiveClient({
          ...peer,
          repoId: request.repoId,
          archive: archive as unknown as Readonly<Record<string, unknown>>,
        })) as { readonly outcome: string },
    },
    stream,
    now,
    readSettings,
    runtimeInstances: input.ports.runtimeInstances,
    prepareLaunch: input.ports.prepareRuntimeLaunch,
    prepareWorkerGitEnvironment: input.ports.prepareWorkerGitEnvironment,
    resolveAgent: (agentId) => trustedScheduleAgents.get(agentId) ?? mirroredAgentDeclaration(request, agentId),
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
      const scheduled = terminal.schedule;
      if (!scheduled) return;
      const detail = await scheduleSettlementDetail(
        request.workspaceRoot,
        scheduled,
        terminal.resultRef ?? terminal.reason,
      );
      const response = await runFleetScheduleCommandClient({
        ...peer,
        repoId: request.repoId,
        scheduleId: scheduled.scheduleId,
        opId: `${terminal.runtimeSessionId}-schedule-attempt-terminal`,
        action: {
          kind: "schedule-settle",
          scheduleId: scheduled.scheduleId,
          claimFence: scheduled.claimFence,
          outcome: terminal.outcome,
          endedAt: terminal.endedAt,
          ...(detail ? { detail } : {}),
        },
      });
      if (response.outcome !== "applied")
        throw edgeRuntimeError("schedule_settlement_pending", `Center Schedule settlement was ${response.outcome}.`);
    },
    ...(input.launch ? { launch: input.launch } : {}),
    schedule,
  });
  // Adoption is shared by concurrent requests, but a failed connection must not become a
  // permanent property of the cached edge runtime.  The daemon keeps one runtime per
  // node, so retain the instance and discard only the rejected readiness attempt;
  // the next request can then observe a recovered center and adopt again.
  let ready: Promise<void> | null = null;
  const ensureReady = (): Promise<void> => {
    if (ready === null) {
      const attempt = spawner.adopt();
      ready = attempt.catch((error: unknown) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  };
  return {
    run: async (
      method: FleetEdgeRuntimeRequest["payload"]["method"],
      action: JsonObject,
      connectionSignal?: AbortSignal,
    ): Promise<JsonObject> => {
      await ensureReady();
      if (method === "repo.schedule.run") return runSchedule(action);
      if (method === "repo.agentRuntime.handoff")
        return runRuntimeHandoff({
          rootDir: request.workspaceRoot,
          payload: action,
          command: async (command, body) => {
            const result = await runFleetTaskCommandClient({
              ...peer,
              repoId: request.repoId,
              taskId: null,
              opId: `handoff_${Date.now()}`,
              waitMs: 0,
              action: command as { kind: string },
              ...(body ? { privatePayload: body } : {}),
            });
            return result.receipt as JsonObject;
          },
          spawn: (checkpoint, spawn, rollout) =>
            spawner.spawnHandoff(checkpoint, spawn, edgeBinding(request), null, rollout),
        });
      return method === "repo.agentRuntime.spawn"
        ? spawner.spawn(action, edgeBinding(request))
        : method === "repo.agentRuntime.cancel"
          ? spawner.cancel(action, edgeBinding(request))
          : ((await runFleetRuntimeReadClient({
              ...runtimeReadPeer,
              repoId: request.repoId,
              method,
              payload: action,
              connectionSignal,
            })) as JsonObject);
    },
    close: () => {
      spawner.close();
    },
  };

  async function runSchedule(action: JsonObject): Promise<JsonObject> {
    const actionKind = requiredScheduleText(action.kind, "kind"),
      assigned = await readFleetRepositoryMetadataClient(peer),
      scheduleId = typeof action.scheduleId === "string" ? action.scheduleId : request.repoId;
    const operationKey =
        typeof action.idempotencyKey === "string" && action.idempotencyKey
          ? action.idempotencyKey
          : `${actionKind}:${scheduleId}:${Date.now().toString(36)}`,
      command = await runFleetScheduleCommandClient({
        ...peer,
        repoId: request.repoId,
        scheduleId,
        opId: fleetScheduleOpId(request.repoId, request.nodeId, operationKey),
        writerEpoch: assigned.writerEpoch,
        action: { ...action, kind: actionKind, scheduleId },
      });
    if (command.outcome !== "applied") return scheduleResult(actionKind, command);
    const receipt = command.receipt as JsonObject;
    if (["schedule-list", "schedule-reckon", "schedule-runs", "schedule-show"].includes(actionKind))
      return scheduleResult(actionKind, command);
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
    if (!active || active.nodeId !== request.nodeId || typeof active.claimFence !== "string" || target.kind !== "agent")
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
      workspace: await prepareScheduleOccurrenceWorkspace(
        request.workspaceRoot,
        scheduleValueV1,
        () => readSettings().worktree.setup,
      ),
      idempotencyKey: operationKey,
      now,
      spawn: async (scheduled) => {
        const spawned = await spawner.spawnScheduled(scheduled, edgeBinding(request));
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
          opId: fleetScheduleOpId(request.repoId, request.nodeId, idempotencyKey),
          action: { kind: "schedule-dispatch-link", ...linked },
        }),
      settleFailure: ({ idempotencyKey, ...failed }) =>
        runFleetScheduleCommandClient({
          ...peer,
          repoId: request.repoId,
          scheduleId,
          opId: fleetScheduleOpId(request.repoId, request.nodeId, idempotencyKey),
          action: { kind: "schedule-settle", ...failed },
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

// The wire result crossed a process boundary, so the edge re-judges the served
// shape rather than trusting the peer's word — same posture as the paged
// runtime overview reads.
function taskRuntimeContext(
  read: Readonly<Record<string, unknown>>,
  taskId: string,
): {
  readonly causalContext: string | null;
  readonly profileId: string | null;
  readonly worktree: TaskWorktreeBindingV1 | null;
} {
  const worktree = read.worktree as { readonly branch?: unknown; readonly path?: unknown } | null | undefined;
  if (
    read.schema === "task-runtime-context-read/v1" &&
    read.ok === true &&
    read.taskId === taskId &&
    (read.causalContext === null || typeof read.causalContext === "string") &&
    (read.profileId === null || typeof read.profileId === "string") &&
    (worktree === null ||
      (typeof worktree === "object" && typeof worktree.branch === "string" && typeof worktree.path === "string"))
  )
    return {
      causalContext: read.causalContext,
      profileId: read.profileId === null ? null : (read.profileId as string),
      worktree: worktree ? { branch: worktree.branch as string, path: worktree.path as string } : null,
    };
  throw edgeRuntimeError("runtime_read_invalid", `Center returned an invalid runtime context read for task ${taskId}.`);
}

/**
 * An edge holds no ledger of its own: the agents installed at the center reach it as the documents of its
 * mirrored view, under the same bundled layer every node ships.
 */
function mirroredAgentDeclaration(
  request: Pick<FleetEdgeRuntimeRequest["payload"], "viewRoot" | "repoId" | "workspaceRoot">,
  agentId: string,
): RuntimeAgent {
  const logical = `agents/${agentId}.json`;
  if (entitySlug(agentId) && locateFleetMirrorView(request.viewRoot, request.repoId)?.entries.has(logical))
    return parseAgentDeclarationV1(
      JSON.parse(readFileSync(path.join(resolveHarnessLayout(request.workspaceRoot).authoredRoot, logical), "utf8")),
    );
  const bundled = readBundledAgentDeclaration(agentId);
  if (bundled) return bundled;
  throw edgeRuntimeError(
    "agent_not_found",
    `${agentId} is neither in this node's mirrored view nor a bundled agent; ` +
      "run ha daemon fleet edge sync, then retry.",
  );
}

function requiredScheduleText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw edgeRuntimeError("invalid_field", `${field} is required.`);
}

function fleetScheduleOpId(repoId: string, nodeId: string, key: string): string {
  return `schedule-${createHash("sha256").update(`${repoId}\0${nodeId}\0${key}`).digest("hex").slice(0, 32)}`;
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

function edgeBinding(request: Pick<FleetEdgeRuntimeRequest["payload"], "nodeId">) {
  return {
    actor: { principal: { personId: "fleet-edge" }, executor: null },
    source: { kind: "node" as const, nodeId: request.nodeId },
  };
}
/**
 * The mirrored task contract carries the plan's readiness contract in its descriptor; packages
 * materialized before descriptors carried it resolve through the bundled catalog their
 * templateRef names. An unresolvable contract fails closed here.
 */
function mirroredPlanContract(packageRoot: string, taskId: string) {
  let contractJson: unknown;
  try {
    contractJson = JSON.parse(readFileSync(path.join(packageRoot, "task-contract.json"), "utf8"));
  } catch {
    throw edgeRuntimeError(
      "runtime_task_package_unavailable",
      `Task ${taskId} has no readable mirrored task contract; run ha daemon fleet edge sync, then retry.`,
    );
  }
  const descriptor =
      contractJson && typeof contractJson === "object" && !Array.isArray(contractJson)
        ? (contractJson as { readonly documents?: unknown }).documents
        : undefined,
    planDescriptor = Array.isArray(descriptor)
      ? descriptor.find(
          (row): row is { readonly slot: string; readonly path: string } =>
            !!row &&
            typeof row === "object" &&
            (row as { readonly slot?: unknown }).slot === "task.plan" &&
            typeof (row as { readonly path?: unknown }).path === "string",
        )
      : undefined,
    contract = planDescriptor
      ? transitionDocumentReadinessContract({ contract: contractJson, descriptor: planDescriptor })
      : null;
  if (contract === null)
    throw edgeRuntimeError(
      "runtime_task_package_unavailable",
      `Task ${taskId} plan scaffold is not resolvable from the mirrored package; run ha daemon fleet edge sync, then retry.`,
    );
  return contract;
}

function edgeRuntimeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
