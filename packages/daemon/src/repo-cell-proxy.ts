import path from "node:path";
import {
  makeGitEventStore,
  makeTaskProjectionReader,
  type TaskProjectionListQuery,
  type TaskProjectionQueries,
} from "../../kernel/src/index.ts";
import { makeAgentRuntimeStreamHub } from "./agent-runtime-stream.ts";
import { openReplicaCutSource } from "./fleet/replica-cut-store.ts";
import { openTerminalHost } from "./terminal-host.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import { acquireWorkspaceLock } from "./repo-cell-lock.ts";
import type { RepoCellOpenInput } from "./repo-cell-open.ts";
import { operationId } from "./repo-cell-proof.ts";
import type { RepoCell, RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { repoCellTaskQueryJudgments } from "./repo-cell.ts";
import { makeTaskQueryReadModel } from "./task-query-read.ts";
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
  const taskQueries = (projection: TaskProjectionQueries) =>
    makeTaskQueryReadModel({
      rootDir: input.rootDir,
      projection: projection as never,
      judgments: repoCellTaskQueryJudgments,
    });
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
      if (method === "repo.tasks.list")
        return query((projection) => taskQueries(projection).guiTasks(taskListQuery(payload))) as never;
      return supervisor.request("read", { method, payload }, binding);
    },
    workspaceSummary: () => query((projection) => workspaceSummaryFromProjection(projection as never)),
    observeTail: (payload, daemon) => supervisor.request("observeTail", { payload, daemon }),
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

function taskListQuery(payload: Readonly<Record<string, unknown>>): TaskProjectionListQuery {
  const status = typeof payload.status === "string" ? payload.status : undefined,
    changedAfterRevision =
      payload.changedAfterRevision === undefined ? undefined : Number(payload.changedAfterRevision),
    updatedAfter = typeof payload.updatedAfter === "string" ? payload.updatedAfter : undefined,
    updatedBefore = typeof payload.updatedBefore === "string" ? payload.updatedBefore : undefined,
    limit = payload.limit === undefined ? undefined : Number(payload.limit),
    cursor = typeof payload.cursor === "string" ? payload.cursor : undefined;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 500))
    throw cellCodedError("invalid_command", "Query limit must be an integer between 1 and 500.");
  if (changedAfterRevision !== undefined && (!Number.isSafeInteger(changedAfterRevision) || changedAfterRevision < 0))
    throw cellCodedError("invalid_command", "Task changedAfterRevision must be a non-negative integer.");
  return {
    ...(status ? { status: status as TaskProjectionListQuery["status"] } : {}),
    ...(changedAfterRevision === undefined ? {} : { changedAfterRevision }),
    ...(updatedAfter ? { updatedAfter } : {}),
    ...(updatedBefore ? { updatedBefore } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor ? { cursor } : {}),
  };
}

function legacyTaskList(
  projection: TaskProjectionQueries,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  input: RepoCellOpenInput,
): Awaited<ReturnType<RepoCell["run"]>> {
  const limit = action.limit === undefined ? undefined : Number(action.limit),
    read = projection.readTaskIndex(),
    rows = read.rows
      .filter((row) => row.packageDisposition === "active")
      .slice(0, limit === undefined || !Number.isSafeInteger(limit) ? undefined : limit)
      .map((row) => ({
        taskId: row.taskId,
        status: row.status,
        title: row.title,
        pinned: row.pinned,
        module: row.moduleKey ?? "",
        updatedAt: row.updatedAt,
        packagePath: row.packagePath,
        packageDisposition: row.packageDisposition,
        taskClass: row.taskClass,
      })),
    payload = {
      schema: "task-list/v2",
      mode: "flat",
      rows,
      count: rows.length,
      warnings: read.warnings,
      status: read.status,
      watermark: read.watermark,
      sourceRevision: read.sourceRevision,
    },
    opId = operationId(action, binding, input.repoId, read.sourceRevision),
    base = {
      opId,
      revision: read.sourceRevision,
      evidence: JSON.stringify(payload),
      visibility: "center" as const,
      proof: {
        committedRevision: read.sourceRevision,
        appliedCut: read.watermark,
        durable: true,
        canonicalVisible: read.status === "ready",
        worktreeVisible: null,
      },
      ...payload,
    };
  return (
    read.status === "ready"
      ? { outcome: "applied" as const, ...base }
      : {
          outcome: "pending" as const,
          ...base,
          nextAction: `Retry after the task projection catches up from revision ${read.watermark} to ${read.sourceRevision}.`,
        }
  ) as never;
}
