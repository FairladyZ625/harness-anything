import { borrowPgReadClient } from "./pg-read-savepoint.ts";
import { backfillPgEntityDeclarationPage } from "./pg-entity-declaration-catchup.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { Pool, type PoolClient } from "pg";
import { consumeKnownError } from "@harness-anything/kernel";
import { createPgTaskProjectionSource } from "./pg-task-source.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { PG_TASK_QUERY_METHODS } from "./pg-task-query-contract.ts";
import { createPgStorageBackend } from "./backend.ts";
import type { PostgresTaskEventStoreRequest } from "../postgres/pg-task-event-store.ts";
import type { CanonicalEventV1, LeaseV1 } from "@harness-anything/kernel";
import { changePgLease } from "./pg-lease-cas.ts";
import { initializePgTerminalMaterialization } from "./pg-query-model-materialize.ts";
import { rebuildPgProjection } from "./pg-task-event-materialize.ts";
import { backfillPgArtifactDocuments } from "./pg-artifact-timeline.ts";
import { backfillPgDispatchLifecycle } from "./pg-dispatch-lifecycle.ts";
import { maintainPgRelationCycleAuditPage } from "./pg-relation-cycle-audit.ts";
import { borrowPostgresCommitWork, withPostgresTransaction, withPostgresCommitGuard } from "../postgres/transaction.ts";
import { pgEpochTransactions, type PgEpochRequest } from "../postgres/pg-epoch-transaction.ts";
import { pgReplicationHead, pgReplicationPage } from "../postgres/pg-replication.ts";
import type { ReplicationPosition } from "../store/replication-log.ts";
import { pgSlotOperation } from "../postgres/pg-slot-operations.ts";
import path from "node:path";
import { localGitWorktreeSettlement } from "../store/local-version-control-system.ts";

export interface PgQuerySessionInput {
  readonly requestPort: MessagePort;
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
  readonly op:
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
    | "replication";
  readonly method?: string;
  readonly args?: readonly unknown[];
  readonly now?: string;
}

type StandalonePgWorkerInput = Omit<PgQuerySessionInput, "requestPort"> & {
  readonly connectionString: string;
  readonly authorityConnectionString?: string;
};
const data = workerData as StandalonePgWorkerInput | undefined;
if (!isMainThread && parentPort && typeof data?.connectionString === "string") {
  const pool = new Pool({ connectionString: data.connectionString, max: 4 }),
    authority = data.authorityConnectionString
      ? new Pool({ connectionString: data.authorityConnectionString, max: 1 })
      : null,
    session = startWorker({ ...data, requestPort: parentPort }, pool, authority);
  process.on("uncaughtExceptionMonitor", session.fail);
  process.on("exit", (code) =>
    session.fail(
      Object.assign(new Error(`PostgreSQL task query worker exited (${code})`), { code: "pg_query_worker_exited" }),
    ),
  );
}
export { startWorker as startPgQuerySession };

