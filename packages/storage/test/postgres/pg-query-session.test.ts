// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import type { Pool } from "pg";
import { startPgQuerySession } from "../../src/pg/pg-task-query-worker.ts";
import { pgliteGroupReadPool } from "../../src/pglite/read-session-pool.ts";

for (const { embedded, readOnly } of [
  { embedded: false, readOnly: false },
  { embedded: true, readOnly: false },
  { embedded: true, readOnly: true },
])
  test(
    `closing a ${readOnly ? "borrowed read-only" : embedded ? "embedded" : "standalone"} query endpoint drains its active operation before returning the client`,
    { timeout: 5_000 },
    async () => {
      let unblock!: () => void, observed!: () => void;
      const blocked = new Promise<void>((resolve) => {
          unblock = resolve;
        }),
        reached = new Promise<void>((resolve) => {
          observed = resolve;
        });
      let checkedOut = false,
        releases = 0,
        waiting = false;
      const client = Object.assign(new EventEmitter(), {
        async query(sql: string) {
          assert.equal(checkedOut, true, "an unfinished operation used a returned pool client");
          if (sql === "SHOW synchronous_commit") return { rows: [{ synchronous_commit: "on" }], rowCount: 1 };
          if (sql === "SHOW transaction_read_only")
            return { rows: [{ transaction_read_only: readOnly ? "on" : "off" }], rowCount: 1 };
          if (readOnly)
            assert.doesNotMatch(
              sql,
              /\b(?:INSERT|UPDATE|DELETE)\b/u,
              "opening a shared query facade must remain read-only",
            );
          if (sql === "SHOW synchronous_commit") return { rows: [{ synchronous_commit: "on" }], rowCount: 1 };
          if (sql.includes("SELECT backfill_cursor,backfill_complete FROM ha_relation_cycle_count"))
            return { rows: [{ backfill_cursor: null, backfill_complete: true }], rowCount: 1 };
          if (/^\s*SELECT value FROM ha_projection_values/u.test(sql) && !waiting) {
            waiting = true;
            observed();
            await blocked;
          }
          return { rows: [], rowCount: 0 };
        },
        release() {
          assert.equal(checkedOut, true);
          checkedOut = false;
          releases++;
        },
      });
      const pool = {
          connect: async () => {
            assert.equal(checkedOut, false);
            checkedOut = true;
            return client;
          },
        } as unknown as Pool,
        readSessions = embedded ? pgliteGroupReadPool(pool, { active: true, writes: new Set() }) : undefined,
        { port1, port2 } = new MessageChannel(),
        startup = once(port1, "message"),
        session = startPgQuerySession(
          {
            repoId: "drain",
            path: "test",
            scope: { tenantId: "drain", projectId: "drain", policyEpoch: 1 },
            ready: new Int32Array(new SharedArrayBuffer(12)),
            state: new Int32Array(new SharedArrayBuffer(12)),
            requestPort: port2,
            responsePort: port2,
          },
          readSessions?.pool ?? pool,
          null,
          { ownsPools: false, readSessions },
        );
      try {
        const [ready] = await startup;
        assert.equal(ready.error, undefined);
        const begin = once(port1, "message");
        port1.postMessage({ id: 1, op: "begin" });
        await begin;
        const result = once(port1, "message");
        port1.postMessage({ id: 2, op: "query", method: "readRuntimeSession", args: ["session"] });
        await reached;
        let closed = false;
        const closing = session.close().then(() => {
          closed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(closed, false, "close returned while its query still owned the connection");
        assert.equal(
          releases,
          readOnly ? 1 : 2,
          "only initialization and standalone maintenance have released clients",
        );
        unblock();
        const [reply] = await result;
        assert.equal(reply.error, undefined);
        assert.equal(reply.result, null);
        await closing;
        assert.equal(releases, readOnly ? 2 : 3);
        assert.equal(checkedOut, false);
      } finally {
        unblock();
        await session.close();
        port1.close();
        port2.close();
      }
    },
  );

// A cancellation must be decided by the transaction owner before COMMIT starts.
import { withPostgresTransaction, withPostgresCommitGuard } from "../../src/postgres/transaction.ts";

test("C6a: cancellation winning before the final SQL returns prevents COMMIT", { timeout: 5000 }, async () => {
  const state = new Int32Array(new SharedArrayBuffer(12));
  let arm = false,
    commitCalls = 0,
    rollbackCalls = 0;
  const reached = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>();
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      if (sql === "SHOW synchronous_commit") return { rows: [{ synchronous_commit: "on" }], rowCount: 1 };
      if (sql.includes("SELECT backfill_cursor,backfill_complete FROM ha_relation_cycle_count")) {
        if (arm) {
          reached.resolve();
          await released.promise;
        }
        return { rows: [{ backfill_cursor: null, backfill_complete: true }], rowCount: 1 };
      }
      if (arm && sql === "COMMIT") commitCalls++;
      if (arm && sql === "ROLLBACK") rollbackCalls++;
      return { rows: [], rowCount: 0 };
    },
    release() {},
  });
  const pool = { connect: async () => client } as unknown as Pool;
  const { port1, port2 } = new MessageChannel();
  const startup = once(port1, "message");
  const session = startPgQuerySession(
    {
      repoId: "cas-baseline",
      path: "test",
      scope: { tenantId: "cas", projectId: "cas", policyEpoch: 1 },
      ready: new Int32Array(new SharedArrayBuffer(12)),
      state,
      requestPort: port2,
      responsePort: port2,
    },
    pool,
    null,
    { ownsPools: false },
  );
  try {
    const [ready] = await startup;
    assert.equal(ready.error, undefined);
    arm = true;
    Atomics.store(state, 2, 1);
    const response = once(port1, "message");
    port1.postMessage({ id: 1, op: "relation-cycle-maintenance" });
    await reached.promise;
    const cancelPrevious = Atomics.compareExchange(state, 1, 0, -1);
    assert.equal(cancelPrevious, 0);
    released.resolve();
    const [reply] = await response;
    console.log("S2_C6A", JSON.stringify({ cancelPrevious, state: [...state], commitCalls, rollbackCalls, reply }));
    assert.equal(commitCalls, 0, "a successful pre-commit cancellation must exclude COMMIT");
    assert.equal(rollbackCalls, 1);
  } finally {
    released.resolve();
    await session.close();
    port1.close();
    port2.close();
  }
});

test("commit guard rejection remains a transaction-owner rollback", async () => {
  const queries: string[] = [];
  const aborted = Object.assign(new Error("pre-commit CAS lost"), { code: "write_aborted_pre_commit" });
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      queries.push(sql);

      return { rows: [], rowCount: 0 };
    },
    release() {},
  });
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(
    withPostgresCommitGuard(
      async () => {
        throw aborted;
      },
      () => withPostgresTransaction(pool, async () => null),
    ),
    (error) => error === aborted,
  );
  console.log(
    "S2_COMMIT_OWNER",
    JSON.stringify({ queries, rollbackCalls: queries.filter((sql) => sql === "ROLLBACK").length }),
  );
  assert.equal(
    queries.filter((sql) => sql === "ROLLBACK").length,
    1,
    "CAS rejection must remain a pre-commit rollback path",
  );
});
