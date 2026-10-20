// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import type { JsonObject } from "@harness-anything/daemon";
import {
  EDGE_JOIN_LINK_PREFIX,
  edgeJoinEntryParams,
  edgeJoinLinkFromArgv,
  registerEdgeJoinEntryIpc,
} from "../src/main/edge-join-entry-ipc.ts";

const LINK = `${EDGE_JOIN_LINK_PREFIX}eyJ2ZXJzaW9uIjoxfQ`,
  event = { sender: { id: 7 }, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent,
  policy = {
    isTrustedWebContentsId: (id: number) => id === 7,
    rendererUrl: { packagedRendererUrl: event.senderFrame!.url },
  };

function fixture(replies: readonly JsonObject[] = [{ ok: true }]) {
  let handler!: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>;
  const sent: JsonObject[] = [],
    opened: string[] = [];
  registerEdgeJoinEntryIpc(
    {
      handle: (channel, listener) => {
        assert.equal(channel, "harness:edge:join");
        handler = listener;
      },
    },
    policy,
    {
      daemonRequest: async (params) => {
        sent.push(params);
        return replies[sent.length - 1] ?? { ok: true };
      },
      openExternal: async (url) => {
        opened.push(url);
      },
    },
  );
  return { sent, opened, invoke: (input: unknown, sender = event) => handler(sender, input) };
}

test("the renderer request is narrowed to one join link, one poll, or one read-only progress query", () => {
  assert.deepEqual(edgeJoinEntryParams({ kind: "join", link: LINK }), { kind: "join", link: LINK });
  assert.deepEqual(edgeJoinEntryParams({ kind: "poll" }), { kind: "poll" });
  assert.deepEqual(edgeJoinEntryParams({ kind: "progress" }), { kind: "progress" });
  assert.deepEqual(edgeJoinEntryParams({ kind: "open-login" }), { kind: "open-login" });
  for (const bad of [
    { kind: "join", link: "https://example.test/join" },
    { kind: "join", link: `${EDGE_JOIN_LINK_PREFIX}` },
    { kind: "join", link: `${EDGE_JOIN_LINK_PREFIX}${"a".repeat(4096)}` },
    { kind: "join", link: LINK, rootDir: "/tmp/elsewhere" },
    { kind: "poll", link: LINK },
    { kind: "delete" },
    {},
  ])
    assert.throws(() => edgeJoinEntryParams(bad), /Edge join|Paste a harness-edge/u, JSON.stringify(bad));
});

test("only a harness-edge://join argument from the OS becomes a link", () => {
  assert.equal(edgeJoinLinkFromArgv(["/Applications/Harness.app", LINK]), LINK);
  assert.equal(edgeJoinLinkFromArgv(["/Applications/Harness.app", "--flag"]), null);
  assert.equal(edgeJoinLinkFromArgv([`${EDGE_JOIN_LINK_PREFIX}${"a".repeat(4096)}`]), null);
  assert.equal(edgeJoinLinkFromArgv(["harness-edge://other/thing"]), null);
});

test("join, poll, and progress reach the daemon's existing operations unchanged", async () => {
  const { sent, invoke } = fixture([
    {
      ok: true,
      command: "edge-join",
      pending: true,
      verificationUri: "https://login.example.test/device",
      userCode: "X",
    },
    { ok: true, pending: false },
    { ok: true, command: "edge-join", repositories: [] },
  ]);

  await invoke({ kind: "join", link: LINK });
  await invoke({ kind: "poll" });
  await invoke({ kind: "progress" });

  assert.deepEqual(sent, [
    { operation: "edge-join", link: LINK },
    { operation: "login-poll" },
    { operation: "edge-join-progress" },
  ]);
});

test("open-login opens only the https page the daemon last named", async () => {
  const { opened, invoke } = fixture([
    { ok: true, pending: true, verificationUri: "https://login.example.test/device", userCode: "X" },
    { ok: true },
  ]);

  await assert.rejects(invoke({ kind: "open-login" }), /No edge join sign-in is waiting/u);
  assert.deepEqual(opened, []);

  await invoke({ kind: "poll" });
  await invoke({ kind: "open-login" });
  assert.deepEqual(opened, ["https://login.example.test/device"]);
});

test("a daemon-named sign-in page that is not https is refused, never opened", async () => {
  const { opened, invoke } = fixture([
    { ok: true, pending: true, verificationUri: "http://login.example.test/device" },
  ]);

  await assert.rejects(invoke({ kind: "poll" }), /non-https/u);
  assert.deepEqual(opened, []);
});

test("an untrusted renderer cannot reach the daemon", async () => {
  const { sent, invoke } = fixture();

  await assert.rejects(
    invoke({ kind: "poll" }, {
      sender: { id: 99 },
      senderFrame: { url: "https://evil.example/" },
    } as IpcMainInvokeEvent),
    /untrusted/u,
  );
  assert.deepEqual(sent, []);
});
