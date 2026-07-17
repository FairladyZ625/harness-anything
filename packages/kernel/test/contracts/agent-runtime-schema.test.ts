// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "effect";
import { runtimeKindRegistry } from "../../src/index.ts";
import { AgentRuntimeInventorySchema } from "../../src/schemas/agent-runtime.ts";

test("agent runtime schema accepts independent four-state evidence", () => {
  const fixture = {
    schema: "agent-runtime-inventory/v1",
    generatedAt: "2026-07-17T12:00:00.000Z",
    kinds: [],
    installations: [{
      installationId: "local:codex:path",
      kindId: "codex",
      hostId: "local",
      executablePath: "/opt/bin/codex",
      discoveredBy: "path",
      states: {
        installed: { state: true, reason: "executable-verified" },
        authenticated: { state: false, reason: "profile-not-authenticated" },
        running: { state: "unknown", reason: "process-witness-unavailable" },
        attachable: { state: false, reason: "attach-channel-unavailable" }
      }
    }],
    sessions: []
  } as const;
  const decoded = Schema.decodeUnknownSync(AgentRuntimeInventorySchema)(fixture);

  assert.deepEqual(decoded.installations[0]?.states, {
    installed: { state: true, reason: "executable-verified" },
    authenticated: { state: false, reason: "profile-not-authenticated" },
    running: { state: "unknown", reason: "process-witness-unavailable" },
    attachable: { state: false, reason: "attach-channel-unavailable" }
  });
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
