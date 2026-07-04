import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { currentSessionToProvenancePayload, makeEnvironmentCurrentSessionProbe, makeHumanFallbackSessionProbe } from "../src/index.ts";

test("human fallback session probe returns deterministic manual provenance input", () => {
  const probe = makeHumanFallbackSessionProbe({
    now: () => "2026-07-03T00:00:00.000Z",
    user: () => "ZeyuLi"
  });

  const session = Effect.runSync(probe.currentSession);

  assert.deepEqual(session, {
    runtime: "human",
    sessionId: "human-cli-1783036800000",
    source: "manual",
    detectedAt: "2026-07-03T00:00:00.000Z",
    user: "ZeyuLi"
  });
  assert.deepEqual(currentSessionToProvenancePayload(session, "2026-07-03T00:01:00.000Z"), {
    runtime: "human",
    sessionId: "human-cli-1783036800000",
    boundAt: "2026-07-03T00:01:00.000Z"
  });
});

test("environment session probe detects configured agent runtime session before human fallback", () => {
  const probe = makeEnvironmentCurrentSessionProbe({
    now: () => "2026-07-03T00:00:00.000Z",
    env: { CODEX_SESSION_ID: "codex-session-1" }
  });

  assert.deepEqual(Effect.runSync(probe.currentSession), {
    runtime: "codex",
    sessionId: "codex-session-1",
    source: "runtime",
    detectedAt: "2026-07-03T00:00:00.000Z"
  });
});

test("environment session probe binds Codex thread id before legacy session id", () => {
  const probe = makeEnvironmentCurrentSessionProbe({
    now: () => "2026-07-03T00:00:00.000Z",
    env: {
      CODEX_THREAD_ID: "019f28de-f7f6-7223-a2a8-b2968686fe21",
      CODEX_SESSION_ID: "legacy-codex-session"
    }
  });

  assert.deepEqual(Effect.runSync(probe.currentSession), {
    runtime: "codex",
    sessionId: "019f28de-f7f6-7223-a2a8-b2968686fe21",
    source: "runtime",
    detectedAt: "2026-07-03T00:00:00.000Z"
  });
});
