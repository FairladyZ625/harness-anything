import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { receiveMessageOnPort, Worker, MessageChannel, type MessagePort } from "node:worker_threads";
import { extname } from "node:path";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import type { PgTaskQueryMethods } from "./pg-task-query-contract.ts";
import type { PostgresTaskEventStoreRequest, PostgresTaskEventStoreResult } from "../postgres/pg-task-event-store.ts";
import type { LeaseV1 } from "@harness-anything/kernel";
import type { PgEpochRequest } from "../postgres/pg-epoch-transaction.ts";
import type { WriterEpochLease } from "../writer-epoch-contract.ts";
import type { PgRelationCycleRefreshPage } from "./pg-relation-cycle-audit.ts";
export type { PgTaskQueryMethods } from "./pg-task-query-contract.ts";

export interface PgTaskQueryReaderOptions {
  readonly connectionString: string;
  readonly authorityConnectionString?: string;
  readonly requireRuntimeRole?: boolean;
  readonly authoredRoot?: string;
  readonly scope: PgProjectionScope;
  readonly repoId: string;
  readonly path?: string;
  readonly startupTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly now?: () => string;
}

export interface PgTaskQueryReader {
  readonly path: string;
  readonly withSession: <A>(read: (queries: PgTaskQueryMethods) => A) => A;
  readonly close: () => void;
  readonly executeCanonical: (request: PostgresTaskEventStoreRequest) => PostgresTaskEventStoreResult;
  readonly changeLease: (
    operation: "reserve" | "activate" | "renew" | "release",
    expected: LeaseV1,
    now: string,
    expiresAt?: string,
  ) => LeaseV1;
  readonly rebuild: () => void;
  readonly warmIndexes: (maxItems?: number) => import("./pg-entity-declaration-catchup.ts").EntityIndexPage;
  /** One-time artifact timeline expansion; returns the number of backfilled rows (0 when ready). */
  readonly backfillArtifactTimeline: () => number;
  /** Refold the dispatch lifecycle model when the projection has no current lifecycle cursor. */
  readonly backfillDispatchLifecycle: () => number;
  readonly maintainRelationCycleAuditPage: () => PgRelationCycleRefreshPage;
  readonly writerEpoch: (request: PgEpochRequest) => WriterEpochLease | number | null;
  readonly replication: (operation: "head" | "page" | "slots", payload?: unknown) => unknown;
}

/** Internal endpoint: PG owns a worker; embedded storage supplies a logical MessagePort. */
export interface PgQueryEndpoint {
  postMessage(value: unknown): void;
  terminate(): void | Promise<number>;
  unref(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
}
export type PgQueryConnectionOptions = Omit<
  PgTaskQueryReaderOptions,
  "connectionString" | "authorityConnectionString" | "requireRuntimeRole"
>;
export type PgQueryConnector = (
  input: PgQueryConnectionOptions & {
    readonly path: string;
    readonly ready: Int32Array;
    readonly state: Int32Array;
    readonly responsePort: MessagePort;
    readonly requestPort: MessagePort;
  },
) => PgQueryEndpoint;

interface WorkerResponse {
  readonly id: number;
  readonly fatal?: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly fields?: Readonly<Record<string, unknown>>;
  };
}

const DEFAULT_STARTUP_TIMEOUT_MS = storageReadPolicy.defaultValue.deadlines.startup;
const DEFAULT_QUERY_TIMEOUT_MS = storageReadPolicy.defaultValue.deadlines.query;

/**
 * Synchronous query facade for the asynchronous PG driver. A session is one worker-owned
 * repeatable-read transaction; each port method is one RPC, not one RPC per returned row.
 */
