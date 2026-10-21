import { fleetMirrorTaskPaths } from "./fleet-edge-mirror.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { requiredCellText } from "./repo-cell-settlement.ts";
import { operationId } from "./repo-cell-proof.ts";
import { canStartExecution, type RepositorySettingsV1, type TaskProjection } from "@harness-anything/kernel";
import { readEdgeRuntimeRepository } from "./fleet-edge-runtime-read.ts";
import { repositoryReadData } from "./protocol/repository-read-frame.ts";
import { withEdgeReadModel } from "./fleet-edge-task-read.ts";
import { makeFleetSquadCoordinator } from "./fleet-squad-coordinator.ts";
import { readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { readEdgeViewBlob, readEdgeRuntimeResult } from "./runtime-result-read.ts";
import { runRuntimeHandoff } from "./runtime-handoff.ts";
import { recordRuntimeExecutionPrincipal } from "./runtime-execution-principal-store.ts";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assertTransitionDocumentReady,
  entitySlug,
  readSettingsFacet,
  requireTransitionDocumentKind,
  resolveHarnessLayout,
  validateScheduleV1,
  type AgentRuntimeEventV1,
  type ScheduleV1,
  type TaskWorktreeBindingV1,
} from "@harness-anything/kernel";
import { selectReviewTarget } from "./review-dispatch-admission.ts";
import { resolveSquadDispatch } from "./agent-entities.ts";
import { parseAgentDeclarationV1 } from "@harness-anything/kernel";
import { readBundledAgentDeclaration } from "@harness-anything/preset";
import type { PreparedRuntimeLaunch, RuntimeInstanceSummary, RuntimeLaunchRequest } from "./agent-runtime-instances.ts";
import {
  readFleetRepositoryMetadataClient,
  runFleetEdgeRuntimeArchiveClient,
  runFleetRuntimeEventClient,
  readFleetOperationalClient,
  runFleetScheduleCommandClient,
  runFleetTaskCommandClient,
  type FleetPeerOptions,
} from "./fleet-edge-write.ts";
import { applyFleetMirrorCut, locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { transitionDocumentReadinessContract } from "./transition-document-access.ts";
import { validateAgentRuntimeOverview, type AgentRuntimeOverviewResult } from "./agent-runtime-contract.ts";
import { makeRuntimeSpawner, type RuntimeDaemonRoute, type RuntimeLauncher } from "./runtime-spawn.ts";
import type { RuntimeAgent } from "./runtime-spawn-types.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { readReplicaGeneration } from "./fleet/replica-generation.ts";
import { runFleetEdgeWrite, transientFleetReceipt } from "./fleet-edge-write.ts";
import { readScheduleAction, dispatchClaimedSchedule } from "./schedule-action-runtime.ts";
import { prepareScheduleOccurrenceWorkspace, scheduleSettlementDetail } from "./schedule-occurrence-workspace.ts";
import { taskMissionSections, taskPlanSection, runtimeMissionName } from "./runtime-spawn-mission.ts";

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
      | "repo.agentRuntime.steer"
      | "repo.agentRuntime.handoff"
      | "repo.agentRuntime.overview"
      | "repo.agentRuntime.sessions.await"
      | "repo.agentRuntime.sessions.read"
      | "repo.schedule.run"
      | "repo.squad.control";
    readonly action: JsonObject;
  };
}
type RuntimePorts = {
  readonly runtimeInstances: () => readonly RuntimeInstanceSummary[];
  readonly prepareRuntimeLaunch: (instanceId: string, request: RuntimeLaunchRequest) => Promise<PreparedRuntimeLaunch>;
  readonly reclaimRuntimeTempDirectory: (instanceId: string, runtimeSessionId: string) => Error | null;
  readonly reclaimSettledRuntimeTempDirectories: (
    settledRuntimeSessionIds: readonly string[],
  ) => { readonly instanceId: string; readonly runtimeSessionId: string; readonly error: Error }[];
  readonly prepareDaemonGitEnvironment: (
    instanceId: string,
    provider?: "github" | "gitlab",
  ) => Promise<NodeJS.ProcessEnv | null>;
};
const runtimeOverviewPageLimit = 16;

