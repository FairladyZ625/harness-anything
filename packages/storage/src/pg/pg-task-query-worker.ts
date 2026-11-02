import { readCutInTransaction } from "./pg-event-queries.ts";
import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { consumeKnownError } from "@harness-anything/kernel";
import { createPgTaskProjectionSource } from "./pg-task-source.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../postgres/scope-schema.ts";
import { PG_TASK_QUERY_METHODS } from "./pg-task-query-contract.ts";
import { createPgStorageBackend } from "./backend.ts";
import type { PostgresTaskEventStoreRequest } from "../postgres/pg-task-event-store.ts";
import type { CanonicalEventV1, LeaseV1 } from "@harness-anything/kernel";
import { changePgLease } from "./pg-lease-cas.ts";
import { rebuildPgProjection } from "./pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { pgEpochTransactions, type PgEpochRequest } from "../postgres/pg-epoch-transaction.ts";
import { pgReplicationHead, pgReplicationPage } from "../postgres/pg-replication.ts";
import type { ReplicationPosition } from "../store/replication-log.ts";
import { pgSlotOperation } from "../postgres/pg-slot-operations.ts";
import path from "node:path";
import { localGitWorktreeSettlement } from "../store/local-version-control-system.ts";

interface PgQueryWorkerData {
  readonly connectionString: string;
  readonly authorityConnectionString?: string;
  readonly requireRuntimeRole?: boolean;
  readonly authoredRoot?: string;
  readonly scope: PgProjectionScope;
  readonly repoId: string;
  readonly path: string;
  readonly ready: Int32Array;
  readonly state: Int32Array;
  readonly responsePort: MessagePort;
}

interface PgQueryWorkerRequest {
  readonly id: number;
  readonly op: "begin" | "query" | "end" | "close" | "canonical" | "lease" | "rebuild" | "epoch" | "replication";
  readonly method?: string;
  readonly args?: readonly unknown[];
  readonly now?: string;
}

const data = workerData as PgQueryWorkerData | undefined;
if (!isMainThread && data && parentPort) startWorker(data);

function startWorker(input: PgQueryWorkerData): void {
  const pool = new Pool({ connectionString: input.connectionString, max: 4 });
  const authorityPool = input.authorityConnectionString
      ? new Pool({ connectionString: input.authorityConnectionString, max: 1 })
      : null,
    epochs = authorityPool ? pgEpochTransactions(authorityPool) : null;
  const backend = createPgStorageBackend({
    pool,
    repoId: input.repoId,
    scope: { ...input.scope, readers: input.scope.readers ?? [] },
    readAuthoredDocument: input.authoredRoot
      ? (logical) => {
          const node = localGitWorktreeSettlement.readNode(path.join(input.authoredRoot!, ...logical.split("/")));
          return node ? { ...node, nodeKind: node.mode === "120000" ? "symbolic-link" : "file" } : null;
        }
      : undefined,
  });
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
  authorityPool?.on("error", fail);
  process.on("uncaughtExceptionMonitor", fail);
  process.on("exit", (code) =>
    fail(Object.assign(new Error(`PostgreSQL task query worker exited (${code})`), { code: "pg_query_worker_exited" })),
  );

  const initialize = async () => {
    const client = await pool.connect();
    try {
      if (input.requireRuntimeRole) {
        const row = (
          await client.query<{ unsafe: boolean }>(
            "SELECT r.rolsuper OR r.rolbypassrls OR EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'ha_%' AND tableowner=current_user) AS unsafe FROM pg_roles r WHERE rolname=current_user",
          )
        ).rows[0];
        if (!row || row.unsafe)
          throw Object.assign(new Error("PostgreSQL runtime requires a non-owner role without BYPASSRLS"), {
            code: "pg_runtime_role_unsafe",
          });
      }
    } finally {
      client.release();
    }
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
      if (request.op === "replication") {
        if (sessionClient) throw new Error("replication operations cannot nest in a query session");
        const scope = { ...input.scope, readers: input.scope.readers ?? [] },
          args = request.args?.[0] as { after: ReplicationPosition; limit: number } | undefined;
        const result = await withPostgresTransaction(
          pool,
          async (client) => {
            if (request.method === "head") return pgReplicationHead(client, scope, input.repoId);
            if (request.method === "slots")
              return pgSlotOperation(
                client,
                scope,
                input.repoId,
                request.args![0] as Parameters<typeof pgSlotOperation>[3],
              );
            if (request.method === "page" && args)
              return pgReplicationPage(client, scope, input.repoId, args.after, args.limit);
            throw new Error("unknown PG replication operation");
          },
          scope,
          { isolationLevel: "repeatable read" },
        );
        respond(request.id, input.state, result);
        return;
      }
      if (request.op === "epoch") {
        if (sessionClient || !epochs)
          throw new Error("PG epoch authority is unavailable during a read session or without a management connection");
        respond(request.id, input.state, await epochs.execute(request.args![0] as PgEpochRequest));
        return;
      }
      if (request.op === "lease") {
        if (sessionClient) throw new Error("lease writes cannot run inside a projection read session");
        const [operation, expected, now, expiresAt] = request.args as [
          "reserve" | "activate" | "renew" | "release",
          LeaseV1,
          string,
          string | undefined,
        ];
        respond(
          request.id,
          input.state,
          await changePgLease({
            pool,
            scope: { ...input.scope, readers: input.scope.readers ?? [] },
            repoId: input.repoId,
            operation,
            expected,
            now,
            expiresAt,
          }),
        );
        return;
      }
      if (request.op === "rebuild") {
        if (sessionClient) throw new Error("rebuild cannot run inside a projection read session");
        await withPostgresTransaction(
          pool,
          async (client) => {
            const keys = [input.scope.tenantId, input.scope.projectId, input.repoId];
            const head = (
              await client.query<{ revision: string }>(
                "SELECT revision FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 FOR UPDATE",
                keys,
              )
            ).rows[0];
            const events = (
              await client.query<{ event_json: string; readers: string[] }>(
                "SELECT event_json,readers FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 ORDER BY revision",
                keys,
              )
            ).rows;
            const readers = new Map(
              events.map((row) => [(JSON.parse(row.event_json) as CanonicalEventV1).opId, row.readers]),
            );
            await rebuildPgProjection(client, input.scope, {
              events: events.map((row) => JSON.parse(row.event_json) as CanonicalEventV1),
              sourceRevision: Number(head?.revision ?? 0),
              readEventReaders: (event) => readers.get(event.opId) ?? [],
              readContentBlob: async (sha256) =>
                (
                  await client.query<{ body: Buffer }>(
                    "SELECT body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3",
                    [input.scope.tenantId, input.scope.projectId, sha256],
                  )
                ).rows[0]?.body ?? null,
            });
          },
          input.scope,
        );
        respond(request.id, input.state, null);
        return;
      }
      if (request.op === "canonical") {
        if (sessionClient) throw new Error("canonical operations cannot run inside a projection read session");
        respond(
          request.id,
          input.state,
          await backend.eventStore.execute(request.args![0] as PostgresTaskEventStoreRequest),
        );
        return;
      }
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
        await epochs?.close();
        await authorityPool?.end();
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
        await epochs?.close();
        await authorityPool?.end();
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