export function createPgTaskQueryReader(options: PgTaskQueryReaderOptions): PgTaskQueryReader;
export function createPgTaskQueryReader(
  options: PgQueryConnectionOptions,
  connect: PgQueryConnector,
): PgTaskQueryReader;
export function createPgTaskQueryReader(
  options: PgTaskQueryReaderOptions | PgQueryConnectionOptions,
  connect?: PgQueryConnector,
): PgTaskQueryReader {
  const postgres = options as PgTaskQueryReaderOptions;
  const path = options.path ?? "postgres:task-projection",
    startupTimeoutMs = checkedTimeout(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, "startup"),
    queryTimeoutMs = checkedTimeout(options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS, "query"),
    { port1, port2 } = new MessageChannel(),
    ready = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    worker: PgQueryEndpoint =
      connect?.({ ...options, path, ready, state, responsePort: port2, requestPort: port1 }) ??
      new Worker(new URL(`./pg-task-query-worker${extname(import.meta.filename)}`, import.meta.url), {
        workerData: {
          connectionString: postgres.connectionString,
          authorityConnectionString: postgres.authorityConnectionString,
          requireRuntimeRole: postgres.requireRuntimeRole,
          authoredRoot: options.authoredRoot,
          scope: options.scope,
          repoId: options.repoId,
          path,
          ready,
          state,
          responsePort: port2,
        },
        transferList: [port2],
        execArgv: process.execArgv.filter(
          (argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps",
        ),
      });
  let requestId = 0,
    activeSession = false,
    closed = false;
  let lifecycleError: Error | undefined;
  // EventEmitter errors arrive after a synchronous caller yields. Consume them here even
  // when a fatal response or the bounded wait has already invalidated the reader.
  worker.on("error", (error) => {
    lifecycleError = error;
    closed = true;
    port1.close();
  });
  worker.on("exit", (code) => {
    if (!closed)
      lifecycleError = Object.assign(new Error(`PostgreSQL task query worker exited (${code})`), {
        code: "pg_query_worker_exited",
      });
    closed = true;
    port1.close();
  });
  worker.unref();
  let startup: WorkerResponse;
  try {
    startup = waitForWorker(ready, port1, 0, startupTimeoutMs, worker, "PostgreSQL task query worker failed to start");
  } catch (error) {
    port1.close();
    throw error;
  }
  if (startup.error) {
    void worker.terminate();
    port1.close();
    throw restoreError(startup.error);
  }

  const request = <Result>(
    op:
      | "begin"
      | "query"
      | "end"
      | "close"
      | "canonical"
      | "lease"
      | "rebuild"
      | "warm-indexes"
      | "artifact-backfill"
      | "dispatch-lifecycle-backfill"
      | "relation-cycle-maintenance"
      | "epoch"
      | "replication",
    method?: string,
    args?: readonly unknown[],
  ): Result => {
    if (closed && op !== "close") throw new Error("PostgreSQL task query reader is closed", { cause: lifecycleError });
    if (op === "query" && !activeSession) throw new Error("PostgreSQL query methods require an active reader session");
    const id = ++requestId;
    // Never overwrite the worker's terminal (-1) signal between requests.
    Atomics.compareExchange(state, 0, 1, 0);
    if (Atomics.load(state, 0) !== -1)
      worker.postMessage({
        id,
        op,
        ...(method ? { method } : {}),
        ...(args ? { args } : {}),
        ...(op === "query" && options.now ? { now: options.now() } : {}),
      });
    let response: WorkerResponse;
    try {
      response = waitForWorker(state, port1, id, queryTimeoutMs, worker, "PostgreSQL task query worker timed out");
    } catch (error) {
      closed = true;
      port1.close();
      throw error;
    }
    if (response.fatal) {
      lifecycleError = response.error ? restoreError(response.error) : undefined;
      closed = true;
      port1.close();
      void worker.terminate();
    }
    if (response.error) throw restoreError(response.error);
    return response.result as Result;
  };

  const queries = new Proxy(
    { path },
    {
      get(target, property) {
        if (property === "path") return target.path;
        if (typeof property !== "string") return undefined;
        return (...args: readonly unknown[]) => request("query", property, args);
      },
    },
  ) as unknown as PgTaskQueryMethods;

  return {
    path,
    executeCanonical: (value) => {
      if (activeSession) throw new Error("canonical operations cannot run inside a projection read session");
      return request("canonical", undefined, [value]);
    },
    changeLease: (...args) => {
      if (activeSession) throw new Error("lease writes cannot run inside a projection read session");
      return request("lease", undefined, args);
    },
    rebuild: () => {
      if (activeSession) throw new Error("rebuild cannot run inside a projection read session");
      request("rebuild");
    },
    warmIndexes: (maxItems = 64) => {
      if (activeSession) throw new Error("index catch-up cannot run inside a projection read session");
      return request("warm-indexes", undefined, [maxItems]);
    },
    backfillArtifactTimeline: () => {
      if (activeSession) throw new Error("artifact backfill cannot run inside a projection read session");
      return request("artifact-backfill");
    },
    backfillDispatchLifecycle: () => {
      if (activeSession) throw new Error("dispatch lifecycle backfill cannot run inside a projection read session");
      return request("dispatch-lifecycle-backfill");
    },
    maintainRelationCycleAuditPage: () => {
      if (activeSession) throw new Error("relation cycle maintenance cannot run inside a projection read session");
      return request("relation-cycle-maintenance");
    },
    writerEpoch: (value) => request("epoch", undefined, [value]),
    replication: (operation, payload) => request("replication", operation, [payload]),
    withSession: (read) => {
      if (closed) throw new Error("PostgreSQL task query reader is closed", { cause: lifecycleError });
      if (activeSession) throw new Error("PostgreSQL task query sessions cannot be nested");
      request("begin");
      activeSession = true;
      try {
        return read(queries);
      } finally {
        activeSession = false;
        if (!closed) request("end");
      }
    },
    close: () => {
      if (closed) return;
      if (activeSession) throw new Error("cannot close PostgreSQL task query reader during a session");
      try {
        request("close");
      } finally {
        closed = true;
        port1.close();
      }
    },
  };
}

function checkedTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000)
    throw new RangeError(`PostgreSQL task query ${label} timeout must be between 1 and 300000 ms`);
  return value;
}

function waitForWorker(
  state: Int32Array,
  port: MessagePort,
  requestId: number,
  waitMs: number,
  worker: PgQueryEndpoint,
  timeoutMessage: string,
): WorkerResponse {
  if (Atomics.wait(state, 0, 0, waitMs) === "timed-out") {
    void worker.terminate();
    throw Object.assign(new Error(timeoutMessage), { code: "pg_query_worker_timeout" });
  }
  let response: WorkerResponse | undefined;
  // Drain already delivered responses, giving a terminal failure precedence over a
  // successful response sent immediately before the connection died.
  for (let entry = receiveMessageOnPort(port); entry; entry = receiveMessageOnPort(port)) {
    response = entry.message as WorkerResponse;
    if (response.fatal) return response;
  }
  if (!response || response.id !== requestId) {
    void worker.terminate();
    throw Object.assign(new Error("PostgreSQL task query worker returned an invalid response"), {
      code: "pg_query_worker_protocol_error",
    });
  }
  return response;
}

function restoreError(error: NonNullable<WorkerResponse["error"]>): Error {
  const restored = Object.assign(new Error(error.message), error.fields ?? {});
  restored.name = error.name;
  return restored;
}

export { waitForWorker as waitForPgQueryWorker, restoreError as restorePgQueryError };
