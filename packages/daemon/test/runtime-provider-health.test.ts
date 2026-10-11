// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { openRuntimeProviderHealthStore } from "../src/runtime-provider-health.ts";

test("provider health persists bounded cooldowns and freezes after the configured streak", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-provider-health-"));
  try {
    const store = openRuntimeProviderHealthStore(root),
      at = "2026-10-12T00:00:00.000Z";
    const first = store.recordFailure({
      instanceId: "codex-sub",
      reason: "HTTP 429",
      occurredAt: at,
      cooldownBaseSeconds: 30,
      cooldownMaxSeconds: 300,
      freezeAfter: 2,
      freezeDurationSeconds: 1800,
    });
    assert.equal(first.failureStreak, 1);
    assert.equal(first.cooldownUntil, "2026-10-12T00:00:30.000Z");
    assert.equal(first.frozen, false);
    const second = store.recordFailure({
      instanceId: "codex-sub",
      reason: "HTTP 503",
      occurredAt: "2026-10-12T00:01:00.000Z",
      cooldownBaseSeconds: 30,
      cooldownMaxSeconds: 300,
      freezeAfter: 2,
      freezeDurationSeconds: 1800,
    });
    assert.equal(second.failureStreak, 2);
    assert.equal(second.frozen, false);
    assert.equal(second.frozenUntil, "2026-10-12T00:31:00.000Z");
    assert.equal(openRuntimeProviderHealthStore(root).get("codex-sub").failureStreak, 2);
    const reset = store.reset("codex-sub", "2026-10-12T00:02:00.000Z");
    assert.equal(reset.failureStreak, 0);
    assert.equal(reset.frozen, false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("provider supplied reset time is preserved and auth failures freeze permanently", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-provider-health-"));
  try {
    const store = openRuntimeProviderHealthStore(root),
      longWindow = store.recordFailure({
        instanceId: "codex-window",
        reason: "weekly quota",
        occurredAt: "2026-10-12T00:00:00.000Z",
        resetAt: "2026-10-20T00:00:00.000Z",
      }),
      shorterWindow = store.recordFailure({
        instanceId: "codex-window",
        reason: "short rate limit",
        occurredAt: "2026-10-12T00:01:00.000Z",
        resetAt: "2026-10-12T00:02:00.000Z",
      }),
      row = store.recordFailure({
        instanceId: "codex-api",
        reason: "authentication failed",
        occurredAt: "2026-10-12T00:00:00.000Z",
        resetAt: "2026-10-13T00:00:00.000Z",
        permanentFreeze: true,
      });
    assert.equal(longWindow.cooldownUntil, "2026-10-20T00:00:00.000Z");
    assert.equal(shorterWindow.cooldownUntil, longWindow.cooldownUntil);
    assert.equal(row.cooldownUntil, "2026-10-13T00:00:00.000Z");
    assert.equal(row.frozen, true);
    assert.equal(row.frozenUntil, null);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
