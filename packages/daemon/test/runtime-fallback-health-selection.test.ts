// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import {
  initialFallbackAttempt,
  scheduleFallbackContinuation,
  settleFallbackAttempt,
} from "../src/daemon-host/runtime-spawn-fallback.ts";
import type { RuntimeInstanceSummary } from "../src/daemon-host/agent-runtime-instances.ts";
import type {
  RuntimeAttemptOutcome,
  RuntimeFallbackAttempt,
  RuntimeProviderFault,
} from "../src/daemon-host/runtime-fallback-contract.ts";
import type { RuntimeProviderHealth } from "../src/runtime-engine/runtime-provider-health.ts";
import type {
  ActiveRuntime,
  RuntimeAttemptTerminal,
  RuntimeSpawnerContext,
} from "../src/daemon-host/runtime-spawn-types.ts";

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

test("a single provider retries request_unavailable with backoff, then settles as infrastructure failure", async () => {
  const retry = await settle({
      candidates: ["provider-a"],
      rows: [],
      maxRetries: 1,
      retryRound: 0,
      backoffBaseSeconds: 2,
      reason: "request_unavailable before any tool call",
    }),
    exhausted = await settle({
      candidates: ["provider-a"],
      rows: [],
      maxRetries: 1,
      retryRound: 1,
      backoffBaseSeconds: 2,
      reason: "request_unavailable before any tool call",
    });
  assert.equal(retry.fallback?.state, "scheduled");
  assert.equal(retry.fallback?.notBeforeAt, "2026-10-22T00:00:02.000Z");
  assert.equal(retry.terminal, null, "the first startup fault remains retryable");
  assert.equal(exhausted.fallback?.state, "exhausted");
  assert.equal(exhausted.terminal?.outcome, "failed");
  assert.match(String(exhausted.terminal?.reason), /Provider fallback exhausted after 2 attempt/u);
});

test("post-tool transient fault retries up to 2 times on the same session without recording health failure, then exhausts without cold replay", async () => {
  const retry1 = await settle({
    candidates: ["provider-a", "provider-b"],
    rows: [],
    toolCallObserved: true,
    providerSessionId: "session-same-1",
    providerFault: { code: "server_error", faultClass: "server_error", reason: "HTTP 503 upstream unavailable" },
    reason: "HTTP 503 upstream unavailable",
  });
  assert.equal(retry1.fallback?.state, "scheduled");
  assert.equal(retry1.fallback?.sameSessionResume, true);
  assert.equal(retry1.fallback?.providerSessionId, "session-same-1");
  assert.deepEqual(retry1.fallback?.nextProvider, { instance: "provider-a", model: "model-a" });
  assert.ok(
    Number.isInteger(retry1.fallback?.delayMs) &&
      Number(retry1.fallback?.delayMs) >= 0 &&
      Number(retry1.fallback?.delayMs) <= 500,
    `expected attempt 0 full-jitter delay in [0, 500], got ${String(retry1.fallback?.delayMs)}`,
  );
  assert.equal(retry1.recordFailureCalls, 0);
  assert.equal(retry1.terminal, null);

  // Attempt 1 may fail before observing a new tool call; sameSessionRetryCount keeps it on the same session.
  const retry2 = await settle({
    candidates: ["provider-a", "provider-b"],
    rows: [],
    toolCallObserved: false,
    providerSessionId: "session-same-1",
    sameSessionRetryCount: 1,
    sameSessionProviderSessionId: "session-same-1",
    providerFault: { code: "provider_disconnected", faultClass: "provider_disconnected", reason: "stream closed" },
    reason: "stream closed",
  });
  assert.equal(retry2.fallback?.state, "scheduled");
  assert.equal(retry2.fallback?.sameSessionResume, true);
  assert.deepEqual(retry2.fallback?.nextProvider, { instance: "provider-a", model: "model-a" });
  assert.ok(
    Number.isInteger(retry2.fallback?.delayMs) &&
      Number(retry2.fallback?.delayMs) >= 0 &&
      Number(retry2.fallback?.delayMs) <= 1000,
    `expected attempt 1 full-jitter delay in [0, 1000], got ${String(retry2.fallback?.delayMs)}`,
  );
  assert.equal(retry2.recordFailureCalls, 0);
  assert.equal(retry2.terminal, null);

  // Retry budget exhausted (sameSessionRetryCount === 2): fail closed with zero cold replay onto provider-b.
  const exhausted = await settle({
    candidates: ["provider-a", "provider-b"],
    rows: [],
    toolCallObserved: false,
    providerSessionId: "session-same-1",
    sameSessionRetryCount: 2,
    sameSessionProviderSessionId: "session-same-1",
    providerFault: { code: "server_error", faultClass: "server_error", reason: "HTTP 503 upstream unavailable" },
    reason: "HTTP 503 upstream unavailable",
  });
  assert.equal(exhausted.fallback?.state, "exhausted");
  assert.equal(exhausted.terminal?.outcome, "failed");
  assert.match(String(exhausted.terminal?.reason), /Same-session resume exhausted after 2 retry/u);
  assert.equal(exhausted.recordFailureCalls, 1);
});

