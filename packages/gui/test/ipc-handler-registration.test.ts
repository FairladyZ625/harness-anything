import assert from "node:assert/strict";
import test from "node:test";
import { preloadAllowlist, registerHarnessIpcHandlers, type GuiServiceBridge } from "../src/index.ts";

test("main process registers one IPC handler for each preload allowlist method", async () => {
  const channels: string[] = [];
  const bridge: GuiServiceBridge = {
    invoke: async (method, payload) => ({ ok: true, method, payload })
  };

  const handlers = new Map<string, (event: never, payload: unknown) => Promise<unknown>>();
  registerHarnessIpcHandlers({
    handle: (channel, listener) => {
      channels.push(channel);
      handlers.set(channel, listener as (event: never, payload: unknown) => Promise<unknown>);
    }
  }, bridge);

  assert.deepEqual(channels, preloadAllowlist.map((method) => `harness:${method}`));
  assert.deepEqual(await handlers.get("harness:getTasks")?.(undefined as never, null), {
    ok: true,
    method: "getTasks",
    payload: null
  });
  await assert.rejects(() => handlers.get("harness:getTasks")?.(undefined as never, "raw-string"), /payload must be an object/i);
});
