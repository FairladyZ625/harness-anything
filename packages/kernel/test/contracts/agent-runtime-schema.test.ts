// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRuntimeInstallation,
  parseRuntimeKind,
  parseRuntimeSession,
  runtimeKindRegistry
} from "../../src/index.ts";

const observedAt = "2026-07-17T12:00:00.000Z";

test("RuntimeKind schema rejects malformed and excess input fail-closed", () => {
  const valid = runtimeKindRegistry[1];
  assert.equal(parseRuntimeKind(valid).kindId, "codex");
  assert.throws(() => parseRuntimeKind({ ...valid, credential: "must-not-be-accepted" }));
  assert.throws(() => parseRuntimeKind({ ...valid, capabilities: [...valid.capabilities, valid.capabilities[0]] }));
});

test("RuntimeInstallation schema rejects a state backed by another state's criterion", () => {
  const valid = installationFixture();
  assert.equal(parseRuntimeInstallation(valid).installationId, "local:codex:path");
  assert.throws(() => parseRuntimeInstallation({
    ...valid,
    states: {
      ...valid.states,
      authenticated: valid.states.installed
    }
  }));
  assert.throws(() => parseRuntimeInstallation({ ...valid, states: { ...valid.states, token: "must-not-be-accepted" } }));
});

test("RuntimeSession schema rejects malformed process and attach-channel witnesses", () => {
  const valid = sessionFixture();
  assert.equal(parseRuntimeSession(valid).runtimeSessionId, "runtime-session-1");
  assert.throws(() => parseRuntimeSession({ ...valid, processWitness: { state: "alive", startedAt: observedAt } }));
  assert.throws(() => parseRuntimeSession({
    ...valid,
    attachable: { ...valid.attachable, observation: { ...valid.attachable.observation, outcome: "unavailable" } }
  }));
});

test("each of the four independent criteria has a positive observable control", () => {
  const states = parseRuntimeInstallation(installationFixture()).states;
  assert.deepEqual(
    [states.installed, states.authenticated, states.running, states.attachable].map((evidence) => [evidence.criterion, evidence.state, evidence.observation?.kind]),
    [
      ["executable-probe", true, "executable-probe"],
      ["authentication-probe", true, "authentication-probe"],
      ["process-probe", true, "process-probe"],
      ["attach-channel-probe", true, "attach-channel-probe"]
    ]
  );
});

test("static runtime registry includes claude-code and codex protocol families with capability placeholders", () => {
  assert.deepEqual(
    runtimeKindRegistry.map(({ kindId, protocolFamily }) => ({ kindId, protocolFamily })),
    [
      { kindId: "claude-code", protocolFamily: "stream-json" },
      { kindId: "codex", protocolFamily: "json-rpc" }
    ]
  );
  for (const kind of runtimeKindRegistry) {
    assert.equal(kind.capabilities.find(({ name }) => name === "discover")?.state, "supported");
    assert.equal(kind.capabilities.find(({ name }) => name === "attach")?.state, "unknown");
  }
});

function installationFixture() {
  return {
    installationId: "local:codex:path",
    kindId: "codex",
    hostId: "local",
    executablePath: "/opt/bin/codex",
    discoveredBy: "path",
    states: {
      installed: {
        criterion: "executable-probe", state: true, reason: "executable-verified", observedAt,
        observation: { kind: "executable-probe", source: "path", executablePath: "/opt/bin/codex", outcome: "executable" }
      },
      authenticated: {
        criterion: "authentication-probe", state: true, reason: "profile-authenticated", observedAt,
        observation: { kind: "authentication-probe", profileKind: "chatgpt-account", outcome: "authenticated" }
      },
      running: {
        criterion: "process-probe", state: true, reason: "process-alive", observedAt,
        observation: { kind: "process-probe", outcome: "alive", runtimeSessionId: "runtime-session-1", pid: 4242 }
      },
      attachable: {
        criterion: "attach-channel-probe", state: true, reason: "attach-channel-available", observedAt,
        observation: { kind: "attach-channel-probe", outcome: "available", runtimeSessionId: "runtime-session-1" }
      }
    }
  } as const;
}

function sessionFixture() {
  return {
    runtimeSessionId: "runtime-session-1",
    kindId: "codex",
    installationId: "local:codex:path",
    processWitness: { state: "alive", pid: 4242, startedAt: observedAt },
    attachable: {
      criterion: "attach-channel-probe", state: true, reason: "attach-channel-available", observedAt,
      observation: { kind: "attach-channel-probe", outcome: "available", runtimeSessionId: "runtime-session-1" }
    }
  } as const;
}
