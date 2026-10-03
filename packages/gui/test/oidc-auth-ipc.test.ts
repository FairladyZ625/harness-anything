// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBindingStatusReply,
  requireSuccessfulAuthReply,
  systemBrowserLogin,
  registerOidcAuthIpc,
} from "../src/main/oidc-auth-ipc.ts";
import type { IpcMainInvokeEvent } from "electron";
import {
  OIDC_LOGIN_CHANNEL,
  OIDC_STATUS_CHANNEL,
  OIDC_LOGOUT_CHANNEL,
  OIDC_BOOTSTRAP_STATUS_CHANNEL,
  OIDC_BOOTSTRAP_ADMIN_CHANNEL,
  OIDC_BINDING_STATUS_CHANNEL,
} from "../src/api/oidc-auth-contract.ts";

test("a local repository keeps the original socket bootstrap status and a targeted administrator mutation is refused", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  const event = { sender: { id: 7 }, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
  let calls = 0;
  registerOidcAuthIpc(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    {
      isTrustedWebContentsId: (id) => id === 7,
      rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" },
    },
    {
      daemonRequest: async () => {
        calls++;
        return { ok: true, required: true };
      },
      openExternal: async () => undefined,
    },
  );
  assert.deepEqual(await handlers.get(OIDC_BOOTSTRAP_STATUS_CHANNEL)!(event, { repoId: "local-repo" }), {
    ok: true,
    required: true,
  });
  await assert.rejects(
    handlers.get(OIDC_BOOTSTRAP_ADMIN_CHANNEL)!(event, { repoId: "remote-repo" }),
    /original local socket/u,
  );
  assert.equal(calls, 1, "a targeted bootstrap mutation never reaches either daemon");
});

test("auth IPC pins login completion to its initial repository and scopes status/logout", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>(),
    calls: Record<string, unknown>[] = [];
  const event = { sender: { id: 7 }, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
  const target = { repoId: "server-a" };
  registerOidcAuthIpc(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    {
      isTrustedWebContentsId: (id) => id === 7,
      rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" },
    },
    {
      daemonRequest: async (params) => {
        calls.push(params);
        return params.operation === "login-begin"
          ? { authorizationUrl: `${String(params.redirectUri)}?code=code&state=state` }
          : { ok: true };
      },
      openExternal: async (url) => {
        target.repoId = "server-b";
        assert.equal((await fetch(url)).status, 200);
      },
    },
  );
  await handlers.get(OIDC_LOGIN_CHANNEL)!(event, target);
  assert.deepEqual(
    calls.map((call) => [call.operation, call.repoId]),
    [
      ["login-begin", "server-a"],
      ["login-complete", "server-a"],
    ],
  );
  await handlers.get(OIDC_STATUS_CHANNEL)!(event, { repoId: "server-b" });
  await handlers.get(OIDC_LOGOUT_CHANNEL)!(event, { repoId: "server-a" });
  assert.deepEqual(
    calls.slice(2).map((call) => [call.operation, call.repoId]),
    [
      ["session", "server-b"],
      ["logout", "server-a"],
    ],
  );
});

test("auth IPC rejects daemon failure receipts with their code and explanation", () => {
  assert.throws(
    () =>
      requireSuccessfulAuthReply({
        ok: false,
        code: "bootstrap_failed",
        rejectionExplanation: "fetch failed",
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "bootstrap_failed");
      assert.equal((error as Error).message, "bootstrap_failed: fetch failed");
      return true;
    },
  );
});

test("binding IPC projects an unconfigured receipt as an explicit state", () => {
  assert.deepEqual(
    normalizeBindingStatusReply({
      ok: false,
      code: "rbac_not_configured",
      rejectionExplanation: "Run ha bootstrap first.",
    }),
    { ok: true, configured: false },
  );
});

test("binding IPC forwards the selected edge and preserves center metadata and discovery errors", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  const event = { sender: { id: 7 }, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
  const binding = {
    source: "fleet-center",
    mode: "external",
    ready: true,
    url: "https://center.example",
    realm: "harness",
    clientId: "harness-node-edge",
  };
  let failed = false;
  registerOidcAuthIpc(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    {
      isTrustedWebContentsId: (id) => id === 7,
      rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" },
    },
    {
      daemonRequest: async (params) => {
        assert.deepEqual(params, { operation: "health", repoId: "edge" });
        return failed
          ? { ok: false, code: "oidc_listener_required", rejectionExplanation: "Center discovery refused." }
          : binding;
      },
      openExternal: async () => undefined,
    },
  );
  const read = () => handlers.get(OIDC_BINDING_STATUS_CHANNEL)!(event, { repoId: "edge" });
  assert.deepEqual(await read(), binding);
  failed = true;
  await assert.rejects(read(), { code: "oidc_listener_required" });
});

test("system-browser login opens only after the loopback callback is listening", async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await systemBrowserLogin({
    daemonRequest: async (params) => {
      calls.push(params);
      if (params.operation === "login-begin") {
        const redirectUri = String(params.redirectUri);
        return { authorizationUrl: `${redirectUri}?code=code-from-keycloak&state=state-from-keycloak` };
      }
      return { ok: true, authenticated: true, personId: "person-zeyu" };
    },
    openExternal: async (url) => {
      const response = await fetch(url);
      assert.equal(response.status, 200);
    },
  });
  assert.deepEqual(result, { ok: true, authenticated: true, personId: "person-zeyu" });
  assert.equal(calls[0]?.operation, "login-begin");
  assert.match(String(calls[0]?.redirectUri), /^http:\/\/127\.0\.0\.1:\d+\/oidc\/callback$/u);
  assert.deepEqual(calls[1], {
    operation: "login-complete",
    code: "code-from-keycloak",
    state: "state-from-keycloak",
  });
});
