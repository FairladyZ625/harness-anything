import { receiveMessageOnPort, Worker, MessageChannel, type MessagePort } from "node:worker_threads";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import type { PgTaskQueryMethods } from "./pg-task-query-contract.ts";
export type { PgTaskQueryMethods } from "./pg-task-query-contract.ts";

export interface PgTaskQueryReaderOptions {
  readonly connectionString: string;
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
}

interface WorkerResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly fields?: Readonly<Record<string, unknown>>;
  };
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

/**
 * Synchronous query facade for the asynchronous PG driver. A session is one worker-owned
 * repeatable-read transaction; each port method is one RPC, not one RPC per returned row.
 */
export function createPgTaskQueryReader(options: PgTaskQueryReaderOptions): PgTaskQueryReader {
  const path = options.path ?? "postgres:task-projection",
    startupTimeoutMs = checkedTimeout(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, "startup"),
    queryTimeoutMs = checkedTimeout(options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS, "query"),
    { port1, port2 } = new MessageChannel(),
    ready = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    worker = new Worker(new URL("./pg-task-query-worker.ts", import.meta.url), {
      workerData: {
        connectionString: options.connectionString,
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
  worker.unref();
  let startup: WorkerResponse;
  try {
    startup = waitForWorker(ready, port1, 0, startupTimeoutMs, worker, "PostgreSQL task query worker failed to start");
  } catch (error) {
    port1.close();
    throw error;
  }
  if (startup.error) {
    port1.close();
    throw restoreError(startup.error);
  }
  let requestId = 0,
    activeSession = false,
    closed = false;

  const request = <Result>(
    op: "begin" | "query" | "end" | "close",
    method?: string,
    args?: readonly unknown[],
  ): Result => {
    if (closed && op !== "close") throw new Error("PostgreSQL task query reader is closed");
    if (op === "query" && !activeSession) throw new Error("PostgreSQL query methods require an active reader session");
    const id = ++requestId;
    Atomics.store(state, 0, 0);
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
    withSession: (read) => {
      if (closed) throw new Error("PostgreSQL task query reader is closed");
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
  timeoutMs: number,
  worker: Worker,
  timeoutMessage: string,
): WorkerResponse {
  if (Atomics.wait(state, 0, 0, timeoutMs) === "timed-out") {
    void worker.terminate();
    throw Object.assign(new Error(timeoutMessage), { code: "pg_query_worker_timeout" });
  }
  const response = receiveMessageOnPort(port)?.message as WorkerResponse | undefined;
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