export async function readFleetRuntimeSessionsPaged(readPage: (payload: JsonObject) => Promise<unknown>): Promise<
  readonly {
    readonly runtimeSessionId: string;
    readonly providerSessionId: string | null;
    readonly instanceId: string;
    readonly liveness: "live" | "stale" | "unknown" | "exited";
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | null;
  }[]
> {
  const sessions: Array<{
    readonly runtimeSessionId: string;
    readonly providerSessionId: string | null;
    readonly instanceId: string;
    readonly liveness: "live" | "stale" | "unknown" | "exited";
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | null;
  }> = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await readPage({ limit: runtimeOverviewPageLimit, ...(cursor === null ? {} : { cursor }) });
    const issues = validateAgentRuntimeOverview(repositoryReadData(result));
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

export function createFleetEdgeRuntimeWorkQueue(onError: (error: unknown) => void) {
  let tail = Promise.resolve(),
    closed = false;
  const schedule = (work: () => void | Promise<void>): Promise<void> => {
    const scheduled = tail.then(() => {
      if (closed) return;
      return work();
    });
    tail = scheduled.then(
      () => undefined,
      (error: unknown) => onError(error),
    );
    return scheduled;
  };
  return {
    schedule,
    close: () => {
      closed = true;
    },
  };
}

export function openFleetEdgeRuntime(input: {
  readonly request: FleetEdgeRuntimeRequest["payload"];
  readonly readBinding: () => Promise<import("./repo-cell-types.ts").RepoCellBinding>;
  readonly daemonGeneration: number;
  readonly daemonRoute: RuntimeDaemonRoute;
  readonly ports: RuntimePorts;
  /** Waits for an in-flight resident stream to publish its first readable generation. */
  readonly waitForReplicaReady?: (signal?: AbortSignal) => Promise<boolean>;
  readonly launch?: RuntimeLauncher;
  readonly now?: () => string;
}) {
  // Provider signals already remain in the edge-local dispatch JSONL, while remote status
  // polls the canonical session read below. Forwarding stream frames would create a second,
  // non-canonical synchronization surface with no consumer or settlement contract.
  const request = input.request,
    credential = request.credential,
    peer: FleetPeerOptions = {
      readAccessToken: async () => {
        const session = (await input.readBinding()).keycloakAuthorization?.session;
        return session?.currentAccessToken ? session.currentAccessToken() : session?.accessToken;
      },
      hostname: request.host,
      port: request.port,
      ca: readFileSync(request.caPath, "utf8"),
      ...(request.servername ? { servername: request.servername } : {}),
      nodeId: request.nodeId,
      credential,
      repoId: request.repoId,
      ...(readFleetEdgeConfig(request.workspaceRoot)?.humanClientId
        ? { humanClientId: readFleetEdgeConfig(request.workspaceRoot)!.humanClientId }
        : {}),
    },
    runtimeReadTimeoutMs = readFleetEdgeConfig(request.workspaceRoot)?.waitTimeoutMs,
    runtimeReadPeer: FleetPeerOptions = {
      ...peer,
      ...(runtimeReadTimeoutMs === undefined ? {} : { timeoutMs: runtimeReadTimeoutMs }),
    },
    // A mutating center round trip settles when the single-writer queue applies the operation,
    // not within a read's transport bound: git materialization, durable state writes, or a
    // latched cell's recovery can each hold the reply past any flat deadline. Write sessions
    // carry the edge's configured center wait budget plus the transport margin the
    // task-command client already applies (waitMs + 10s); inheriting the 5s read default
    // turned every legitimately slow write into "Fleet response timeout".
    centerWriteWaitMs = runtimeReadTimeoutMs ?? 30_000,
    writePeer: FleetPeerOptions = { ...peer, timeoutMs: centerWriteWaitMs + 10_000 },
    now = input.now ?? (() => new Date().toISOString()),
    stream = { publish: () => ({}) as never },
    // Repository settings follow the authorized replica cut, including before workspace materialization.
    readSettings = () =>
      withEdgeReadModel({ ...request, principalId: replicaOwner }, (projection) => ({
        ...readSettingsFacet(readFileSync(resolveHarnessLayout(request.workspaceRoot).configPath!, "utf8")),
        ...(projection.getEntity("settings", "repository")!.value as RepositorySettingsV1),
      }));
  let replicaOwner: string | undefined;
  const readReplica = async (method: Parameters<typeof readEdgeRuntimeRepository>[1], payload: JsonObject) =>
    readEdgeRuntimeRepository(
      { ...request, principalId: (await input.readBinding()).actor.principal.personId },
      method,
      payload,
    );
  const executionCredentials = new Map<string, { credential: string; expiresAt: string; personId: string }>();
  const trustedScheduleAgents = new Map<string, RuntimeAgent>();
  const workQueue = createFleetEdgeRuntimeWorkQueue((error) => {
    console.error("[fleet-edge-runtime] Pending runtime work failed:", error);
    // Durable dispatch streams remain the recovery source. The next supported request
    // re-enters adoption instead of treating failed initialization as permanent readiness.
    ready = null;
  });
  const schedule = workQueue.schedule;
  const runScheduleCommand: typeof runFleetScheduleCommandClient = async (options) => {
    return runFleetEdgeWrite({
      viewRoot: request.viewRoot,
      repoId: request.repoId,
      nodeId: request.nodeId,
      timeoutMs: centerWriteWaitMs,
      write: () => runFleetScheduleCommandClient(options),
    });
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
        recordRuntimeExecutionPrincipal(
          request.workspaceRoot,
          request.repoId,
          runtimeSessionId,
          execution.credential,
          execution.personId,
          execution.expiresAt,
        );
        return { credential: execution.credential, expiresAt: execution.expiresAt };
      },
      taskContext: async (taskId, missionName, review) => {
        // Pull only in write preparation; repository values themselves use the shared local query.
        await pullRuntimeReplica();
        let runtimeContext = taskRuntimeContext(
          await readReplica("repo.tasks.runtimeContext.read", { taskId }),
          taskId,
        );
        let current = runtimeContext.snapshot;
        if (!current.task) throw edgeRuntimeError("task_read_failed", "Task context is unavailable.");
        let executionId = review
          ? selectReviewTarget(taskId, review.executionId, current, false)?.executionId
          : current.lease?.phase === "held"
            ? current.lease.executionId
            : undefined;
        const taskStartExecutionId = "runtime-task-start-" + taskId;
        if (!executionId && !review && canStartExecution(current, taskStartExecutionId)) {
          const taskStartOpId = randomUUID();
          const started = await runFleetEdgeWrite({
            viewRoot: request.viewRoot,
            repoId: request.repoId,
            nodeId: request.nodeId,
            timeoutMs: centerWriteWaitMs,
            write: () =>
              runFleetTaskCommandClient({
                ...writePeer,
                repoId: request.repoId,
                taskId,
                opId: taskStartOpId,
                action: { kind: "task-start", taskId },
                waitMs: centerWriteWaitMs,
                timeoutMs: centerWriteWaitMs + 10_000,
              }),
          });
          if (started.outcome !== "applied")
            throw edgeRuntimeError(
              started.code ?? "task_start_rejected",
              `The center could not start task ${taskId}: ${String(started.code ?? started.outcome)}.`,
            );
          await pullRuntimeReplica();
          runtimeContext = taskRuntimeContext(await readReplica("repo.tasks.runtimeContext.read", { taskId }), taskId);
          current = runtimeContext.snapshot;
          executionId = current.lease?.phase === "held" ? current.lease.executionId : undefined;
        }
        if (!executionId) throw edgeRuntimeError("execution_missing", "The task has no current execution.");
        const view = locateFleetMirrorView(request.viewRoot, request.repoId, request.nodeId, {
          entriesPrefix: `tasks/${taskId}`,
        });
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
            : fleetMirrorTaskPaths(view, taskId)
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
          // Causal context, risk tier, profile and worktree binding share the just-confirmed replica cut.
          // Authored task files remain the explicitly synchronized local workspace.
          { causalContext, riskTier, profileId, worktree } = runtimeContext;
        let plan: string;
        try {
          plan = readFileSync(planPath, "utf8");
        } catch {
          throw edgeRuntimeError(
            "runtime_task_package_unavailable",
            `Task ${taskId} has no readable mirrored task plan; run ha daemon fleet edge sync, then retry.`,
          );
        }
        const { planContract } = mirroredPlanContract(packageRoot, taskId);
        assertTransitionDocumentReady(requireTransitionDocumentKind("runtime.run"), plan, planContract);
        // A re-dispatched worker answers the latest owner return: the mirrored managed
        // `returns/iteration-N.md` of iteration N rides verbatim in the mission and in the
        // remote task context, exactly like the local projection paths inject it.
        const priorIteration = current.task && current.task.iteration > 0 ? current.task.iteration - 1 : null,
          ownerReturnBody =
            priorIteration === null
              ? null
              : (() => {
                  const logicalPath = `${candidates[0]!}/returns/iteration-${String(priorIteration)}.md`;
                  if (!view.entries.has(logicalPath)) return null;
                  let body: string;
                  try {
                    body = readFileSync(
                      path.join(packageRoot, "returns", `iteration-${String(priorIteration)}.md`),
                      "utf8",
                    );
                  } catch {
                    throw edgeRuntimeError(
                      "runtime_task_package_unavailable",
                      `Task ${taskId} has an unreadable mirrored owner return at ${logicalPath}; ` +
                        "run ha daemon fleet edge sync, then retry.",
                    );
                  }
                  return body.trim() ? body.trim() : null;
                })();
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
            ...taskMissionSections(
              taskId,
              causalContext,
              riskTier,
              current.task?.taskClass,
              ownerReturnBody,
              review !== undefined,
            ),
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
          riskTier,
          profileId,
          taskClass: current.task!.taskClass,
          ownerReturnBody,
          planBody: plan,
          mission: (reachedPackageRoot) =>
            [taskPlanSection(plan, reachedPackageRoot), ...missionAfterPackage].join("\n\n"),
          causalContext,
          worktree,
        };
      },
      readRuntimeSessions: () =>
        readFleetRuntimeSessionsPaged(async (payload) => readReplica("repo.agentRuntime.overview", payload)),
      publish: async (draft) => {
        let response: Awaited<ReturnType<typeof runFleetRuntimeEventClient>>;
        try {
          response = await runFleetEdgeWrite({
            viewRoot: request.viewRoot,
            repoId: request.repoId,
            nodeId: request.nodeId,
            timeoutMs: centerWriteWaitMs,
            write: () =>
              runFleetRuntimeEventClient({
                ...writePeer,
                repoId: request.repoId,
                opId: draft.opId,
                eventType: draft.type,
                payload: draft.payload,
                ...(draft.resultBody === undefined ? {} : { resultBody: draft.resultBody }),
                ...(draft.dispatchContext === undefined ? {} : { dispatchContext: draft.dispatchContext }),
              }),
          });
        } catch (error) {
          if (
            draft.type !== "runtime_session_started" &&
            error instanceof Error &&
            "code" in error &&
            error.code === "runtime_session_transition_invalid"
          ) {
            console.warn("[fleet-edge-runtime] Discarded stale RuntimeSession transition:", error.message);
            return { event: null, receipt: { outcome: "no_changes", code: "no_changes" } };
          }
          throw error;
        }
        // A returned dispatch is immediately usable by local status/foreground wait. This
        // acknowledgement belongs to write preparation; subsequent reads remain offline.
        if (draft.type === "runtime_session_started") await pullRuntimeReplica();
        const { executionCredential, executionExpiresAt, executionPrincipalId, ...receipt } = response.receipt;
        if (
          typeof executionCredential === "string" &&
          typeof executionExpiresAt === "string" &&
          typeof executionPrincipalId === "string" &&
          typeof draft.payload.runtimeSessionId === "string"
        )
          executionCredentials.set(draft.payload.runtimeSessionId, {
            credential: executionCredential,
            expiresAt: executionExpiresAt,
            personId: executionPrincipalId,
          });
        return {
          event: response.event as unknown as AgentRuntimeEventV1 | null,
          receipt: {
            ...receipt,
            ...(typeof executionPrincipalId === "string" ? { executionPrincipalId } : {}),
          } as JsonObject,
        };
      },
      archive: async (archive) => {
        const response = await runFleetEdgeWrite({
          viewRoot: request.viewRoot,
          repoId: request.repoId,
          nodeId: request.nodeId,
          timeoutMs: centerWriteWaitMs,
          write: () =>
            runFleetEdgeRuntimeArchiveClient({
              ...writePeer,
              repoId: request.repoId,
              archive: archive as unknown as Readonly<Record<string, unknown>>,
            }),
        });
        return response.receipt as { readonly outcome: string };
      },
    },
    stream,
    now,
    readSettings,
    runtimeInstances: input.ports.runtimeInstances,
    prepareLaunch: input.ports.prepareRuntimeLaunch,
    reclaimRuntimeTempDirectory: input.ports.reclaimRuntimeTempDirectory,
    reclaimSettledRuntimeTempDirectories: input.ports.reclaimSettledRuntimeTempDirectories,
    prepareDaemonGitEnvironment: input.ports.prepareDaemonGitEnvironment,
    resolveAgent: (agentId) => trustedScheduleAgents.get(agentId) ?? mirroredAgentDeclaration(request, agentId),
    resolveSquadDispatch: (squadId, leaderId, workerId, binding) =>
      withEdgeReadModel(
        {
          viewRoot: request.viewRoot,
          repoId: request.repoId,
          nodeId: request.nodeId,
          principalId: binding.actor.principal.personId,
        },
        (projection) =>
          resolveSquadDispatch({
            rootDir: request.workspaceRoot,
            ...(squadId ? { squadId } : {}),
            leaderId,
            ...(workerId ? { workerId } : {}),
            entityStore: {
              get: (kind, id) => projection.getEntity(kind, id),
              list: (kind) => projection.listEntities(kind),
            },
          }),
      ),
    onAttemptTerminal: async (terminal) => {
      if (terminal.task) {
        const { taskId, executionId } = terminal.task,
          settled = await runFleetEdgeWrite({
            viewRoot: request.viewRoot,
            repoId: request.repoId,
            nodeId: request.nodeId,
            timeoutMs: centerWriteWaitMs,
            write: () =>
              runFleetTaskCommandClient({
                ...writePeer,
                repoId: request.repoId,
                taskId,
                opId: `runtime-terminal-${terminal.runtimeSessionId}`,
                waitMs: centerWriteWaitMs,
                action: {
                  kind: "task-release",
                  taskId,
                  terminalExecutionId: executionId,
                  terminalRuntimeSessionId: terminal.runtimeSessionId,
                  reason: `Runtime session ${terminal.runtimeSessionId} reached a terminal dispatch state.`,
                },
              }),
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
      await squad.reconcile();
      const scheduled = terminal.schedule;
      if (!scheduled) return;
      const linked = await runScheduleCommand({
        ...writePeer,
        repoId: request.repoId,
        scheduleId: scheduled.scheduleId,
        opId: `${terminal.runtimeSessionId}-schedule-terminal-link`,
        action: {
          kind: "schedule-dispatch-link",
          scheduleId: scheduled.scheduleId,
          claimFence: scheduled.claimFence,
          dispatchId: terminal.dispatchId,
          runtimeSessionId: terminal.runtimeSessionId,
        },
      });
      if (linked.outcome !== "applied")
        throw edgeRuntimeError(
          "schedule_settlement_pending",
          `Center Schedule terminal link was ${linked.outcome}.`,
          transientFleetReceipt(linked),
        );
      const detail = await scheduleSettlementDetail(request.workspaceRoot, scheduled, terminal.reason);
      const response = await runScheduleCommand({
        ...writePeer,
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
        throw edgeRuntimeError(
          "schedule_settlement_pending",
          `Center Schedule settlement was ${response.outcome}.`,
          transientFleetReceipt(response),
        );
    },
    ...(input.launch ? { launch: input.launch } : {}),
    schedule,
  });
  const squad = makeFleetSquadCoordinator({
    request,
    peer: writePeer,
    spawner,
    controlBinding: input.readBinding,
    sync: async () => {
      await pullRuntimeReplica();
    },
    prepareWorkspace: prepareRuntimeWorkspace,
    readWorktreeSetup: () => readSettings().worktree,
    readResult: (ref) => readEdgeRuntimeResult(request.viewRoot, request.repoId, request.nodeId, ref),
  });
  // Adoption is shared by concurrent requests, but a failed connection must not become a
  // permanent property of the cached edge runtime.  The daemon keeps one runtime per
  // node, so retain the instance and discard only the rejected readiness attempt;
  // the next request can then observe a recovered center and adopt again.
  let ready: Promise<void> | null = null;
  const ensureReady = (): Promise<void> => {
    if (ready === null) {
      // adopt() runs with the temp-directory sweep enabled: a readiness attempt only ever
      // runs after the previous one rejected, and a spawn that passed a rejected attempt
      // threw before prepareLaunch — so no launch is mid-flight while the sweep runs.
      const attempt = pullRuntimeReplica()
        .then(() => spawner.adopt())
        .then(() => squad.reconcile());
      ready = attempt.catch((error: unknown) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  };
  return {
    reconcile: () =>
      schedule(async () => {
        if (readDispatchStreamHeaders(request.workspaceRoot).length === 0) return;
        await ensureReady();
        await squad.flushPublications();
        await pullRuntimeReplica();
      }),
    run: async (
      method: FleetEdgeRuntimeRequest["payload"]["method"],
      action: JsonObject,
      connectionSignal?: AbortSignal,
    ): Promise<JsonObject> => {
      if (method === "repo.agentRuntime.overview" || method === "repo.agentRuntime.sessions.read")
        return readReplica(method, action);
      if (method === "repo.schedule.run" && action.kind === "runtime-session-read") {
        if (typeof action.runtimeSessionId !== "string" || !action.runtimeSessionId)
          throw edgeRuntimeError("runtime_read_invalid", "Schedule runtime read requires a session id.");
        return readReplica("repo.agentRuntime.sessions.read", { runtimeSessionId: action.runtimeSessionId });
      }
      const readBinding = await input.readBinding();
      if (
        method === "repo.schedule.run" &&
        ["schedule-list", "schedule-show", "schedule-runs", "schedule-reckon"].includes(String(action.kind))
      )
        return withEdgeReadModel(
          { ...request, principalId: readBinding.actor.principal.personId },
          (projection, frame, view) =>
            ({
              ...readScheduleAction(
                {
                  rootDir: request.workspaceRoot,
                  projection: projection as TaskProjection,
                  now,
                  input: { repoId: request.repoId },
                  operationId,
                  requiredCellText,
                  cellCodedError,
                  store: { readContentBlob: (sha256) => readEdgeViewBlob(view, sha256) },
                },
                action as { kind: string },
                readBinding,
              ),
              ...frame,
            }) as unknown as JsonObject,
        );
      // Local termination cannot wait for adoption's canonical publications.
      if (method === "repo.squad.control" && action.kind === "squad-cancel") return squad.run(action);
      if (method === "repo.agentRuntime.cancel") return spawner.cancel(action, await input.readBinding());
      if (method === "repo.agentRuntime.steer") return spawner.steer(action, await input.readBinding());
      if (method === "repo.agentRuntime.spawn" && typeof action.taskId === "string")
        await prepareRuntimeWorkspace(action.taskId);
      await ensureReady();
      await squad.flushPublications();
      if (method === "repo.squad.control") return squad.run(action);
      if (method === "repo.schedule.run") return runSchedule(action);
      if (method === "repo.agentRuntime.handoff")
        return runRuntimeHandoff({
          rootDir: request.workspaceRoot,
          payload: action,
          command: async (command, body) => {
            const result = await runFleetEdgeWrite({
              viewRoot: request.viewRoot,
              repoId: request.repoId,
              nodeId: request.nodeId,
              timeoutMs: centerWriteWaitMs,
              write: () =>
                runFleetTaskCommandClient({
                  ...writePeer,
                  repoId: request.repoId,
                  taskId: null,
                  opId: `handoff_${Date.now()}`,
                  waitMs: centerWriteWaitMs,
                  action: command as { kind: string },
                  ...(body ? { privatePayload: body } : {}),
                }),
            });
            return result.receipt as JsonObject;
          },
          spawn: async (checkpoint, spawn, rollout) =>
            spawner.spawnHandoff(checkpoint, spawn, await input.readBinding(), null, rollout),
        });
      return method === "repo.agentRuntime.spawn"
        ? spawner.spawn(action, await input.readBinding())
        : ((await readFleetOperationalClient({
            ...runtimeReadPeer,
            repoId: request.repoId,
            method,
            payload: action,
            connectionSignal,
          })) as JsonObject);
    },
    close: () => {
      workQueue.close();
      spawner.close();
    },
  };

  async function runSchedule(action: JsonObject): Promise<JsonObject> {
    const actionKind = requiredScheduleText(action.kind, "kind"),
      assigned = await readFleetRepositoryMetadataClient(writePeer),
      scheduleId = typeof action.scheduleId === "string" ? action.scheduleId : request.repoId;
    const operationKey =
        typeof action.idempotencyKey === "string" && action.idempotencyKey
          ? action.idempotencyKey
          : `${actionKind}:${scheduleId}:${Date.now().toString(36)}`,
      command = await runScheduleCommand({
        ...writePeer,
        repoId: request.repoId,
        scheduleId,
        opId: fleetScheduleOpId(request.repoId, request.nodeId, operationKey),
        writerEpoch: assigned.writerEpoch,
        action: { ...action, kind: actionKind, scheduleId },
      });
    if (command.outcome !== "applied") return scheduleResult(actionKind, command);
    const receipt = command.receipt as JsonObject;
    if (actionKind !== "schedule-run-now") {
      await prepareRuntimeWorkspace();
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
        () => readSettings().worktree,
      ),
      idempotencyKey: operationKey,
      now,
      spawn: async (scheduled) => {
        const spawned = await spawner.spawnScheduled(scheduled, await input.readBinding());
        return {
          outcome: String(spawned.outcome),
          ...(typeof spawned.dispatchId === "string" ? { dispatchId: spawned.dispatchId } : {}),
          ...(typeof spawned.runtimeSessionId === "string" ? { runtimeSessionId: spawned.runtimeSessionId } : {}),
        };
      },
      linkDispatch: ({ idempotencyKey, ...linked }) =>
        runScheduleCommand({
          ...writePeer,
          repoId: request.repoId,
          scheduleId,
          opId: fleetScheduleOpId(request.repoId, request.nodeId, idempotencyKey),
          action: { kind: "schedule-dispatch-link", ...linked },
        }),
      settleFailure: ({ idempotencyKey, ...failed }) =>
        runScheduleCommand({
          ...writePeer,
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

  async function pullRuntimeReplica() {
    let generation = readReplicaGeneration(
      path.join(request.viewRoot, "repos", request.repoId, "views", request.nodeId),
    );
    if (!generation && input.waitForReplicaReady && (await input.waitForReplicaReady()))
      generation = readReplicaGeneration(path.join(request.viewRoot, "repos", request.repoId, "views", request.nodeId));
    if (!generation) throw edgeRuntimeError("replica_unavailable", "The edge replica has not been initialized.");
    const pulled = { replica: { viewId: request.nodeId, knownHead: generation.metadata.position } };
    replicaOwner = (await input.readBinding()).actor.principal.personId;
    return pulled;
  }

  async function prepareRuntimeWorkspace(taskId?: string): Promise<void> {
    const pulled = await pullRuntimeReplica();
    if (taskId !== undefined) {
      const view = locateFleetMirrorView(request.viewRoot, request.repoId, request.nodeId, {
        entriesPrefix: `tasks/${taskId}`,
      });
      const materializedRoot = resolveHarnessLayout(request.workspaceRoot).authoredRoot;
      const packagePresent =
        view !== null &&
        fleetMirrorTaskPaths(view, taskId)
          .filter((logical) => logical.endsWith("/INDEX.md"))
          .some((logical) =>
            existsSync(path.join(materializedRoot, ...logical.slice(0, -"/INDEX.md".length).split("/"))),
          );
      if (packagePresent) return;
    }
    const materialized = applyFleetMirrorCut(request.viewRoot, request.repoId, request.workspaceRoot, "pull", {
      viewId: pulled.replica.viewId,
    });
    if (materialized.outcome === "pull_blocked")
      throw edgeRuntimeError(
        "pull_blocked",
        "The runtime workspace cannot materialize the canonical cut because local changes conflict.",
      );
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
  readonly riskTier: "low" | "medium" | "high" | null;
  readonly profileId: string | null;
  readonly worktree: TaskWorktreeBindingV1 | null;
  readonly snapshot: import("./repo-cell-types.ts").Snapshot & {
    readonly workspace: import("./protocol/daemon-protocol-gui-types.ts").TaskWorkspaceView | null;
  };
} {
  const worktree = read.worktree as { readonly branch?: unknown; readonly path?: unknown } | null | undefined;
  if (
    read.schema === "task-runtime-context-read/v1" &&
    read.ok === true &&
    read.taskId === taskId &&
    (read.causalContext === null || typeof read.causalContext === "string") &&
    (read.riskTier === null || ["low", "medium", "high"].includes(String(read.riskTier))) &&
    (read.profileId === null || typeof read.profileId === "string") &&
    (worktree === null ||
      (typeof worktree === "object" && typeof worktree.branch === "string" && typeof worktree.path === "string")) &&
    read.snapshot !== null &&
    typeof read.snapshot === "object"
  )
    return {
      causalContext: read.causalContext,
      riskTier: read.riskTier === null ? null : (read.riskTier as "low" | "medium" | "high"),
      profileId: read.profileId === null ? null : (read.profileId as string),
      worktree: worktree ? { branch: worktree.branch as string, path: worktree.path as string } : null,
      snapshot: read.snapshot as import("./repo-cell-types.ts").Snapshot & {
        readonly workspace: import("./protocol/daemon-protocol-gui-types.ts").TaskWorkspaceView | null;
      },
    };
  throw edgeRuntimeError(
    "runtime_read_invalid",
    `Replica returned an invalid runtime context read for task ${taskId}.`,
  );
}

/**
 * An edge holds no ledger of its own: the agents installed at the center reach it as the documents of its
 * mirrored view, under the same bundled layer every node ships.
 */
function mirroredAgentDeclaration(
  request: Pick<FleetEdgeRuntimeRequest["payload"], "viewRoot" | "repoId" | "workspaceRoot" | "nodeId">,
  agentId: string,
): RuntimeAgent {
  const logical = `agents/${agentId}.json`;
  if (
    entitySlug(agentId) &&
    locateFleetMirrorView(request.viewRoot, request.repoId, request.nodeId)?.entries.has(logical)
  )
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
  result: Extract<import("./fleet/command-protocol.ts").FleetFrameV1, { schema: "fleet.schedule.result/v1" }>,
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
  return { planContract: contract };
}

function edgeRuntimeError(code: string, message: string, retryable?: boolean): Error {
  return Object.assign(new Error(message), retryable === undefined ? { code } : { code, retryable });
}
