// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import {
  effectiveProviderBlockedUntil,
  openRuntimeProviderHealthStore,
} from "../src/runtime-engine/runtime-provider-health.ts";

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

test("separately opened node stores merge updates instead of overwriting another instance", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-provider-health-"));
  try {
    const first = openRuntimeProviderHealthStore(root),
      second = openRuntimeProviderHealthStore(root);
    first.recordFailure({ instanceId: "codex-a", reason: "HTTP 429", occurredAt: "2026-10-12T00:00:00.000Z" });
    second.recordFailure({ instanceId: "codex-b", reason: "HTTP 503", occurredAt: "2026-10-12T00:00:01.000Z" });
    assert.equal(first.get("codex-a").failureStreak, 1);
    assert.equal(first.get("codex-b").failureStreak, 1);
    assert.equal(second.list().length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("provider health fallback cooldown reads the shared policy default", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-provider-health-policy-")),
    previousBase = daemonRuntimePolicy.defaultValue.health.cooldownBaseSeconds;
  try {
    daemonRuntimePolicy.defaultValue.health.cooldownBaseSeconds = 7;
    const row = openRuntimeProviderHealthStore(root).recordFailure({
      instanceId: "codex-policy-default",
      reason: "HTTP 429",
      occurredAt: "2026-10-12T00:00:00.000Z",
    });
    assert.equal(row.cooldownUntil, "2026-10-12T00:00:07.000Z");
  } finally {
    daemonRuntimePolicy.defaultValue.health.cooldownBaseSeconds = previousBase;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("quota health transitions are orthogonal to transport failures and manual freezes (503 -> quota -> recovery)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-provider-health-quota-"));
  try {
    const store = openRuntimeProviderHealthStore(root),
      resetAt = "2026-11-28T00:00:00.000Z";
    const first = store.recordQuotaExhausted({
      instanceId: "codex-quota",
      occurredAt: "2026-11-21T10:00:00.000Z",
      resetAt,
    });
    const second = store.recordQuotaExhausted({
      instanceId: "codex-quota",
      occurredAt: "2026-11-21T10:05:00.000Z",
      resetAt,
    });
    const third = store.recordQuotaExhausted({
      instanceId: "codex-quota",
      occurredAt: "2026-11-21T10:10:00.000Z",
      resetAt: "2026-11-22T00:00:00.000Z",
    });
    assert.equal(first.failureStreak, 0);
    assert.equal(second.failureStreak, 0);
    assert.equal(third.failureStreak, 0);
    assert.equal(third.frozenUntil, null);
    assert.equal(third.cooldownUntil, null);
    assert.equal(third.quotaExhaustedUntil, resetAt);
    assert.equal(effectiveProviderBlockedUntil(third), resetAt);

    // Clearing quota_exhausted clears quotaExhaustedUntil cleanly.
    const cleared = store.clearQuotaExhausted("codex-quota", "2026-11-21T11:00:00.000Z");
    assert.equal(cleared.quotaExhaustedUntil, null);
    assert.equal(effectiveProviderBlockedUntil(cleared), null);

    // Permanent freeze is preserved across quota exhaustion and quota recovery.
    store.recordFailure({
      instanceId: "frozen-account",
      reason: "manual freeze",
      occurredAt: "2026-11-21T10:00:00.000Z",
      permanentFreeze: true,
    });
    store.recordQuotaExhausted({
      instanceId: "frozen-account",
      occurredAt: "2026-11-21T10:05:00.000Z",
      resetAt,
    });
    const afterQuotaClear = store.clearQuotaExhausted("frozen-account", "2026-11-21T11:00:00.000Z");
    assert.equal(afterQuotaClear.frozen, true);
    assert.equal(afterQuotaClear.reason, "manual freeze");
    assert.equal(afterQuotaClear.quotaExhaustedUntil, null);

    // Active HTTP 503 cooldown -> subsequent quota_exhausted -> quota recovery MUST preserve HTTP 503 cooldown & reason!
    const after503 = store.recordFailure({
      instanceId: "network-account",
      reason: "HTTP 503",
      occurredAt: "2026-11-21T10:00:00.000Z",
      cooldownBaseSeconds: 3600,
    });
    assert.equal(after503.cooldownUntil, "2026-11-21T11:00:00.000Z");
    const after503AndQuota = store.recordQuotaExhausted({
      instanceId: "network-account",
      occurredAt: "2026-11-21T10:05:00.000Z",
      resetAt: "2026-11-21T12:00:00.000Z",
    });
    assert.equal(after503AndQuota.reason, "HTTP 503");
    assert.equal(after503AndQuota.cooldownUntil, "2026-11-21T11:00:00.000Z");
    assert.equal(after503AndQuota.quotaExhaustedUntil, "2026-11-21T12:00:00.000Z");
    assert.equal(effectiveProviderBlockedUntil(after503AndQuota), "2026-11-21T12:00:00.000Z");
    const afterQuotaRecovery = store.clearQuotaExhausted("network-account", "2026-11-21T10:15:00.000Z");
    assert.equal(afterQuotaRecovery.quotaExhaustedUntil, null);
    assert.equal(afterQuotaRecovery.reason, "HTTP 503");
    assert.equal(afterQuotaRecovery.failureStreak, 1);
    assert.equal(afterQuotaRecovery.cooldownUntil, "2026-11-21T11:00:00.000Z");
    assert.equal(effectiveProviderBlockedUntil(afterQuotaRecovery), "2026-11-21T11:00:00.000Z");

    // effectiveProviderBlockedUntil always prefers the latest of frozenUntil, cooldownUntil, and quotaExhaustedUntil.
    assert.equal(
      effectiveProviderBlockedUntil({
        cooldownUntil: "2026-11-28T00:00:00.000Z",
        frozenUntil: "2026-11-21T10:30:00.000Z",
        quotaExhaustedUntil: "2026-11-29T00:00:00.000Z",
      }),
      "2026-11-29T00:00:00.000Z",
    );
    assert.equal(
      effectiveProviderBlockedUntil({
        cooldownUntil: "2026-11-21T10:30:00.000Z",
        frozenUntil: "2026-11-22T00:00:00.000Z",
        quotaExhaustedUntil: null,
      }),
      "2026-11-22T00:00:00.000Z",
    );

    // recordSuccess only clears quotaExhaustedUntil when the succeeded model matches the exhausted
    // scope or the observed reset window has elapsed (never on an unrelated model or unscoped success).
    store.recordQuotaExhausted({
      instanceId: "scoped-model-account",
      occurredAt: "2026-11-21T10:00:00.000Z",
      resetAt: "2026-11-28T00:00:00.000Z",
      scope: "model",
      models: ["gemini-4-argon-high"],
    });
    const afterUnscopedSuccess = store.recordSuccess("scoped-model-account", "2026-11-21T10:05:00.000Z");
    assert.equal(afterUnscopedSuccess.quotaExhaustedUntil, "2026-11-28T00:00:00.000Z");
    const afterOtherModelSuccess = store.recordSuccess("scoped-model-account", "2026-11-21T10:06:00.000Z", {
      model: "gemini-4-hydrogen-low",
    });
    assert.equal(afterOtherModelSuccess.quotaExhaustedUntil, "2026-11-28T00:00:00.000Z");
    const afterMatchingModelSuccess = store.recordSuccess("scoped-model-account", "2026-11-21T10:07:00.000Z", {
      model: "gemini-4-argon-high",
    });
    assert.equal(afterMatchingModelSuccess.quotaExhaustedUntil, null);

    // Account-wide exhaustion clears on matching-account execution with a model, OR once resetAt elapses.
    store.recordQuotaExhausted({
      instanceId: "account-wide-quota",
      occurredAt: "2026-11-21T10:00:00.000Z",
      resetAt: "2026-11-28T00:00:00.000Z",
      scope: "account",
    });
    assert.equal(
      store.recordSuccess("account-wide-quota", "2026-11-21T10:05:00.000Z").quotaExhaustedUntil,
      "2026-11-28T00:00:00.000Z",
    );
    assert.equal(store.recordSuccess("account-wide-quota", "2026-11-28T00:00:00.000Z").quotaExhaustedUntil, null);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
