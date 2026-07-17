// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  makeRuntimeAdapter,
  RuntimeAdapterUnsupportedError,
  type RuntimeAdapterTransport
} from "../src/agent-runtime-adapter.ts";

test("runtime adapter reports negotiated capabilities and rejects unsupported operations", async () => {
  const calls: string[] = [];
  const transport: RuntimeAdapterTransport = {
    identify: async () => { calls.push("identify"); return { installations: [], sessions: [] }; },
    spawn: async () => { calls.push("spawn"); return { runtimeSessionId: "runtime-1" }; },
    events: async () => { calls.push("events"); return []; }
  };
  const adapter = makeRuntimeAdapter({
    kindId: "claude-code",
    capabilities: {
      discover: true,
      spawn: true,
      attach: false,
      resume: true,
      interactive: false,
      resize: false,
      events: true
    },
    transport
  });

  assert.equal(adapter.capabilities().attach, false);
  await assert.rejects(
    adapter.attach({ runtimeSessionId: "runtime-1" }),
    (error: unknown) => error instanceof RuntimeAdapterUnsupportedError && error.capability === "attach"
  );
  assert.deepEqual(calls, []);
});

test("resume starts a new process while attach only reuses the live channel", async () => {
  const calls: string[] = [];
  const transport: RuntimeAdapterTransport = {
    identify: async () => ({ installations: [], sessions: [] }),
    spawn: async (input) => {
      calls.push(input.resumeProviderSessionId ? "resume-spawn" : "spawn");
      return { runtimeSessionId: "new-runtime-session" };
    },
    attach: async ({ runtimeSessionId }) => {
      calls.push(`attach:${runtimeSessionId}`);
      return { runtimeSessionId };
    },
    events: async () => []
  };
  const adapter = makeRuntimeAdapter({
    kindId: "codex",
    capabilities: {
      discover: true, spawn: true, attach: true, resume: true,
      interactive: true, resize: false, events: true
    },
    transport
  });

  await adapter.spawn({
    installationId: "codex-local",
    prompt: "continue",
    cwd: "/workspace",
    authenticationProfileKind: "chatgpt-account",
    resumeProviderSessionId: "provider-old"
  });
  await adapter.attach({ runtimeSessionId: "live-runtime-session" });

  assert.deepEqual(calls, ["resume-spawn", "attach:live-runtime-session"]);
});