function startWorker(
  input: PgQuerySessionInput,
  pool: Pool,
  authorityPool: Pool | null,
  options: {
    readonly ownsPools?: boolean;
    readonly beforeCommitCasHook?: () => Promise<void>;
    readonly afterCommitCasHook?: () => Promise<void>;
    readonly onClose?: () => void;
    readonly onFailure?: (error: Error) => void;
    readonly readSessions?: {
      readonly begin: (client: PoolClient) => void;
      readonly beforeEnd: (client: PoolClient) => Promise<void>;
      readonly end: (client: PoolClient) => void;
    };
    readonly epochs?: ReturnType<typeof pgEpochTransactions>;
    readonly canonical?: <Result>(
      request: PostgresTaskEventStoreRequest,
      operation: () => Promise<Result>,
    ) => Promise<Result>;
  } = {},
): { readonly close: () => Promise<void>; readonly fail: (error: Error) => void } {
  const ownsPools = options.ownsPools !== false,
    epochs = options.epochs ?? (authorityPool ? pgEpochTransactions(authorityPool) : null);
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
    sessionClient: PoolClient | null = null;
  let sessionEnd: ((rollback: boolean) => void) | undefined, sessionCompletion: Promise<boolean> | undefined;
  const pending = new Set<Promise<void>>();
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
    sessionEnd?.(true);
    if (ownsPools) void pool.end();
    input.responsePort.close();
    input.requestPort.close();
    options.onFailure?.(error);
  };
  if (ownsPools) {
    pool.on("error", fail);
    authorityPool?.on("error", fail);
  }

  const initialize = async () => {
    const client = await pool.connect();
    let borrowedReadOnly = false;
    try {
      // Embedded storage has no replication peer. Network PG must retain at least remote flush durability.
      if (!options.readSessions) {
        const row = (await client.query<{ synchronous_commit: string }>("SHOW synchronous_commit")).rows[0];
        if (!row || !["on", "remote_apply"].includes(row.synchronous_commit))
          throw Object.assign(new Error("PostgreSQL runtime requires synchronous_commit=on or remote_apply"), {
            code: "pg_synchronous_commit_unsafe",
          });
      }
      if (options.readSessions)
        borrowedReadOnly =
          (await client.query<{ transaction_read_only: string }>("SHOW transaction_read_only")).rows[0]!
            .transaction_read_only === "on";
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
      await client.release();
    }
    // An embedded facade may borrow another reader's snapshot. Only that actual read-only
    // transaction must skip writes; ordinary opens still prepare their scoped cache.
    if (!borrowedReadOnly)
      for (;;) {
        const page = await withPostgresTransaction(
          pool,
          (cycleClient) => maintainPgRelationCycleAuditPage(cycleClient, input.scope),
          input.scope,
        );
        if (page.done) break;
      }
    if (!borrowedReadOnly)
      await withPostgresTransaction(
        pool,
        async (client) => {
          const metadata = await client.query<{ watermark: string }>(
            "SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
            [input.scope.tenantId, input.scope.projectId, input.scope.policyEpoch],
          );
          await initializePgTerminalMaterialization(client, input.scope, Number(metadata.rows[0]?.watermark ?? 0));
        },
        input.scope,
      );
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
        if (!sessionClient) throw new Error("PostgreSQL query requested outside a reader session");
        const owner = sessionClient;
        return borrowPostgresCommitWork(await borrowPgReadClient(owner), owner);
      },
    }) as unknown as Pool;

  const finishSession = async (command: "COMMIT" | "ROLLBACK") => {
    if (sessionClient) await options.readSessions?.beforeEnd(sessionClient);
    sessionEnd?.(command === "ROLLBACK");
    await sessionCompletion;
    sessionEnd = undefined;
    sessionCompletion = undefined;
  };

  let closing: Promise<void> | undefined;
  const closeResources = () =>
    (closing ??= (async () => {
      await Promise.all(pending);
      await finishSession("ROLLBACK");
      await epochs?.close();
      if (ownsPools) {
        await authorityPool?.end();
        await pool.end();
      }
      options.onClose?.();
    })());
  const close = async () => {
    if (stopped) return;
    await closeResources();
    stopped = true;
    input.responsePort.close();
    input.requestPort.close();
  };

  const handle = async (request: PgQueryWorkerRequest) => {
    if (stopped || closing) return;
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
        for (;;) {
          const page = await withPostgresTransaction(
            pool,
            (client) => maintainPgRelationCycleAuditPage(client, input.scope),
            input.scope,
          );
          if (page.done) break;
        }
        respond(request.id, input.state, null);
        return;
      }
      if (request.op === "warm-indexes") {
        if (sessionClient) throw new Error("index catch-up cannot run inside a projection read session");
        respond(
          request.id,
          input.state,
          await backfillPgEntityDeclarationPage(pool, input.scope, input.repoId, Number(request.args?.[0] ?? 64)),
        );
        return;
      }
      if (request.op === "relation-cycle-maintenance") {
        if (sessionClient) throw new Error("relation cycle maintenance cannot run inside a projection read session");
        respond(
          request.id,
          input.state,
          await withPostgresTransaction(
            pool,
            (client) => maintainPgRelationCycleAuditPage(client, input.scope),
            input.scope,
          ),
        );
        return;
      }
      if (request.op === "artifact-backfill") {
        if (sessionClient) throw new Error("artifact backfill cannot run inside a projection read session");
        respond(
          request.id,
          input.state,
          await withPostgresTransaction(
            pool,
            (client) => backfillPgArtifactDocuments(client, input.scope, input.repoId),
            input.scope,
          ),
        );
        return;
      }
      if (request.op === "dispatch-lifecycle-backfill") {
        if (sessionClient) throw new Error("dispatch lifecycle backfill cannot run inside a projection read session");
        respond(
          request.id,
          input.state,
          await withPostgresTransaction(
            pool,
            (client) => backfillPgDispatchLifecycle(client, input.scope, input.repoId),
            input.scope,
          ),
        );
        return;
      }
      if (request.op === "canonical") {
        if (sessionClient) throw new Error("canonical operations cannot run inside a projection read session");
        const value = request.args![0] as PostgresTaskEventStoreRequest,
          operation = () => backend.eventStore.execute(value);
        respond(request.id, input.state, await (options.canonical ? options.canonical(value, operation) : operation()));
        return;
      }
      if (request.op === "begin") {
        if (sessionClient) throw new Error("PostgreSQL query session is already active");
        const begun = Promise.withResolvers<void>(),
          ending = Promise.withResolvers<boolean>();
        sessionEnd = ending.resolve;
        sessionCompletion = withPostgresTransaction(
          pool,
          async (client) => {
            if (stopped || closing) throw new Error("PostgreSQL query reader closed before its session began");
            sessionClient = client;
            client.on("error", fail);
            try {
              await readCutInTransaction(client, input.scope, [...(input.scope.readers ?? [])], input.repoId);
              options.readSessions?.begin(client);
              begun.resolve();
              return await ending.promise;
            } finally {
              options.readSessions?.end(client);
              client.removeListener("error", fail);
              sessionClient = null;
            }
          },
          input.scope,
          { isolationLevel: "repeatable read", readOnly: true, rollbackOnly: (rollback) => rollback },
        );
        // Startup failures settle begin; later failures are observed by finishSession.
        void sessionCompletion.catch(begun.reject);
        await begun.promise;
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
        await closeResources();
        respond(request.id, input.state, null);
        stopped = true;
        input.responsePort.close();
        input.requestPort.close();
        return;
      }
      throw new Error(`unknown PostgreSQL task query operation: ${String(request.op)}`);
    } catch (error) {
      if (stopped) {
        consumeKnownError(error);
        return;
      }
      let failure = error;
      if (request.op === "begin" && sessionCompletion) {
        try {
          await finishSession("ROLLBACK");
        } catch (rollbackError) {
          if (rollbackError !== error)
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

  const guardCommit = async (state: Int32Array, requestHooks: boolean) => {
    if (requestHooks) await options.beforeCommitCasHook?.();
    const previous = Atomics.compareExchange(state, 1, 0, 1);
    if (previous === -1)
      throw Object.assign(new Error("PostgreSQL write aborted before commit"), {
        code: "write_aborted_pre_commit",
      });
    // Startup and multi-transaction requests remain uncancellable after their first COMMIT.
    if (requestHooks) await options.afterCommitCasHook?.();
  };
  void withPostgresCommitGuard(() => guardCommit(input.ready, false), initialize).then(
    () => {
      if (stopped) return;
      respond(0, input.ready, null);
      input.requestPort.on("message", (request: PgQueryWorkerRequest) => {
        // Logical reads can commit deferred cold-recovery writes. Bind their physical
        // owner at begin too: its async context survives until end resolves the session.
        const operation = withPostgresCommitGuard(
          () => guardCommit(input.state, true),
          () => handle(request),
        );
        if (request.op !== "close") pending.add(operation);
        void operation.then(
          () => pending.delete(operation),
          (error: unknown) => {
            pending.delete(operation);
            fail(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    },
    async (error: unknown) => {
      if (stopped) {
        consumeKnownError(error);
        return;
      }
      let failure = error;
      try {
        await closeResources();
      } catch (closeError) {
        failure = new AggregateError([error, closeError], "PostgreSQL task query worker failed to start and close.");
        consumeKnownError(closeError);
      }
      respond(0, input.ready, undefined, failure);
      consumeKnownError(failure);
      input.responsePort.close();
      input.requestPort.close();
    },
  );
  return { close, fail };
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

export { serializeError as serializePgQueryError };
