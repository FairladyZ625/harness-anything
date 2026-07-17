// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentRuntimeSessionService,
  type RuntimeAdapterProcessEvent,
  type RuntimeProtocolAdapter,
  type RuntimeSessionStore
} from "../src/agent-runtime/session-service.ts";

test("daemon owns process witness, early-binds provider session, and preserves it after exit", async () => {
  let listener: ((event: RuntimeAdapterProcessEvent) => void) | undefined;
  const saved: unknown[] = [];
  const store: RuntimeSessionStore = {
    load: async () => [],
    save: async (sessions) => { saved.push(structuredClone(sessions)); }
  };
  const adapter: RuntimeProtocolAdapter = {
    kindId: "codex",
    capabilities: {
      discover: true, spawn: true, attach: true, resume: true,
      interactive: true, resize: false, events: true
    },
    spawn: async () => ({
      pid: 4242,
      onEvent: (next) => { listener = next; },
      close: () => undefined
    })
  };
  const service = await createAgentRuntimeSessionService({
    adapters: [adapter],
    store,
    authProfiles: async () => [{ kindId: "codex", profileKind: "chatgpt-account", state: "configured", guidance: "ready" }],
    createId: () => "runtime-session-1",
    now: sequenceClock()
  });

  const spawned = await service.spawn({
    kindId: "codex",
    prompt: "inspect the repository",
    cwd: "/workspace",
    authenticationProfileKind: "chatgpt-account",
    taskId: "task_1"
  });
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  assert.equal(spawned.session.process.pid, 4242);
  assert.equal(spawned.session.process.state, "alive");

  listener?.({ kind: "provider-session", providerSessionId: "provider-1" });
  listener?.({ kind: "heartbeat" });
  listener?.({ kind: "exit", exitCode: 17 });
  await new Promise((resolve) => setImmediate(resolve));

  const status = await service.status({ runtimeSessionId: "runtime-session-1" });
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.sessions[0]?.providerSessionId, "provider-1");
  assert.equal(status.sessions[0]?.process.state, "exited");
  assert.equal(status.sessions[0]?.process.exitCode, 17);
  assert.equal(status.sessions[0]?.attachable, false);
  assert.equal(status.sessions[0]?.clientBinding?.assertion, "client-asserted");
  assert.ok(saved.length >= 4, "every witness transition and early provider binding is persisted");
});

test("daemon restart preserves the provider pointer but downgrades an unrecoverable live channel", async () => {
  const persisted = [{
    runtimeSessionId: "runtime-live-before-restart",
    kindId: "claude-code",
    providerSessionId: "claude-provider-1",
    process: { state: "alive" as const, pid: 5151, startedAt: "2026-07-17T00:00:00.000Z" },
    attachable: true,
    capabilities: {
      discover: true, spawn: true, attach: false, resume: true,
      interactive: false, resize: false, events: true
    },
    resultState: "running" as const,
    events: []
  }];
  const service = await createAgentRuntimeSessionService({
    adapters: [],
    store: { load: async () => persisted, save: async () => undefined },
    authProfiles: async () => []
  });

  const status = await service.status({ runtimeSessionId: "runtime-live-before-restart" });
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.sessions[0]?.providerSessionId, "claude-provider-1");
  assert.equal(status.sessions[0]?.process.state, "unknown");
  assert.equal(status.sessions[0]?.attachable, false);
});

function sequenceClock(): () => string {
  let tick = 0;
  return () => `2026-07-17T00:00:0${tick++}.000Z`;
}
