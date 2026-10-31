// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import type { RuntimeAgent, RuntimeSessionSelection } from "../src/runtime-spawn-types.ts";
import { initialFallbackAttempt } from "../src/runtime-spawn-fallback.ts";

// A resumed dispatch settles a provider-side failure exactly like a fresh one: it must have a
// fallback chain, or the same `provider_fault` that switches providers on a fresh dispatch ends the
// resumed dispatch outright. Measured on deli-ai-lab 2026-10-28: two dispatches of the same reviewer
// declaration died with `DeepSeek Messages SSE event type mismatch`; the fresh one switched to the
// second instance, the resumed one had no chain and needed a manual re-dispatch.

const agent: RuntimeAgent = {
  id: "reviewer",
  name: "Reviewer",
  instructions: "Review the delivery.",
  runtimes: [{ type: "deepseek-harness", model: "deepseek-v4.1-flash" }],
};

const instance = (instanceId: string): RuntimeInstanceSummary =>
  ({
    instanceId,
    kindId: "deepseek-harness",
    providerId: "deepseek",
    models: ["deepseek-v4.1-flash"],
    defaultModel: "deepseek-v4.1-flash",
    enabled: true,
    authReadiness: { status: "ready", code: null, hint: null },
  }) as never;

const session = (providerSessionId: string, instanceId: string): RuntimeSessionSelection =>
  ({ runtimeSessionId: "runtime_source", providerSessionId, instanceId, liveness: "live", outcome: null }) as never;

const chain = (sessions: readonly RuntimeSessionSelection[], allowed = ["ds-bailian", "ds-harness-api"]) =>
  initialFallbackAttempt(
    agent,
    undefined,
    undefined,
    "provider-session-source",
    "task-review:task_1:exe_1:reviewer",
    "dispatch_successor",
    "mission",
    [instance("ds-bailian"), instance("ds-harness-api")],
    sessions,
    allowed,
  );

test("a resumed dispatch keeps a fallback chain anchored at the provider that just failed", () => {
  const attempt = chain([session("provider-session-source", "ds-bailian")]);
  assert.ok(attempt, "a resumed dispatch must still get a fallback chain");
  assert.deepEqual(
    attempt.candidates.map(({ instance: instanceId }) => instanceId),
    ["ds-bailian", "ds-harness-api"],
    "the resumed provider leads; the successor is the next declared instance",
  );
  assert.equal(attempt.attemptIndex, 0);
  assert.equal(attempt.candidateIndex, 0);
});

test("the resumed provider leads even when it is not the automatic first candidate", () => {
  // ds-harness-api is listed first in the project allowlist, but the resumed session runs on
  // ds-bailian: attempt 0 is that same session, so the chain must not claim the first attempt ran on
  // an instance that never launched.
  const attempt = chain([session("provider-session-source", "ds-bailian")], ["ds-harness-api", "ds-bailian"]);
  assert.ok(attempt);
  assert.deepEqual(
    attempt.candidates.map(({ instance: instanceId }) => instanceId),
    ["ds-bailian", "ds-harness-api"],
  );
  assert.equal(new Set(attempt.candidates.map(({ instance: instanceId }) => instanceId)).size, 2);
});

test("a resumed provider outside the current allowlist still leads and is not duplicated", () => {
  const attempt = chain([session("provider-session-source", "ds-bailian")], ["ds-harness-api"]);
  assert.ok(attempt);
  assert.deepEqual(
    attempt.candidates.map(({ instance: instanceId }) => instanceId),
    ["ds-bailian", "ds-harness-api"],
  );
});

test("a resumed session the projection does not carry keeps the previous no-chain behavior", () => {
  assert.equal(
    chain([]),
    undefined,
    "an unknown provider instance cannot anchor a chain; guessing one would settle attempt 0 under a provider that never ran",
  );
});

test("a fresh dispatch still derives its chain from the declared order", () => {
  const attempt = initialFallbackAttempt(
    agent,
    undefined,
    undefined,
    undefined,
    "task-review:task_1:exe_1:reviewer",
    "dispatch_successor",
    "mission",
    [instance("ds-bailian"), instance("ds-harness-api")],
    [],
    ["ds-bailian", "ds-harness-api"],
  );
  assert.ok(attempt);
  assert.deepEqual(
    attempt.candidates.map(({ instance: instanceId }) => instanceId),
    ["ds-bailian", "ds-harness-api"],
  );
});

