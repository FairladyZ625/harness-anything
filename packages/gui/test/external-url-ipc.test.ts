// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { EXTERNAL_URL_OPEN_CHANNEL } from "../src/api/external-url-contract.ts";
import { registerExternalUrlIpc } from "../src/main/external-url-ipc.ts";

const event = { sender: { id: 7 }, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
function fixture(openExternal?: (url: string) => Promise<void>) {
  let handler!: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>;
  const opened: string[] = [];
  registerExternalUrlIpc(
    {
      handle: (channel, listener) => {
        assert.equal(channel, EXTERNAL_URL_OPEN_CHANNEL);
        handler = listener;
      },
    },
    {
      rootDir: process.cwd(),
      openExternal:
        openExternal ??
        (async (url) => {
          opened.push(url);
        }),
    },
    {
      isTrustedWebContentsId: (id) => id === 7,
      rendererUrl: { packagedRendererUrl: event.senderFrame!.url },
    },
  );
  return { invoke: (payload: unknown, sender = event) => handler(sender, payload), opened };
}
test("trusted renderer opens HTTP(S) targets through the host", async () => {
  const f = fixture();
  for (const url of ["https://example.test/oauth?state=one#callback", "http://localhost:8080/login"])
    await f.invoke(url);
  assert.deepEqual(f.opened, ["https://example.test/oauth?state=one#callback", "http://localhost:8080/login"]);
});
test("rejects unsafe schemes, malformed payloads and untrusted senders before host access", async () => {
  const f = fixture();
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "custom:login",
    "",
    "not a URL",
    null,
    { url: "https://example.test" },
  ])
    await assert.rejects(f.invoke(url), /External URL/u);
  await assert.rejects(
    f.invoke("https://example.test", { ...event, sender: { id: 99 } } as IpcMainInvokeEvent),
    /Rejected IPC/u,
  );
  await assert.rejects(
    f.invoke("https://example.test", { ...event, senderFrame: { url: "https://example.test" } } as IpcMainInvokeEvent),
    /Rejected IPC/u,
  );
  assert.equal(f.opened.length, 0);
});
test("surfaces host opening failures", async () => {
  const failure = new Error("host open failed");
  await assert.rejects(
    fixture(async () => {
      throw failure;
    }).invoke("https://example.test"),
    (error) => error === failure,
  );
});
