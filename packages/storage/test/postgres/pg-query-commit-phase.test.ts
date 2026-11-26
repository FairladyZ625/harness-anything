// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
import type { Pool } from "pg";
import { createPgTaskQueryReader, waitForPgQueryWorker } from "../../src/pg/pg-task-query-reader.ts";
import { startPgQuerySession } from "../../src/pg/pg-task-query-worker.ts";
import { borrowPgReadClient } from "../../src/pg/pg-read-savepoint.ts";
import { pgEpochTransactions } from "../../src/postgres/pg-epoch-transaction.ts";
import {
  withPostgresTransaction,
  withPostgresCommitGuard,
  afterPostgresCommit,
  borrowPostgresCommitWork,
} from "../../src/postgres/transaction.ts";

test("C6a timeout waits for rollback and kills only a stuck aborted request", (t) => {
  for (const stuck of [false, true]) {
    const { port1, port2 } = new MessageChannel(),
      state = new Int32Array(new SharedArrayBuffer(12));
    let clock = 0,
      terminateCalls = 0;
    const calls: number[] = [];
    const now = t.mock.method(performance, "now", () => clock);
    const wait = t.mock.method(Atomics, "wait", (_state: Int32Array, _index: number, _value: number, ms: number) => {
      calls.push(ms);
      clock += ms;
      if (calls.length === 2 && !stuck) {
        assert.equal(Atomics.load(state, 1), -1);
        port2.postMessage({
          id: 1,
          error: { name: "Error", message: "aborted", fields: { code: "write_aborted_pre_commit" } },
        });
        Atomics.store(state, 0, 1);
      }
      return "timed-out" as const;
    });
    try {
      const response = () =>
        waitForPgQueryWorker(
          state,
          port1,
          1,
          200,
          {
            terminate: () => {
              terminateCalls++;
            },
          } as never,
          "timeout",
          { rollbackGraceMs: 50 },
        );
      if (stuck) assert.throws(response, { code: "pg_query_worker_timeout" });
      else assert.equal(response().error?.fields?.code, "write_aborted_pre_commit");
      assert.deepEqual(calls, [200, 50]);
      assert.equal(Atomics.load(state, 1), -1);
      assert.equal(terminateCalls, stuck ? 1 : 0);
      console.log("C6A_ROLLBACK_WAIT", JSON.stringify({ stuck, terminateCalls, phase: state[1], calls }));
    } finally {
      now.mock.restore();
      wait.mock.restore();
      port1.close();
      port2.close();
    }
  }
});

for (const write of [false, true])
  test(`C6b ${write ? "write" : "read"} commit ignores expired deadline, polls in 1s slices, and never terminates`, (t) => {
    const { port1, port2 } = new MessageChannel(),
      state = new Int32Array(new SharedArrayBuffer(12));
    Atomics.compareExchange(state, 1, 0, 1);
    let terminateCalls = 0;
    const waits: number[] = [];
    t.mock.method(Atomics, "wait", (_state: Int32Array, _index: number, _value: number, ms: number) => {
      waits.push(ms);
      assert.equal(Atomics.compareExchange(state, 1, 0, -1), 1);
      if (waits.length === 3) {
        port2.postMessage({ id: 1, result: "committed" });
        Atomics.store(state, 0, 1);
      }
      return "timed-out" as const;
    });
    try {
      assert.equal(
        waitForPgQueryWorker(
          state,
          port1,
          1,
          1,
          {
            terminate: () => {
              terminateCalls++;
            },
          } as never,
          "timeout",
          write ? { rollbackGraceMs: 1 } : undefined,
        ).result,
        "committed",
      );
      assert.deepEqual(waits, [1000, 1000, 1000]);
      assert.equal(terminateCalls, 0);
      assert.equal(state[1], 1);
      console.log("C6B_WAIT", JSON.stringify({ terminateCalls, waits, phase: state[1] }));
    } finally {
      port1.close();
      port2.close();
    }
  });

test("read timeout losing the abort CAS retains a concurrently committing worker", (t) => {
  const { port1, port2 } = new MessageChannel(),
    state = new Int32Array(new SharedArrayBuffer(12)),
    compareExchange = Atomics.compareExchange;
  let clock = 0,
    terminateCalls = 0,
    abortAttempts = 0;
  const waits: number[] = [];
  t.mock.method(performance, "now", () => clock);
  t.mock.method(
    Atomics,
    "compareExchange",
    (array: Int32Array, index: number, expected: number, replacement: number) => {
      if (index === 1 && replacement === -1) {
        abortAttempts++;
        assert.equal(compareExchange(array, index, 0, 1), 0);
      }
      return compareExchange(array, index, expected, replacement);
    },
  );
  t.mock.method(Atomics, "wait", (_state: Int32Array, _index: number, _value: number, ms: number) => {
    waits.push(ms);
    clock += ms;
    if (ms === 1000) {
      port2.postMessage({ id: 1, result: "committed" });
      Atomics.store(state, 0, 1);
    }
    return "timed-out" as const;
  });
  try {
    assert.equal(
      waitForPgQueryWorker(
        state,
        port1,
        1,
        200,
        {
          terminate: () => {
            terminateCalls++;
          },
        } as never,
        "timeout",
      ).result,
      "committed",
    );
    assert.equal(abortAttempts, 1);
    assert.deepEqual(waits, [200, 1000]);
    assert.equal(state[1], 1);
    assert.equal(terminateCalls, 0);
  } finally {
    port1.close();
    port2.close();
  }
});