test("post-tool missing providerSessionId, deterministic error, or quota_exhausted fails closed with zero retries", async () => {
  const missingSession = await settle({
    candidates: ["provider-a", "provider-b"],
    rows: [],
    toolCallObserved: true,
    providerSessionId: null,
    providerFault: { code: "server_error", faultClass: "server_error", reason: "HTTP 503 upstream unavailable" },
    reason: "HTTP 503 upstream unavailable",
  });
  assert.equal(missingSession.fallback?.state, "exhausted");
  assert.equal(missingSession.terminal?.outcome, "failed");
  assert.equal(missingSession.recordFailureCalls, 1);

  const deterministicError = await settle({
    candidates: ["provider-a", "provider-b"],
    rows: [],
    toolCallObserved: true,
    providerSessionId: "session-same-1",
    providerFault: { code: "request_unavailable", faultClass: null, reason: "request_unavailable" },
    reason: "request_unavailable",
  });
  assert.equal(deterministicError.fallback?.state, "exhausted");
  assert.equal(deterministicError.terminal?.outcome, "failed");
  assert.equal(deterministicError.recordFailureCalls, 1);

  const quota = await settle({
    candidates: ["provider-a", "provider-b"],
    rows: [],
    toolCallObserved: true,
    providerSessionId: "session-same-1",
    classification: "provider_quota",
    providerFault: { code: "quota_exhausted", faultClass: "quota_exhausted", reason: "quota exhausted" },
    reason: "quota exhausted",
  });
  assert.equal(quota.fallback?.state, "exhausted");
  assert.equal(quota.terminal?.outcome, "failed");
  assert.equal(quota.recordFailureCalls, 1);
});

