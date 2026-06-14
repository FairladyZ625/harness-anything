import assert from "node:assert/strict";
import test from "node:test";
import { preloadAllowlist, registerHarnessIpcHandlers, type GuiServiceBridge } from "../src/index.ts";

const trustedEvent = {
  sender: {
    id: 1
  },
  senderFrame: {
    url: "file:///app/renderer/index.html"
  }
};
const trustedRendererUrl = trustedEvent.senderFrame.url;

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
  await assert.rejects(() => handlers.get("harness:getTasks")?.(trustedEvent, "raw-string"), /payload must be an object/i);
  await assert.rejects(
    () => handlers.get("harness:getTasks")?.({ sender: { id: 1 }, senderFrame: { url: "https://example.com" } }, null),
    /untrusted_renderer_url/i
  );
  await assert.rejects(
    () => handlers.get("harness:getTasks")?.({ sender: { id: 2 }, senderFrame: trustedEvent.senderFrame }, null),
    /untrusted_web_contents/i
  );
});
