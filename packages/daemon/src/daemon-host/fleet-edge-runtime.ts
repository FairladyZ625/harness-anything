import type { DaemonRuntimePorts } from "./daemon-host-context.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { enrichCausalContextWithLocalWorktrees } from "./repo-cell-trace-view.ts";
import { timeDispatchStage, withDispatchStageClock } from "./dispatch-stage-clock.ts";
import { readAllTaskDispatchPages } from "./dispatch-read.ts";
import type * as RuntimeStatus from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { fleetMirrorTaskPaths } from "./fleet-edge-mirror.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { requiredCellText } from "./repo-cell-settlement.ts";
import { operationId } from "./repo-cell-proof.ts";
import {
  canStartExecution,
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  consumeKnownError,
  isNativeExecution,
  repositorySettings,
  type RepositorySettingsV1,
  type RuntimeProviderUnreachable,
  type TaskProjection,
} from "@harness-anything/kernel";
import { readEdgeRuntimeRepository } from "./fleet-edge-runtime-read.ts";
import { repositoryRuntimeReads } from "./repository-runtime-reads.ts";
import { repositoryReadData } from "./protocol/repository-read-frame.ts";
import { withEdgeReadModel } from "./fleet-edge-task-read.ts";
import { makeFleetSquadCoordinator } from "./fleet-squad-coordinator.ts";
import { countActiveDispatchStreams } from "./dispatch-stream.ts";
import {
  advanceDispatchControlCursor,
  hasPendingSteerReceipts,
  PENDING_STEER_RECEIPT_HIGH_WATERMARK,
  pendingSteerReceiptCount,
  readDispatchControlCursor,
  readSettledControlOpIdsAboveCursor,
  recordPendingSteerReceipt,
  recordSettledControlAboveCursor,
} from "./dispatch-steer-state.ts";
import type { RuntimeSteerSelector } from "./runtime-steer-target.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { readEdgeViewBlob, readEdgeRuntimeResult } from "./runtime-result-read.ts";
import { readFallbackExhaustion } from "./runtime-spawn-fallback.ts";
import { runRuntimeHandoff } from "./runtime-handoff.ts";
import { readAuthoredDocumentBytes } from "./authored-document-read-port.ts";
import {
  findPersistedRuntimeExecutionPrincipal,
  recordRuntimeExecutionPrincipal,
} from "./runtime-execution-principal-store.ts";
import { executionCredentialRejected } from "./runtime-execution-credential.ts";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import {
  assertTransitionDocumentReady,
  classifyTextualArtifactPath,
  entitySlug,
  readSettingsFacet,
  requireTransitionDocumentKind,
  resolveHarnessLayout,
  validateScheduleV1,
  type AgentRuntimeEventV1,
  type RuntimeSessionReadQuery,
  type ScheduleV1,
  type TaskWorktreeBindingV1,
} from "@harness-anything/kernel";
import { selectReviewTarget } from "./review-dispatch-admission.ts";
import { runtimeRecoveryError } from "./runtime-recovery-watch.ts";
import { resolveSquadDispatch } from "./agent-entities.ts";
import { readProjectedAgentDeclaration } from "./agent-declaration-resolution.ts";
import { readLocalAgentRecord } from "./local-agent-store.ts";
import { localDeclarationMatchesSharedValue } from "@harness-anything/kernel";
import { mergeRepositoryLocalSettings, readLocalState } from "./repo-cell-settings-state.ts";
import { readBundledAgentDeclaration } from "@harness-anything/preset";
import {
  readFleetRepositoryMetadataClient,
  runFleetEdgeRuntimeArchiveClient,
  runFleetRuntimeEventClient,
  readFleetOperationalClient,
  runFleetScheduleCommandClient,
  runFleetTaskCommandClient,
  runFleetEdgeUploadClient,
  runFleetEdgeTaskCommand,
} from "./fleet-edge-write.ts";
import { applyFleetMirrorCut, locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import {
  mirroredPlanContract as resolveMirroredPlanContract,
  resolveReviewPublicationInstanceCandidates,
} from "./fleet-edge-review-helpers.ts";
import { validateAgentRuntimeOverview, type AgentRuntimeOverviewResult } from "./agent-runtime-contract.ts";
import { makeRuntimeSpawner, type RuntimeDaemonRoute, type RuntimeLauncher } from "./runtime-spawn.ts";
import { createFleetEdgeRuntimeControlConsumer, type RemoteRuntimeControlEvent } from "./fleet-edge-runtime-control.ts";
import {
  createFleetEdgeSteerReceiptPump,
  forwardFleetEdgeRemoteRuntimeControl,
} from "./fleet-edge-runtime-control-bridge.ts";
import type { ReviewerReviewRecoveryInput, RuntimeAgent, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { readReplicaGeneration } from "../fleet-sync/fleet/replica-generation.ts";
import { runFleetEdgeWrite, transientFleetReceipt } from "./fleet-edge-write.ts";
import { readScheduleAction, dispatchClaimedSchedule } from "./schedule-action-runtime.ts";
import { orchestrateRuntimeSessionsAwait } from "./runtime-orchestration.ts";
import { prepareScheduleOccurrenceWorkspace, scheduleSettlementDetail } from "./schedule-occurrence-workspace.ts";
import { taskMissionSections, taskPlanSection, runtimeMissionName } from "./runtime-spawn-mission.ts";
import { presetSnapshotReader, taskOutputShape } from "./task-worktree.ts";
import { readRuntimeDispatchOwnerEvidence } from "./runtime-dispatch-owner-evidence.ts";
import { runtimeSpawnReceipt } from "../runtime-engine/runtime-spawn-receipt.ts";
import { admitTaskDispatch } from "./task-dispatch-recovery.ts";
import { currentForwardedRuntimeAuth, runtimeForwardingContext } from "./fleet/forwarding-port.ts";
import type { FleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { assertFleetEdgeRepositoryGit } from "./fleet-edge-git-preflight.ts";
import { publishSubmittedCut } from "./submitted-cut-publication.ts";
import { taskPrBodyRenderer } from "./task-pr-body-render.ts";

export interface FleetEdgeRuntimeRequest {
  readonly payload: FleetEdgeConfig & {
    readonly workspaceRoot: string;
    readonly method:
      | "repo.agentRuntime.spawn"
      | "repo.agentRuntime.cancel"
      | "repo.agentRuntime.steer"
      | "repo.agentRuntime.handoff"
      | "repo.agentRuntime.overview"
      | "repo.agentRuntime.sessions.await"
      | "repo.agentRuntime.sessions.read"
      | "repo.task.dispatches"
      | "repo.tasks.autoClaimCandidates"
      | "repo.tasks.autoDispatchCandidates"
      | "repo.schedule.run"
      | "repo.squad.control";
    readonly action: JsonObject;
  };
}
type FleetRuntimeLocation = Omit<FleetEdgeRuntimeRequest["payload"], "method" | "action">;
type RuntimePorts = Omit<DaemonRuntimePorts, "runtimeProviderHealth" | "listRuntimeTempSessionIds"> &
  Partial<Pick<DaemonRuntimePorts, "runtimeProviderHealth" | "listRuntimeTempSessionIds">>;
const runtimeOverviewPageLimit = daemonProtocolFleetPolicy.defaultValue.fleet.overviewPageLimit;
const localReplicaWaitBackstopMs = daemonProtocolFleetPolicy.defaultValue.fleet.localReplicaWaitBackstopMs;

/**
 * Replica changes are a wake hint; each wake re-reads settlement from the edge view.
 */
function waitForLocalReplicaChange(
  viewRoot: string,
  repoId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new Error("The connection that parked this wait closed."));
  const viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(signal?.reason ?? new Error("The connection that parked this wait closed."));
    const timer = setTimeout(() => finish(), localReplicaWaitBackstopMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (existsSync(viewDir)) {
      try {
        watcher = watch(viewDir, { persistent: false }, (_event, filename) => {
          if (filename === undefined || String(filename) === "current.json") finish();
        });
        watcher.on("error", () => finish());
      } catch (error) {
        cleanup();
        throw error;
      }
    }
  });
}
export async function readFleetRuntimeSessionsPaged(readPage: (payload: JsonObject) => Promise<unknown>): Promise<
  readonly {
    readonly runtimeSessionId: string;
    readonly providerSessionId: string | null;
    readonly instanceId: string;
    readonly liveness: RuntimeStatus.RuntimeLiveness;
    readonly outcome: NonNullable<RuntimeStatus.RuntimeSession["outcome"]> | null;
    readonly providerUnreachable: RuntimeProviderUnreachable | null;
  }[]
> {
  const sessions: Array<{
    readonly runtimeSessionId: string;
    readonly providerSessionId: string | null;
    readonly instanceId: string;
    readonly liveness: RuntimeStatus.RuntimeLiveness;
    readonly outcome: NonNullable<RuntimeStatus.RuntimeSession["outcome"]> | null;
    readonly providerUnreachable: RuntimeProviderUnreachable | null;
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
        providerUnreachable: activity.providerUnreachable ?? null,
      })),
    );
    cursor = overview.page.nextCursor;
    if (cursor !== null && seen.has(cursor))
      throw edgeRuntimeError("runtime_read_invalid", `Runtime overview repeated cursor ${cursor}.`);
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
  return sessions;
}

