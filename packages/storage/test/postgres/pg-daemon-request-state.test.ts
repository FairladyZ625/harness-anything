// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AsyncResource } from "node:async_hooks";
import test from "node:test";
import { createPgTaskQueryReader, withStorageWriteRequest } from "../../src/pg/pg-task-query-reader.ts";

for (const phase of [-1, 1])
  test(`daemon request ${phase} is not reset by internal SQL RPCs or inherited background callbacks`, async () => {
    const state = new Int32Array(new SharedArrayBuffer(12)),
      seen: unknown[] = [];
    const reader = createPgTaskQueryReader(
      { repoId: "probe", scope: { tenantId: "t", projectId: "p", policyEpoch: 1 } },
      (input) => {
        assert.notEqual(input.state, state);
        input.responsePort.postMessage({ id: 0, result: null });
        Atomics.store(input.ready, 0, 1);
        return Object.assign(new EventEmitter(), {
          unref() {},
          terminate() {
            throw new Error("unexpected termination");
          },
          postMessage(request: { id: number; op: string; writeRequest?: { state: Int32Array; id: number } }) {
            if (request.writeRequest) {
              assert.equal(request.writeRequest.id, 41);
              assert.equal(request.writeRequest.state, state);
              seen.push({ id: request.id, phase: state[1], outerId: state[2] });
            } else seen.push("unbound");
            input.responsePort.postMessage({ id: request.id, result: null });
            Atomics.store(input.state, 0, 1);
            if (request.op === "close") input.responsePort.close();
          },
        });
      },
    );
    Atomics.store(state, 2, 41);
    Atomics.compareExchange(state, 1, 0, phase);
    let background!: () => void;
    try {
      await withStorageWriteRequest({ state, id: 41 }, async () => {
        reader.executeCanonical({ operation: "head" });
        reader.executeCanonical({ operation: "head" });
        // A durable publisher may inherit async context and run after its owner returned.
        background = AsyncResource.bind(() => reader.executeCanonical({ operation: "head" }));
      });
      background();
      assert.deepEqual(seen, [{ id: 1, phase, outerId: 41 }, { id: 2, phase, outerId: 41 }, "unbound"]);
      assert.equal(state[0], 0, "SQL replies do not close the daemon slot");
      console.log("S3_OUTER_STATE", JSON.stringify({ phase, state: [...state], seen }));
    } finally {
      reader.close();
    }
  });

test("fatal SQL endpoint wakes the bound daemon owner without overwriting its commit winner", async () => {
  const { MessageChannel } = await import("node:worker_threads"),
    { once } = await import("node:events"),
    { startPgQuerySession } = await import("../../src/pg/pg-task-query-worker.ts");
  const { port1, port2 } = new MessageChannel(),
    state = new Int32Array(new SharedArrayBuffer(12)),
    owner = new Int32Array(new SharedArrayBuffer(12)),
    reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      if (sql === "SHOW synchronous_commit") return { rows: [{ synchronous_commit: "on" }] };
      if (sql.includes("SELECT backfill_cursor,backfill_complete"))
        return { rows: [{ backfill_complete: true, backfill_cursor: null }] };
      return { rows: [] };
    },
    release() {},
  });
  const ready = once(port1, "message"),
    session = startPgQuerySession(
      {
        repoId: "fatal",
        path: "test",
        scope: { tenantId: "t", projectId: "p", policyEpoch: 1 },
        ready: new Int32Array(new SharedArrayBuffer(12)),
        state,
        requestPort: port2,
        responsePort: port2,
      },
      { connect: async () => client } as never,
      null,
      {
        ownsPools: false,
        afterCommitCasHook: async () => {
          reached.resolve();
          await release.promise;
        },
      },
    );
  try {
    await ready;
    Atomics.store(owner, 2, 41);
    const response = once(port1, "message");
    port1.postMessage({ id: 1, op: "relation-cycle-maintenance", writeRequest: { state: owner, id: 41 } });
    await reached.promise;
    assert.equal(owner[1], 1);
    session.fail(Object.assign(new Error("connection lost"), { code: "08006" }));
    assert.equal(owner[0], -1);
    assert.equal(state[0], -1);
    assert.equal(owner[1], 1);
    assert.equal(owner[2], 41);
    const [fatal] = await response;
    assert.equal(fatal.fatal, true);
  } finally {
    release.resolve();
    await session.close();
    port1.close();
    port2.close();
  }
});
