// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { canonicalCommitClient } from "../src/daemon-host/canonical-commit-client.ts";
import type { CanonicalCommitCall } from "../src/writer-cell/canonical-commit-protocol.ts";

test("commit close is idempotent and disconnect prevents another transport call", () => {
  let calls = 0;
  const post = (call: CanonicalCommitCall) => {
    calls++;
    call.response.postMessage({ ok: true, value: undefined });
    Atomics.store(call.state, 0, 1);
  };
  const client = canonicalCommitClient(post as Worker["postMessage"]);
  client.close();
  client.close();
  client.abandon();
  client.close();
  assert.equal(calls, 1, "a retired writer must not be asked to close again");
});

test("a dead writer rejects before sending instead of waiting for the acknowledgement timeout", () => {
  const state = new Int32Array(new SharedArrayBuffer(8));
  const client = canonicalCommitClient(
    () => assert.fail("dead writer cannot receive a call"),
    state.buffer as SharedArrayBuffer,
  );
  assert.throws(() => client.close(), { code: "daemon_closed" });
});

test("writer exit wakes the pending caller with an uncertain acceptance outcome", () => {
  const state = new Int32Array(new SharedArrayBuffer(8));
  Atomics.store(state, 1, 1);
  const client = canonicalCommitClient(
    ((call: CanonicalCommitCall) => {
      Atomics.store(call.state, 1, 0);
      Atomics.store(call.state, 0, -1);
      Atomics.notify(call.state, 0);
    }) as Worker["postMessage"],
    state.buffer as SharedArrayBuffer,
  );
  assert.throws(() => client.close(), { code: "publication_indeterminate" });
});

// dec_04A9211B073F29F0FC1E1CA573 CH2: durable-before-success retains the physical COMMIT owner.
test("the host does not impose another acknowledgement deadline over a storage commit", (t) => {
  let pending: CanonicalCommitCall | undefined;
  t.mock.method(Atomics, "wait", (_state: Int32Array, _index: number, _value: number, timeout?: number) => {
    assert.equal(timeout, undefined, "SyncRep may outlast a host acknowledgement deadline");
    assert.ok(pending);
    pending.response.postMessage({ ok: true, value: undefined });
    Atomics.store(pending.state, 0, 1);
    return "ok";
  });
  const client = canonicalCommitClient(((call: CanonicalCommitCall) => {
    pending = call;
  }) as Worker["postMessage"]);
  client.close();
});
