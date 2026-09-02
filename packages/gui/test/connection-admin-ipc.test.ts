// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONNECTION_PROBE_CHANNEL,
  CONNECTION_REGISTER_CHANNEL,
  CONNECTION_STATUS_CHANNEL,
  CONNECTION_UNREGISTER_CHANNEL,
  CONNECTION_UPDATE_CHANNEL,
  REPO_REGISTER_CHANNEL,
  REPO_UNREGISTER_CHANNEL,
  REPO_UPDATE_CHANNEL,
  WORKSPACE_INSPECT_CHANNEL,
} from "../src/api/connection-admin-contract.ts";
import {
  registerConnectionAdminIpc,
  suggestedRepoId,
  type AdminJsonRpcRequest,
} from "../src/main/connection-admin-ipc.ts";

/**
 * Settings → 仓库与连接 的 admin IPC 契约(PLT-EdgeGUI-W3):
 * ①通道面闭合(九个通道,无多余);②转发参数与 daemon RPC 形状一致
 * (closed params,可选字段缺省即省略);③非法字段/形状在主进程入口即拒;
 * ④inspectWorkspace 只读本机 .harness 存在性,不触 daemon。
 */

const trustedEvent = {
  sender: { id: 7 },
  senderFrame: { url: "file:///Applications/Harness/renderer/index.html" },
};
const trustPolicy = {
  isTrustedWebContentsId: (id: number) => id === 7,
  rendererUrl: { packagedRendererUrl: trustedEvent.senderFrame.url },
};

function register() {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const request: AdminJsonRpcRequest = async (method, params) => {
    calls.push({ method, params: { ...params } });
    return { schema: "command-receipt/v2", ok: true, command: "stub", outcome: "applied" };
  };
  registerConnectionAdminIpc(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as never);
      },
    },
    { request },
    trustPolicy,
  );
  return {
    handlers,
    calls,
    invoke: (channel: string, payload: unknown) => handlers.get(channel)!(trustedEvent, payload),
    reject: (channel: string, payload: unknown) => handlers.get(channel)!(trustedEvent, payload),
  };
}

test("connection admin IPC exposes exactly the nine closed channels", () => {
  const { handlers } = register();
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [
      CONNECTION_PROBE_CHANNEL,
      CONNECTION_REGISTER_CHANNEL,
      CONNECTION_STATUS_CHANNEL,
      CONNECTION_UNREGISTER_CHANNEL,
      CONNECTION_UPDATE_CHANNEL,
      REPO_REGISTER_CHANNEL,
      REPO_UNREGISTER_CHANNEL,
      REPO_UPDATE_CHANNEL,
      WORKSPACE_INSPECT_CHANNEL,
    ].sort(),
  );
});

test("admin IPC forwards closed params to the daemon RPC shapes", async () => {
  const admin = register();
  await admin.invoke(CONNECTION_STATUS_CHANNEL, null);
  await admin.invoke(CONNECTION_PROBE_CHANNEL, { endpoint: "tcp://127.0.0.1:9911" });
  await admin.invoke(CONNECTION_REGISTER_CHANNEL, { displayName: "Server B", endpoint: "tcp://127.0.0.1:9911" });
  await admin.invoke(CONNECTION_UPDATE_CHANNEL, {
    connectionId: "server-b",
    endpoint: "tcp://127.0.0.1:9912",
    state: "disabled",
  });
  await admin.invoke(CONNECTION_UNREGISTER_CHANNEL, { connectionId: "server-b" });
  await admin.invoke(REPO_REGISTER_CHANNEL, {
    repoId: "proxy-repo",
    mode: "remote-proxy",
    connectionId: "server-b",
  });
  await admin.invoke(REPO_UPDATE_CHANNEL, { repoId: "proxy-repo", state: "enabled", displayName: "Proxy" });
  await admin.invoke(REPO_UNREGISTER_CHANNEL, { repoId: "proxy-repo" });
  assert.equal(
    JSON.stringify(admin.calls, null, 0),
    JSON.stringify([
      { method: "daemon.status", params: {} },
      { method: "daemon.connection.probe", params: { endpoint: "tcp://127.0.0.1:9911" } },
      {
        method: "daemon.connection.register",
        params: { displayName: "Server B", endpoint: "tcp://127.0.0.1:9911" },
      },
      {
        method: "daemon.connection.update",
        params: { connectionId: "server-b", endpoint: "tcp://127.0.0.1:9912", state: "disabled" },
      },
      { method: "daemon.connection.unregister", params: { connectionId: "server-b" } },
      {
        method: "daemon.repo.register",
        params: { repoId: "proxy-repo", mode: "remote-proxy", connectionId: "server-b" },
      },
      { method: "daemon.repo.update", params: { repoId: "proxy-repo", displayName: "Proxy", state: "enabled" } },
      { method: "daemon.repo.unregister", params: { repoId: "proxy-repo" } },
    ]),
  );
});

test("admin IPC rejects unknown fields and malformed shapes at the entry", async () => {
  const admin = register();
  await assert.rejects(admin.invoke(CONNECTION_STATUS_CHANNEL, { extra: 1 }), /does not accept a payload/u);
  await assert.rejects(admin.invoke(CONNECTION_PROBE_CHANNEL, { endpoint: "" }), /endpoint must be/u);
  await assert.rejects(
    admin.invoke(CONNECTION_REGISTER_CHANNEL, { endpoint: "tcp://x:1", displayName: "x", rootDir: "/tmp" }),
    /does not accept field rootDir/u,
  );
  await assert.rejects(admin.invoke(CONNECTION_UPDATE_CHANNEL, { connectionId: "Bad_Id" }), /lowercase slug/u);
  await assert.rejects(admin.invoke(REPO_UPDATE_CHANNEL, { repoId: "ok-repo", mode: "weird" }), /mode/u);
  await assert.rejects(admin.invoke(REPO_REGISTER_CHANNEL, { rootDir: "relative/path" }), /absolute/u);
});

test("workspace inspect only reads local .harness presence and never touches the daemon", async () => {
  const admin = register();
  const withLedger = mkdtempSync(path.join(tmpdir(), "ha-admin-inspect-"));
  const withoutLedger = mkdtempSync(path.join(tmpdir(), "ha-admin-inspect-"));
  try {
    mkdirSync(path.join(withLedger, ".harness"));
    writeFileSync(path.join(withLedger, ".harness", "registry.json"), "{}");
    const present = (await admin.invoke(WORKSPACE_INSPECT_CHANNEL, { rootDir: withLedger })) as {
      hasWorkspace: boolean;
      suggestedRepoId: string;
    };
    assert.equal(present.hasWorkspace, true);
    const absent = (await admin.invoke(WORKSPACE_INSPECT_CHANNEL, { rootDir: withoutLedger })) as {
      hasWorkspace: boolean;
    };
    assert.equal(absent.hasWorkspace, false);
    assert.equal(admin.calls.length, 0);
  } finally {
    rmSync(withLedger, { recursive: true, force: true });
    rmSync(withoutLedger, { recursive: true, force: true });
  }
});

test("suggested repo id mirrors the daemon slug vocabulary", () => {
  assert.equal(suggestedRepoId("My_Project-2"), "my-project-2");
  assert.equal(suggestedRepoId("9lives"), "repo-9lives");
});
