import { fleetMirrorTaskPaths } from "./fleet-edge-mirror.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { requiredCellText } from "./repo-cell-settlement.ts";
import { operationId } from "./repo-cell-proof.ts";
import {
  canStartExecution,
  consumeKnownError,
  isNativeExecution,
  type RepositorySettingsV1,
  type RuntimeProviderUnreachable,
  type TaskProjection,
} from "@harness-anything/kernel";
import { readEdgeRuntimeRepository } from "./fleet-edge-runtime-read.ts";
import { repositoryRuntimeReads } from "./repository-runtime-reads.ts";
import { repositoryReadData } from "./protocol/repository-read-frame.ts";
import { readEdgeDispatchLifecycle, withEdgeReadModel } from "./fleet-edge-task-read.ts";
import { makeFleetSquadCoordinator } from "./fleet-squad-coordinator.ts";
import { readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { readEdgeViewBlob, readEdgeRuntimeResult } from "./runtime-result-read.ts";
import { runRuntimeHandoff } from "./runtime-handoff.ts";
import { readAuthoredDocumentBytes } from "./authored-document-read-port.ts";
import { recordRuntimeExecutionPrincipal } from "./runtime-execution-principal-store.ts";
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
  runFleetEdgeUploadClient,
  runFleetEdgeTaskCommand,
} from "./fleet-edge-write.ts";
import { applyFleetMirrorCut, locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { transitionDocumentReadinessContract } from "./transition-document-access.ts";
import { validateAgentRuntimeOverview, type AgentRuntimeOverviewResult } from "./agent-runtime-contract.ts";
import { makeRuntimeSpawner, type RuntimeDaemonRoute, type RuntimeLauncher } from "./runtime-spawn.ts";
import type { ReviewerReviewRecoveryInput, RuntimeAgent, RuntimeSessionSelection } from "./runtime-spawn-types.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { readReplicaGeneration } from "./fleet/replica-generation.ts";
import { runFleetEdgeWrite, transientFleetReceipt } from "./fleet-edge-write.ts";
import { readScheduleAction, dispatchClaimedSchedule } from "./schedule-action-runtime.ts";
import { orchestrateRuntimeSessionsAwait } from "./runtime-orchestration.ts";
import { prepareScheduleOccurrenceWorkspace, scheduleSettlementDetail } from "./schedule-occurrence-workspace.ts";
import { taskMissionSections, taskPlanSection, runtimeMissionName } from "./runtime-spawn-mission.ts";
import { reconcileProcessGroup } from "./runtime/process-group-reconciler.ts";
import { readRuntimeDispatchOwnerEvidence } from "./runtime-spawn-control.ts";
import { runtimeForwardingContext } from "./fleet/forwarding-port.ts";
import type { FleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { assertFleetEdgeRepositoryGit } from "./fleet-edge-git-preflight.ts";

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
type RuntimePorts = {
  readonly runtimeInstances: () => readonly RuntimeInstanceSummary[];
  readonly prepareRuntimeLaunch: (instanceId: string, request: RuntimeLaunchRequest) => Promise<PreparedRuntimeLaunch>;
  readonly prepareCloudRelay: NonNullable<Parameters<typeof makeRuntimeSpawner>[0]["prepareCloudRelay"]>;
  readonly reclaimRuntimeTempDirectory: (instanceId: string, runtimeSessionId: string) => Error | null;
  readonly listRuntimeTempSessionIds?: () => readonly string[];
  readonly reclaimSettledRuntimeTempDirectories: (
    settledRuntimeSessionIds: readonly string[],
  ) => { readonly instanceId: string; readonly runtimeSessionId: string; readonly error: Error }[];
  readonly prepareDaemonGitEnvironment: (
    instanceId: string,
    provider: "github" | "gitlab",
    repoId: string,
  ) => Promise<NodeJS.ProcessEnv | null>;
};
const runtimeOverviewPageLimit = 16;
const localReplicaWaitBackstopMs = 1_000;

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
    readonly liveness: "live" | "stale" | "unknown" | "exited";
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | null;
    readonly providerUnreachable: RuntimeProviderUnreachable | null;
  }[]
> {
  const sessions: Array<{
    readonly runtimeSessionId: string;
    readonly providerSessionId: string | null;
    readonly instanceId: string;
    readonly liveness: "live" | "stale" | "unknown" | "exited";
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "stopped" | null;
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
    close: () => {
      closed = true;
    },
  };
}

export function openFleetEdgeRuntime(input: {
  readonly request: FleetRuntimeLocation;
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
  readonly now?: () => string;
}) {
  const controlBinding = input.controlBinding,
    now = input.now ?? (() => new Date().toISOString()),
    stream = { publish: () => ({}) as never };
  const context = () => runtimeForwardingContext(input.request, () => input.readAccessToken(input.request));
  const readSettings = () => {
    const { request } = context();
    return withEdgeReadModel({ ...request, principalId: replicaOwner }, (projection) => ({
      ...readSettingsFacet(readFileSync(resolveHarnessLayout(request.workspaceRoot).configPath!, "utf8")),
      ...((projection.getEntity("settings", "repository")?.value as RepositorySettingsV1 | undefined) ?? {}),
    }));
  };
  let replicaOwner: string | undefined;
  const readMirroredDocument = (logicalPath: string): string | null => {
    const { request } = context();

    if (replicaOwner === undefined) return null;
    return withEdgeReadModel(
      { ...request, principalId: replicaOwner, includeEntries: true },
      (projection) => projection.readDocument(logicalPath).document?.body ?? null,
    );
  };
  const readMirroredEscalationAnswer = (packagePath: string): string | null => {
    const { request } = context();

    if (replicaOwner === undefined) return null;
    const documents = withEdgeReadModel({ ...request, principalId: replicaOwner, includeEntries: true }, (projection) =>
      projection.readDocuments(`${packagePath}/artifacts/rulings/`).documents.map((document) => ({
        ...document,
        body: projection.readDocument(document.path).document?.body ?? "",
      })),
    );
    const answers = documents
      .filter((document) => document.path.endsWith(".resolution.md"))
      .flatMap((document) => {
        try {
          const value = JSON.parse(document.body) as Record<string, unknown>;
          return value.schema === "worker-escalation-resolution/v1" &&
            typeof value.dispatchId === "string" &&
            typeof value.answer === "string" &&
            value.answer.trim() !== "" &&
            typeof value.answeredAt === "string"
            ? [{ dispatchId: value.dispatchId, answer: value.answer, answeredAt: value.answeredAt }]
            : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => left.answeredAt.localeCompare(right.answeredAt))
      .at(-1);
    return answers ? `Owner answer to worker escalation ${answers.dispatchId}: ${answers.answer}` : null;
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

    const view = locateFleetMirrorView(request.viewRoot, request.repoId, request.nodeId);
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
    if (!execution || Date.parse(execution.expiresAt) <= Date.now())
      throw edgeRuntimeError(
        "execution_credential_rejected",
        "Center did not issue a live review recovery credential.",
      );
    if (
      review.binding.actor.executor?.id !== `runtime-session:${review.runtimeSessionId}` ||
      review.binding.actor.principal.personId !== execution.personId ||
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
      view = locateFleetMirrorView(request.viewRoot, request.repoId, request.nodeId),
      reportClass = classifyTextualArtifactPath(review.report.path);
    if (
      !view ||
      !reportClass ||
      packetPath !== review.packet.path ||
      review.report.path !== `${reportPackage}/artifacts/reports/${review.dispatchId}.md`
    )
      throw edgeRuntimeError("review_report_invalid", "Review recovery artifacts do not match the dispatch package.");
    const [candidate] = await runFleetEdgeUploadClient({
      ...writePeer,
      timeoutMs: 60_000,
      changes: [
        {
          path: review.report.path,
          body: Buffer.from(review.report.body, "utf8"),
          mediaType: reportClass.mediaType,
        },
      ],
    });
    if (!candidate) throw edgeRuntimeError("review_report_missing", "Review report upload returned no content claim.");
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
          executionCredential: execution.credential,
          opId: recoveryOpId,
          repoId: request.repoId,
          taskId: review.taskId,
          action,
          waitMs: centerWriteWaitMs,
          timeoutMs: centerWriteWaitMs + 10_000,
          docChanges: [
            {
              path: review.report.path,
              baseBlobSha256: view.entries.get(review.report.path)?.sha256 ?? null,
              policyId: reportClass.policyId,
              candidate,
            },
          ],
          mirrorBaseCut: { revision: view.revision, headDigest: view.headDigest },
        });
    const result = await runFleetEdgeTaskCommand({
      timeoutMs: centerWriteWaitMs + 60_000,
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
  const spawner = makeRuntimeSpawner({
    get repoId() {
      return input.request.repoId;
    },
    get rootDir() {
      return input.request.workspaceRoot;
    },
    daemonGeneration: input.daemonGeneration,
    get runtimeNode() {
      return { nodeId: input.request.nodeId };
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
      taskContext: async (taskId, missionName, review, onClaimed) => {
        const { request, centerWriteWaitMs, writePeer } = context();

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
        const activeExecution = current.executions.find(
          (execution) =>
            isNativeExecution(execution) &&
            execution.iteration === current.task?.iteration &&
            execution.state === "active",
        );
        const taskStartExecutionId = activeExecution?.executionId ?? "runtime-task-start-" + taskId;
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
                action: {
                  kind: "task-start",
                  taskId,
                  ...(activeExecution ? { executionId: activeExecution.executionId } : {}),
                },
                waitMs: centerWriteWaitMs,
                timeoutMs: centerWriteWaitMs + 10_000,
              }),
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
          runtimeContext = taskRuntimeContext(await readReplica("repo.tasks.runtimeContext.read", { taskId }), taskId);
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
          { causalContext, riskTier, profileId, riskTierFlowVersion, worktree, reviewerNote } = runtimeContext;
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
        const priorIteration = current.task && current.task.iteration > 0 ? current.task.iteration - 1 : null,
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
              readMirroredEscalationAnswer(candidates[0]!),
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
      readRuntimeSession: (runtimeSessionId) =>
        readRuntimeProjection(input.request, (projection) => projection.readRuntimeSession(runtimeSessionId)),
      readRuntimeSessions: async (query) => {
        const request = input.request;
        if (query?.unsettledOnly || query?.runtimeSessionId !== undefined || query?.providerSessionId !== undefined)
          return readRuntimeProjection(request, (projection) => readEdgeRuntimeSessions(projection, query));
        return readFleetRuntimeSessionsPaged((payload) =>
          readRuntimeProjection(request, (projection, frame, view) => ({
            ...repositoryRuntimeReads(
              projection as TaskProjection,
              { readContentBlob: (sha256) => readEdgeViewBlob(view, sha256) },
              undefined,
              request.viewRoot,
              true,
              false,
            ).overview(payload),
            ...frame,
          })),
        );
      },
      readDispatchLifecycle: (query) =>
        readRuntimeProjection(input.request, (projection, frame) =>
          readEdgeDispatchLifecycle(projection, frame, query),
        ),
      readRuntimeDispatch: (runtimeSessionId) =>
        readRuntimeProjection(input.request, (projection) =>
          readRuntimeDispatchOwnerEvidence(projection, runtimeSessionId),
        ),
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
        if (draft.type === "runtime_session_started") await pullRuntimeReplica();
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
        const sanitizedReceipt = {
          ...receipt,
          ...(typeof executionPrincipalId === "string" ? { executionPrincipalId } : {}),
        } as JsonObject;
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
    prepareLaunch: input.ports.prepareRuntimeLaunch,
    prepareCloudRelay: input.ports.prepareCloudRelay,
    reclaimRuntimeTempDirectory: input.ports.reclaimRuntimeTempDirectory,
    ...(input.ports.listRuntimeTempSessionIds
      ? { listRuntimeTempSessionIds: input.ports.listRuntimeTempSessionIds }
      : {}),
    reclaimSettledRuntimeTempDirectories: input.ports.reclaimSettledRuntimeTempDirectories,
    prepareDaemonGitEnvironment: input.ports.prepareDaemonGitEnvironment,
    resolveAgent: (agentId) => {
      const { request } = context();
      return trustedScheduleAgents.get(agentId) ?? mirroredAgentDeclaration(request, agentId);
    },
    resolveSquadDispatch: (squadId, leaderId, workerId, binding) => {
      const { request } = context();
      return withEdgeReadModel(
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
      const { request, centerWriteWaitMs, writePeer } = context();

      if (terminal.task) {
        const { taskId, executionId } = terminal.task,
          processGroupPid = terminal.processGroupPid;
        if (
          Number.isSafeInteger(processGroupPid) &&
          Number(processGroupPid) > 1 &&
          reconcileProcessGroup({
            pid: Number(processGroupPid),
            pgid: Number(processGroupPid),
            dispatch: { rootDir: request.workspaceRoot, dispatchId: terminal.dispatchId },
          }) !== "proven_stopped"
        )
          throw edgeRuntimeError(
            "runtime_lease_release_failed",
            `Runtime process group ${String(processGroupPid)} was not proven stopped on the edge.`,
          );
        const settled = await runFleetEdgeWrite({
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
                terminalExecutionId: executionId,
                terminalRuntimeSessionId: terminal.runtimeSessionId,
                ...(Number.isSafeInteger(processGroupPid) && Number(processGroupPid) > 1
                  ? { terminalProcessGroupPid: Number(processGroupPid) }
                  : {}),
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
            settled.code === "lease_conflict"
              ? "lease_conflict"
              : settled.code === "runtime_process_group_unproven"
                ? "runtime_process_group_unproven"
                : settled.code === "execution_credential_rejected"
                  ? "execution_credential_rejected"
                  : "runtime_lease_release_failed",
            `Center rejected Runtime terminal lease settlement: ${String(settled.code ?? settled.outcome)}.`,
          );
        await pullRuntimeReplica();
      }
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
    schedule,
  });
  const squad = makeFleetSquadCoordinator({
    get request() {
      return input.request;
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
  let ready: Promise<void> | null = null;
  const ensureReady = (): Promise<void> => {
    if (ready === null) {
      const attempt = pullRuntimeReplica().then(() => {
        void spawner.adopt().then(
          () => {
            schedule(() => squad.reconcile());
          },
          (error: unknown) => console.error("[runtime-recovery]", error),
        );
      });
      ready = attempt.catch((error: unknown) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  };
  return {
    reconcile: async () => {
      const { request } = context();

      if (readDispatchStreamHeaders(request.workspaceRoot).length === 0) return;
      await ensureReady();
      const recovered = await spawner.adopt();
      await schedule(async () => {
        await squad.flushPublications();
        await pullRuntimeReplica();
      });
      const failed = runtimeRecoveryError(recovered);
      if (failed) throw failed;
    },
    run: async (
      method: FleetEdgeRuntimeRequest["payload"]["method"],
      action: JsonObject,
      connectionSignal?: AbortSignal,
    ): Promise<JsonObject> => {
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
      if (method === "repo.squad.control" && action.kind === "squad-cancel") return squad.run(action);
      if (method === "repo.agentRuntime.cancel") return spawner.cancel(action, await controlBinding(request));
      if (method === "repo.agentRuntime.steer") return spawner.steer(action, await controlBinding(request));
      if (method === "repo.agentRuntime.spawn" && typeof action.taskId !== "string") await preflightRuntimeWorkspace();
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
      return method === "repo.agentRuntime.spawn"
        ? spawner.spawn(action, await controlBinding(request))
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
        (await read("repo.task.dispatches", { taskIds: taskIds as string[] })) as never,
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

    await preflightRuntimeWorkspace();
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
  readonly reviewerNote: string | null;
  readonly worktree: TaskWorktreeBindingV1 | null;
  readonly continuationContext: import("./runtime-continuation-context.ts").RuntimeContinuationSeed | null;
  readonly snapshot: import("./repo-cell-types.ts").Snapshot & {
    readonly workspace: import("./protocol/daemon-protocol-gui-types.ts").TaskWorkspaceView | null;
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
    (read.reviewerNote === null || typeof read.reviewerNote === "string") &&
    (worktree === null ||
      (typeof worktree === "object" && typeof worktree.branch === "string" && typeof worktree.path === "string")) &&
    read.snapshot !== null &&
    typeof read.snapshot === "object"
  )
    return {
      causalContext: read.causalContext,
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
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          readAuthoredDocumentBytes(resolveHarnessLayout(request.workspaceRoot).authoredRoot, logical),
        ),
      ),
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
function mirroredPlanContract(contractBody: string | null, taskId: string) {
  let contractJson: unknown;
  try {
    if (contractBody === null) throw new Error("task contract unavailable");
    contractJson = JSON.parse(contractBody);
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
