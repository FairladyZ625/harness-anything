// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { defaultDaemonRuntimePolicy, resolveDaemonRuntimePolicy } from "../src/runtime/runtime-policy.ts";

test("daemon runtime policy preserves canonical defaults and resolves one startup snapshot", () => {
  assert.deepEqual(resolveDaemonRuntimePolicy({}), defaultDaemonRuntimePolicy);
  assert.deepEqual(resolveDaemonRuntimePolicy({
    HARNESS_DAEMON_WRITE_LOCK_TTL_MS: "120000",
    HARNESS_DAEMON_INTERACTIVE_MICROBATCH_MS: "0",
    HARNESS_DAEMON_MAX_INTERACTIVE_OPS_PER_COMMIT: "64",
    HARNESS_DAEMON_MATERIALIZER_POLL_MS: "10000",
    HARNESS_DAEMON_MATERIALIZER_MAX_BRANCHES_PER_BATCH: "2",
    HARNESS_DAEMON_PROJECTION_RECONCILE_INTERVAL_MS: "60000",
    HARNESS_DAEMON_REGISTRY_RECONCILE_INTERVAL_MS: "2000"
  }), {
    write: { lockTtlMs: 120_000, interactiveMicroBatchMs: 0, maxInteractiveOpsPerCommit: 64 },
    materializer: { pollMs: 10_000, maxBranchesPerBatch: 2 },
    projection: { reconcileIntervalMs: 60_000 },
    registry: { reconcileIntervalMs: 2_000 }
  });
});

test("daemon runtime policy rejects invalid values before runtime construction", () => {
  assert.throws(() => resolveDaemonRuntimePolicy({ HARNESS_DAEMON_WRITE_LOCK_TTL_MS: "0" }), /HARNESS_DAEMON_WRITE_LOCK_TTL_MS/u);
  assert.throws(() => resolveDaemonRuntimePolicy({ HARNESS_DAEMON_INTERACTIVE_MICROBATCH_MS: "-1" }), /HARNESS_DAEMON_INTERACTIVE_MICROBATCH_MS/u);
  assert.throws(() => resolveDaemonRuntimePolicy({ HARNESS_DAEMON_MAX_INTERACTIVE_OPS_PER_COMMIT: "many" }), /HARNESS_DAEMON_MAX_INTERACTIVE_OPS_PER_COMMIT/u);
});

test("daemon runtime policy resolves environment over project YAML values", () => {
  const policy = resolveDaemonRuntimePolicy({ HARNESS_DAEMON_WRITE_LOCK_TTL_MS: "180000" }, {
    writeLockTtlMs: 120_000,
    materializerPollMs: 10_000
  });
  assert.equal(policy.write.lockTtlMs, 180_000);
  assert.equal(policy.materializer.pollMs, 10_000);
});
