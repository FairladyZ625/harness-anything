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
import { ledgerWriteCommandTopology } from "../../preset/src/preset-command-contract.ts";
import { makeAgentRuntimeReadModel } from "./agent-runtime-read.ts";
import { makeAgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { readRuntimeAttemptChain, readSessionGroupDispatches, readTaskDispatches } from "./dispatch-read.ts";
import { openReplicaCutSource } from "./fleet/replica-cut-store.ts";
import { readObserveEventTail, readObserveTail } from "./observe-tail.ts";
import { openTerminalHost } from "./terminal-host.ts";
import { taskShowFromProjection } from "./repo-cell-completion.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { createRepoCellApi, repoCellSynchronousRead, type RepoCellApiContext } from "./repo-cell-api.ts";
import { dispatchRead } from "./repo-cell-command.ts";
import { acquireWorkspaceLock } from "./repo-cell-lock.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import { operationId } from "./repo-cell-proof.ts";
import { renderEvidencePayload } from "./repo-cell-evidence.ts";
import { admitRepoMode } from "./repo-mode.ts";
import { requiredCellText } from "./repo-cell-settlement.ts";
import { makeRepoCellSettingsState } from "./repo-cell-settings-state.ts";
import { listTasks, type TaskQueryCell } from "./repo-cell-task-query.ts";
import type { RepoCell, RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { repoCellTaskQueryJudgments } from "./repo-cell.ts";
import { makeSquadCoordinator } from "./squad-coordinator.ts";
import { makeTaskQueryReadModel } from "./task-query-read.ts";
import { openWriterSupervisor } from "./writer-supervisor.ts";
import { workspaceSummaryFromProjection } from "./workspace-summary-read.ts";

const TASK_STATUS_FILTERS = Object.freeze(["planned", "active", "blocked", "in_review", "done", "cancelled"]);
const writerAttached = (cell: { readonly state: string }): boolean => cell.state === "attached";
const writerServing = (cell: { readonly state: string }): boolean =>
  cell.state === "attached" || cell.state === "unavailable";
const projectionReady = (read: { readonly status: string }): boolean => read.status === "ready";
const validTaskStatusFilter = (value: string | undefined): boolean =>
  value === undefined || TASK_STATUS_FILTERS.includes(value);

/** Host-side RepoCell boundary: admission/proxy plus completed-cut projection reads only. */
export async function openRepoCellProxy(input: RepoCellOpenInput): Promise<RepoCell> {
  const lock = await acquireWorkspaceLock(input.rootDir);
  let relayRuntimeSignal: NonNullable<RepoCellOpenInput["onRuntimeSignal"]> = () => undefined;
  let supervisor: Awaited<ReturnType<typeof openWriterSupervisor>>;
  try {
    supervisor = await openWriterSupervisor({
      ...input,
      onRuntimeSignal: (runtimeSessionId, signal) => {
        relayRuntimeSignal(runtimeSessionId, signal);
        input.onRuntimeSignal?.(runtimeSessionId, signal);
      },
    });
  } catch (error) {
    await lock.close();
    throw error;
  }
  const reader = makeTaskProjectionReader({ rootDir: input.rootDir, ...(input.now ? { now: input.now } : {}) }),
    gitOptions = { repoId: input.repoId, rootDir: input.rootDir, authoredBranch: input.authoredBranch },
    currentGit = () => makeGitEventStore(gitOptions),
    readCurrentLedger = <T>(read: (store: ReturnType<typeof makeTaskEventReader>) => T): T => {
      const store = makeTaskEventReader(gitOptions);
      try {
        return read(store);
      } finally {
        void store.drain();
      }
    },
    replica = openReplicaCutSource({
      repoId: input.repoId,
      localRoot: path.dirname(path.dirname(reader.path)),
      readBasis: (afterRevision) => reader.withSession((projection) => projection.readReplicaBasis(afterRevision)),
      // Fleet replication follows the acknowledged writer cut, including the durable
      // WAL suffix that may not have reached Git yet. This reader is immutable; the
      // RepoWriterCell remains the only mutable WAL owner.
      readLedgerCut: () => readCurrentLedger((store) => store.currentCut()),
      readContentBlob: (sha256) => readCurrentLedger((store) => store.readContentBlob(sha256)),
      readEvent: (opId) => readCurrentLedger((store) => store.readEvent(opId)),
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
  relayRuntimeSignal = runtime.publish;
  let closed = false;

  const query = <T>(read: (projection: TaskProjectionQueries) => T): T => {
    if (closed) throw cellCodedError("repo_unavailable", "RepoCell is closed.");
    const status = supervisor.status();
    if (!writerServing(status))
      throw cellCodedError("repo_unavailable", status.lastError ?? "RepoWriterCell is not ready.");
    // An unavailable writer never causes a repair from a serving read. SQLite either
    // returns the last completed transaction or an explicit read error.
    return reader.withSession(read);
  };
  const latched = (): string => {
    const status = supervisor.status(),
      cause = status.lastError ?? "RepoCell is unavailable.";
    return status.causeClass === "infrastructure"
      ? [
          "this workspace stays latched until its Git or lock infrastructure recovers:",
          "repair the infrastructure cause below, then rerun the command; the next attempt re-probes the workspace",
          `and re-attaches automatically once it verifies. Cause: ${cause}`,
        ].join(" ")
      : status.causeClass === "projection"
        ? [
            "this workspace stays latched until its projection verifies:",
            "run ha daemon projection rebuild to repair the projection cause below; this command remains available",
            `while latched and re-attaches automatically once the projection verifies. Cause: ${cause}`,
          ].join(" ")
        : [
            "this workspace stays latched until its ledger data verifies:",
            "repair the data-shape cause below, then rerun the command; the next attempt re-probes the ledger",
            `and re-attaches automatically once the data verifies. Cause: ${cause}`,
          ].join(" ");
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
        : currentGit(),
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
  const run: RepoCell["run"] = async (action, binding, signal) => {
    if (closed)
      return {
        outcome: "op_rejected",
        opId: operationId(action, binding, input.repoId, 0),
        code: "repo_unavailable",
        nextAction: "RepoCell closed before this queued command could execute.",
      } as never;
    if (action.kind === "task-list" && supervisor.status().state === "attached")
      return query((projection) => legacyTaskList(projection, action, binding, input));
    if (action.kind === "task-show" && supervisor.status().state === "attached")
      return query((projection) => legacyTaskShow(projection, action, input));
    // Writes must yield once so a close started in the same turn wins admission.
    // Host-owned projection reads do not need that scheduling boundary.
    await Promise.resolve();
    if (closed)
      return {
        outcome: "op_rejected",
        opId: "closed",
        code: "repo_unavailable",
        nextAction: "Re-open the repository before retrying the command.",
      } as never;
    return supervisor.request("run", { action }, binding, signal);
  };
  const admitTerminalWrite = (binding: RepoCellBinding): void => {
    const admission = admitRepoMode(input.mode ?? "local", ledgerWriteCommandTopology, binding.source);
    if (!admission.ok) throw cellCodedError(admission.code, admission.nextAction);
    if (closed || supervisor.status().state !== "attached")
      throw cellCodedError("repo_unavailable", "RepoWriterCell is unavailable.");
  };
  const terminal: RepoCell["terminal"] = {
    list: terminalHost.list,
    attach: terminalHost.attach,
    detach: terminalHost.detach,
    close: terminalHost.close,
    spawn: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.spawn(payload);
    },
    spawnTrusted: (launch, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.spawnTrusted(launch);
    },
    input: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.input(payload);
    },
    resize: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.resize(payload);
    },
    terminate: (payload, binding) => {
      admitTerminalWrite(binding);
      return terminalHost.terminate(payload);
    },
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
      if (method === "repo.tasks.list")
        return query((projection) =>
          makeTaskQueryReadModel({
            rootDir: input.rootDir,
            projection: projection as TaskProjection,
            judgments: repoCellTaskQueryJudgments,
          }).guiTasks(taskListQuery(payload)),
        ) as never;
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
      if (!writerAttached(status)) throw cellCodedError("repo_unavailable", latched());
      const read = query((projection) => projection.readCut());
      if (!projectionReady(read)) throw cellCodedError("repo_unavailable", "RepoCell L2 projection is not ready.");
      return { cellState: "attached", l2State: "ready" } as const;
    },
    attach: async (runtimeSessionId, afterCursor) => {
      const status = supervisor.status();
      if (!writerAttached(status)) throw cellCodedError("repo_unavailable", latched());
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

function taskListQuery(payload: Readonly<Record<string, unknown>>): TaskProjectionListQuery {
  const status = typeof payload.status === "string" ? payload.status : undefined,
    changedAfterRevision =
      payload.changedAfterRevision === undefined ? undefined : Number(payload.changedAfterRevision),
    updatedAfter = typeof payload.updatedAfter === "string" ? payload.updatedAfter : undefined,
    updatedBefore = typeof payload.updatedBefore === "string" ? payload.updatedBefore : undefined,
    limit = payload.limit === undefined ? undefined : Number(payload.limit),
    cursor = typeof payload.cursor === "string" ? payload.cursor : undefined;
  if (!validTaskStatusFilter(status)) throw cellCodedError("invalid_command", "Query status is invalid for this read.");
  if (changedAfterRevision !== undefined && (!Number.isSafeInteger(changedAfterRevision) || changedAfterRevision < 0))
    throw cellCodedError("invalid_command", "Task changedAfterRevision must be a non-negative integer.");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
    throw cellCodedError("invalid_command", "Query limit must be an integer between 1 and 500.");
  if (
    [updatedAfter, updatedBefore].some((value) => value !== undefined && !timestamp(value)) ||
    (updatedAfter && updatedBefore && updatedAfter > updatedBefore)
  )
    throw cellCodedError("invalid_command", "Query time window must use ordered ISO-8601 timestamps.");
  if (cursor !== undefined && !cursor) throw cellCodedError("invalid_command", "Query cursor is invalid.");
  return {
    ...(status ? { status: status as TaskProjectionListQuery["status"] } : {}),
    ...(changedAfterRevision === undefined ? {} : { changedAfterRevision }),
    ...(updatedAfter ? { updatedAfter } : {}),
    ...(updatedBefore ? { updatedBefore } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor ? { cursor } : {}),
  };
}

function legacyTaskShow(
  projection: TaskProjectionQueries,
  action: RepoTaskAction,
  input: RepoCellOpenInput,
): Awaited<ReturnType<RepoCell["run"]>> {
  const taskId = typeof action.taskId === "string" && action.taskId ? action.taskId : null;
  if (taskId === null) throw cellCodedError("invalid_command", "taskId is required");
  return taskShowFromProjection(input.rootDir, projection, taskId) as unknown as Awaited<ReturnType<RepoCell["run"]>>;
}

function legacyTaskList(
  projection: TaskProjectionQueries,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  input: RepoCellOpenInput,
): Awaited<ReturnType<RepoCell["run"]>> {
  const readResult: TaskQueryCell["readResult"] = (opId, value, revision, worktreeVisible, cut) => {
    const payload = {
        ...value,
        status: cut?.status,
        watermark: cut?.watermark,
        sourceRevision: cut?.sourceRevision,
      },
      base = {
        opId,
        revision,
        evidence: JSON.stringify(payload),
        summary: renderEvidencePayload(payload),
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
          nextAction: [
            `Retry after the task projection catches up from revision ${cut?.watermark ?? 0}`,
            `to ${cut?.sourceRevision ?? revision}.`,
          ].join(" "),
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
  if (!validTaskStatusFilter(status)) throw cellCodedError("invalid_command", "Query status is invalid for this read.");
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
