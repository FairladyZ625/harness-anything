import { parentPort, workerData, Worker, type MessagePort } from "node:worker_threads";
import { Pool } from "pg";
import { createPgTaskQueryReader, withStorageWriteRequest } from "../../../storage/src/pg/pg-task-query-reader.ts";
import { startPgQuerySession } from "../../../storage/src/pg/pg-task-query-worker.ts";
import {
  serializeWriterError,
  type RepoWriterControlV1,
  type RepoWriterRequestV1,
} from "../../src/repo-writer-protocol.ts";
import type { PostgresTaskEventStoreRequest } from "../../../storage/src/postgres/pg-task-event-store.ts";
import type { PostgresStorageBackendConfig } from "../../../storage/src/storage-backend.ts";

const data = workerData as {
  query?: boolean;
  storage: PostgresStorageBackendConfig;
  repoId: string;
  before: boolean;
  gate: Int32Array;
  reached: Int32Array;
  stats: Int32Array;
  state?: Int32Array;
  ready?: Int32Array;
  responsePort?: MessagePort;
};
const scope = { ...data.storage.scope!, readers: [] } as {
  tenantId: string;
  projectId: string;
  policyEpoch: number;
  readers: string[];
};
const actualTerminate = Worker.prototype.terminate;
Worker.prototype.terminate = function () {
  Atomics.add(data.stats, 2, 1);
  return actualTerminate.call(this);
};
if (data.query) {
  const pool = new Pool({ connectionString: data.storage.connectionString, max: 2 });
  let requestActive = false;
  const traced = new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const connection = await target.connect();
          return new Proxy(connection, {
            get(client, method) {
              if (method === "query")
                return async (sql: string, values?: unknown[]) => {
                  if (requestActive && sql === "COMMIT") Atomics.add(data.stats, 0, 1);
                  if (requestActive && sql === "ROLLBACK") Atomics.add(data.stats, 1, 1);
                  return client.query(sql, values);
                };
              const value = Reflect.get(client, method);
              return typeof value === "function" ? value.bind(client) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pause = async () => {
    if (Atomics.load(data.gate, 0) !== 0) return;
    requestActive = true;
    Atomics.store(data.reached, 0, 1);
    Atomics.notify(data.reached, 0);
    await Atomics.waitAsync(data.gate, 0, 0).value;
  };
  const session = startPgQuerySession(
    {
      repoId: data.repoId,
      scope,
      path: "s3-cas",
      ready: data.ready!,
      state: data.state!,
      requestPort: parentPort!,
      responsePort: data.responsePort!,
    },
    traced,
    null,
    { beforeCommitCasHook: data.before ? pause : undefined, afterCommitCasHook: data.before ? undefined : pause },
  );
  process.on("uncaughtExceptionMonitor", session.fail);
} else {
  const reader = createPgTaskQueryReader(
    { repoId: data.repoId, scope },
    (input) =>
      new Worker(new URL(import.meta.url), {
        workerData: { ...data, query: true, state: input.state, ready: input.ready, responsePort: input.responsePort },
        transferList: [input.responsePort],
      }),
  );
  parentPort!.postMessage({
    schema: "harness-repo-writer-status/v1",
    kind: "ready",
    status: { repoId: data.repoId, state: "attached", generation: 1, queueDepth: 0 },
  });
  parentPort!.on("message", async (request: RepoWriterRequestV1 | RepoWriterControlV1) => {
    if (request.schema === "harness-repo-writer-control/v1") {
      if (request.command === "drain") reader.close();
      parentPort!.postMessage({
        schema: "harness-repo-writer-receipt/v1",
        requestId: request.requestId,
        outcome: "ok",
        value: null,
      });
      return;
    }
    if (request.schema !== "harness-repo-writer-request/v1") return;
    try {
      const value = await withStorageWriteRequest(
        {
          ...request.writeRequest!,
          onOperation: (opId) => {
            const state = new SharedArrayBuffer(8),
              bytes = new SharedArrayBuffer(1024 * 1024),
              view = new Int32Array(state);
            parentPort!.postMessage({
              schema: "harness-repo-writer-capability-call/v1",
              callId: "operation",
              capability: "writeOperation",
              sync: { state, bytes },
              payload: { requestId: request.requestId, opId },
            });
            while (Atomics.load(view, 0) === 0) Atomics.wait(view, 0, 0);
          },
        },
        async () => reader.executeCanonical(request.payload as PostgresTaskEventStoreRequest),
      );
      parentPort!.postMessage({
        schema: "harness-repo-writer-receipt/v1",
        requestId: request.requestId,
        outcome: "ok",
        value,
      });
    } catch (error) {
      parentPort!.postMessage({
        schema: "harness-repo-writer-receipt/v1",
        requestId: request.requestId,
        outcome: "error",
        error: serializeWriterError(error),
      });
    }
  });
}