test("a cooling pinned instance still leads the chain instead of the last allowlist row", () => {
  const attempt = initialFallbackAttempt(
    agent,
    "ds-bailian",
    undefined,
    undefined,
    "task-review:task_1:exe_1:reviewer",
    "dispatch_successor",
    "mission",
    [instance("ds-bailian"), instance("ds-harness-api")],
    [],
    ["ds-bailian", "ds-harness-api"],
    [
      {
        instanceId: "ds-bailian",
        failureStreak: 1,
        cooldownUntil: null,
        frozenUntil: null,
        frozen: true,
        reason: "HTTP 429",
        lastFailureAt: "2026-10-28T00:00:00.000Z",
        lastResetAt: null,
      },
    ],
  );
  assert.ok(attempt);
  assert.deepEqual(
    attempt.candidates.map(({ instance: instanceId }) => instanceId),
    ["ds-bailian", "ds-harness-api"],
    "attempt 0 ran on the pin, so the chain must record it before the first successor",
  );
});

test("a pinned fallback chain accepts the shared case-insensitive model resolution", () => {
  const catalogModel = "Deepseek-V4.1-Flash",
    attempt = initialFallbackAttempt(
      agent,
      "ds-bailian",
      undefined,
      undefined,
      "task-review:task_1:exe_1:reviewer",
      "dispatch_successor",
      "mission",
      [{ ...instance("ds-bailian"), models: [catalogModel], defaultModel: catalogModel }, instance("ds-harness-api")],
      [],
      ["ds-bailian", "ds-harness-api"],
    );
  assert.ok(attempt, "a catalog case variant still admits its pinned fallback chain");
  assert.deepEqual(
    attempt.candidates.map(({ instance: instanceId }) => instanceId),
    ["ds-bailian", "ds-harness-api"],
  );
});

const providerHealth = (
  instanceId: string,
  overrides: Partial<{
    failureStreak: number;
    cooldownUntil: string | null;
    frozen: boolean;
    frozenUntil: string | null;
    reason: string | null;
    lastFailureAt: string | null;
    lastResetAt: string | null;
  }> = {},
) => ({
  instanceId,
  failureStreak: overrides.failureStreak ?? 1,
  cooldownUntil: overrides.cooldownUntil ?? null,
  frozen: overrides.frozen ?? false,
  frozenUntil: overrides.frozenUntil ?? null,
  reason: overrides.reason ?? "HTTP 429",
  lastFailureAt: overrides.lastFailureAt ?? "2026-10-28T00:00:00.000Z",
  lastResetAt: overrides.lastResetAt ?? null,
});

// The original incident: data-migration declared two runtimes, the second was cooling at dispatch
// time, and the frozen chain recorded only the first. After the first provider fault the dispatch
// could only retry codex-api; the cooling second candidate was never usable. Health must be a
// selection-time filter, not chain membership.
test("a cooling successor stays in the chain so it can recover after dispatch", () => {
  const attempt = initialFallbackAttempt(
    agent,
    undefined,
    undefined,
    undefined,
    "task-review:task_1:exe_1:reviewer",
    "dispatch_successor",
    "mission",
    [instance("ds-bailian"), instance("ds-harness-api")],
    [],
    ["ds-bailian", "ds-harness-api"],
    [providerHealth("ds-harness-api", { cooldownUntil: "2099-01-01T00:05:00.000Z" })],
  );
  assert.ok(attempt);
  assert.deepEqual(
    attempt.candidates.map(({ instance: instanceId }) => instanceId),
    ["ds-bailian", "ds-harness-api"],
    "a cooling successor is still a declared candidate and must enter the chain",
  );
});

test("a temporarily frozen successor stays in the chain so it can recover after dispatch", () => {
  const attempt = initialFallbackAttempt(
    agent,
    undefined,
    undefined,
    undefined,
    "task-review:task_1:exe_1:reviewer",
    "dispatch_successor",
    "mission",
    [instance("ds-bailian"), instance("ds-harness-api")],
    [],
    ["ds-bailian", "ds-harness-api"],
    [providerHealth("ds-harness-api", { frozen: false, frozenUntil: "2099-01-01T00:30:00.000Z" })],
  );
  assert.ok(attempt);
  assert.deepEqual(
    attempt.candidates.map(({ instance: instanceId }) => instanceId),
    ["ds-bailian", "ds-harness-api"],
    "a temporary freeze is health, not membership; the candidate must remain in the chain",
  );
});

test("an auto-selected anchor keeps a cooling candidate that sorts before it", () => {
  const attempt = initialFallbackAttempt(
    agent,
    "ds-harness-api",
    undefined,
    undefined,
    "task-review:task_1:exe_1:reviewer",
    "dispatch_successor",
    "mission",
    [instance("ds-bailian"), instance("ds-harness-api")],
    [],
    ["ds-bailian", "ds-harness-api"],
    [providerHealth("ds-bailian", { cooldownUntil: "2099-01-01T00:05:00.000Z" })],
    undefined,
    true,
  );
  assert.ok(attempt);
  assert.deepEqual(
    attempt.candidates.map(({ instance: instanceId }) => instanceId),
    ["ds-harness-api", "ds-bailian"],
    "an auto-selected anchor must not drop a declared candidate that sorts before it",
  );
});
