// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { settleFallbackAttempt } from "../src/runtime-spawn-fallback.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "../src/runtime-fallback-contract.ts";
import type { RuntimeProviderHealth } from "../src/runtime-provider-health.ts";
import type { ActiveRuntime, RuntimeAttemptTerminal, RuntimeSpawnerContext } from "../src/runtime-spawn-types.ts";

// Health is selection-time information, not chain membership. The chain keeps every declared
// candidate; when the next candidate is cooling the settle must wait for its recovery, and a
// permanently frozen candidate must be skipped instead of blocking a later healthy one.

const now = "2026-10-22T00:00:00.000Z";

const health = (instanceId: string, overrides: Partial<RuntimeProviderHealth> = {}): RuntimeProviderHealth => ({
  instanceId,
  failureStreak: 1,
  cooldownUntil: null,
  frozen: false,
  frozenUntil: null,
  reason: "HTTP 429",
  lastFailureAt: "2026-10-21T23:59:00.000Z",
  lastResetAt: null,
  ...overrides,
});

test("a cooling next candidate is scheduled at its recovery time", async () => {
  const result = await settle({
    candidates: ["provider-a", "provider-b"],
    rows: [health("provider-b", { cooldownUntil: "2026-10-22T00:00:30.000Z" })],
  });
  assert.equal(result.fallback?.state, "scheduled");
  assert.equal((result.fallback?.nextProvider as { instance?: string } | undefined)?.instance, "provider-b");
  assert.equal(result.fallback?.notBeforeAt, "2026-10-22T00:00:30.000Z");
});

test("a permanently frozen next candidate is skipped for a later healthy one", async () => {
  const result = await settle({
    candidates: ["provider-a", "provider-b", "provider-c"],
    rows: [health("provider-b", { frozen: true })],
  });
  assert.equal(result.fallback?.state, "scheduled");
  assert.equal((result.fallback?.nextProvider as { instance?: string } | undefined)?.instance, "provider-c");
  assert.equal(result.fallback?.notBeforeAt, now);
});

test("waiting for a cooling candidate past the provider wait budget exhausts instead of scheduling", async () => {
  const result = await settle({
    candidates: ["provider-a", "provider-b"],
    rows: [health("provider-b", { cooldownUntil: "2026-10-22T00:10:00.000Z" })],
    maxWaitSeconds: 300,
    maxRetries: 0,
  });
  assert.equal(result.fallback?.state, "exhausted");
  assert.match(String(result.fallback?.reason ?? ""), /wait budget exhausted/u);
  assert.equal(result.terminal?.outcome, "failed");
});

async function settle(options: {
  readonly candidates: readonly string[];
  readonly rows: readonly RuntimeProviderHealth[];
  readonly maxWaitSeconds?: number;
  readonly maxRetries?: number;
}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "fallback-health-selection-"));
  let fallback: Record<string, unknown> | null = null;
  let terminal: RuntimeAttemptTerminal | null = null;
  const rows = new Map(options.rows.map((row) => [row.instanceId, row]));
  try {
    const attempt: RuntimeFallbackAttempt = {
      attemptGroupId: "attempt-group",
      attemptIndex: 0,
      candidateIndex: 0,
      retryRound: 0,
      rootDispatchKey: "root",
      originalMission: "mission",
      candidates: options.candidates.map((instance) => ({ instance, model: "model-a" })),
    };
    const context = {
      input: {
        rootDir,
        now: () => now,
        readSettings: () => ({
          runtime: {
            providerMaxRetries: options.maxRetries ?? 0,
            providerRoundBackoffBaseSeconds: 0,
            providerRoundBackoffMaxSeconds: 0,
            providerMaxWaitSeconds: options.maxWaitSeconds ?? 300,
          },
        }),
        runtimeProviderHealth: {
          get: (instanceId: string) => rows.get(instanceId) ?? health(instanceId),
          list: () => [...rows.values()],
          recordFailure: () => undefined,
          recordSuccess: () => undefined,
          reset: () => undefined,
        },
        onAttemptTerminal: async (value: RuntimeAttemptTerminal) => {
          terminal = value;
        },
      },
      reconcileFallback: () => undefined,
    } as unknown as RuntimeSpawnerContext;
    await settleFallbackAttempt(
      context,
      {
        dispatchId: "dispatch_0123456789abcdef01234567",
        fallbackAttempt: attempt,
        providerOutcome: "succeeded",
        startedAt: now,
        stream: {
          appendFallbackState: (value: Record<string, unknown>) => {
            fallback = value;
          },
        },
      } as unknown as ActiveRuntime,
      outcome(),
      {
        runtimeSessionId: "runtime_0123456789abcdef01234567",
        dispatchId: "dispatch_0123456789abcdef01234567",
        task: null,
        schedule: null,
        outcome: "failed",
        reason: "provider fault",
        endedAt: now,
        binding: {} as never,
      },
    );
    return { fallback, terminal };
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function outcome(): RuntimeAttemptOutcome {
  return {
    outcome: "stopped",
    classification: "provider_fault",
    reason: "provider fault",
    provider: { instance: "provider-a", model: "model-a", kind: "codex" },
    attemptGroupId: "attempt-group",
    attemptIndex: 0,
  } as RuntimeAttemptOutcome;
}
