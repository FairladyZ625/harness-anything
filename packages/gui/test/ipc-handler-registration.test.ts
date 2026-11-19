// harness-test-tier: contract
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  RPC_CHANNEL,
  STREAM_OPEN_CHANNEL,
  STREAM_CLOSE_CHANNEL,
  registerHarnessIpcHandlers,
  withIpcDomainErrors,
  type GuiServiceBridge,
} from "../src/index.ts";

const sender = Object.assign(new EventEmitter(), { id: 1, send: () => undefined });
const trustedEvent = { sender, senderFrame: { url: "file:///app/renderer/index.html" } };

function register(bridge: GuiServiceBridge) {
  const handlers = new Map<string, (event: typeof trustedEvent, value: unknown) => Promise<unknown>>();
  registerHarnessIpcHandlers(
    {
      handle: (channel, listener) => {
        assert.equal(handlers.has(channel), false, channel);
        handlers.set(channel, listener as unknown as (event: typeof trustedEvent, value: unknown) => Promise<unknown>);
      },
      on: () => undefined,
    },
    bridge,
    {
      isTrustedWebContentsId: (id) => id === 1,
      rendererUrl: { packagedRendererUrl: trustedEvent.senderFrame.url },
    },
  );
  return handlers;
}

// harness-contract: gui.ipc-preload-alignment
// dec_89D06D7360CBEC09795F7B12EC/CH3: one RPC envelope across transports; IPC independently checks the sender.
// dec_89D06D7360CBEC09795F7B12EC/CH3 closes admission before dispatch.
// harness-contract: gui.ipc-preload-alignment
test("main admits the canonical envelope on one unary channel", async () => {
  const handlers = register({
    invoke: async (method, params) => ({ method, params }),
    stream: async () => () => undefined,
  });
  assert.deepEqual([...handlers.keys()], [RPC_CHANNEL, STREAM_OPEN_CHANNEL, STREAM_CLOSE_CHANNEL]);
  const call = handlers.get(RPC_CHANNEL)!;
  const read = { method: "repo.tasks.list", params: { repo: { repoId: "repo-a" }, payload: { limit: 10 } } };
  assert.deepEqual(await call(trustedEvent, read), read);
  await assert.rejects(() => call(trustedEvent, { ...read, method: "daemon.stop" }), /not allowed/u);
  await assert.rejects(() => call(trustedEvent, { ...read, params: { repoId: "repo-a" } }), /invalid/u);
  await assert.rejects(
    () => call(trustedEvent, { ...read, params: { repo: { repoId: "repo-a" }, payload: { limit: 0 } } }),
    /invalid/u,
  );
  await assert.rejects(
    () => call({ ...trustedEvent, senderFrame: { url: "https://example.test" } }, read),
    /untrusted_renderer_url/u,
  );
  await assert.rejects(() => call({ ...trustedEvent, sender: { ...sender, id: 2 } }, read), /untrusted_web_contents/u);
});

test("generic stream IPC isolates subscriptions by sender and aborts opening and active readers", async () => {
  const seen: AbortSignal[] = [];
  const handlers = register({
    invoke: async () => undefined,
    stream: async (_method, _params, _value, signal) => {
      seen.push(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return () => undefined;
    },
  });
  const open = handlers.get(STREAM_OPEN_CHANNEL)!;
  const close = handlers.get(STREAM_CLOSE_CHANNEL)!;
  const request = {
    method: "repo.agentRuntime.attach",
    subscriptionId: "renderer-1",
    params: { repo: { repoId: "repo-a" }, payload: { runtimeSessionId: "runtime-a" } },
  };
  const first = open(trustedEvent, request);
  await assert.rejects(() => open(trustedEvent, request), /already exists/u);
  await assert.rejects(() => open(trustedEvent, { ...request, method: "repo.task.run" }), /unknown/iu);
  await assert.rejects(() => close({ ...trustedEvent, sender: { ...sender, id: 2 } }, request), /untrusted/u);
  assert.equal(seen[0]?.aborted, false);
  await close(trustedEvent, request);
  await first;
  assert.equal(seen[0]?.aborted, true);
  const second = open(trustedEvent, request);
  sender.emit("destroyed");
  await second;
  assert.equal(seen[1]?.aborted, true);
  assert.equal(sender.listenerCount("destroyed"), 0);
});

test("withIpcDomainErrors records desensitized IPC sequence when HARNESS_GUI_IPC_TRACE is enabled", async () => {
  const prevTrace = process.env.HARNESS_GUI_IPC_TRACE;
  const globalRecord = globalThis as Record<string, unknown>;
  const prevGlobal = globalRecord.__harnessGuiIpcTrace;
  process.env.HARNESS_GUI_IPC_TRACE = "1";
  try {
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const registrar = withIpcDomainErrors({
      handle: (channel, listener) => {
        handlers.set(channel, listener as (event: unknown, payload: unknown) => Promise<unknown>);
      },
      on: () => undefined,
    });
    registrar.handle("harness:rpc", async (_, envelope) => {
      if ((envelope as { method: string }).method === "repo.projection.read")
        throw Object.assign(new Error("projection failed"), { code: "projection_unavailable" });
      return { ok: true };
    });

    await handlers.get("harness:rpc")?.(trustedEvent, {
      method: "daemon.runtimeInstance.create",
      params: { payload: { name: "Private Instance", apiKey: "fixture-api-key", token: "fixture-token" } },
    });
    const failedReply = await handlers.get("harness:rpc")?.(trustedEvent, {
      method: "repo.projection.read",
      params: { repo: { repoId: "repo-a" }, payload: { facet: "overview", body: "large-private-body" } },
    });
    assert.deepEqual(failedReply, {
      ipcFailure: { code: "projection_unavailable", message: "projection failed" },
    });

    const tracer = globalRecord.__harnessGuiIpcTrace as { snapshot: (clear?: boolean) => unknown[] };
    assert.equal(typeof tracer?.snapshot, "function");
    const entries = tracer.snapshot(true) as Array<Record<string, unknown>>;
    assert.equal(entries.length, 2);
    const serialized = JSON.stringify(entries);
    assert.equal(serialized.includes("fixture-api-key"), false);
    assert.equal(serialized.includes("fixture-token"), false);
    assert.equal(serialized.includes("large-private-body"), false);
    assert.equal(entries[0].channel, "harness:rpc");
    assert.equal(entries[0].method, "daemon.runtimeInstance.create");
    assert.equal(entries[0].result, "ok");
    assert.deepEqual(entries[0].payloadSummary, {
      keys: ["apiKey", "name", "token"],
      fields: { name: "Private Instance" },
      redactedKeys: ["apiKey", "token"],
    });
    assert.equal(entries[1].channel, "harness:rpc");
    assert.equal(entries[1].method, "repo.projection.read");
    assert.deepEqual(entries[1].payloadSummary, {
      keys: ["body", "facet", "repoId"],
      fields: { facet: "overview", repoId: "repo-a" },
      redactedKeys: ["body"],
    });
    assert.equal(entries[1].result, "ipc_failure");
    assert.equal(entries[1].errorCode, "projection_unavailable");
    assert.equal(tracer.snapshot().length, 0);
  } finally {
    if (prevTrace === undefined) delete process.env.HARNESS_GUI_IPC_TRACE;
    else process.env.HARNESS_GUI_IPC_TRACE = prevTrace;
    if (prevGlobal === undefined) delete globalRecord.__harnessGuiIpcTrace;
    else globalRecord.__harnessGuiIpcTrace = prevGlobal;
  }
});