test("startup maintenance owns a protected commit phase before its handshake settles", { timeout: 5000 }, async () => {
  const ready = new Int32Array(new SharedArrayBuffer(12)),
    state = new Int32Array(new SharedArrayBuffer(12)),
    entered = Promise.withResolvers<void>(),
    released = Promise.withResolvers<void>(),
    { port1, port2 } = new MessageChannel();
  let requestHooks = 0;
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      if (sql === "SHOW synchronous_commit") return { rows: [{ synchronous_commit: "on" }] };
      if (sql.includes("SELECT backfill_cursor,backfill_complete FROM ha_relation_cycle_count"))
        return { rows: [{ backfill_cursor: null, backfill_complete: true }] };
      if (sql === "COMMIT") {
        entered.resolve();
        await released.promise;
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  });
  const startup = once(port1, "message"),
    session = startPgQuerySession(
      {
        repoId: "startup",
        path: "startup",
        scope: { tenantId: "t", projectId: "p", policyEpoch: 1 },
        ready,
        state,
        requestPort: port2,
        responsePort: port2,
      },
      { connect: async () => client } as unknown as Pool,
      null,
      {
        ownsPools: false,
        beforeCommitCasHook: async () => {
          requestHooks++;
        },
      },
    );
  try {
    await entered.promise;
    assert.equal(ready[0], 0);
    assert.equal(ready[1], 1);
    assert.equal(state[1], 0, "startup must not consume the first request's phase");
    assert.equal(requestHooks, 0, "request interleaving hooks do not run during startup");
    released.resolve();
    assert.equal((await startup)[0].error, undefined);
    assert.equal(ready[0], 1);
  } finally {
    released.resolve();
    await startup;
    await session.close();
    port1.close();
    port2.close();
  }
});

test("commit-phase worker death returns indeterminate without attempting termination", () => {
  const { port1, port2 } = new MessageChannel(),
    state = new Int32Array(new SharedArrayBuffer(12));
  Atomics.compareExchange(state, 1, 0, 1);
  Atomics.store(state, 0, -1);
  port2.postMessage({
    id: -1,
    fatal: true,
    error: { name: "Error", message: "worker exited", fields: { code: "pg_query_worker_exited" } },
  });
  let terminated = false;
  try {
    assert.equal(
      waitForPgQueryWorker(
        state,
        port1,
        1,
        1,
        {
          terminate: () => {
            terminated = true;
          },
        } as never,
        "timeout",
        { rollbackGraceMs: 1 },
      ).error?.fields?.code,
      "publication_indeterminate",
    );
    assert.equal(terminated, false);
  } finally {
    port1.close();
    port2.close();
  }
});

test("reader exposes one 12-byte request bridge and resets phase only between completed ids", () => {
  const state = new Int32Array(new SharedArrayBuffer(12));
  const ids: number[] = [];
  const reader = createPgTaskQueryReader(
    { state, repoId: "r", scope: { tenantId: "t", projectId: "p", policyEpoch: 1 } },
    (input) => {
      input.responsePort.postMessage({ id: 0 });
      Atomics.store(input.ready, 0, 1);
      return Object.assign(new EventEmitter(), {
        unref() {},
        terminate() {
          throw new Error("unexpected termination");
        },
        postMessage(request: { id: number; op: string }) {
          assert.equal(input.state.byteLength, 12);
          assert.equal(input.state, state);
          assert.equal(state[1], 0);
          assert.equal(state[2], request.id);
          ids.push(request.id);
          Atomics.compareExchange(state, 1, 0, 1);
          input.responsePort.postMessage({ id: request.id, result: null });
          Atomics.store(state, 0, 1);
          if (request.op === "close") input.responsePort.close();
        },
      });
    },
  );
  reader.executeCanonical({ operation: "head" });
  const oldId = state[2];
  reader.executeCanonical({ operation: "head" });
  assert.notEqual(state[2], oldId, "a stale cancellation must check its id before CAS");
  reader.close();
  assert.deepEqual(ids, [1, 2, 3]);
});

