// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { registerProjectDirectoryIpc } from "../src/main/project-directory-ipc.ts";
import { PROJECT_DIRECTORY_CHANNEL } from "../src/api/project-directory-contract.ts";
import type { IpcMainInvokeEvent } from "electron";

const event = { sender: { id: 7 }, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
const policy = {
  isTrustedWebContentsId: (id: number) => id === 7,
  rendererUrl: { packagedRendererUrl: event.senderFrame!.url },
};

function fixture(error = "") {
  let handler!: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>;
  const opened: string[] = [],
    lookedUp: string[] = [];
  registerProjectDirectoryIpc(
    {
      handle: (channel, listener) => {
        assert.equal(channel, PROJECT_DIRECTORY_CHANNEL);
        handler = listener;
      },
    },
    {
      registeredRoot: (id) => {
        lookedUp.push(id);
        return id === "local" ? "/registered/local" : null;
      },
      openPath: async (root) => {
        opened.push(root);
        return error;
      },
    },
    policy,
  );
  return { invoke: (payload: unknown, sender = event) => handler(sender, payload), opened, lookedUp };
}

test("opens only the root resolved from the registered repoId", async () => {
  const f = fixture();
  await f.invoke({ repoId: "local" });
  assert.deepEqual(f.lookedUp, ["local"]);
  assert.deepEqual(f.opened, ["/registered/local"]);
});

test("rejects renderer paths, unknown repos and untrusted senders before opening", async () => {
  const f = fixture();
  for (const payload of [{ repoId: "local", path: "/other" }, { path: "/other" }, { repoId: "/other" }, null])
    await assert.rejects(f.invoke(payload), /requires only/u);
  assert.deepEqual(f.lookedUp, []);
  await assert.rejects(f.invoke({ repoId: "remote" }), /no registered local workspace/u);
  await assert.rejects(
    f.invoke({ repoId: "local" }, { ...event, sender: { id: 99 } } as IpcMainInvokeEvent),
    /Rejected IPC/u,
  );
  assert.deepEqual(f.opened, []);
});

test("reports shell open failures", async () => {
  await assert.rejects(fixture("Folder unavailable").invoke({ repoId: "local" }), /Folder unavailable/u);
});