test("scheduleFallbackContinuation cancels pending same-session timer when closeSignal aborts", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "fallback-abort-"));
  const abortController = new AbortController();
  let scheduled = 0;
  let launched = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const dispatchId = "dispatch_0123456789abcdef01234568";
    const writer = openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId: "runtime_0123456789abcdef01234568",
      taskId: null,
      agentId: null,
      role: null,
      squadId: null,
      cwd: rootDir,
      instanceId: "provider-a",
      kindId: "codex",
      model: "model-a",
      requestedAt: now,
      fallbackAttempt: {
        attemptGroupId: "attempt-group",
        attemptIndex: 0,
        candidateIndex: 0,
        retryRound: 0,
        rootDispatchKey: "root",
        originalMission: "mission",
        candidates: [{ instance: "provider-a", model: "model-a" }],
      },
      binding: {
        actor: { principal: { kind: "person", personId: "person_1", role: "owner" }, sessionId: "session_1" },
        source: "local-cli",
        repoId: "repo_1",
      } as never,
    });
    writer.appendAttemptOutcome(outcome("HTTP 503 upstream unavailable"), "2026-10-22T00:00:01.000Z");
    writer.appendFallbackState(
      {
        state: "scheduled",
        notBeforeAt: "2026-10-22T00:00:02.000Z",
        nextProvider: { instance: "provider-a", model: "model-a" },
        waitStartedAt: now,
        delayMs: 2_000,
        sameSessionResume: true,
        providerSessionId: "session-same-1",
      },
      now,
    );
    const context = {
      closed: () => false,
      closeSignal: abortController.signal,
      input: {
        rootDir,
        now: () => now,
        remote: {
          readDispatchLifecycle: async () => ({
            status: "ready" as const,
            rows: [
              {
                controlLeafDispatchId: dispatchId,
                policy: { fallbackPending: true, groupSettled: false },
              },
            ],
          }),
        },
        schedule: async (work: () => Promise<void>) => {
          scheduled += 1;
          await work();
        },
      },
    } as unknown as RuntimeSpawnerContext;
    await scheduleFallbackContinuation({
      context,
      dispatchId,
      launch: async () => {
        launched += 1;
      },
    });
    abortController.abort();
    t.mock.timers.tick(5_000);
    await Promise.resolve();
    assert.equal(scheduled, 0);
    assert.equal(launched, 0);
  } finally {
    t.mock.timers.reset();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("QUOTA-17: fallback chain keeps quota-exhausted successors for recovery, checks live model quota on hops, and honors quotaExhaustedUntil in terminal recoverAt", async () => {
  const makeInstance = (
    instanceId: string,
    overrides: Partial<RuntimeInstanceSummary> = {},
  ): RuntimeInstanceSummary => ({
    schemaVersion: 2,
    instanceId,
    name: instanceId,
    kindId: "agy",
    installationId: "agy-install",
    providerId: "google",
    models: ["gemini-4-argon-high", "gemini-4-hydrogen-low"],
    availableModels: ["gemini-4-argon-high", "gemini-4-hydrogen-low"],
    defaultModel: "gemini-4-argon-high",
    enabled: true,
    tier: 1,
    credentialSource: "instance",
    permissionMode: "bypass",
    isolationState: "enforced",
    authMode: "subscription",
    authState: "authenticated",
    authReadiness: { status: "ready", code: null, hint: null, basis: "provider" },
    configuration: {},
    ...overrides,
  });

  // 1. Chain construction retains provider-b even though provider-b's quota is exhausted at T0;
  //    once provider-b recovers during attempt 0 (at T0 + 60s), settle schedules provider-b immediately.
  const providerA = makeInstance("provider-a");
  const providerBExhaustedAtBuild = makeInstance("provider-b", {
    quota: {
      schemaVersion: 1,
      observedAt: now,
      source: "agy-cli",
      plan: "Pro",
      windows: [
        {
          id: "argon-weekly",
          label: "Argon",
          kind: "weekly",
          scope: "primary",
          remainingFraction: 0,
          usedPercent: 100,
          resetsAt: "2026-10-22T00:00:30.000Z",
        },
      ],
    },
  });
  const chain = initialFallbackAttempt(
    null,
    undefined,
    "gemini-4-argon-high",
    undefined,
    "dispatch-key-quota-17",
    "dispatch-17",
    "mission",
    [providerA, providerBExhaustedAtBuild],
    [],
    ["provider-a", "provider-b"],
    [],
    now,
  );
  assert.ok(chain);
  assert.deepEqual(
    chain.candidates.map((candidate) => candidate.instance),
    ["provider-a", "provider-b"],
    "quota-exhausted successor must stay in fallback chain at construction time",
  );
  const afterRecovery = await settle({
    candidates: ["provider-a", "provider-b"],
    model: "gemini-4-argon-high",
    now: "2026-10-22T00:01:00.000Z",
    rows: [
      health("provider-b", { cooldownUntil: null, reason: null, quotaExhaustedUntil: "2026-10-22T00:00:30.000Z" }),
    ],
    instances: [providerA, providerBExhaustedAtBuild],
  });
  assert.equal(afterRecovery.fallback?.state, "scheduled");
  assert.equal((afterRecovery.fallback?.nextProvider as { instance?: string } | undefined)?.instance, "provider-b");
  assert.equal(afterRecovery.fallback?.notBeforeAt, "2026-10-22T00:01:00.000Z");

  // 2. Mid-flight single-model quota exhaustion on mixed-model provider-b (providerHealth has NO instance-wide
  //    quotaExhaustedUntil because hydrogen still has quota) skips provider-b to healthy provider-c!
  const providerBMixedMidFlight = makeInstance("provider-b", {
    quota: {
      schemaVersion: 1,
      observedAt: now,
      source: "agy-cli",
      plan: "Pro",
      windows: [
        {
          id: "argon-weekly",
          label: "Argon",
          kind: "weekly",
          scope: "primary",
          remainingFraction: 0,
          usedPercent: 100,
          resetsAt: "2026-10-22T00:02:00.000Z",
        },
        {
          id: "gemini-weekly",
          label: "Gemini",
          kind: "weekly",
          scope: "primary",
          remainingFraction: 0.85,
          usedPercent: 15,
          resetsAt: "2026-10-29T00:00:00.000Z",
        },
      ],
    },
  });
  const providerCHealthy = makeInstance("provider-c");
  const skipMixed = await settle({
    candidates: ["provider-a", "provider-b", "provider-c"],
    model: "gemini-4-argon-high",
    rows: [],
    instances: [providerA, providerBMixedMidFlight, providerCHealthy],
  });
  assert.equal(skipMixed.fallback?.state, "scheduled");
  assert.equal((skipMixed.fallback?.nextProvider as { instance?: string } | undefined)?.instance, "provider-c");
  assert.equal(skipMixed.fallback?.notBeforeAt, now);

  // Without provider-c, mixed-model provider-b waits until its Argon resetAt instead of launching immediately!
  const waitMixed = await settle({
    candidates: ["provider-a", "provider-b"],
    model: "gemini-4-argon-high",
    rows: [],
    instances: [providerA, providerBMixedMidFlight],
  });
  assert.equal(waitMixed.fallback?.state, "scheduled");
  assert.equal((waitMixed.fallback?.nextProvider as { instance?: string } | undefined)?.instance, "provider-b");
  assert.equal(waitMixed.fallback?.notBeforeAt, "2026-10-22T00:02:00.000Z");

  // 3. Full-chain exhausted pass honors quotaExhaustedUntil in terminal recoverAt (both within & over wait budget).
  const retryOnQuotaClock = await settle({
    candidates: ["provider-a"],
    rows: [
      health("provider-a", {
        cooldownUntil: null,
        frozenUntil: null,
        reason: null,
        quotaExhaustedUntil: "2026-10-22T00:02:00.000Z",
      }),
    ],
    maxRetries: 1,
    maxWaitSeconds: 300,
  });
  assert.equal(retryOnQuotaClock.fallback?.state, "scheduled");
  assert.equal(retryOnQuotaClock.fallback?.notBeforeAt, "2026-10-22T00:02:00.000Z");

  const budgetExceededOnQuotaClock = await settle({
    candidates: ["provider-a"],
    rows: [
      health("provider-a", {
        cooldownUntil: null,
        frozenUntil: null,
        reason: null,
        quotaExhaustedUntil: "2026-10-22T00:05:00.000Z",
      }),
    ],
    maxRetries: 1,
    maxWaitSeconds: 60,
  });
  assert.equal(budgetExceededOnQuotaClock.fallback?.state, "exhausted");
  assert.match(String(budgetExceededOnQuotaClock.fallback?.reason ?? ""), /wait budget exhausted/u);
  assert.match(String(budgetExceededOnQuotaClock.fallback?.reason ?? ""), /quota_exhausted/u);
});

async function settle(options: {
  readonly candidates: readonly string[];
  readonly rows: readonly RuntimeProviderHealth[];
  readonly instances?: readonly RuntimeInstanceSummary[];
  readonly model?: string;
  readonly now?: string;
  readonly maxWaitSeconds?: number;
  readonly maxRetries?: number;
  readonly retryRound?: number;
  readonly backoffBaseSeconds?: number;
  readonly reason?: string;
  readonly kind?: string;
  readonly classification?: RuntimeAttemptOutcome["classification"];
  readonly toolCallObserved?: boolean;
  readonly providerSessionId?: string | null;
  readonly sameSessionRetryCount?: number;
  readonly sameSessionProviderSessionId?: string;
  readonly providerFault?: RuntimeProviderFault | null;
}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "fallback-health-selection-"));
  const effectiveNow = options.now ?? now;
  const effectiveModel = options.model ?? "model-a";
  let fallback: Record<string, unknown> | null = null;
  let terminal: RuntimeAttemptTerminal | null = null;
  let recordFailureCalls = 0;
  const rows = new Map(options.rows.map((row) => [row.instanceId, row]));
  try {
    const attempt: RuntimeFallbackAttempt = {
      attemptGroupId: "attempt-group",
      attemptIndex: options.sameSessionRetryCount ?? options.retryRound ?? 0,
      candidateIndex: 0,
      retryRound: options.retryRound ?? 0,
      rootDispatchKey: "root",
      originalMission: "mission",
      candidates: options.candidates.map((instance) => ({ instance, model: effectiveModel })),
      ...(options.sameSessionRetryCount === undefined ? {} : { sameSessionRetryCount: options.sameSessionRetryCount }),
      ...(options.sameSessionProviderSessionId === undefined
        ? {}
        : { sameSessionProviderSessionId: options.sameSessionProviderSessionId }),
    };
    const context = {
      input: {
        rootDir,
        now: () => effectiveNow,
        ...(options.instances ? { runtimeInstances: () => options.instances! } : {}),
        readSettings: () => ({
          runtime: {
            providerMaxRetries: options.maxRetries ?? 0,
            providerRoundBackoffBaseSeconds: options.backoffBaseSeconds ?? 0,
            providerRoundBackoffMaxSeconds: options.backoffBaseSeconds ?? 0,
            providerMaxWaitSeconds: options.maxWaitSeconds ?? 300,
          },
        }),
        runtimeProviderHealth: {
          get: (instanceId: string) => rows.get(instanceId) ?? health(instanceId),
          list: () => [...rows.values()],
          recordFailure: () => {
            recordFailureCalls += 1;
          },
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
        startedAt: effectiveNow,
        toolCallObserved: options.toolCallObserved ?? false,
        providerSessionId: options.providerSessionId ?? null,
        providerFault: options.providerFault ?? null,
        lossReason: null,
        stream: {
          appendFallbackState: (value: Record<string, unknown>) => {
            fallback = value;
          },
        },
      } as unknown as ActiveRuntime,
      outcome(options.reason, options.kind, options.classification),
      {
        runtimeSessionId: "runtime_0123456789abcdef01234567",
        dispatchId: "dispatch_0123456789abcdef01234567",
        task: null,
        schedule: null,
        outcome: "failed",
        reason: "provider fault",
        endedAt: effectiveNow,
        binding: {} as never,
      },
    );
    return { fallback, terminal, recordFailureCalls };
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function outcome(
  reason = "provider fault",
  kind = "codex",
  classification: RuntimeAttemptOutcome["classification"] = "provider_fault",
): RuntimeAttemptOutcome {
  return {
    outcome: "stopped",
    classification,
    reason,
    provider: { instance: "provider-a", model: "model-a", kind },
    attemptGroupId: "attempt-group",
    attemptIndex: 0,
  } as RuntimeAttemptOutcome;
}
