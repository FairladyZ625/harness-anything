// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  apiRouteContracts,
  assertUniqueHarnessIpcChannels,
  deferredGuiBridgeContracts,
  HARNESS_PROJECTION_CHANGED_CHANNEL,
  HARNESS_WATCH_PROJECTION_CHANGES_CHANNEL,
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

test("projection subscription sink forwards daemon notifications to the trusted renderer", async () => {
  type NotificationEvent = {
    readonly sender: { readonly id: number; readonly send: (channel: string, payload: unknown) => void };
    readonly senderFrame: { readonly url: string };
  };
  const handlers = new Map<string, (event: NotificationEvent, payload: unknown) => Promise<unknown>>();
  const deliveries: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  let daemonSink: ((notification: never) => void) | undefined;
  const event = {
    ...trustedEvent,
    sender: {
      id: 1,
      send: (channel: string, payload: unknown) => deliveries.push({ channel, payload })
    }
  };
  registerHarnessIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener as (event: NotificationEvent, payload: unknown) => Promise<unknown>) },
    { invoke: async () => ({ ok: true }) },
    { isTrustedWebContentsId: () => true, rendererUrl: { packagedRendererUrl: trustedRendererUrl } },
    {
      watch: async (_repoId, sink) => {
        daemonSink = sink as (notification: never) => void;
        return { mode: "push" };
      }
    }
  );

  expectChannelRegistered(handlers, HARNESS_WATCH_PROJECTION_CHANGES_CHANNEL);
  assert.deepEqual(await handlers.get(HARNESS_WATCH_PROJECTION_CHANGES_CHANNEL)?.(event, { repoId: "repo-a" }), { mode: "push" });
  const notification = {
    type: "change" as const,
    repoId: "repo-a",
    event: { schema: "projection-change/v1" as const, sourceHash: "sha256:new", entities: [{ kind: "task", id: "task-a" }] }
  };
  daemonSink?.(notification as never);
  assert.deepEqual(deliveries, [{ channel: HARNESS_PROJECTION_CHANGED_CHANNEL, payload: notification }]);
});

function expectChannelRegistered(handlers: ReadonlyMap<string, unknown>, channel: string): void {
  assert.equal(handlers.has(channel), true, `missing IPC delivery link ${channel}`);
}
