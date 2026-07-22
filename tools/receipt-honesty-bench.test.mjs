// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { resolveReceiptHonestyBenchPolicy } from "./receipt-honesty-bench.mjs";

test("receipt honesty benchmark policy resolves flags over environment and preserves defaults", () => {
  assert.deepEqual(resolveReceiptHonestyBenchPolicy([], {}), {
    lockConflictRetry: { maxWaitMs: 100, initialDelayMs: 5, maxDelayMs: 10 },
    barrierTimeoutMs: 10_000,
    barrierPollMs: 5
  });
  assert.deepEqual(resolveReceiptHonestyBenchPolicy([
    "--lock-max-wait-ms", "250",
    "--barrier-poll-ms", "20"
  ], {
    HARNESS_BENCH_LOCK_MAX_WAIT_MS: "200",
    HARNESS_BENCH_BARRIER_TIMEOUT_MS: "15000"
  }), {
    lockConflictRetry: { maxWaitMs: 250, initialDelayMs: 5, maxDelayMs: 10 },
    barrierTimeoutMs: 15_000,
    barrierPollMs: 20
  });
});

test("receipt honesty benchmark policy rejects invalid values and retry ordering", () => {
  assert.throws(() => resolveReceiptHonestyBenchPolicy([], {
    HARNESS_BENCH_BARRIER_TIMEOUT_MS: "forever"
  }), /HARNESS_BENCH_BARRIER_TIMEOUT_MS/u);
  assert.throws(() => resolveReceiptHonestyBenchPolicy([
    "--lock-initial-delay-ms", "20",
    "--lock-max-delay-ms", "10"
  ], {}), /initial delay/u);
});
