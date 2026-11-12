// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { runFleetEdgeRetry } from "../src/fleet-edge-write.ts";

test("daemon close stops an edge retry before its backoff starts another attempt", async (t) => {
  const controller = new AbortController(),
    closed = new Error("daemon closed");
  t.mock.method(Math, "random", () => {
    // Backoff calculation queues close after the sleep is installed, before even its 1ms minimum can fire.
    queueMicrotask(() => controller.abort(closed));
    return 0;
  });
  let attempts = 0;
  await assert.rejects(
    runFleetEdgeRetry({
      timeoutMs: 90_000,
      signal: controller.signal,
      write: async () => {
        attempts += 1;
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
      },
    }),
    (error: unknown) => error === closed,
  );
  assert.equal(attempts, 1, "close must not leave the retry loop free to run another attempt");
});

test("daemon close interrupts an attempt that ignores the close signal", async () => {
  const controller = new AbortController(),
    started = Promise.withResolvers<void>();
  const retrying = runFleetEdgeRetry({
    timeoutMs: 90_000,
    signal: controller.signal,
    write: () => {
      started.resolve();
      return new Promise<never>(() => undefined);
    },
  });
  await started.promise;
  controller.abort(new Error("daemon closed"));
  await assert.rejects(retrying, /daemon closed/u);
});
