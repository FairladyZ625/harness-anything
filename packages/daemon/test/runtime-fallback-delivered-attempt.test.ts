// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { settleFallbackAttempt } from "../src/runtime-spawn-fallback.ts";
import type { RuntimeAttemptOutcome, RuntimeFallbackAttempt } from "../src/runtime-fallback-contract.ts";
import type { ActiveRuntime, RuntimeAttemptTerminal, RuntimeSpawnerContext } from "../src/runtime-spawn-types.ts";

// A drained reconnect now labels some attempts provider_fault, including attempts the settlement
// later accepts as delivered. Delivery must keep its success disposition: re-running a delivered
// attempt is the regression this suite exists to prevent.

const fallback: RuntimeFallbackAttempt = {
  attemptGroupId: "attempt-group",
  attemptIndex: 0,
  rootDispatchKey: "root",
  originalMission: "mission",
  candidates: [{ instance: "provider-a" }, { instance: "provider-b" }],
};

test("a delivered attempt never schedules a fallback, even when its tail is provider_fault", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "fallback-delivered-"));
  try {
    const terminal = await sink(rootDir, { delivered: true });
    assert.equal(terminal.outcome, "succeeded");
    assert.deepEqual(terminal.plannedFallbacks, [], "a delivered attempt must not be re-dispatched");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an undelivered provider_fault still schedules the next declared runtime", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "fallback-undelivered-"));
  try {
    const terminal = await sink(rootDir, { delivered: false });
    assert.deepEqual(terminal.plannedFallbacks, ["provider-b"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("delivery records provider health as success, not failure", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "fallback-health-"));
  try {
    const failures: string[] = [],
      successes: string[] = [],
      terminal = await sink(rootDir, {
        delivered: true,
        runtimeProviderHealth: {
          recordFailure: (failure: { instanceId: string }) => failures.push(failure.instanceId),
          recordSuccess: (instanceId: string) => successes.push(instanceId),
        },
      });
    assert.deepEqual(failures, [], "a delivered attempt is not a provider failure");
    assert.deepEqual(successes, ["provider-a"]);
    assert.equal(terminal.outcome, "succeeded");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function sink(
  rootDir: string,
  options: {
    readonly delivered: boolean;
    readonly runtimeProviderHealth?: {
      recordFailure: (failure: { readonly instanceId: string }) => void;
      recordSuccess: (instanceId: string, startedAt: string) => void;
    };
  },
) {
  const terminal: { outcome: "succeeded" | "failed" } = { outcome: options.delivered ? "succeeded" : "failed" },
    attempt = classify();
  const context = {
    input: {
      rootDir,
      now: () => "2026-10-22T00:00:00.000Z",
      readSettings: () => ({ runtime: { providerMaxRetries: 1, providerRoundBackoffBaseSeconds: 0 } }),
      onAttemptTerminal: async (value: RuntimeAttemptTerminal) => {
        terminal.outcome = value.outcome === "succeeded" ? "succeeded" : "failed";
      },
      ...(options.runtimeProviderHealth ? { runtimeProviderHealth: options.runtimeProviderHealth } : {}),
    },
  } as unknown as RuntimeSpawnerContext;
  const plan = await settleFallbackAttempt(
    context,
    {
      dispatchId: "dispatch_0123456789abcdef01234567",
      fallbackAttempt: fallback,
      providerOutcome: "succeeded",
      startedAt: "2026-10-22T00:00:00.000Z",
      stream: { appendFallbackState: () => undefined },
    } as unknown as ActiveRuntime,
    attempt,
    {
      runtimeSessionId: "runtime_0123456789abcdef01234567",
      dispatchId: "dispatch_0123456789abcdef01234567",
      task: null,
      schedule: null,
      outcome: options.delivered ? "succeeded" : "failed",
      reason: options.delivered ? null : attempt.reason,
      endedAt: "2026-10-22T00:00:00.000Z",
      binding: {} as never,
    },
  );
  return Object.assign(terminal, {
    plannedFallbacks: plan?.fallbackSchedule ? [plan.fallbackSchedule.nextProvider.instance] : [],
  });
}

/** The classification the reconnect rule produces: provider_fault on a stopped outcome. */
function classify(): RuntimeAttemptOutcome {
  return {
    outcome: "stopped",
    classification: "provider_fault",
    reason: "Provider stream reconnected 1 time(s) and the attempt closed after the last reconnect (1/5).",
    provider: { instance: "provider-a", model: "model-a", kind: "codex" },
    attemptGroupId: "attempt-group",
    attemptIndex: 0,
  } as RuntimeAttemptOutcome;
}