for (const setting of ["on", "remote_apply", "off", "local", "remote_write"])
  test(`network worker startup enforces remote flush: synchronous_commit=${setting}`, async () => {
    const { port1, port2 } = new MessageChannel();
    const client = Object.assign(new EventEmitter(), {
      async query(sql: string) {
        if (sql === "SHOW synchronous_commit") return { rows: [{ synchronous_commit: setting }] };
        if (sql.includes("SELECT backfill_cursor,backfill_complete"))
          return { rows: [{ backfill_complete: true, backfill_cursor: null }] };
        return { rows: [] };
      },
      release() {},
    });
    const startup = once(port1, "message");
    const session = startPgQuerySession(
      {
        requestPort: port2,
        responsePort: port2,
        repoId: "r",
        path: "test",
        scope: { tenantId: "t", projectId: "p", policyEpoch: 1 },
        ready: new Int32Array(new SharedArrayBuffer(12)),
        state: new Int32Array(new SharedArrayBuffer(12)),
      },
      { connect: async () => client } as unknown as Pool,
      null,
      { ownsPools: false },
    );
    try {
      const [response] = await startup;
      if (["on", "remote_apply"].includes(setting)) assert.equal(response.error, undefined);
      else assert.equal(response.error.fields.code, "pg_synchronous_commit_unsafe");
    } finally {
      await session.close();
      port1.close();
      port2.close();
    }
  });

for (const operation of ["acquire", "retire"] as const)
  test(`epoch ${operation} COMMIT obeys the same cancellation guard`, async () => {
    const queries: string[] = [];
    const client = Object.assign(new EventEmitter(), {
      async query(sql: string) {
        queries.push(sql);
        return {
          rows: sql.startsWith("SELECT writer_epoch")
            ? [{ writer_epoch: "1", writer_holder_id: "h", writer_issued_at: "now", migration_control: null }]
            : sql.startsWith("SELECT MAX(writer_epoch)")
              ? [{ floor: "0" }]
              : [],
        };
      },
      release() {},
    });
    const epochs = pgEpochTransactions({ connect: async () => client } as unknown as Pool);
    const request = { repoId: "r", holderId: "h", now: "now", epoch: 1 };
    const aborted = Object.assign(new Error("cancelled"), { code: "write_aborted_pre_commit" });
    await assert.rejects(
      withPostgresCommitGuard(
        async () => {
          throw aborted;
        },
        () => epochs.execute({ ...request, operation }),
      ),
      { code: "write_aborted_pre_commit" },
    );
    assert.equal(queries.filter((q) => q === "COMMIT").length, 0);
    assert.equal(queries.filter((q) => q === "ROLLBACK").length, 1);
    await epochs.close();
  });

for (const operation of ["acquire", "retire"] as const)
  test(`epoch ${operation} commit disconnect destroys the connection without rollback`, async () => {
    const queries: string[] = [],
      failure = Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
    let releaseError: unknown;
    const client = Object.assign(new EventEmitter(), {
      async query(sql: string) {
        queries.push(sql);
        if (sql === "COMMIT") throw failure;
        return {
          rows: sql.startsWith("SELECT writer_epoch")
            ? [{ writer_epoch: "1", writer_holder_id: "h", writer_issued_at: "now", migration_control: null }]
            : sql.startsWith("SELECT MAX(writer_epoch)")
              ? [{ floor: "0" }]
              : [],
        };
      },
      release(error: unknown) {
        releaseError = error;
      },
    });
    const epochs = pgEpochTransactions({ connect: async () => client } as unknown as Pool),
      request = { repoId: "r", holderId: "h", now: "now", epoch: 1 };
    await assert.rejects(epochs.execute({ ...request, operation }), (error) => error === failure);
    assert.equal(queries.filter((q) => q === "ROLLBACK").length, 0);
    assert.equal(releaseError, failure);
    await epochs.close();
  });

for (const broken of [false, true])
  test(`epoch held fence releases lock WAL with rollback (${broken ? "broken connection" : "healthy"})`, async () => {
    const queries: string[] = [];
    const failure = new Error("rollback connection lost");
    let releaseError: unknown;
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (broken && sql === "ROLLBACK") throw failure;
        return { rows: [{ writer_epoch: "1", writer_holder_id: "h", migration_control: null }] };
      },
      release(error: unknown) {
        releaseError = error;
      },
    };
    const epochs = pgEpochTransactions({ connect: async () => client } as unknown as Pool);
    const request = { repoId: "r", holderId: "h", now: "now", epoch: 1 };
    await epochs.execute({ ...request, operation: "begin" });
    let commitGuardCalls = 0;
    const end = withPostgresCommitGuard(
      async () => {
        commitGuardCalls++;
      },
      () => epochs.execute({ ...request, operation: "end" }),
    );
    if (broken) await assert.rejects(end, (error) => error === failure);
    else await end;
    assert.ok(queries.some((sql) => sql.endsWith(" FOR SHARE")));
    assert.equal(queries.filter((sql) => sql === "COMMIT").length, 0);
    assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1);
    assert.equal(commitGuardCalls, 0);
    assert.equal(releaseError, broken ? failure : undefined);
    await epochs.close();
  });

