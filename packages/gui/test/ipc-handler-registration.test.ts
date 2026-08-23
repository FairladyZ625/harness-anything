// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { daemonGuiInvokeFacets, daemonGuiStreamFacets } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { apiRouteContracts, assertUniqueHarnessIpcChannels, preloadAllowlist, registerHarnessIpcHandlers,
  assertPreloadPayload, shippedPreloadMethods, type GuiServiceBridge } from "../src/index.ts";

const trustedEvent = { sender: { id: 1 }, senderFrame: { url: "file:///app/renderer/index.html" } };
const trustedRendererUrl = trustedEvent.senderFrame.url;

test("preload and IPC channels derive from the API registry", () => {
  const registryMethods = [...daemonGuiInvokeFacets, ...daemonGuiStreamFacets].map(({ guiBridgeMethod }) => guiBridgeMethod), invokeMethods = daemonGuiInvokeFacets.map(({ guiBridgeMethod }) => guiBridgeMethod), channels: string[] = [];
  registerHarnessIpcHandlers({ handle: (channel) => { channels.push(channel); }, on: (channel) => { channels.push(channel); } }, { invoke: async () => ({ ok: true }), stream: async () => () => undefined },
    { isTrustedWebContentsId: () => true, rendererUrl: { packagedRendererUrl: trustedRendererUrl } });
  assert.deepEqual(shippedPreloadMethods, registryMethods);
  assert.deepEqual(preloadAllowlist, registryMethods);
  const invokeChannels = invokeMethods.map((method) => `harness:${method}`), streamChannels = daemonGuiStreamFacets.flatMap(({ guiBridgeMethod }) => [`harness:${guiBridgeMethod}`, `harness:${guiBridgeMethod}:detach`]); assert.deepEqual(channels, [...invokeChannels, ...streamChannels]);
});

test("main process registers one IPC handler for each preload allowlist method", async () => {
  const bridge: GuiServiceBridge = { invoke: async (method, payload) => ({ ok: true, method, payload }), stream: async () => () => undefined };
  const handlers = new Map<string, (event: typeof trustedEvent, payload: unknown) => Promise<unknown>>();
  registerHarnessIpcHandlers({ handle: (channel, listener) => { handlers.set(channel, listener as (event: typeof trustedEvent, payload: unknown) => Promise<unknown>); }, on: () => undefined }, bridge,
    { isTrustedWebContentsId: (id) => id === 1, rendererUrl: { packagedRendererUrl: trustedRendererUrl } });
  const streamMethods = new Set(apiRouteContracts.filter(({ method }) => method === "STREAM").map(({ guiBridgeMethod }) => guiBridgeMethod)), invokeMethods = preloadAllowlist.filter((method) => !streamMethods.has(method)); assert.deepEqual([...handlers.keys()], invokeMethods.map((method) => `harness:${method}`));
  const routeByMethod = new Map(daemonGuiInvokeFacets.map((route) => [route.guiBridgeMethod, route]));
  const runtimePayload = (method: string): object => method === "listRuntimeInstances" ? { all: true } : method === "createRuntimeInstance" ? { instanceId: "codex-review", name: "Codex Review", kindId: "codex", installationId: "installation-codex", providerId: "openai", models: ["gpt-5.6-sol"], codex: {}, authMode: "api-key", apiKey: "sk-typed-in-form" } : ["signInRuntimeInstance", "signOutRuntimeInstance"].includes(method) ? { repoId: "repo-a", instanceId: "codex-review", idempotencyKey: "once" } : method === "updateRuntimeInstance" ? { instanceId: "codex-review", enabled: true } : { instanceId: "codex-review" };
  const runtimeMethods = new Set(["listRuntimeInstances", "showRuntimeInstance", "createRuntimeInstance", "updateRuntimeInstance", "deleteRuntimeInstance", "signInRuntimeInstance", "signOutRuntimeInstance"]);
  for (const method of invokeMethods) { const payload = runtimeMethods.has(method) ? runtimePayload(method) : method === "getTaskDispatches" ? { repoId: "repo-a", taskIds: ["task-a"] } : routeByMethod.get(method)?.requiresRepo ? { repoId: "repo-a" } : null; assert.deepEqual(await handlers.get(`harness:${method}`)?.(trustedEvent, payload), { ok: true, method, payload }); }
  await assert.rejects(() => handlers.get("harness:getTasks")?.(trustedEvent, "raw-string"), /payload must be an object/iu);
  assert.throws(() => assertPreloadPayload("spawnAgentRuntime", { nested: { apiToken: "forbidden" } }), /secret-like key/iu);
  assert.throws(() => assertPreloadPayload("createRuntimeInstance", { instanceId: "codex-review", name: "Codex Review", kindId: "codex", installationId: "installation-codex", providerId: "openai", models: ["gpt"], authMode: "subscription", apiKey: "subscription-cannot-carry-a-key" }), /invalid/iu);
  assert.throws(() => assertPreloadPayload("showRuntimeInstance", { instanceId: "codex-review", apiKey: "only-create-accepts-it" }), /secret-like key/iu);
  assert.throws(() => assertPreloadPayload("createRuntimeInstance", { instanceId: "codex-review", name: "Codex Review", kindId: "codex", installationId: "installation-codex", providerId: "openai", models: ["gpt"], authMode: "api-key", credentialRef: "keychain:forbidden/ref" }), /secret-like key/iu);
  assert.throws(() => assertPreloadPayload("createRuntimeInstance", { instanceId: "claude-review", name: "Claude Review", kindId: "claude", installationId: "installation-claude", providerId: "anthropic", models: ["claude"], claude: {}, codex: { reasoningEffort: "high" }, authMode: "subscription" }), /invalid/iu);
  await assert.rejects(() => handlers.get("harness:getTasks")?.({ sender: { id: 1 }, senderFrame: { url: "https://example.com" } }, null), /untrusted_renderer_url/iu);
  await assert.rejects(() => handlers.get("harness:getTasks")?.({ sender: { id: 2 }, senderFrame: trustedEvent.senderFrame }, null), /untrusted_web_contents/iu);
  assert.equal(handlers.has("harness:capabilities"), false);
});

test("main process rejects duplicate IPC channels", () => {
  assert.throws(() => assertUniqueHarnessIpcChannels(["getTasks", "getTasks"]), /Duplicate Harness IPC handler channel/u);
});
