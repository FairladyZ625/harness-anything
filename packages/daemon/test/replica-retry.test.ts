// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { replicaRetryDelay } from "../src/fleet/replica-retry.ts";

test("protocol and quota failures have a finite three-attempt budget with exponential backoff and jitter", () => {
  for (const code of [
    "invalid_frame",
    "replica_protocol_error",
    "replica_quota_exceeded",
    "replica_apply_failed",
    "ENOSPC",
    "EDQUOT",
    "edge_upgrade_required",
  ]) {
    const failure = Object.assign(new Error(code), { code });
    assert.equal(replicaRetryDelay(failure, 0, 0), 300_000);
    assert.equal(replicaRetryDelay(failure, 1, 0.5), 615_000);
    assert.equal(replicaRetryDelay(failure, 2, 0), null);
    assert.equal(replicaRetryDelay(failure, 30, 1), null);
  }
});
test("transient transport failures retain capped full jitter", () => {
  const error = Object.assign(new Error("disconnected"), { code: "ECONNRESET" });
  assert.equal(replicaRetryDelay(error, 0, 0), 0);
  assert.equal(replicaRetryDelay(error, 0, 0.5), 125);
  assert.equal(replicaRetryDelay(error, 50, 0.5), 15_000);
});