/**
 * The unsettled/point-read recovery input reads the replica projection by key or unsettled set.
 * Every selected field must survive: `providerUnreachable` is the center's persisted fault
 * classification, so dropping it here would make adoption silently clear a live fault.
 */
export function readEdgeRuntimeSessions(
  projection: Pick<TaskProjection, "readRuntimeSessions">,
  query?: RuntimeSessionReadQuery,
): readonly RuntimeSessionSelection[] {
  return projection.readRuntimeSessions(query).map((session) => ({
    runtimeSessionId: session.runtimeSessionId,
    providerSessionId: session.providerSessionId,
    instanceId: session.instanceId,
    liveness: session.liveness,
    outcome: session.outcome,
    providerUnreachable: session.providerUnreachable ?? null,
  }));
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
    drain: () => tail,
    close: () => {
      closed = true;
    },
  };
}

export function openFleetEdgeRuntime(input: {
  readonly resolveLocation: () => FleetRuntimeLocation;
  readonly readAccessToken: (request: FleetRuntimeLocation) => Promise<string | undefined>;
  readonly readBinding: (request?: FleetRuntimeLocation) => Promise<import("./repo-cell-types.ts").RepoCellBinding>;
  /** Binding for controls and launches; offline replica identity is valid for reads only. */
  readonly controlBinding: (request?: FleetRuntimeLocation) => Promise<import("./repo-cell-types.ts").RepoCellBinding>;
  readonly daemonGeneration: number;
  readonly daemonRoute: RuntimeDaemonRoute;
  readonly ports: RuntimePorts;
  readonly forwardTaskAction: (action: Record<string, unknown> & { kind: string }) => Promise<JsonObject>;
  /** Waits for an in-flight resident stream to publish its first readable generation. */
  readonly waitForReplicaReady?: (request: FleetRuntimeLocation, signal?: AbortSignal) => Promise<boolean>;
  /** Reports a released task once its canonical runtime outcome is readable on this node. */
  readonly onTaskSettled?: (taskId: string) => void;
  readonly launch?: RuntimeLauncher;
  readonly recordLifecycle?: import("./lifecycle-log.ts").DaemonLifecycleRecorder;
  readonly now?: () => string;
}) {
  const controlBinding = input.controlBinding,
    now = input.now ?? (() => new Date().toISOString()),
    stream = { publish: () => ({}) as never };
  const context = () => {
    const request = input.resolveLocation();
    return runtimeForwardingContext(request, () => input.readAccessToken(request));
  };
  const readSettings = () => {
    const { request } = context();
    return withEdgeReadModel({ ...request, principalId: replicaOwner, includeEntries: false }, (projection) =>
      mergeRepositoryLocalSettings(
        repositorySettings({
          ...readSettingsFacet(readFileSync(resolveHarnessLayout(request.workspaceRoot).configPath!, "utf8")),
          ...((projection.getEntity("settings", "repository")?.value as RepositorySettingsV1 | undefined) ?? {}),
        }),
        readLocalState(request.workspaceRoot).value,
      ),
    );
  };
  let replicaOwner: string | undefined;
  const readMirroredDocument = (logicalPath: string): string | null => {
    const { request } = context();

    if (replicaOwner === undefined) return null;
    return withEdgeReadModel(
      { ...request, principalId: replicaOwner, includeEntries: false },
      (projection) => projection.readDocument(logicalPath).document?.body ?? null,
    );
  };
  const readReplica = async (method: Parameters<typeof readEdgeRuntimeRepository>[1], payload: JsonObject) => {
    const { request } = context();
    return readEdgeRuntimeRepository(
      { ...request, principalId: (await input.readBinding(request)).actor.principal.personId },
      method,
      payload,
    );
  };
  const executionCredentials = new Map<
    string,
    { credential: string; expiresAt: string; personId: string; surfaces: readonly string[] }
  >();
  const runtimeControlReceipts = new Map<string, JsonObject>();
  const discardExpiredExecutionCredentials = () => {
    const nowMs = Date.now();
    for (const [runtimeSessionId, execution] of executionCredentials)
      if (Date.parse(execution.expiresAt) <= nowMs) executionCredentials.delete(runtimeSessionId);
  };
  const trustedScheduleAgents = new Map<string, RuntimeAgent>();
  const workQueue = createFleetEdgeRuntimeWorkQueue((error) => {
    console.error("[fleet-edge-runtime] Pending runtime work failed:", error);
    ready = null;
    adoptedOnce = false;
  });
  const schedule = workQueue.schedule;
  const runScheduleCommand: typeof runFleetScheduleCommandClient = async (options) => {
    const { request, centerWriteWaitMs } = context();

    return runFleetEdgeWrite({
      viewRoot: request.viewRoot,
      repoId: request.repoId,
      nodeId: request.nodeId,
      timeoutMs: centerWriteWaitMs,
      write: () => runFleetScheduleCommandClient(options),
    });
  };
  const readEdgeReviewerArtifacts = async (artifact: {
    readonly taskId: string;
    readonly dispatchId: string;
    readonly cwd: string;
  }) => {
    const { request } = context();

    const view = locateFleetMirrorView(request.viewRoot, request.repoId, request.nodeId, {
      entriesPrefix: `tasks/${artifact.taskId}`,
    });
    if (!view) return null;
    const packagePaths = fleetMirrorTaskPaths(view, artifact.taskId)
      .filter((logical) => logical.startsWith("tasks/") && logical.endsWith("/INDEX.md"))
      .filter((logical) => {
        try {
          const index = readMirroredDocument(logical);
          if (index === null) return false;
          return index
            .split(/\r?\n/u)
            .some((line) => line === `task_id: ${artifact.taskId}` || line === `taskId: ${artifact.taskId}`);
        } catch {
          return false;
        }
      })
      .map((logical) => logical.slice(0, -"/INDEX.md".length));
    if (packagePaths.length !== 1) return null;
    const reportPath = `${packagePaths[0]}/artifacts/reports/${artifact.dispatchId}.md`,
      packetPath = `${packagePaths[0]}/artifacts/reports/${artifact.dispatchId}.json`,
      authoredRoot = resolveHarnessLayout(request.workspaceRoot).authoredRoot,
      artifactBody = (logical: string) => {
        const relative = logical.split("/");
        const authoredCandidate = path.join(authoredRoot, ...relative);
        for (const candidate of [
          path.join(artifact.cwd, "harness", ...relative),
          path.join(artifact.cwd, ...relative),
          path.join(artifact.cwd, "artifacts", "reports", path.basename(logical)),
          authoredCandidate,
        ]) {
          if (!existsSync(candidate)) continue;
          const entry = lstatSync(candidate);
          if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 2 * 1024 * 1024) continue;
          return new TextDecoder("utf-8", { fatal: true }).decode(
            candidate === authoredCandidate
              ? readAuthoredDocumentBytes(authoredRoot, logical)
              : readFileSync(candidate),
          );
        }
        return readMirroredDocument(logical);
      },
      packet = artifactBody(packetPath),
      report = artifactBody(reportPath);
    return packet === null || report === null
      ? null
      : { packet: { path: packetPath, body: packet }, report: { path: reportPath, body: report } };
  };
  const recoverEdgeReviewerReview = async (review: ReviewerReviewRecoveryInput) => {
    const { request, writePeer, centerWriteWaitMs } = context();

    discardExpiredExecutionCredentials();
    const execution = executionCredentials.get(review.runtimeSessionId);
    const persisted = execution
      ? null
      : findPersistedRuntimeExecutionPrincipal(request.workspaceRoot, review.runtimeSessionId, review.dispatchId);
    if (!execution) {
      if (!persisted)
        throw edgeRuntimeError(
          "execution_credential_rejected",
          "Center did not issue a live review recovery credential.",
        );
      const expiresMs = Date.parse(persisted.expiresAt);
      if (!Number.isFinite(expiresMs) || expiresMs <= Date.now())
        throw executionCredentialRejected("expired", {
          expiresAt: persisted.expiresAt,
          dispatchId: review.dispatchId,
          role: "reviewer",
        });
      if (persisted.personId !== review.binding.actor.principal.personId)
        throw edgeRuntimeError(
          "execution_credential_rejected",
          "Review recovery binding does not match the recorded principal.",
        );
    }
    if (
      review.binding.actor.executor?.id !== `runtime-session:${review.runtimeSessionId}` ||
      review.binding.actor.principal.personId !== (execution?.personId ?? persisted!.personId) ||
      typeof review.binding.source !== "object" ||
      review.binding.source.kind !== "node" ||
      review.binding.source.nodeId !== request.nodeId
    )
      throw edgeRuntimeError(
        "execution_credential_rejected",
        "Review recovery binding does not name its runtime session.",
      );
    const reportSuffix = `/artifacts/reports/${review.dispatchId}.md`,
      reportPackage = review.report.path.endsWith(reportSuffix)
        ? review.report.path.slice(0, -reportSuffix.length)
        : null,
      packetPath = reportPackage ? `${reportPackage}/artifacts/reports/${review.dispatchId}.json` : null,
      view = locateFleetMirrorView(request.viewRoot, request.repoId, request.nodeId, {
        entryPaths: [packetPath ?? "", `${reportPackage ?? ""}/artifacts/reports/${review.dispatchId}.md`].filter(
          Boolean,
        ),
      }),
      reportClass = classifyTextualArtifactPath(review.report.path),
      packetClass = classifyTextualArtifactPath(review.packet.path);
    if (
      !view ||
      !reportClass ||
      !packetClass ||
      packetPath !== review.packet.path ||
      review.report.path !== `${reportPackage}/artifacts/reports/${review.dispatchId}.md`
    )
      throw edgeRuntimeError("review_report_invalid", "Review recovery artifacts do not match the dispatch package.");
    const [reportCandidate, packetCandidate] = await runFleetEdgeUploadClient({
      ...writePeer,
      timeoutMs: daemonProtocolFleetPolicy.defaultValue.fleet.taskContentTimeoutMs,
      changes: [
        {
          path: review.report.path,
          body: Buffer.from(review.report.body, "utf8"),
          mediaType: reportClass.mediaType,
        },
        {
          path: review.packet.path,
          body: Buffer.from(review.packet.body, "utf8"),
          mediaType: packetClass.mediaType,
        },
      ],
    });
    if (!reportCandidate || !packetCandidate)
      throw edgeRuntimeError("review_report_missing", "Review report upload returned no content claim.");
    let packet: unknown;
    try {
      packet = JSON.parse(review.packet.body);
    } catch {
      throw edgeRuntimeError("review_report_invalid", "Review recovery packet is not valid JSON.");
    }
    if (typeof packet !== "object" || packet === null || Array.isArray(packet))
      throw edgeRuntimeError("review_report_invalid", "Review recovery packet must be a JSON object.");
    const action = {
        ...packet,
        kind: "task-review-execution",
        taskId: review.taskId,
        executionId: review.executionId,
        reviewId: `review-${review.dispatchId}`,
      } as const,
      recoveryOpId = randomUUID(),
      taskCommand = () =>
        runFleetTaskCommandClient({
          ...writePeer,
          ...(execution ? { executionCredential: execution.credential } : {}),
          opId: recoveryOpId,
          repoId: request.repoId,
          taskId: review.taskId,
          action,
          waitMs: centerWriteWaitMs,
          timeoutMs: centerWriteWaitMs + daemonProtocolFleetPolicy.defaultValue.fleet.receiptResponseOverheadMs,
          docChanges: [
            {
              path: review.packet.path,
              baseBlobSha256: view.entries.get(review.packet.path)?.sha256 ?? null,
              policyId: packetClass.policyId,
              candidate: packetCandidate,
            },
            {
              path: review.report.path,
              baseBlobSha256: view.entries.get(review.report.path)?.sha256 ?? null,
              policyId: reportClass.policyId,
              candidate: reportCandidate,
            },
          ],
          mirrorBaseCut: { revision: view.revision, headDigest: view.headDigest },
        });
    const result = await runFleetEdgeTaskCommand({
      timeoutMs: centerWriteWaitMs + daemonProtocolFleetPolicy.defaultValue.fleet.taskContentTimeoutMs,
      readOnly: false,
      write: taskCommand,
      settle: () =>
        runFleetEdgeWrite({
          viewRoot: request.viewRoot,
          repoId: request.repoId,
          nodeId: request.nodeId,
          timeoutMs: centerWriteWaitMs,
          write: taskCommand,
        }),
    });
    const receiptOutcome =
      result.receipt && typeof result.receipt.outcome === "string" ? result.receipt.outcome : result.outcome;
    if (result.outcome !== "applied" || !["applied", "no_changes"].includes(receiptOutcome))
      throw edgeRuntimeError(
        result.code ?? "review_result_missing",
        `Center did not accept Review ${`review-${review.dispatchId}`}: ${String(result.code ?? receiptOutcome)}.`,
      );
  };
  type ExecutionSignalScope = { signal: AbortSignal | undefined };
  const executionSignalContext = new AsyncLocalStorage<ExecutionSignalScope>();
  const withExecutionSignal = async <Result>(
    signal: AbortSignal | undefined,
    action: (scope: ExecutionSignalScope) => Promise<Result>,
  ) => {
    const scope = { signal };
    try {
      return await action(scope);
    } finally {
      // Child callbacks inherit the store, but the request owns its cancellation signal.
      scope.signal = undefined;
    }
  };
  const reviewSpawnContext = new AsyncLocalStorage<{
    readonly runtimeInstanceId?: string;
    readonly preferredRuntimeInstanceId?: string;
    readonly agentId?: string;
  }>();
  const readDispatchLifecycle: import("./runtime-spawn-types.ts").RemoteRuntimePersistence["readDispatchLifecycle"] =
    async (query) => {
      const { runtimeReadPeer, request } = context();
      const connectionSignal = executionSignalContext.getStore()?.signal;
      return (await readFleetOperationalClient({
        ...runtimeReadPeer,
        repoId: request.repoId,
        method: "repo.agentRuntime.lifecycle.read",
        payload: query,
        ...(connectionSignal ? { connectionSignal } : {}),
      })) as unknown as import("@harness-anything/kernel").DispatchLifecycleRead;
    };
  const readTaskContext = async (taskId: string, purpose?: "settlement") => {
    const { runtimeReadPeer, request } = context();
    const connectionSignal = executionSignalContext.getStore()?.signal;
    return taskRuntimeContext(
      purpose === "settlement"
        ? await readReplica("repo.tasks.runtimeContext.read", { taskId })
        : await readFleetOperationalClient({
            ...runtimeReadPeer,
            repoId: request.repoId,
            method: "repo.tasks.runtimeContext.read",
            payload: { taskId },
            ...(connectionSignal ? { connectionSignal } : {}),
          }),
      taskId,
    );
  };
  const spawner = makeRuntimeSpawner({
    get repoId() {
      return input.resolveLocation().repoId;
    },
    get rootDir() {
      return input.resolveLocation().workspaceRoot;
    },
    daemonGeneration: input.daemonGeneration,
    ...(input.recordLifecycle ? { recordLifecycle: input.recordLifecycle } : {}),
    get runtimeNode() {
      return { nodeId: input.resolveLocation().nodeId };
    },
    runtimeDaemonRoute: input.daemonRoute,
    remote: {
      executionCredential: (runtimeSessionId) => {
        const { request } = context();

        discardExpiredExecutionCredentials();
        const execution = executionCredentials.get(runtimeSessionId);
        if (!execution)
          throw edgeRuntimeError("execution_credential_rejected", "Center did not issue this dispatch credential.");
        recordRuntimeExecutionPrincipal(
          request.workspaceRoot,
          request.repoId,
          runtimeSessionId,
          execution.credential,
          execution.personId,
          execution.expiresAt,
          execution.surfaces,
        );
        return { credential: execution.credential, expiresAt: execution.expiresAt };
      },
      readReviewerArtifacts: async ({ taskId, dispatchId, cwd }) =>
        readEdgeReviewerArtifacts({
          taskId,
          dispatchId,
          cwd,
        }),
      recoverReviewerReview: async (review) => recoverEdgeReviewerReview(review),
      releaseExecutionCredential: (runtimeSessionId) => {
        executionCredentials.delete(runtimeSessionId);
      },
      reviewerReviewRegistered: async ({ taskId, reviewId, runtimeSessionId }) => {
        await pullRuntimeReplica();
        const context = taskRuntimeContext(await readReplica("repo.tasks.runtimeContext.read", { taskId }), taskId);
        return context.snapshot.reviews.some(
          (review) =>
            review.reviewId === reviewId || review.actor.executor?.id === `runtime-session:${runtimeSessionId}`,
        );
      },
      runtimeControlReceipt: (runtimeSessionId) => runtimeControlReceipts.get(runtimeSessionId) ?? null,
      taskContext: async (taskId, missionName, review, onClaimed, purpose) => {
        const { request, centerWriteWaitMs, writePeer } = context();

        await pullRuntimeReplica();
        let runtimeContext = await timeDispatchStage("task_context_read", () => readTaskContext(taskId, purpose));
        let current = runtimeContext.snapshot;
        if (!current.task) throw edgeRuntimeError("task_read_failed", "Task context is unavailable.");
        const taskForOutputShape = current.task;
        const outputShape = await readRuntimeProjection(request, (projection) =>
          taskOutputShape(taskForOutputShape, presetSnapshotReader(projection)),
        );
        let executionId = review
          ? selectReviewTarget(taskId, review.executionId, current, false)?.executionId
          : current.lease?.phase === "held"
            ? current.lease.executionId
            : undefined;
        const activeExecution = current.executions.find(
          (execution) =>
            isNativeExecution(execution) &&
            execution.iteration === current.task?.iteration &&
            execution.state === "active",
        );
        const taskStartExecutionId = activeExecution?.executionId ?? "runtime-task-start-" + taskId;
        if (!executionId && !review && purpose !== "settlement" && canStartExecution(current, taskStartExecutionId)) {
          const taskStartOpId = randomUUID();
          const started = await runFleetEdgeWrite({
            viewRoot: request.viewRoot,
            repoId: request.repoId,
            nodeId: request.nodeId,
            timeoutMs: centerWriteWaitMs,
            write: () =>
              timeDispatchStage("center_task_start", () =>
                runFleetTaskCommandClient({
                  ...writePeer,
                  repoId: request.repoId,
                  taskId,
                  opId: taskStartOpId,
                  action: {
                    kind: "task-start",
                    taskId,
                    ...(activeExecution ? { executionId: activeExecution.executionId } : {}),
                  },
                  waitMs: centerWriteWaitMs,
                  timeoutMs: centerWriteWaitMs + daemonProtocolFleetPolicy.defaultValue.fleet.receiptResponseOverheadMs,
                }),
              ),
          });
          if (started.outcome !== "applied")
            throw edgeRuntimeError(
              started.code ?? "task_start_rejected",
              `The center could not start task ${taskId}: ${String(started.code ?? started.outcome)}.`,
            );
          const claimOpId = started.receipt?.opId;
          if (started.receipt?.outcome === "applied" && typeof claimOpId === "string")
            onClaimed?.(async () => {
              const released = await runFleetEdgeWrite({
                viewRoot: request.viewRoot,
                repoId: request.repoId,
                nodeId: request.nodeId,
                timeoutMs: centerWriteWaitMs,
                write: () =>
                  runFleetTaskCommandClient({
                    ...writePeer,
                    repoId: request.repoId,
                    taskId,
                    opId: randomUUID(),
                    waitMs: centerWriteWaitMs,
                    action: {
                      kind: "task-release",
                      taskId,
                      claimOpId,
                      reason: "Runtime spawn failed after acquiring the task lease.",
                    },
                  }),
              });
              if (
                released.outcome !== "applied" &&
                released.code !== "lease_not_found" &&
                released.code !== "runtime_terminal_superseded"
              )
                throw edgeRuntimeError(
                  released.code ?? "runtime_lease_release_failed",
                  `Center rejected failed-spawn lease release: ${String(released.code ?? released.outcome)}.`,
                );
            });
          await pullRuntimeReplica();
          runtimeContext = await timeDispatchStage("task_context_read", () => readTaskContext(taskId, purpose));
          current = runtimeContext.snapshot;
          executionId = current.lease?.phase === "held" ? current.lease.executionId : undefined;
        }
        if (!executionId) throw edgeRuntimeError("execution_missing", "The task has no current execution.");
        const view = locateFleetMirrorView(request.viewRoot, request.repoId, request.nodeId, {
          entriesPrefix: `tasks/${taskId}`,
        });
        const materializedRoot = resolveHarnessLayout(request.workspaceRoot).authoredRoot;
        const readLocalAuthoredDocument = (logicalPath: string): string | null => {
          try {
            return new TextDecoder("utf-8", { fatal: true }).decode(
              readAuthoredDocumentBytes(materializedRoot, logicalPath),
            );
          } catch (error) {
            consumeKnownError(error);
            return null;
          }
        };
        const packagePathsFor = (logical: string): string[] => {
          const packagePath = logical.slice(0, -"/INDEX.md".length);
          try {
            const body = readLocalAuthoredDocument(logical);
            if (body === null) return [];
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
          { riskTier, profileId, riskTierFlowVersion, worktree, reviewerNote } = runtimeContext;
        let plan: string;
        try {
          plan = readLocalAuthoredDocument(`${candidates[0]!}/task_plan.md`) ?? "";
          if (!plan) throw new Error("task plan unavailable");
        } catch {
          throw edgeRuntimeError(
            "runtime_task_package_unavailable",
            `Task ${taskId} has no readable mirrored task plan; run ha daemon fleet edge sync, then retry.`,
          );
        }
        const { planContract } = mirroredPlanContract(
          readLocalAuthoredDocument(`${candidates[0]!}/task-contract.json`),
          taskId,
        );
        assertTransitionDocumentReady(requireTransitionDocumentKind("runtime.run"), plan, planContract);
        const causalContext = await timeDispatchStage("worktree_collision_scan", () =>
            enrichCausalContextWithLocalWorktrees(runtimeContext.causalContext, {
              workspaceRoot: request.workspaceRoot,
              plan,
              taskId,
              skip: review !== undefined || purpose === "settlement",
            }),
          ),
          priorIteration = current.task && current.task.iteration > 0 ? current.task.iteration - 1 : null,
          ownerReturnBody =
            [
              priorIteration === null
                ? null
                : (() => {
                    const logicalPath = `${candidates[0]!}/returns/iteration-${String(priorIteration)}.md`;
                    if (!view.entries.has(logicalPath)) return null;
                    let body: string;
                    try {
                      body =
                        readLocalAuthoredDocument(`${candidates[0]!}/returns/iteration-${String(priorIteration)}.md`) ??
                        "";
                      if (!body) throw new Error("owner return unavailable");
                    } catch {
                      throw edgeRuntimeError(
                        "runtime_task_package_unavailable",
                        `Task ${taskId} has an unreadable mirrored owner return at ${logicalPath}; ` +
                          "run ha daemon fleet edge sync, then retry.",
                      );
                    }
                    return body.trim() ? body.trim() : null;
                  })(),
              runtimeContext.escalationContext,
            ]
              .filter((value): value is string => value !== null)
              .join("\n\n") || null;
        const mission = missionName
            ? (() => {
                const name = runtimeMissionName(missionName),
                  logicalPath = `${candidates[0]!}/artifacts/missions/${name}.md`;
                if (!view.entries.has(logicalPath))
                  throw edgeRuntimeError(
                    "runtime_mission_unavailable",
                    `Task ${taskId} has no current mirrored mission at ${logicalPath}.`,
                  );
                let body: string;
                try {
                  body = readLocalAuthoredDocument(logicalPath) ?? "";
                  if (!body) throw new Error("mission unavailable");
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
              profileId,
              riskTierFlowVersion,
              review !== undefined ? null : reviewerNote,
              outputShape,
            ),
            ...(mission ? [`# Mission: ${missionName}\n\n${mission.trim()}`] : []),
          ];
        if (review && purpose !== "settlement") {
          const execution = current.executions.find((value) => value.executionId === executionId)!,
            submission = execution.submission!,
            executorId = execution.actor.executor?.id,
            implementationSession = executorId?.startsWith("runtime-session:")
              ? executorId.slice("runtime-session:".length)
              : null,
            publication = await readRuntimeProjection(request, (projection) => ({
              instanceId: implementationSession
                ? projection.readRuntimeDispatch(implementationSession)?.payload.instanceId
                : undefined,
              renderBody: taskPrBodyRenderer({
                rootDir: request.workspaceRoot,
                projection: projection as TaskProjection,
                taskId,
                submission,
              }),
            })),
            // The renderer captures projection inputs synchronously; await Git reads after
            // the replica's synchronous SQLite reader session has closed.
            renderBody = await publication.renderBody,
            spawnHints = reviewSpawnContext.getStore(),
            intentInstanceId =
              current.task?.reviewDispatchIntent?.executionId === executionId
                ? current.task.reviewDispatchIntent.runtimeInstanceId
                : undefined,
            candidateInstanceIds = resolveReviewPublicationInstanceCandidates({
              implementationInstanceId: publication.instanceId,
              selectedInstanceId: spawnHints?.runtimeInstanceId,
              intentInstanceId,
              preferredInstanceId: spawnHints?.preferredRuntimeInstanceId,
              agentId: spawnHints?.agentId,
              readSettings,
              findAgent: (agentId) =>
                trustedScheduleAgents.get(agentId) ??
                findMirroredAgentDeclaration(
                  request,
                  agentId,
                  current.task?.metadata?.verticalId ?? readSettings().defaultVertical,
                ),
              localInstances: input.ports.runtimeInstances(),
            }),
            prepareDaemonGitEnvironment = input.ports.prepareDaemonGitEnvironment
              ? async (_initialId: string, provider: "github" | "gitlab", repoId: string) => {
                  for (const candidateId of candidateInstanceIds) {
                    const env = await input.ports.prepareDaemonGitEnvironment(candidateId, provider, repoId);
                    if (env !== null) return env;
                  }
                  return null;
                }
              : undefined;
          await publishSubmittedCut({
            rootDir: request.workspaceRoot,
            repoId: request.repoId,
            taskId,
            taskTitle: current.task!.title,
            submission,
            ...(candidateInstanceIds[0] ? { instanceId: candidateInstanceIds[0] } : {}),
            ...(prepareDaemonGitEnvironment ? { prepareDaemonGitEnvironment } : {}),
            ...(renderBody ? { renderBody } : {}),
          });
        }
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
          verticalId: current.task?.metadata?.verticalId ?? null,
          profileId,
          riskTierFlowVersion,
          taskClass: current.task!.taskClass,
          ownerReturnBody,
          continuationContext: runtimeContext.continuationContext,
          planBody: plan,
          reviewerNote: review !== undefined ? null : reviewerNote,
          mission: (reachedPackageRoot) =>
            [taskPlanSection(plan, reachedPackageRoot), ...missionAfterPackage].join("\n\n"),
          causalContext,
          worktree,
        };
      },
      readTaskLifecycleNode: (taskId) =>
        readRuntimeProjection(
          input.resolveLocation(),
          (projection) => projection.read(taskId, false, false).snapshot.task?.currentNode ?? null,
        ),
      readRuntimeSession: (runtimeSessionId) =>
        readRuntimeProjection(input.resolveLocation(), (projection) => projection.readRuntimeSession(runtimeSessionId)),
      readRuntimeSessions: async (query) => {
        const request = input.resolveLocation();
        if (query?.unsettledOnly || query?.runtimeSessionId !== undefined || query?.providerSessionId !== undefined)
          return readRuntimeProjection(request, (projection) => readEdgeRuntimeSessions(projection, query));
        return readFleetRuntimeSessionsPaged((payload) =>
          readRuntimeProjection(request, (projection, frame, view) => ({
            ...repositoryRuntimeReads(
              projection as TaskProjection,
              { readContentBlob: (sha256) => readEdgeViewBlob(view, sha256) },
              undefined,
              request.viewRoot,
              false,
            ).overview(payload),
            ...frame,
          })),
        );
      },
      readDispatchLifecycle,
      readRuntimeDispatch: (runtimeSessionId) =>
        readRuntimeProjection(input.resolveLocation(), (projection) =>
          readRuntimeDispatchOwnerEvidence(projection, runtimeSessionId),
        ),
      readFallbackExhaustion: (attempt) => {
        const request = input.resolveLocation();
        return readRuntimeProjection(request, (projection) =>
          readFallbackExhaustion(
            projection,
            (ref) => readEdgeRuntimeResult(request.viewRoot, request.repoId, request.nodeId, ref),
            attempt,
          ),
        );
      },
      publish: async (draft) => {
        const { request, centerWriteWaitMs, writePeer } = context();

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
        if (draft.type === "runtime_session_started" || draft.type === "runtime_dispatch_requested")
          await pullRuntimeReplica();
        const {
          event: _event,
          executionCredential,
          executionExpiresAt,
          executionPrincipalId,
          executionSurfaces,
          ...receipt
        } = response.receipt;
        discardExpiredExecutionCredentials();
        if (
          typeof executionCredential === "string" &&
          typeof executionExpiresAt === "string" &&
          typeof executionPrincipalId === "string" &&
          typeof draft.payload.runtimeSessionId === "string"
        ) {
          if (!Array.isArray(executionSurfaces) || executionSurfaces.some((surface) => typeof surface !== "string"))
            throw edgeRuntimeError("execution_credential_rejected", "Center returned invalid execution surfaces.");
          executionCredentials.set(draft.payload.runtimeSessionId, {
            credential: executionCredential,
            expiresAt: executionExpiresAt,
            personId: executionPrincipalId,
            surfaces: executionSurfaces,
          });
        }
        const sanitizedReceipt = receipt as JsonObject;
        if (draft.type === "runtime_session_cancelled" && typeof draft.payload.runtimeSessionId === "string")
          runtimeControlReceipts.set(draft.payload.runtimeSessionId, sanitizedReceipt);
        return {
          event: response.event as unknown as AgentRuntimeEventV1 | null,
          receipt: sanitizedReceipt,
        };
      },
      archive: async (archive) => {
        const { request, centerWriteWaitMs, writePeer } = context();

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
    runtimeInstanceDispatchState: input.ports.runtimeInstanceDispatchState,
    runtimeProviderHealth: input.ports.runtimeProviderHealth,
    cloudRuntime: input.ports.cloudRuntime,
    prepareLaunch: input.ports.prepareRuntimeLaunch,
    prepareCloudRelay: input.ports.prepareCloudRelay,
    reclaimRuntimeTempDirectory: input.ports.reclaimRuntimeTempDirectory,
    ...(input.ports.listRuntimeTempSessionIds
      ? { listRuntimeTempSessionIds: input.ports.listRuntimeTempSessionIds }
      : {}),
    reclaimSettledRuntimeTempDirectories: input.ports.reclaimSettledRuntimeTempDirectories,
    prepareDaemonGitEnvironment: input.ports.prepareDaemonGitEnvironment,
    resolveAgent: (agentId, verticalId) => {
      const { request } = context();
      return (
        trustedScheduleAgents.get(agentId) ??
        mirroredAgentDeclaration(
          request,
          agentId,
          input.daemonRoute.userRoot,
          verticalId ?? readSettings().defaultVertical,
        )
      );
    },
    resolveSquadDispatch: (squadId, leaderId, workerId, binding, verticalId) => {
      const { request } = context();
      return withEdgeReadModel(
        {
          viewRoot: request.viewRoot,
          repoId: request.repoId,
          nodeId: request.nodeId,
          principalId: binding.actor.principal.personId,
          includeEntries: false,
        },
        (projection) =>
          resolveSquadDispatch({
            rootDir: request.workspaceRoot,
            ...(squadId ? { squadId } : {}),
            leaderId,
            ...(workerId ? { workerId } : {}),
            userRoot: input.daemonRoute.userRoot,
            repoId: request.repoId,
            verticalId: verticalId ?? readSettings().defaultVertical,
            entityStore: {
              get: (kind, id) => projection.getEntity(kind, id),
              list: (kind) => projection.listEntities(kind),
            },
          }),
      );
    },
    onRuntimeOutcome: (event) => {
      const { request } = context();

      withEdgeReadModel({ ...request, principalId: replicaOwner, includeEntries: false }, (projection) => {
        const session = projection.readRuntimeSession(event.payload.runtimeSessionId);
        for (const { taskId } of session?.taskBindings ?? [])
          if (projection.currentLease(taskId)?.phase !== "held") input.onTaskSettled?.(taskId);
      });
    },
    onAttemptTerminal: async (terminal) => {
      const { request, writePeer } = context();

      await squad.reconcile();
      const scheduled = terminal.schedule;
      if (!scheduled) return;
      const linked = await runScheduleCommand({
        ...writePeer,
        repoId: request.repoId,
        scheduleId: scheduled.scheduleId,
        opId: randomUUID(),
        action: {
          kind: "schedule-dispatch-link",
          scheduleId: scheduled.scheduleId,
          claimFence: scheduled.claimFence,
          dispatchId: terminal.dispatchId,
          runtimeSessionId: terminal.runtimeSessionId,
          idempotencyKey: `${terminal.runtimeSessionId}:terminal-link`,
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
        opId: randomUUID(),
        action: {
          kind: "schedule-settle",
          scheduleId: scheduled.scheduleId,
          claimFence: scheduled.claimFence,
          outcome: terminal.outcome,
          endedAt: terminal.endedAt,
          idempotencyKey: `${terminal.runtimeSessionId}:attempt-terminal`,
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
    onPendingSteerReceipt: () => triggerReceiptFlush(),
    schedule,
  });
  const receiptPump = createFleetEdgeSteerReceiptPump({
    hasPending: () => hasPendingSteerReceipts(context().request.workspaceRoot),
    flushPending: async () => {
      const { request } = context();
      await spawner.flushPendingSteerReceipts(await controlBinding(request));
    },
  });
  const triggerReceiptFlush = receiptPump.trigger;
  const squad = makeFleetSquadCoordinator({
    readDispatchLifecycle,
    get request() {
      return input.resolveLocation();
    },
    get peer() {
      return context().writePeer;
    },
    forwardTaskAction: input.forwardTaskAction,
    spawner,
    controlBinding,
    sync: async () => {
      await pullRuntimeReplica();
    },
    prepareWorkspace: prepareRuntimeWorkspace,
    readWorktreeSetup: () => readSettings().worktree,
    readResult: (ref) => {
      const { request } = context();
      return readEdgeRuntimeResult(request.viewRoot, request.repoId, request.nodeId, ref);
    },
  });
  const remoteControl = createFleetEdgeRuntimeControlConsumer({
    nodeId: () => input.resolveLocation().nodeId,
    activeRuntimeSessionIds: () => spawner.activeRuntimeSessionIds(),
    isRuntimeActive: (runtimeSessionId) => spawner.isRuntimeActive(runtimeSessionId),
    readDurableCursor: (runtimeSessionId) => {
      const dispatchId = spawner.activeDispatchId(runtimeSessionId);
      return dispatchId ? readDispatchControlCursor(input.resolveLocation().workspaceRoot, dispatchId) : 0;
    },
    advanceDurableCursor: (runtimeSessionId, revision) => {
      const dispatchId = spawner.activeDispatchId(runtimeSessionId);
      if (dispatchId) advanceDispatchControlCursor(input.resolveLocation().workspaceRoot, dispatchId, revision);
    },
    readSettledAboveCursor: (runtimeSessionId) => {
      const dispatchId = spawner.activeDispatchId(runtimeSessionId);
      return dispatchId ? readSettledControlOpIdsAboveCursor(input.resolveLocation().workspaceRoot, dispatchId) : [];
    },
    recordSettledAboveCursor: (runtimeSessionId, opId, revision) => {
      const dispatchId = spawner.activeDispatchId(runtimeSessionId);
      if (dispatchId)
        recordSettledControlAboveCursor(input.resolveLocation().workspaceRoot, dispatchId, opId, revision);
    },
    isSteerBackpressured: () =>
      pendingSteerReceiptCount(input.resolveLocation().workspaceRoot) >= PENDING_STEER_RECEIPT_HIGH_WATERMARK,
    readControlEventsPage: async (runtimeSessionId, afterRevision, limit) => {
      const request = input.resolveLocation();
      return readRuntimeProjection(request, (projection) => {
        const cut = projection.readCut(),
          events = projection.readRuntimeSessionEventsByType(
            runtimeSessionId,
            ["runtime_session_liveness_changed", "runtime_cancel_requested", "runtime_steer_requested"],
            { afterRevision, limit, filter: "control_request" },
          ) as readonly RemoteRuntimeControlEvent[];
        const maxRev = events.reduce((highest, event) => Math.max(highest, event.workspaceRevision), afterRevision);
        return {
          events,
          scannedToRevision: events.length < limit ? Math.max(maxRev, cut.watermark) : maxRev,
        };
      });
    },
    readCancelControlEvent: async (runtimeSessionId, afterRevision, limit) => {
      const request = input.resolveLocation();
      return readRuntimeProjection(request, (projection) => {
        const cut = projection.readCut(),
          events = projection.readRuntimeSessionEventsByType(
            runtimeSessionId,
            ["runtime_session_liveness_changed", "runtime_cancel_requested"],
            { afterRevision, limit, filter: "cancel_control_request" },
          ) as readonly RemoteRuntimeControlEvent[],
          event = events[0] ?? null;
        return {
          event,
          scannedToRevision: event ? event.workspaceRevision : cut.watermark,
        };
      });
    },
    executeCancel: async (controlRequest) => {
      const { request } = context();
      await spawner.cancel({ runtimeSessionId: controlRequest.runtimeSessionId }, await controlBinding(request));
    },
    executeSteer: async (controlRequest) => {
      const { request } = context();
      await spawner.steer(
        {
          runtimeSessionId: controlRequest.runtimeSessionId,
          prompt: controlRequest.prompt,
          ...(controlRequest.expected ? { expected: controlRequest.expected as unknown as JsonObject } : {}),
        },
        await controlBinding(request),
        {
          remoteControlRequestId: controlRequest.controlRequestId,
          remoteControlOpId: controlRequest.opId,
        },
      );
    },
    reportSteerRejection: (controlRequest, rejection) => {
      const { request } = context();
      recordPendingSteerReceipt(
        request.workspaceRoot,
        controlRequest.dispatchId,
        request.repoId,
        controlRequest.runtimeSessionId,
        {
          status: "rejected",
          controlRequestId: controlRequest.controlRequestId,
          requestOpId: controlRequest.opId,
          reasonCode: rejection.code,
          message: rejection.message,
        },
      );
      // F13: Wake the detached background receipt pump without awaiting any network RPC inside drain().
      triggerReceiptFlush();
    },
    schedule,
  });
  let ready: Promise<void> | null = null;
  let adoptedOnce = false;
  let closed = false;
  let adoptInFlight: Promise<void> | null = null;
  const ensureReady = (): Promise<void> => {
    if (ready === null) {
      const attempt = pullRuntimeReplica().then(() => {
        if (closed) return;
        const adoption = spawner
          .adopt()
          .then(
            (recovered) => {
              if (closed) return;
              if (!runtimeRecoveryError(recovered)) adoptedOnce = true;
              void remoteControl.drain().catch((error: unknown) => console.error("[runtime-remote-control]", error));
              if (hasPendingSteerReceipts(input.resolveLocation().workspaceRoot)) triggerReceiptFlush();
              schedule(() => squad.reconcile());
            },
            (error: unknown) => {
              if (!closed || (error as { readonly code?: unknown } | null)?.code !== "daemon_closed")
                console.error("[runtime-recovery]", error);
            },
          )
          .finally(() => {
            if (adoptInFlight === adoption) adoptInFlight = null;
          });
        adoptInFlight = adoption;
      });
      ready = attempt.catch((error: unknown) => {
        ready = null;
        adoptedOnce = false;
        throw error;
      });
    }
    return ready;
  };
  const forwardRemoteRuntimeControl = (
    kind: "runtime-cancel" | "runtime-steer",
    action: JsonObject,
    requestAuth?: DaemonAuthenticationContext,
  ): Promise<JsonObject> => {
    const { request, centerWriteWaitMs, writePeer } = context();
    return forwardFleetEdgeRemoteRuntimeControl({
      kind,
      action,
      ...(requestAuth ? { requestAuth } : {}),
      centerWriteWaitMs,
      request,
      writePeer,
    });
  };
  return {
    reconcile: async (signal?: AbortSignal) =>
      withExecutionSignal(signal, (connectionSignal) =>
        executionSignalContext.run(connectionSignal, async () => {
          const { request } = context();
          const hasPendingReceipts = hasPendingSteerReceipts(request.workspaceRoot);
          const hasActiveHandles = spawner.activeRuntimeCount() > 0;
          if (!adoptedOnce) {
            const hasDiskStreams = hasActiveHandles || countActiveDispatchStreams(request.workspaceRoot) > 0;
            if (!hasDiskStreams && !hasPendingReceipts) {
              adoptedOnce = true;
              return;
            }
            await ensureReady();
            const recovered = hasDiskStreams ? await spawner.adopt() : [];
            const failed = runtimeRecoveryError(recovered);
            if (!failed) adoptedOnce = true;
            await remoteControl.drain();
            if (hasPendingSteerReceipts(request.workspaceRoot)) triggerReceiptFlush();
            await schedule(async () => {
              await squad.flushPublications();
              await pullRuntimeReplica();
            });
            if (failed) throw failed;
            return;
          }
          // Steady-state ACK path (F4 & F13): zero readdirSync and zero spawner.adopt();
          // pending receipt uplinks run asynchronously off the control drain.
          if (hasPendingReceipts) triggerReceiptFlush();
          if (!hasActiveHandles) return;
          await ensureReady();
          await remoteControl.drain();
          await schedule(async () => {
            await squad.flushPublications();
          });
        }),
      ),
    run: async (
      method: FleetEdgeRuntimeRequest["payload"]["method"],
      action: JsonObject,
      connectionSignal?: AbortSignal,
    ): Promise<JsonObject> => {
      const requestAuth = currentForwardedRuntimeAuth();
      const { runtimeReadPeer, centerWriteWaitMs, request, writePeer } = context();

      if (method === "repo.agentRuntime.overview" || method === "repo.agentRuntime.sessions.read")
        return readReplica(method, action);
      const readBinding = await input.readBinding(request);
      let handoffControlBinding: import("./repo-cell-types.ts").RepoCellBinding | undefined;
      if (method === "repo.agentRuntime.sessions.await" && readBinding.keycloakAuthorization === undefined)
        return awaitLocalRuntimeSessions(action, readReplica, connectionSignal);
      if (method === "repo.tasks.autoClaimCandidates" || method === "repo.tasks.autoDispatchCandidates")
        return (await readFleetOperationalClient({
          ...runtimeReadPeer,
          timeoutMs: centerWriteWaitMs,
          repoId: request.repoId,
          method,
          payload: action,
          connectionSignal,
        })) as JsonObject;
      if (
        method === "repo.schedule.run" &&
        ["schedule-list", "schedule-show", "schedule-runs", "schedule-reckon"].includes(String(action.kind))
      )
        return withEdgeReadModel(
          { ...request, principalId: readBinding.actor.principal.personId, includeEntries: false },
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
      if (method === "repo.squad.control" && action.kind === "squad-cancel") return squad.run(action);
      if (method === "repo.agentRuntime.cancel") {
        const runtimeSessionId = typeof action.runtimeSessionId === "string" ? action.runtimeSessionId : null;
        let localTarget =
          action.escalation === true || (runtimeSessionId !== null && spawner.isRuntimeActive(runtimeSessionId));
        if (
          !localTarget &&
          runtimeSessionId !== null &&
          readReplicaGeneration(path.join(request.viewRoot, "repos", request.repoId, "views", request.nodeId)) !== null
        ) {
          const dispatch = await readRuntimeProjection(request, (projection) =>
            projection.readRuntimeDispatch(runtimeSessionId),
          );
          localTarget =
            typeof dispatch?.source === "object" &&
            dispatch.source !== null &&
            dispatch.source.kind === "node" &&
            dispatch.source.nodeId === request.nodeId;
        }
        if (localTarget) return spawner.cancel(action, await controlBinding(request));
        return forwardRemoteRuntimeControl("runtime-cancel", action, requestAuth);
      }
      if (method === "repo.agentRuntime.steer") {
        const selector: RuntimeSteerSelector | null =
          typeof action.dispatchId === "string"
            ? { dispatchId: action.dispatchId }
            : typeof action.runtimeSessionId === "string"
              ? { runtimeSessionId: action.runtimeSessionId }
              : null;
        let localTarget = selector !== null && spawner.activeRuntimeForSelector(selector) !== null;
        if (
          !localTarget &&
          selector !== null &&
          readReplicaGeneration(path.join(request.viewRoot, "repos", request.repoId, "views", request.nodeId)) !== null
        ) {
          const dispatch = await readRuntimeProjection(request, (projection) =>
            "dispatchId" in selector
              ? (projection.readRuntimeDispatchById(selector.dispatchId)?.event ?? null)
              : (projection.readRuntimeDispatch(selector.runtimeSessionId) ??
                projection.readLatestRuntimeDispatchBySession?.(selector.runtimeSessionId) ??
                null),
          );
          localTarget =
            typeof dispatch?.source === "object" &&
            dispatch.source !== null &&
            dispatch.source.kind === "node" &&
            dispatch.source.nodeId === request.nodeId;
        }
        if (localTarget) return spawner.steer(action, await controlBinding(request));
        return forwardRemoteRuntimeControl("runtime-steer", action, requestAuth);
      }
      // One clock spans a dispatch request from workspace preparation to provider launch; runtime_spawn reports its stages.
      return withDispatchStageClock(async () => {
        if (method === "repo.agentRuntime.spawn" && typeof action.taskId !== "string")
          await preflightRuntimeWorkspace();
        if (method === "repo.agentRuntime.spawn" && typeof action.taskId === "string")
          await prepareRuntimeWorkspace(action.taskId);
        if (method === "repo.agentRuntime.handoff" && action.operation === "claim") {
          handoffControlBinding = await controlBinding(request);
          await preflightRuntimeWorkspace();
        }
        await ensureReady();
        await squad.flushPublications();
        if (method === "repo.squad.control") return squad.run(action);
        if (method === "repo.schedule.run") return runSchedule(action);
        if (method === "repo.agentRuntime.handoff")
          return runRuntimeHandoff({
            readDispatchLifecycle,
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
                    opId: randomUUID(),
                    waitMs: centerWriteWaitMs,
                    action: command as { kind: string },
                    ...(body ? { privatePayload: body } : {}),
                  }),
              });
              return result.receipt as JsonObject;
            },
            spawn: async (checkpoint, spawn, rollout) =>
              spawner.spawnHandoff(
                checkpoint,
                spawn,
                handoffControlBinding ?? (await controlBinding(request)),
                null,
                rollout,
              ),
          });
        if (method === "repo.agentRuntime.spawn") {
          const prepared = action.recovery === undefined ? null : await prepareEdgeRecoverySpawn(action);
          if (prepared?.replay) return prepared.replay;
          const spawnPayload = prepared?.payload ?? action;
          const receipt = await withExecutionSignal(connectionSignal, (connectionSignal) =>
            executionSignalContext.run(connectionSignal, () =>
              reviewSpawnContext.run(
                {
                  ...(typeof spawnPayload.runtimeInstanceId === "string"
                    ? { runtimeInstanceId: spawnPayload.runtimeInstanceId }
                    : {}),
                  ...(typeof spawnPayload.preferredRuntimeInstanceId === "string"
                    ? { preferredRuntimeInstanceId: spawnPayload.preferredRuntimeInstanceId }
                    : {}),
                  ...(typeof spawnPayload.agentId === "string" ? { agentId: spawnPayload.agentId } : {}),
                },
                async () =>
                  spawner.spawn(
                    prepared?.payload ?? action,
                    await controlBinding(request),
                    null,
                    Boolean(prepared?.recovery),
                  ),
              ),
            ),
          );
          return prepared?.recovery ? { ...receipt, recovery: { ...prepared.recovery, replayed: false } } : receipt;
        }
        return (await readFleetOperationalClient({
          ...runtimeReadPeer,
          repoId: request.repoId,
          method,
          payload: action,
          connectionSignal,
        })) as JsonObject;
      });
    },
    close: async () => {
      closed = true;
      receiptPump.close();
      workQueue.close();
      await spawner.close();
      await Promise.allSettled([adoptInFlight, workQueue.drain()]);
      await spawner.close();
    },
  };

  async function prepareEdgeRecoverySpawn(action: JsonObject): Promise<
    | { readonly replay: JsonObject; readonly payload?: undefined; readonly recovery?: undefined }
    | {
        readonly replay?: undefined;
        readonly payload: JsonObject;
        readonly recovery: Exclude<ReturnType<typeof admitTaskDispatch>, { kind: "replay" }>["recovery"];
      }
  > {
    const { request } = context();
    await pullRuntimeReplica();
    const admitted = await readRuntimeProjection(request, (projection) =>
      admitTaskDispatch({
        repoId: request.repoId,
        rootDir: request.workspaceRoot,
        projection: projection as TaskProjection,
        payload: action,
      }),
    );
    if (admitted.kind === "replay")
      return {
        replay: {
          ...runtimeSpawnReceipt(
            admitted.event,
            { cut: { opId: admitted.event.opId, revision: admitted.event.workspaceRevision } } as never,
            admitted.event.payload.runtimeSessionId,
            admitted.event.payload.dispatchId,
          ),
          recovery: admitted.recovery,
        } as unknown as JsonObject,
      };
    return { payload: admitted.payload, recovery: admitted.recovery };
  }

  async function readRuntimeProjection<T>(
    request: FleetRuntimeLocation,
    read: Parameters<typeof withEdgeReadModel<T>>[1],
  ): Promise<T> {
    const principalId = (await input.readBinding(request)).actor.principal.personId;
    return withEdgeReadModel({ ...request, principalId, includeEntries: false }, read);
  }

  async function awaitLocalRuntimeSessions(
    payload: JsonObject,
    read: (method: Parameters<typeof readEdgeRuntimeRepository>[1], payload: JsonObject) => Promise<JsonObject>,
    connectionSignal?: AbortSignal,
  ): Promise<JsonObject> {
    const { request } = context();

    return orchestrateRuntimeSessionsAwait(payload, {
      readSession: async (runtimeSessionId) =>
        (await read("repo.agentRuntime.sessions.read", { runtimeSessionId })) as never,
      readTaskDispatches: async (taskIds) =>
        readAllTaskDispatchPages(
          async (facets) =>
            (await read("repo.task.dispatches", {
              taskIds: taskIds as string[],
              limit: DISPATCH_LIFECYCLE_PAGE_LIMIT,
              ...facets,
            })) as never,
        ),
      awaitSignal: () => waitForLocalReplicaChange(request.viewRoot, request.repoId, request.nodeId, connectionSignal),
      connectionSignal,
      codedError: (code, message) => Object.assign(new Error(message), { code }),
    });
  }

  async function runSchedule(action: JsonObject): Promise<JsonObject> {
    const { writePeer, request } = context();

    const actionKind = requiredScheduleText(action.kind, "kind"),
      assigned = await readFleetRepositoryMetadataClient(writePeer),
      scheduleId = typeof action.scheduleId === "string" ? action.scheduleId : request.repoId;
    if (actionKind === "schedule-run-now")
      await assertFleetEdgeRepositoryGit({
        rootDir: request.workspaceRoot,
        center: await readFleetRepositoryMetadataClient({ ...writePeer, includeGitMetadata: true }),
        operation: "runtime dispatch",
      });
    const operationKey =
        typeof action.idempotencyKey === "string" && action.idempotencyKey ? action.idempotencyKey : randomUUID(),
      command = await runScheduleCommand({
        ...writePeer,
        repoId: request.repoId,
        scheduleId,
        opId: randomUUID(),
        writerEpoch: assigned.writerEpoch,
        action: { ...action, kind: actionKind, scheduleId, idempotencyKey: operationKey },
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
      trustedAgent = readProjectedAgentDeclaration(receipt.trustedAgent);
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
        const spawned = await spawner.spawnScheduled(scheduled, await controlBinding());
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
          opId: randomUUID(),
          action: { kind: "schedule-dispatch-link", ...linked, idempotencyKey },
        }),
      settleFailure: ({ idempotencyKey, ...failed }) =>
        runScheduleCommand({
          ...writePeer,
          repoId: request.repoId,
          scheduleId,
          opId: randomUUID(),
          action: { kind: "schedule-settle", ...failed, idempotencyKey },
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
    const { request } = context();

    let generation = readReplicaGeneration(
      path.join(request.viewRoot, "repos", request.repoId, "views", request.nodeId),
    );
    if (!generation && input.waitForReplicaReady && (await input.waitForReplicaReady(request)))
      generation = readReplicaGeneration(path.join(request.viewRoot, "repos", request.repoId, "views", request.nodeId));
    if (!generation) throw edgeRuntimeError("replica_unavailable", "The edge replica has not been initialized.");
    const pulled = { replica: { viewId: request.nodeId, knownHead: generation.metadata.position } };
    replicaOwner = (await input.readBinding(request)).actor.principal.personId;
    return pulled;
  }

  async function prepareRuntimeWorkspace(taskId?: string): Promise<void> {
    const { request } = context();

    await timeDispatchStage("workspace_preflight", preflightRuntimeWorkspace);
    const pulled = await pullRuntimeReplica();
    let requestedPaths: readonly string[] | undefined;
    if (taskId !== undefined) {
      const view = locateFleetMirrorView(request.viewRoot, request.repoId, request.nodeId, {
        entriesPrefix: `tasks/${taskId}`,
      });
      requestedPaths = view === null ? [] : fleetMirrorTaskPaths(view, taskId);
    }
    const materialized = await timeDispatchStage("mirror_materialize", () =>
      applyFleetMirrorCut(request.viewRoot, request.repoId, request.workspaceRoot, "pull", {
        viewId: pulled.replica.viewId,
        ...(requestedPaths === undefined ? { changedPaths: [] } : { request: { paths: requestedPaths } }),
      }),
    );
    if (materialized.outcome === "pull_blocked")
      throw edgeRuntimeError(
        "pull_blocked",
        "The runtime workspace cannot materialize the canonical cut because local changes conflict.",
      );
  }

  async function preflightRuntimeWorkspace(): Promise<void> {
    const { writePeer, request } = context();

    const centerGit = await readFleetRepositoryMetadataClient({ ...writePeer, includeGitMetadata: true });
    await assertFleetEdgeRepositoryGit({
      rootDir: request.workspaceRoot,
      center: centerGit,
      operation: "runtime dispatch",
    });
  }
}

function taskRuntimeContext(
  read: Readonly<Record<string, unknown>>,
  taskId: string,
): {
  readonly causalContext: string | null;
  readonly riskTier: "low" | "medium" | "high" | null;
  readonly riskTierFlowVersion: 1 | null;
  readonly profileId: string | null;
  readonly escalationContext: string | null;
  readonly reviewerNote: string | null;
  readonly worktree: TaskWorktreeBindingV1 | null;
  readonly continuationContext: import("./runtime-continuation-context.ts").RuntimeContinuationSeed | null;
  readonly snapshot: import("./repo-cell-types.ts").Snapshot & {
    readonly workspace: import("./protocol/daemon-protocol-results.ts").TaskWorkspaceView | null;
  };
} {
  const worktree = read.worktree as { readonly branch?: unknown; readonly path?: unknown } | null | undefined;
  if (
    read.schema === "task-runtime-context-read/v3" &&
    read.ok === true &&
    read.taskId === taskId &&
    (read.causalContext === null || typeof read.causalContext === "string") &&
    (read.riskTier === null || ["low", "medium", "high"].includes(String(read.riskTier))) &&
    (read.riskTierFlowVersion === null || read.riskTierFlowVersion === 1) &&
    (read.profileId === null || typeof read.profileId === "string") &&
    (read.escalationContext === undefined ||
      read.escalationContext === null ||
      typeof read.escalationContext === "string") &&
    (read.reviewerNote === null || typeof read.reviewerNote === "string") &&
    (worktree === null ||
      (typeof worktree === "object" && typeof worktree.branch === "string" && typeof worktree.path === "string")) &&
    read.snapshot !== null &&
    typeof read.snapshot === "object"
  )
    return {
      causalContext: read.causalContext,
      escalationContext: typeof read.escalationContext === "string" ? read.escalationContext : null,
      riskTier: read.riskTier === null ? null : (read.riskTier as "low" | "medium" | "high"),
      riskTierFlowVersion: read.riskTierFlowVersion === null ? null : 1,
      profileId: read.profileId === null ? null : (read.profileId as string),
      reviewerNote: read.reviewerNote === null ? null : (read.reviewerNote as string),
      worktree: worktree ? { branch: worktree.branch as string, path: worktree.path as string } : null,
      continuationContext:
        read.continuationContext === null
          ? null
          : {
              dispatchId:
                typeof (read.continuationContext as { readonly dispatchId?: unknown }).dispatchId === "string"
                  ? (read.continuationContext as { readonly dispatchId: string }).dispatchId
                  : (() => {
                      throw edgeRuntimeError(
                        "runtime_read_invalid",
                        "Replica returned an invalid continuation context.",
                      );
                    })(),
              lastConclusion:
                (read.continuationContext as { readonly lastConclusion?: unknown }).lastConclusion === null ||
                typeof (read.continuationContext as { readonly lastConclusion?: unknown }).lastConclusion === "string"
                  ? (read.continuationContext as { readonly lastConclusion: string | null }).lastConclusion
                  : (() => {
                      throw edgeRuntimeError(
                        "runtime_read_invalid",
                        "Replica returned an invalid continuation context.",
                      );
                    })(),
              exitHead:
                (read.continuationContext as { readonly exitHead?: unknown }).exitHead === null ||
                typeof (read.continuationContext as { readonly exitHead?: unknown }).exitHead === "string"
                  ? (read.continuationContext as { readonly exitHead: string | null }).exitHead
                  : (() => {
                      throw edgeRuntimeError(
                        "runtime_read_invalid",
                        "Replica returned an invalid continuation context.",
                      );
                    })(),
            },
      snapshot: read.snapshot as import("./repo-cell-types.ts").Snapshot & {
        readonly workspace: import("./protocol/daemon-protocol-results.ts").TaskWorkspaceView | null;
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
function findMirroredAgentDeclaration(
  request: Pick<FleetEdgeRuntimeRequest["payload"], "viewRoot" | "repoId" | "workspaceRoot" | "nodeId">,
  agentId: string,
  verticalId?: string,
): RuntimeAgent | undefined {
  const logical = `agents/${agentId}.json`;
  if (
    entitySlug(agentId) &&
    locateFleetMirrorView(request.viewRoot, request.repoId, request.nodeId, { entryPaths: [logical] })?.entries.has(
      logical,
    )
  )
    return readProjectedAgentDeclaration(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          readAuthoredDocumentBytes(resolveHarnessLayout(request.workspaceRoot).authoredRoot, logical),
        ),
      ),
    );
  if (!verticalId) return undefined;
  return readBundledAgentDeclaration(agentId, verticalId, request.workspaceRoot) ?? undefined;
}

function mirroredAgentDeclaration(
  request: Pick<FleetEdgeRuntimeRequest["payload"], "viewRoot" | "repoId" | "workspaceRoot" | "nodeId">,
  agentId: string,
  userRoot: string,
  verticalId?: string,
): RuntimeAgent {
  const localRecord = readLocalAgentRecord(userRoot, request.repoId, agentId),
    shared = findMirroredAgentDeclaration(request, agentId);
  if (
    localRecord &&
    shared &&
    !localDeclarationMatchesSharedValue(localRecord.declaration, shared, localRecord.pendingTransfer)
  )
    throw edgeRuntimeError("agent_scope_conflict", `Agent ${agentId} exists in both local and shared scope.`);
  if (shared) return shared;
  if (localRecord) return localRecord.declaration;
  const declaration = verticalId ? readBundledAgentDeclaration(agentId, verticalId, request.workspaceRoot) : null;
  if (declaration) return declaration;
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

function mirroredPlanContract(contractBody: string | null, taskId: string) {
  return resolveMirroredPlanContract(contractBody, taskId, edgeRuntimeError);
}

function edgeRuntimeError(code: string, message: string, retryable?: boolean): Error {
  return Object.assign(new Error(message), retryable === undefined ? { code } : { code, retryable });
}
