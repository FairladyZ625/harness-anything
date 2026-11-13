// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import type { Pool } from "pg";
import { startPgQuerySession } from "../../src/pg/pg-task-query-worker.ts";

test(
  "closing a query endpoint drains its active operation before returning the client",
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
      { port1, port2 } = new MessageChannel(),
      startup = once(port1, "message"),
      session = startPgQuerySession(
        {
          repoId: "drain",
          path: "test",
          scope: { tenantId: "drain", projectId: "drain", policyEpoch: 1 },
          ready: new Int32Array(new SharedArrayBuffer(4)),
          state: new Int32Array(new SharedArrayBuffer(4)),
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
      assert.equal(releases, 2, "only initialization and write-side maintenance have released clients");
      unblock();
      const [reply] = await result;
      assert.equal(reply.error, undefined);
      assert.equal(reply.result, null);
      await closing;
      assert.equal(releases, 3);
      assert.equal(checkedOut, false);
    } finally {
      unblock();
      await session.close();
      port1.close();
      port2.close();
    }
  },
);