test("savepoint read commit work runs only after its physical snapshot commits", async () => {
  const events: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      events.push(sql);
      return { rows: [] };
    },
    release() {},
  });
  const pool = { connect: async () => client } as unknown as Pool;
  await withPostgresTransaction(pool, async (owner) => {
    const borrowed = borrowPostgresCommitWork(await borrowPgReadClient(owner), owner);
    await withPostgresTransaction({ connect: async () => borrowed } as unknown as Pool, async (reader) => {
      afterPostgresCommit(reader, async () => {
        events.push("confirmed-watermark-write");
      });
    });
    assert.equal(
      events.includes("confirmed-watermark-write"),
      false,
      "a released savepoint has not committed the read-only snapshot",
    );
  });
  assert.equal(events.filter((event) => event === "COMMIT").length, 1);
  assert.equal(events.at(-1), "confirmed-watermark-write");
});

test(
  "reader close terminates the worker on close error or timeout and exposes isClosed",
  { timeout: 5000 },
  async () => {
    // 1. Non-fatal close RPC error must still terminate the worker and mark reader closed.
    {
      let terminateCalls = 0;
      const reader = createPgTaskQueryReader(
        { repoId: "close-err", scope: { tenantId: "t", projectId: "p", policyEpoch: 1 } },
        (input) => {
          input.responsePort.postMessage({ id: 0 });
          Atomics.store(input.ready, 0, 1);
          return Object.assign(new EventEmitter(), {
            unref() {},
            terminate() {
              terminateCalls++;
            },
            postMessage(request: { id: number; op: string }) {
              if (request.op === "close") {
                input.responsePort.postMessage({
                  id: request.id,
                  error: { name: "Error", message: "pool end failed" },
                });
                Atomics.store(input.state, 0, 1);
              }
            },
          });
        },
      );
      assert.equal(reader.isClosed(), false);
      assert.throws(() => reader.close(), /pool end failed/);
      assert.equal(reader.isClosed(), true);
      assert.equal(terminateCalls, 1);
    }

    // 2. Timed-out close RPC must terminate the worker and mark reader closed.
    {
      let terminateCalls = 0;
      const reader = createPgTaskQueryReader(
        { repoId: "close-timeout", scope: { tenantId: "t", projectId: "p", policyEpoch: 1 }, queryTimeoutMs: 40 },
        (input) => {
          input.responsePort.postMessage({ id: 0 });
          Atomics.store(input.ready, 0, 1);
          return Object.assign(new EventEmitter(), {
            unref() {},
            terminate() {
              terminateCalls++;
            },
            postMessage() {
              // Deliberately never respond to force close timeout.
            },
          });
        },
      );
      assert.throws(() => reader.close(), { code: "pg_query_worker_timeout" });
      assert.equal(reader.isClosed(), true);
      assert.equal(terminateCalls, 1);
    }

    // 3. Real Worker thread with a live timer must actually exit after close() fails (zero orphan leak).
    {
      let realWorker!: Worker;
      const reader = createPgTaskQueryReader(
        { repoId: "close-real-worker", scope: { tenantId: "t", projectId: "p", policyEpoch: 1 } },
        (input) => {
          const script = `
          const { parentPort, workerData } = require("node:worker_threads");
          const keepAlive = setInterval(() => {}, 60000);
          workerData.responsePort.postMessage({ id: 0 });
          Atomics.store(workerData.ready, 0, 1);
          Atomics.notify(workerData.ready, 0);
          parentPort.on("message", (request) => {
            if (request.op === "close") {
              workerData.responsePort.postMessage({
                id: request.id,
                error: { name: "Error", message: "close failed with live handle" },
              });
              Atomics.store(workerData.state, 0, 1);
              Atomics.notify(workerData.state, 0);
            }
          });
          void keepAlive;
        `;
          realWorker = new Worker(script, {
            eval: true,
            workerData: { ready: input.ready, state: input.state, responsePort: input.responsePort },
            transferList: [input.responsePort],
          });
          return realWorker;
        },
      );
      const exited = once(realWorker, "exit");
      assert.equal(reader.isClosed(), false);
      assert.throws(() => reader.close(), /close failed with live handle/);
      assert.equal(reader.isClosed(), true);
      await exited;
    }
  },
);
