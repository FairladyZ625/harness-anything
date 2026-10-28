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
