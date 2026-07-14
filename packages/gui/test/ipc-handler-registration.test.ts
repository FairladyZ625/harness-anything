// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  apiRouteContracts,
  assertUniqueHarnessIpcChannels,
  deferredGuiBridgeContracts,
  preloadAllowlist,
  registerHarnessIpcHandlers,
  shippedPreloadMethods,
  terminalGuiBridgeContracts,
  type GuiServiceBridge
} from "../src/index.ts";

const trustedEvent = {
  sender: {
    id: 1
  },
  senderFrame: {
    url: "file:///app/renderer/index.html"
  }
};
const trustedRendererUrl = trustedEvent.senderFrame.url;

test("preload and IPC channel surfaces are derived from the API registry", () => {
  const shippedRegistryBridgeMethods = apiRouteContracts
    .map((contract) => contract.guiBridgeMethod)
    .filter((method): method is string => method !== undefined);
  const terminalRegistryBridgeMethods = terminalGuiBridgeContracts.map((contract) => contract.guiBridgeMethod);
  const deferredRegistryBridgeMethods = deferredGuiBridgeContracts.map((contract) => contract.guiBridgeMethod);
  const registryBackedPreloadMethods = [
    ...shippedRegistryBridgeMethods,
    ...deferredRegistryBridgeMethods,
    ...terminalRegistryBridgeMethods
  ];
  const channels: string[] = [];

  registerHarnessIpcHandlers(
    {
      handle: (channel) => {
        channels.push(channel);
      }
    },
    { invoke: async () => ({ ok: true }) },
    { isTrustedWebContentsId: () => true, rendererUrl: { packagedRendererUrl: trustedRendererUrl } }
  );

  assert.deepEqual(shippedPreloadMethods, [...shippedRegistryBridgeMethods, ...terminalRegistryBridgeMethods]);
  assert.deepEqual(preloadAllowlist, registryBackedPreloadMethods);
  assert.deepEqual(channels, registryBackedPreloadMethods.map((method) => `harness:${method}`));
});

test("main process registers one IPC handler for each preload allowlist method", async () => {
  const channels: string[] = [];
  const bridge: GuiServiceBridge = {
    invoke: async (method, payload) => ({ ok: true, method, payload })
  };

  const handlers = new Map<string, (event: typeof trustedEvent, payload: unknown) => Promise<unknown>>();
  registerHarnessIpcHandlers(
    {
      handle: (channel, listener) => {
        channels.push(channel);
        handlers.set(channel, listener as (event: typeof trustedEvent, payload: unknown) => Promise<unknown>);
      }
    },
    bridge,
    { isTrustedWebContentsId: (id) => id === 1, rendererUrl: { packagedRendererUrl: trustedRendererUrl } }
  );

  assert.deepEqual(channels, preloadAllowlist.map((method) => `harness:${method}`));
  assert.deepEqual(await handlers.get("harness:getTasks")?.(trustedEvent, null), {
    ok: true,
    method: "getTasks",
    payload: null
  });
  assert.deepEqual(await handlers.get("harness:getRelationGraph")?.(trustedEvent, null), {
    ok: true,
    method: "getRelationGraph",
    payload: null
  });
  assert.deepEqual(await handlers.get("harness:getDecisionDetail")?.(trustedEvent, { decisionId: "dec_1" }), {
    ok: true,
    method: "getDecisionDetail",
    payload: { decisionId: "dec_1" }
  });
  assert.deepEqual(await handlers.get("harness:getTaskFacts")?.(trustedEvent, { taskId: "task-1" }), {
    ok: true,
    method: "getTaskFacts",
    payload: { taskId: "task-1" }
  });
  await assert.rejects(() => handlers.get("harness:getTasks")?.(trustedEvent, "raw-string"), /payload must be an object/i);
  await assert.rejects(
    () => handlers.get("harness:getTasks")?.({ sender: { id: 1 }, senderFrame: { url: "https://example.com" } }, null),
    /untrusted_renderer_url/i
  );
  await assert.rejects(
    () => handlers.get("harness:getTasks")?.({ sender: { id: 2 }, senderFrame: trustedEvent.senderFrame }, null),
    /untrusted_web_contents/i
  );
  assert.equal(handlers.has("harness:capabilities"), false);
});

test("main process rejects duplicate IPC handler channels before registration", () => {
  assert.throws(
    () => assertUniqueHarnessIpcChannels(["getTasks", "getTasks"]),
    /Duplicate Harness IPC handler channel: harness:getTasks/u
  );
});
