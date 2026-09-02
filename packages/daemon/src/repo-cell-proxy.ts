import path from "node:path";
import {
  makeGitEventStore,
  makeTaskEventReader,
  makeTaskProjectionReader,
  timestamp,
  type TaskProjection,
  type TaskProjectionListQuery,
  type TaskProjectionQueries,
} from "../../kernel/src/index.ts";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import { makeAgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { readRuntimeAttemptChain, readSessionGroupDispatches, readTaskDispatches } from "./dispatch-read.ts";
import { openReplicaCutSource } from "./fleet/replica-cut-store.ts";
import { readObserveEventTail, readObserveTail } from "./observe-tail.ts";
import { openTerminalHost } from "./terminal-host.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { createRepoCellApi, repoCellSynchronousRead, type RepoCellApiContext } from "./repo-cell-api.ts";
import { dispatchRead } from "./repo-cell-command.ts";
import { acquireWorkspaceLock } from "./repo-cell-lock.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import { operationId } from "./repo-cell-proof.ts";
import { requiredCellText } from "./repo-cell-settlement.ts";
import { makeRepoCellSettingsState } from "./repo-cell-settings-state.ts";
import { listTasks, type TaskQueryCell } from "./repo-cell-task-query.ts";
import type { RepoCell, RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { makeSquadCoordinator } from "./squad-coordinator.ts";
import { openWriterSupervisor } from "./writer-supervisor.ts";
import { workspaceSummaryFromProjection } from "./workspace-summary-read.ts";

/** Host-side RepoCell boundary: admission/proxy plus completed-cut projection reads only. */
export async function openRepoCellProxy(input: RepoCellOpenInput): Promise<RepoCell> {
  const lock = await acquireWorkspaceLock(input.rootDir);
  let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>>;
  try {
    supervisor = await openWriterSupervisor(input);
  } catch (error) {
    await lock.close();
    throw error;
  }
  const reader = makeTaskProjectionReader({ rootDir: input.rootDir, ...(input.now ? { now: input.now } : {}) }),
    git = makeGitEventStore({ repoId: input.repoId, rootDir: input.rootDir, authoredBranch: input.authoredBranch }),
    replica = openReplicaCutSource({
      repoId: input.repoId,
      localRoot: path.dirname(path.dirname(reader.path)),
      readBasis: (afterRevision) => reader.withSession((projection) => projection.readReplicaBasis(afterRevision)),
      readLedgerCut: git.currentCut,
      readContentBlob: git.readContentBlob,
      readEvent: git.readEvent,
      readApplied: (opId) => reader.withSession((projection) => projection.readOperation(opId)),
    }),
    runtime = makeAgentRuntimeStreamHub({
      readSession: (runtimeSessionId) =>
        reader.withSession((projection) => projection.readRuntimeSession(runtimeSessionId)),
      canAttach: (session) =>
        session.attachable &&
        reader.withSession((projection) =>
          Boolean(projection.readRuntimeInstallation(session.installationId)?.effectiveCapabilities.includes("attach")),
        ),
      ...(input.now ? { now: () => new Date(input.now!()) } : {}),
    }),
    terminalHost = openTerminalHost({
      repoId: input.repoId,
      rootDir: input.rootDir,
      daemonGeneration: supervisor.status().generation ?? Date.now() * 1_000 + (process.pid % 1_000),
      ...(input.now ? { now: input.now } : {}),
    });
  let closed = false;

  const query = <T>(read: (projection: TaskProjectionQueries) => T): T => {
    if (closed) throw cellCodedError("repo_unavailable", "RepoCell is closed.");
    const status = supervisor.status();
    if (status.state !== "attached" && status.state !== "unavailable")
      throw cellCodedError("repo_unavailable", status.lastError ?? "RepoWriterCell is not ready.");
    // An unavailable writer never causes a repair from a serving read. SQLite either
    // returns the last completed transaction or an explicit read error.
    return reader.withSession(read);
  };
  const latched = (): string => {
    const status = supervisor.status(),
      cause = status.lastError ?? "RepoCell is unavailable.";
    return status.causeClass === "infrastructure"
      ? `this workspace stays latched until its Git or lock infrastructure recovers: repair the infrastructure cause below, then rerun the command; the next attempt re-probes the workspace and re-attaches automatically once it verifies. Cause: ${cause}`
      : status.causeClass === "projection"
        ? `this workspace stays latched until its projection verifies: run ha daemon projection rebuild to repair the projection cause below; this command remains available while latched and re-attaches automatically once the projection verifies. Cause: ${cause}`
        : `this workspace stays latched until its ledger data verifies: repair the data-shape cause below, then rerun the command; the next attempt re-probes the ledger and re-attaches automatically once the data verifies. Cause: ${cause}`;
  };
  const readAtCut = <M extends Parameters<RepoCell["read"]>[0]>(
    projection: TaskProjectionQueries,
    method: M,
    payload: Readonly<Record<string, unknown>>,
    binding?: RepoCellBinding,
  ): Awaited<ReturnType<RepoCell["read"]>> => {
    const writableProjection = projection as TaskProjection,
      needsWalOverlay = (
        [
          "repo.entity.actions.explain",
          "repo.agentRuntime.overview",
          "repo.agentRuntime.sessionGroups",
          "repo.agentRuntime.sessions.read",
          "repo.agentRuntime.events.read",
        ] as readonly string[]
      ).includes(method),
      readStore = needsWalOverlay
        ? makeTaskEventReader({
            repoId: input.repoId,
            rootDir: input.rootDir,
            authoredBranch: input.authoredBranch,
          })
        : git,
      unsupportedWrite = async (): Promise<never> => {
        throw cellCodedError("repo_unavailable", "A query-only RepoCell reader cannot start writer work.");
      },
      squadCoordinator = makeSquadCoordinator({
        rootDir: input.rootDir,
        projection: () => writableProjection,
        store: () => readStore,
        reacquireTaskLease: unsupportedWrite,
        runtimeSpawner: () => ({ spawn: unsupportedWrite, cancel: unsupportedWrite }),
      }),
      runtimeReads = makeAgentRuntimeReadModel({
        readAttemptChain: (runtimeSessionId) => readRuntimeAttemptChain(input.rootDir, runtimeSessionId),
        readDispatch: (taskId, dispatchId) =>
          readTaskDispatches({ rootDir: input.rootDir, projection: writableProjection, taskId }).dispatches.find(
            (row) => row.dispatchId === dispatchId,
          ) ?? null,
        readDispatches: ({ sessions, events }) =>
          readSessionGroupDispatches({ rootDir: input.rootDir, sessions, events }),
        projection: writableProjection,
        store: readStore,
        stream: runtime,
        runtimeInstances: input.runtimeInstances ?? (() => []),
        ...(input.now ? { now: input.now } : {}),
      }),
      now = input.now ?? (() => new Date().toISOString()),
      settings = makeRepoCellSettingsState({
        rootDir: input.rootDir,
        projection: writableProjection,
        cellCodedError,
        now,
      } as never),
      context = {
        extracted: {},
        mode: input.mode ?? "local",
        fleetRoster: input.fleetRoster?.() ?? null,
        input: {
          repoId: input.repoId,
          ...(input.runtimeInstances ? { runtimeInstances: input.runtimeInstances } : {}),
        },
        state: "attached",
        rootDir: input.rootDir,
        store: readStore,
        projection: writableProjection,
        now,
        settings,
        squadCoordinator,
        runtimeReads,
        dispatchRead,
        requiredCellText,
        cellCodedError,
        latched,
      } as unknown as RepoCellApiContext;
    try {
      return createRepoCellApi(context)[repoCellSynchronousRead](method, payload, binding) as Awaited<
        ReturnType<RepoCell["read"]>
      >;
    } finally {
      if (needsWalOverlay) void readStore.drain();
    }
  };
  const run: RepoCell["run"] = async (action, binding) => {
    await Promise.resolve();
    if (closed)
      return {
        outcome: "op_rejected",
        opId: operationId(action, binding, input.repoId, 0),
        code: "repo_unavailable",
        nextAction: "RepoCell closed before this queued command could execute.",
      } as never;
    if (action.kind === "task-list" && supervisor.status().state === "attached")
      return query((projection) => legacyTaskList(projection, action, binding, input));
    return supervisor.request("run", { action }, binding);
  };
  const terminal: RepoCell["terminal"] = {
    list: terminalHost.list,
    attach: terminalHost.attach,
    detach: terminalHost.detach,
    close: terminalHost.close,
    spawn: (payload, _binding) => terminalHost.spawn(payload),
    spawnTrusted: (launch, _binding) => terminalHost.spawnTrusted(launch),
    input: (payload, _binding) => terminalHost.input(payload),
    resize: (payload, _binding) => terminalHost.resize(payload),
    terminate: (payload, _binding) => terminalHost.terminate(payload),
  };
  return {
    get bootstrapReceipt() {
      return supervisor.bootstrapReceipt() as RepoCell["bootstrapReceipt"];
    },
    run,
    presetRun: (action, binding) => supervisor.request("presetRun", { action }, binding),
    spawnRuntime: (payload, binding) => supervisor.request("spawnRuntime", payload, binding),
    cancelRuntime: (payload, binding) => supervisor.request("cancelRuntime", payload, binding),
    runtimeIngress: (action, binding) => supervisor.request("runtimeIngress", { action }, binding),
    catalog: {
      snapshot: () => supervisor.request("catalog", { method: "snapshot", args: [] }),
      preset: (payload) => supervisor.request("catalog", { method: "preset", args: [payload] }),
      reread: (payload) => supervisor.request("catalog", { method: "reread", args: [payload] }),
    },
    terminal,
    read: async (method, payload = {}, binding) => {
      return query((projection) => readAtCut(projection, method, payload, binding)) as never;
    },
    workspaceSummary: () => query((projection) => workspaceSummaryFromProjection(projection as never)),
    observeTail: (payload, daemon) => {
      if (payload !== null && typeof payload === "object" && (payload as { kind?: unknown }).kind === "events")
        return Promise.resolve(
          query((projection) =>
            readObserveEventTail({
              repoId: input.repoId,
              rootDir: input.rootDir,
              mode: input.mode ?? "local",
              projection: projection as TaskProjection,
              payload,
            }),
          ),
        );
      return readObserveTail({
        repoId: input.repoId,
        rootDir: input.rootDir,
        mode: input.mode ?? "local",
        projection: {} as TaskProjection,
        userRoot: daemon.userRoot,
        daemonId: daemon.daemonId,
        payload,
      });
    },
    replica,
    verifyReadiness: async () => {
      const status = supervisor.status();
      if (status.state !== "attached") throw cellCodedError("repo_unavailable", latched());
      const read = query((projection) => projection.readCut());
      if (read.status !== "ready") throw cellCodedError("repo_unavailable", "RepoCell L2 projection is not ready.");
      return { cellState: "attached", l2State: "ready" } as const;
    },
    attach: async (runtimeSessionId, afterCursor) => {
      const status = supervisor.status();
      if (status.state !== "attached") throw cellCodedError("repo_unavailable", latched());
      return runtime.attach(runtimeSessionId, afterCursor);
    },
    runtime,
    status: supervisor.status,
    settlePendingMaterialization: (context) => supervisor.request("settlePendingMaterialization", context),
    close: async () => {
      if (closed) return;
      closed = true;
      runtime.close();
      await terminal.close();
      try {
        await supervisor.close();
      } finally {
        replica.close();
        reader.close();
        await lock.close();
      }
    },
  };
}

function legacyTaskList(
  projection: TaskProjectionQueries,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  input: RepoCellOpenInput,
): Awaited<ReturnType<RepoCell["run"]>> {
  const readResult: TaskQueryCell["readResult"] = (opId, value, revision, worktreeVisible, cut) => {
    const base = {
      opId,
      revision,
      evidence: JSON.stringify({
        ...value,
        status: cut?.status,
        watermark: cut?.watermark,
        sourceRevision: cut?.sourceRevision,
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: revision,
        appliedCut: cut?.watermark ?? revision,
        durable: true,
        canonicalVisible: cut?.status === "ready",
        worktreeVisible,
      },
    };
    return cut?.status === "ready"
      ? { outcome: "applied" as const, ...base }
      : {
          outcome: "pending" as const,
          ...base,
          nextAction: `Retry after the task projection catches up from revision ${cut?.watermark ?? 0} to ${cut?.sourceRevision ?? revision}.`,
        };
  };
  return listTasks(
    {
      input: { repoId: input.repoId },
      rootDir: input.rootDir,
      projection: projection as TaskProjection,
      taskListQueryFromAction: legacyTaskListQuery,
      operationId,
      cellCodedError,
      readResult,
    } as never,
    action,
    binding,
  ) as never;
}

function legacyTaskListQuery(action: RepoTaskAction): TaskProjectionListQuery {
  const status = typeof action.status === "string" ? action.status : undefined,
    updatedAfter = typeof action.updatedAfter === "string" ? action.updatedAfter : undefined,
    updatedBefore = typeof action.updatedBefore === "string" ? action.updatedBefore : undefined,
    limit = action.limit === undefined ? undefined : Number(action.limit),
    cursor = typeof action.cursor === "string" ? action.cursor : undefined;
  if (status !== undefined && !["planned", "active", "blocked", "in_review", "done", "cancelled"].includes(status))
    throw cellCodedError("invalid_command", "Query status is invalid for this read.");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
    throw cellCodedError("invalid_command", "Query limit must be an integer between 1 and 500.");
  if (
    [updatedAfter, updatedBefore].some((value) => value !== undefined && !timestamp(value)) ||
    (updatedAfter && updatedBefore && updatedAfter > updatedBefore)
  )
    throw cellCodedError("invalid_command", "Query time window must use ordered ISO-8601 timestamps.");
  return {
    ...(status ? { status: status as TaskProjectionListQuery["status"] } : {}),
    ...(updatedAfter ? { updatedAfter } : {}),
    ...(updatedBefore ? { updatedBefore } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor ? { cursor } : {}),
  };
}
