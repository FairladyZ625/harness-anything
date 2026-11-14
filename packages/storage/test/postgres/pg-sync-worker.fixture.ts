import { parentPort, workerData, Worker } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { Pool } from "pg";
import { resolvePostgresEventStoreScope } from "../../src/pg/backend.ts";
import { startPgQuerySession } from "../../src/pg/pg-task-query-worker.ts";
import { createPgTaskQueryReader, type PgQueryConnector } from "../../src/pg/pg-task-query-reader.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import type { PostgresStorageBackendConfig } from "../../src/storage-backend.ts";
import type { PostgresTaskEventStoreRequest } from "../../src/postgres/pg-task-event-store.ts";

const data = workerData as {
  mode: "cas" | "bridge" | "product" | "cold-read";
  coldRead?: boolean;
  controlPort?: MessagePort;
  storage: PostgresStorageBackendConfig;
  repoId: string;
  stats: Int32Array;
  state: Int32Array;
  gate: Int32Array;
  before?: boolean;
  port?: MessagePort;
  ready?: Int32Array;
};
const scope = resolvePostgresEventStoreScope(data.storage.scope);
const terminate = Worker.prototype.terminate;
Worker.prototype.terminate = function () {
  Atomics.add(data.stats, 2, 1);
  return terminate.call(this);
};
if (data.mode === "cas") {
  const pool = new Pool({ connectionString: data.storage.connectionString, max: 2 });
  const traced = new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, method) {
              if (method === "query")
                return async (sql: string, values?: unknown[]) => {
                  if (Atomics.load(data.state, 2) !== 0) {
                    if (sql === "COMMIT") Atomics.add(data.stats, 0, 1);
                    if (sql === "ROLLBACK") Atomics.add(data.stats, 1, 1);
                  }
                  const result = await connection.query(sql, values);
                  if (data.coldRead && sql.includes("SELECT EXISTS(SELECT 1 FROM ha_command_outcomes")) {
                    data.controlPort!.postMessage({
                      event: "cold-snapshot",
                      hasNull: result.rows[0]?.has_null_outcomes,
                    });
                    await Atomics.waitAsync(data.gate, 0, 0).value;
                  }
                  return result;
                };
              const value = Reflect.get(connection, method);
              return typeof value === "function" ? value.bind(connection) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pause = async () => {
    parentPort!.postMessage({ event: "barrier" });
    await Atomics.waitAsync(data.gate, 0, 0).value;
  };
  const session = startPgQuerySession(
    {
      requestPort: data.coldRead ? parentPort! : data.port!,
      responsePort: data.port!,
      ready: data.ready!,
      state: data.state,
      scope,
      repoId: data.repoId,
      path: "cas",
    },
    traced,
    null,
    {
      beforeCommitCasHook: !data.coldRead && data.before ? pause : undefined,
      afterCommitCasHook: !data.coldRead && !data.before ? pause : undefined,
      onClose: () => data.controlPort?.close(),
    },
  );
  if (!data.coldRead)
    parentPort!.on("message", async () => {
      await session.close();
      parentPort!.postMessage({ event: "closed" });
      parentPort!.close();
    });
} else {
  Atomics.wait = new Proxy(Atomics.wait, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args),
        [state, , , timeout] = args;
      if (
        state instanceof Int32Array &&
        state.length === 3 &&
        Atomics.load(state, 1) === 1 &&
        timeout === 1_000 &&
        result === "timed-out"
      ) {
        if (data.mode === "cold-read") parentPort!.postMessage({ event: "poll" });
        else {
          Atomics.store(data.gate, 0, 1);
          Atomics.notify(data.gate, 0);
        }
      }
      return result;
    },
  });
  const readerOptions = {
    connectionString: data.storage.connectionString,
    repoId: data.repoId,
    scope,
    state: data.state,
    preCommitTimeoutMs: 200,
    queryTimeoutMs: 200,
  };
  const connect: PgQueryConnector | undefined =
    data.mode === "cold-read"
      ? (input) => {
          const nested = new Worker(new URL(import.meta.url), {
            workerData: { ...data, mode: "cas", coldRead: true, ready: input.ready, port: input.responsePort },
            transferList: [input.responsePort, data.controlPort!],
          });
          return nested;
        }
      : undefined;
  const bridge = ["bridge", "cold-read"].includes(data.mode)
    ? connect
      ? createPgTaskQueryReader(readerOptions, connect)
      : createPgTaskQueryReader(readerOptions)
    : null;
  const store = data.mode === "product" ? makeTaskEventStore({ repoId: data.repoId, storage: data.storage }) : null;
  parentPort!.postMessage({ event: "ready" });
  parentPort!.on("message", async (request: PostgresTaskEventStoreRequest | { operation: "close" | "cold-read" }) => {
    if (request.operation === "close") {
      bridge?.close();
      await store?.drain();
      parentPort!.postMessage({ event: "closed" });
      parentPort!.close();
      return;
    }
    try {
      const result =
        request.operation === "cold-read"
          ? bridge!.withSession(() => null)
          : bridge
            ? bridge.executeCanonical(request as PostgresTaskEventStoreRequest)
            : request.operation === "append"
              ? store!.append(request.bundle as Parameters<NonNullable<typeof store>["append"]>[0])
              : null;
      parentPort!.postMessage({ event: "result", result });
    } catch (error) {
      parentPort!.postMessage({
        event: "result",
        error: error instanceof Error ? { message: error.message, ...error } : error,
      });
    }
  });
}
