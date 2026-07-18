// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  attachChannelProbeEvidence,
  authenticationProbeEvidence,
  executableProbeEvidence,
  processProbeEvidence
} from "../src/index.ts";
import type { AgentRuntimeSessionStatus } from "../src/agent-runtime-control.ts";

const observedAt = "2026-07-17T12:00:00.000Z";

test("installed becomes true only after the executable probe speaks positively", () => {
  const evidence = executableProbeEvidence({ source: "path", executablePath: "/opt/bin/codex", executable: true, observedAt });
  assert.deepEqual([evidence.criterion, evidence.state, evidence.observation?.outcome], ["executable-probe", true, "executable"]);
});

test("authenticated requires provider status; configuration presence remains unknown", () => {
  const positive = authenticationProbeEvidence([{
    kindId: "codex", profileKind: "chatgpt-account", state: "configured", assurance: "authenticated-status", guidance: "ready"
  }], observedAt);
  const unverified = authenticationProbeEvidence([{
    kindId: "codex", profileKind: "api-key", state: "configured", assurance: "configuration-presence", guidance: "configured"
  }], observedAt);
  assert.deepEqual([positive.criterion, positive.state, positive.observation?.outcome], ["authentication-probe", true, "authenticated"]);
  assert.deepEqual([unverified.state, unverified.reason], ["unknown", "authentication-unverified"]);
});

test("running distinguishes a live process witness, successful absence, and probe silence", () => {
  const positive = processProbeEvidence([liveSession()], observedAt);
  const absent = processProbeEvidence([], observedAt);
  const silent = processProbeEvidence(undefined, observedAt);
  assert.deepEqual([positive.criterion, positive.state, positive.observation?.outcome], ["process-probe", true, "alive"]);
  assert.deepEqual([absent.state, absent.reason], [false, "process-not-found"]);
  assert.deepEqual([silent.state, silent.reason], ["unknown", "process-witness-unavailable"]);
});

test("attachable distinguishes an available channel, successful absence, and probe silence", () => {
  const positive = attachChannelProbeEvidence([liveSession()], observedAt);
  const absent = attachChannelProbeEvidence([], observedAt);
  const silent = attachChannelProbeEvidence(undefined, observedAt);
  assert.deepEqual([positive.criterion, positive.state, positive.observation?.outcome], ["attach-channel-probe", true, "available"]);
  assert.deepEqual([absent.state, absent.reason], [false, "attach-channel-unavailable"]);
  assert.deepEqual([silent.state, silent.reason], ["unknown", "attach-channel-probe-failed"]);
});

function liveSession(): AgentRuntimeSessionStatus {
  return {
    runtimeSessionId: "runtime-session-1",
    kindId: "codex",
    process: { state: "alive", pid: 4242, startedAt: observedAt },
    attachable: true,
    capabilities: { discover: true, spawn: true, attach: true, resume: true, interactive: true, resize: false, events: true }
  };
}
