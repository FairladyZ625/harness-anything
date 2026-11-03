import { readCutInTransaction } from "./pg-event-queries.ts";
import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { consumeKnownError } from "@harness-anything/kernel";
import { createPgTaskProjectionSource } from "./pg-task-source.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../postgres/scope-schema.ts";
import { PG_TASK_QUERY_METHODS } from "./pg-task-query-contract.ts";

interface PgQueryWorkerData {
  readonly connectionString: string;
  readonly scope: PgProjectionScope;
  readonly repoId: string;
  readonly path: string;
  readonly ready: Int32Array;
  readonly state: Int32Array;
  readonly responsePort: MessagePort;
}

interface PgQueryWorkerRequest {
  readonly id: number;
  readonly op: "begin" | "query" | "end" | "close";
  readonly method?: string;
  readonly args?: readonly unknown[];
  readonly now?: string;
}

const data = workerData as PgQueryWorkerData | undefined;
if (!isMainThread && data && parentPort) startWorker(data);

function startWorker(input: PgQueryWorkerData): void {
  const pool = new Pool({ connectionString: input.connectionString, max: 4 });
  let source: ReturnType<typeof createPgTaskProjectionSource> | null = null,
    sessionClient: PoolClient | null = null,
    savepoint = 0;
  let queryNow: string | undefined;
  let stopped = false;

  const respond = (id: number, target: Int32Array, result?: unknown, error?: unknown) => {
    if (stopped) return;
    input.responsePort.postMessage({ id, ...(error === undefined ? { result } : { error: serializeError(error) }) });
    Atomics.store(target, 0, 1);
    Atomics.notify(target, 0);
  };

  const fail = (error: Error) => {
    if (stopped) return;
    stopped = true;
    input.responsePort.postMessage({ id: -1, fatal: true, error: serializeError(error) });
    for (const target of [input.ready, input.state]) {
      Atomics.store(target, 0, -1);
      Atomics.notify(target, 0);
    }
    // Destroy the checked-out client before draining the pool; no transaction can be
    // reused after an asynchronous connection error.
    sessionClient?.release(error);
    sessionClient = null;
    void pool.end();
    input.responsePort.close();
    parentPort!.close();
  };
  pool.on("error", fail);
  process.on("uncaughtExceptionMonitor", fail);
  process.on("exit", (code) =>
    fail(Object.assign(new Error(`PostgreSQL task query worker exited (${code})`), { code: "pg_query_worker_exited" })),
  );

  const initialize = async () => {
    const client = await pool.connect();
    client.release();
    source = createPgTaskProjectionSource({
      pool: sessionPool(),
      scope: input.scope,
      repoId: input.repoId,
      path: input.path,
      ownsPool: false,
      now: () => queryNow ?? new Date().toISOString(),
    });
  };

  const sessionPool = () =>
    ({
      connect: async () => {
        const client = sessionClient;
        if (!client) throw new Error("PostgreSQL query requested outside a reader session");
        const name = `ha_query_${++savepoint}`;
        await client.query(`SAVEPOINT ${name}`);
        return {
          query: (query: string, values?: readonly unknown[]) => {
            const normalized = query.trim().replace(/;$/u, "").toUpperCase();
            if (/^BEGIN(?:\s|$)/u.test(normalized))
              return Promise.resolve({ rows: [], rowCount: null } as unknown as QueryResult);
            if (normalized === "COMMIT") return client.query(`RELEASE SAVEPOINT ${name}`) as Promise<QueryResult>;
            if (normalized === "ROLLBACK")
              return client
                .query(`ROLLBACK TO SAVEPOINT ${name}`)
                .then(() => client.query(`RELEASE SAVEPOINT ${name}`)) as Promise<QueryResult>;
            return client.query(query, values as unknown[]) as Promise<QueryResult>;
          },
          on: client.on.bind(client),
          removeListener: client.removeListener.bind(client),
          release: () => undefined,
        };
      },
    }) as unknown as Pool;

  const finishSession = async (command: "COMMIT" | "ROLLBACK") => {
    if (!sessionClient) return;
    const client = sessionClient;
    try {
      await client.query(command);
    } catch (error) {
      if (!stopped) client.release(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      sessionClient = null;
    }
    if (!stopped) client.release();
    client.removeListener("error", fail);
  };

  const handle = async (request: PgQueryWorkerRequest) => {
    try {
      if (request.op === "begin") {
        if (sessionClient) throw new Error("PostgreSQL query session is already active");
        sessionClient = await pool.connect();
        sessionClient.on("error", fail);
        await sessionClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const names = POSTGRES_SCOPE_SCHEMA_CONTRACT.claims;
        await sessionClient.query(
          "SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true)",
          [
            names.tenantId,
            input.scope.tenantId,
            names.projectId,
            input.scope.projectId,
            names.policyEpoch,
            String(input.scope.policyEpoch),
          ],
        );
        await readCutInTransaction(sessionClient, input.scope, [...(input.scope.readers ?? [])], input.repoId);
        respond(request.id, input.state, null);
        return;
      }
      if (request.op === "query") {
        queryNow = request.now;
        if (!sessionClient || !source) throw new Error("PostgreSQL query requested outside a reader session");
        const method = request.method ? Reflect.get(source, request.method) : undefined;
        if (
          !PG_TASK_QUERY_METHODS.includes(request.method as (typeof PG_TASK_QUERY_METHODS)[number]) ||
          typeof method !== "function"
        )
          throw Object.assign(
            new Error(`PostgreSQL task projection query is not implemented: ${request.method ?? ""}`),
            {
              code: "pg_query_not_implemented",
            },
          );
        respond(request.id, input.state, await method.apply(source, [...(request.args ?? [])]));
        return;
      }
      if (request.op === "end") {
        await finishSession("COMMIT");
        respond(request.id, input.state, null);
        return;
      }
      if (request.op === "close") {
        await finishSession("ROLLBACK");
        await pool.end();
        respond(request.id, input.state, null);
        stopped = true;
        input.responsePort.close();
        parentPort!.close();
        return;
      }
      throw new Error(`unknown PostgreSQL task query operation: ${String(request.op)}`);
    } catch (error) {
      if (stopped) {
        consumeKnownError(error);
        return;
      }
      let failure = error;
      if (request.op === "begin" && sessionClient) {
        const client = sessionClient;
        sessionClient = null;
        try {
          await client.query("ROLLBACK");
          client.release();
          client.removeListener("error", fail);
        } catch (rollbackError) {
          client.release(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
          failure = new AggregateError(
            [error, rollbackError],
            "PostgreSQL query session failed to start and roll back.",
          );
          consumeKnownError(rollbackError);
        }
      }
      respond(request.id, input.state, undefined, failure);
      consumeKnownError(failure);
    }
  };

  void initialize().then(
    () => {
      if (stopped) return;
      respond(0, input.ready, null);
      parentPort!.on("message", (request: PgQueryWorkerRequest) => void handle(request));
    },
    async (error: unknown) => {
      if (stopped) {
        consumeKnownError(error);
        return;
      }
      let failure = error;
      try {
        await pool.end();
      } catch (closeError) {
        failure = new AggregateError([error, closeError], "PostgreSQL task query worker failed to start and close.");
        consumeKnownError(closeError);
      }
      respond(0, input.ready, undefined, failure);
      consumeKnownError(failure);
      input.responsePort.close();
      parentPort!.close();
    },
  );
}

function serializeError(value: unknown): {
  readonly name: string;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
} {
  if (!(value instanceof Error)) return { name: "Error", message: String(value), fields: {} };
  const fields: Record<string, unknown> = {};
  for (const key of ["code", "detail", "hint", "constraint", "severity", "schema", "table", "column", "position"])
    if (key in value) fields[key] = Reflect.get(value, key);
  return { name: value.name, message: value.message, fields };
}
