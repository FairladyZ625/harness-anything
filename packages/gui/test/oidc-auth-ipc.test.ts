// harness-test-tier: fast
import { EventEmitter } from "node:events";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBindingStatusReply,
  requireSuccessfulAuthReply,
  embeddedBrowserLogin,
  registerOidcAuthIpc,
} from "../src/main/oidc-auth-ipc.ts";
import type { IpcMainInvokeEvent } from "electron";
import {
  OIDC_LOGIN_CHANNEL,
  OIDC_LOGIN_URL_CHANNEL,
  OIDC_CANCEL_LOGIN_CHANNEL,
  OIDC_STATUS_CHANNEL,
  OIDC_LOGOUT_CHANNEL,
  OIDC_BOOTSTRAP_STATUS_CHANNEL,
  OIDC_BOOTSTRAP_ADMIN_CHANNEL,
  OIDC_BINDING_STATUS_CHANNEL,
  OIDC_OPEN_CONSOLE_CHANNEL,
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
  const event = {
    sender: Object.assign(new EventEmitter(), {
      id: 7,
      send: async (channel: string, page: { url: string }) => {
        assert.equal(channel, OIDC_LOGIN_URL_CHANNEL);
        target.repoId = "server-b";
        assert.equal((await fetch(page.url)).status, 200);
      },
    }),
    senderFrame: { url: "file:///renderer/index.html" },
  } as IpcMainInvokeEvent;
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
      openExternal: async () => {
        assert.fail("login must remain embedded");
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
    ok: true,
    source: "fleet-center",
    mode: "external",
    ready: true,
    url: "https://center.example",
    realm: "harness",
    clientId: "harness-node-edge",
  };
  let failed = false;
  const opened: string[] = [];
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
      openExternal: async (url) => {
        opened.push(url);
      },
    },
  );
  const read = () => handlers.get(OIDC_BINDING_STATUS_CHANNEL)!(event, { repoId: "edge" });
  assert.deepEqual(await read(), binding);
  binding.ok = false;
  binding.ready = false;
  assert.deepEqual(await read(), binding);
  await handlers.get(OIDC_OPEN_CONSOLE_CHANNEL)!(event, { repoId: "edge" });
  assert.deepEqual(opened, ["https://center.example/admin/harness/console/"]);
  failed = true;
  await assert.rejects(read(), { code: "oidc_listener_required" });
  await assert.rejects(handlers.get(OIDC_OPEN_CONSOLE_CHANNEL)!(event, { repoId: "edge" }), {
    code: "oidc_listener_required",
  });
});

test("embedded-browser login opens only after the loopback callback is listening", async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await embeddedBrowserLogin({
    daemonRequest: async (params) => {
      calls.push(params);
      if (params.operation === "login-begin") {
        const redirectUri = String(params.redirectUri);
        return { authorizationUrl: `${redirectUri}?code=code-from-keycloak&state=state-from-keycloak` };
      }
      return { ok: true, authenticated: true, personId: "person-zeyu" };
    },
    signal: new AbortController().signal,
    openBrowser: async (page) => {
      const response = await fetch(page.url);
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

test("cancel during begin never opens a page or completes; a later login can succeed", async () => {
  const controller = new AbortController();
  const operations: unknown[] = [];
  await assert.rejects(
    embeddedBrowserLogin({
      signal: controller.signal,
      daemonRequest: async (params) => {
        operations.push(params.operation);
        controller.abort(new Error("cancelled during begin"));
        return { authorizationUrl: "https://example.com" };
      },
      openBrowser: () => assert.fail("cancelled login opened a page"),
    }),
    /cancelled during begin/u,
  );
  assert.deepEqual(operations, ["login-begin"]);
});

test("cancel after navigation closes the callback listener without exchanging a code", async () => {
  const controller = new AbortController();
  let redirect = "";
  const operations: unknown[] = [];
  await assert.rejects(
    embeddedBrowserLogin({
      signal: controller.signal,
      daemonRequest: async (params) => {
        operations.push(params.operation);
        redirect = String(params.redirectUri);
        return { authorizationUrl: "https://example.com" };
      },
      openBrowser: () => controller.abort(),
    }),
    /cancelled/u,
  );
  assert.deepEqual(operations, ["login-begin"]);
  await assert.rejects(fetch(redirect));
});

test("incomplete and provider-error callbacks end login without completing", async () => {
  for (const query of ["?state=only-state", "?error=access_denied&state=state"]) {
    await assert.rejects(
      embeddedBrowserLogin({
        signal: new AbortController().signal,
        daemonRequest: async (params) => {
          assert.equal(params.operation, "login-begin");
          return { authorizationUrl: `${String(params.redirectUri)}${query}` };
        },
        openBrowser: async (page) => {
          assert.equal((await fetch(page.url)).status, 400);
        },
      }),
      /omitted code or state/u,
    );
  }
});

test("guest senders cannot start or cancel the trusted window login", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  registerOidcAuthIpc(
    {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    {
      isTrustedWebContentsId: (id) => id === 7,
      rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" },
    },
    { daemonRequest: async () => assert.fail("guest reached daemon"), openExternal: async () => undefined },
  );
  const guest = { sender: { id: 8 }, senderFrame: { url: "https://identity.example" } } as IpcMainInvokeEvent;
  await assert.rejects(handlers.get(OIDC_LOGIN_CHANNEL)!(guest));
  await assert.rejects(handlers.get(OIDC_CANCEL_LOGIN_CHANNEL)!(guest));
});

for (const termination of ["cancel", "destroyed"] as const) {
  test(`${termination} releases the window's login slot and permits a fresh attempt`, async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
    let opened!: (url: string) => void;
    let navigation = new Promise<string>((resolve) => {
      opened = resolve;
    });
    const sender = Object.assign(new EventEmitter(), {
      id: 7,
      send: (_channel: string, page: { url: string }) => opened(page.url),
    });
    const event = { sender, senderFrame: { url: "file:///renderer/index.html" } } as unknown as IpcMainInvokeEvent;
    registerOidcAuthIpc(
      {
        handle: (name, handler) => {
          handlers.set(name, handler);
        },
      },
      {
        isTrustedWebContentsId: (id) => id === 7 || id === 9,
        rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" },
      },
      {
        daemonRequest: async (params) =>
          params.operation === "login-begin"
            ? { authorizationUrl: `${String(params.redirectUri)}?code=code&state=state` }
            : { ok: true },
        openExternal: async () => assert.fail("login must remain embedded"),
      },
    );
    const pending = handlers.get(OIDC_LOGIN_CHANNEL)!(event);
    const rejected = assert.rejects(pending, /cancelled/u);
    const url = await navigation;
    await assert.rejects(handlers.get(OIDC_LOGIN_CHANNEL)!(event), /already in progress/u);
    await handlers.get(OIDC_CANCEL_LOGIN_CHANNEL)!({ ...event, sender: { id: 9 } } as IpcMainInvokeEvent);
    if (termination === "cancel") await handlers.get(OIDC_CANCEL_LOGIN_CHANNEL)!(event);
    else sender.emit("destroyed");
    await rejected;
    await assert.rejects(fetch(url));
    assert.equal(sender.listenerCount("destroyed"), 0);
    navigation = new Promise<string>((resolve) => {
      opened = resolve;
    });
    const retry = handlers.get(OIDC_LOGIN_CHANNEL)!(event);
    assert.equal((await fetch(await navigation)).status, 200);
    assert.deepEqual(await retry, { ok: true });
  });
}

for (const termination of ["cancel", "destroyed"] as const) {
  for (const lateReply of ["resolve", "reject"] as const) {
    test(`${termination} ends pending begin and isolates its late ${lateReply} from a retry`, async () => {
      const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
      const begin = Promise.withResolvers<Record<string, string>>();
      const started = Promise.withResolvers<string>();
      const navigation = Promise.withResolvers<string>();
      const urls: string[] = [];
      const operations: unknown[] = [];
      const sender = Object.assign(new EventEmitter(), {
        id: 7,
        send: (_channel: string, page: { url: string }) => {
          urls.push(page.url);
          navigation.resolve(page.url);
        },
      });
      const event = { sender, senderFrame: { url: "file:///renderer/index.html" } } as unknown as IpcMainInvokeEvent;
      registerOidcAuthIpc(
        {
          handle: (name, handler) => {
            handlers.set(name, handler);
          },
        },
        {
          isTrustedWebContentsId: (id) => id === 7,
          rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" },
        },
        {
          daemonRequest: async (params) => {
            operations.push(params.operation);
            assert.equal(params.repoId, "remote-repo");
            if (params.operation === "login-begin") {
              if (operations.length === 1) {
                started.resolve(String(params.redirectUri));
                return begin.promise;
              }
              return { authorizationUrl: `${String(params.redirectUri)}?code=fresh&state=fresh-state` };
            }
            assert.equal(params.code, "fresh");
            assert.equal(params.state, "fresh-state");
            return { ok: true };
          },
          openExternal: async () => assert.fail("login must remain embedded"),
        },
      );
      const pending = handlers.get(OIDC_LOGIN_CHANNEL)!(event, { repoId: "remote-repo" });
      const outcome = pending.then(
        () => "resolved",
        (error: Error) => error.message,
      );
      const redirect = await started.promise;
      try {
        if (termination === "cancel") await handlers.get(OIDC_CANCEL_LOGIN_CHANNEL)!(event);
        else sender.emit("destroyed");
        // One event-loop turn is a scheduling barrier, not a wall-clock delay.
        assert.equal(
          await Promise.race([outcome, new Promise<string>((resolve) => setImmediate(() => resolve("pending")))]),
          "Sign-in cancelled.",
        );
        await assert.rejects(fetch(redirect));
        assert.equal(sender.listenerCount("destroyed"), 0);
        assert.deepEqual(urls, []);
        const retry = handlers.get(OIDC_LOGIN_CHANNEL)!(event, { repoId: "remote-repo" });
        const url = await navigation.promise;
        if (lateReply === "resolve") begin.resolve({ authorizationUrl: "https://stale.example/login" });
        else begin.reject(new Error("late begin failure"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(urls, [url]);
        assert.deepEqual(operations, ["login-begin", "login-begin"]);
        await assert.rejects(handlers.get(OIDC_LOGIN_CHANNEL)!(event), /already in progress/u);
        assert.equal((await fetch(url)).status, 200);
        assert.deepEqual(await retry, { ok: true });
        assert.deepEqual(operations, ["login-begin", "login-begin", "login-complete"]);
        assert.equal(sender.listenerCount("destroyed"), 0);
      } finally {
        begin.resolve({ authorizationUrl: "https://stale.example/login" });
        await handlers.get(OIDC_CANCEL_LOGIN_CHANNEL)!(event);
        await outcome;
      }
    });
  }
}

const listenerAuthorizationUrl = "https://10.211.55.2:18544/realms/harness/protocol/openid-connect/auth";

/** What the shell's login-webview port was asked, and what it answered. */
interface LoginWebviewPortTrace {
  readonly inputs: {
    readonly authorizationUrl: string;
    readonly callbackOrigin: string;
    readonly listenerReply: unknown;
  }[];
  readonly partitionToken: string | null;
  released: number;
}

function loginWebviewPort(trace: LoginWebviewPortTrace) {
  return (input: {
    readonly authorizationUrl: string;
    readonly callbackOrigin: string;
    readonly listenerReply: unknown;
  }): { readonly partitionToken: string; readonly release: () => void } | null => {
    trace.inputs.push(input);
    if (trace.partitionToken === null) return null;
    return { partitionToken: trace.partitionToken, release: () => void trace.released++ };
  };
}

/** A trusted-sender window signing in while the shell grants (or refuses) an isolated login webview. */
async function signInWithWebview(partitionToken: string | null): Promise<{
  readonly trace: LoginWebviewPortTrace;
  readonly outcome: Promise<unknown>;
  readonly cancel: () => Promise<unknown>;
  readonly opened: unknown[];
  readonly redirectPort: () => number;
}> {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  const trace: LoginWebviewPortTrace = { inputs: [], partitionToken, released: 0 },
    opened: unknown[] = [],
    sender = Object.assign(new EventEmitter(), {
      id: 7,
      send: (_channel: string, page: unknown) => {
        opened.push(page);
        // The provider's redirect back to the loopback callback, as the real Keycloak page would.
        void fetch(`http://127.0.0.1:${redirectPort}/oidc/callback?code=code&state=state`).catch(() => undefined);
      },
    }),
    event = { sender, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
  let redirectPort = 0;
  registerOidcAuthIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    { isTrustedWebContentsId: (id) => id === 7, rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" } },
    {
      daemonRequest: async (params) => {
        if (params.operation === "login-begin") {
          redirectPort = Number(new URL(String(params.redirectUri)).port);
          return { authorizationUrl: listenerAuthorizationUrl };
        }
        if (params.operation === "listener")
          return {
            ok: true,
            command: "rbac-listener",
            listener: {
              address: "10.211.55.2",
              hostname: "10.211.55.2",
              port: 18544,
              certificateFile: path.join(import.meta.dirname, "fixtures", "login-listener-leaf.pem"),
              certificateKeyFile: "/fixtures/unused.key",
            },
            version: "fixture",
          };
        return { ok: true, authenticated: true, personId: "person-zeyu" };
      },
      openExternal: async () => assert.fail("login must remain embedded"),
      openLoginWebview: loginWebviewPort(trace),
    },
  );
  const outcome = handlers.get(OIDC_LOGIN_CHANNEL)!(event);
  return {
    trace,
    outcome,
    opened,
    cancel: () => handlers.get(OIDC_CANCEL_LOGIN_CHANNEL)!(event),
    redirectPort: () => redirectPort,
  };
}

test("a listener-backed sign-in opens its page in the granted login webview and releases it when it settles", async () => {
  const login = await signInWithWebview("grant-token-1");
  assert.deepEqual(await login.outcome, { ok: true, authenticated: true, personId: "person-zeyu" });
  assert.deepEqual(login.opened, [{ url: listenerAuthorizationUrl, partitionToken: "grant-token-1" }]);
  // The port sees the authorization URL, the listener state, and the loopback callback origin the
  // grant must also allow — everything it needs to pin origin and certificate before the page navigates.
  assert.equal(login.trace.inputs.length, 1);
  assert.equal(login.trace.inputs[0]?.authorizationUrl, listenerAuthorizationUrl);
  assert.equal(login.trace.inputs[0]?.callbackOrigin, `http://127.0.0.1:${login.redirectPort()}`);
  assert.equal((login.trace.inputs[0]?.listenerReply as { listener?: { port?: number } })?.listener?.port, 18544);
  assert.equal(login.trace.released, 1, "the grant is released once the sign-in settles");
});

test("a sign-in the shell does not grant renders the ordinary embedded page", async () => {
  const login = await signInWithWebview(null);
  assert.deepEqual(await login.outcome, { ok: true, authenticated: true, personId: "person-zeyu" });
  assert.deepEqual(login.opened, [{ url: listenerAuthorizationUrl }]);
  assert.equal(login.trace.released, 0, "nothing was granted, so nothing is released");
});

test("cancelling a listener-backed sign-in releases its login webview grant", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  const trace: LoginWebviewPortTrace = { inputs: [], partitionToken: "grant-token-9", released: 0 },
    sender = Object.assign(new EventEmitter(), { id: 7, send: () => undefined }),
    event = { sender, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
  let resolveBegin!: (reply: Record<string, unknown>) => void;
  registerOidcAuthIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    { isTrustedWebContentsId: (id) => id === 7, rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" } },
    {
      daemonRequest: async (params) => {
        if (params.operation === "login-begin") return new Promise((resolve) => (resolveBegin = resolve));
        if (params.operation === "listener")
          return {
            ok: true,
            command: "rbac-listener",
            listener: {
              address: "10.211.55.2",
              hostname: "10.211.55.2",
              port: 18544,
              certificateFile: path.join(import.meta.dirname, "fixtures", "login-listener-leaf.pem"),
              certificateKeyFile: "/fixtures/unused.key",
            },
            version: "fixture",
          };
        return { ok: true };
      },
      openExternal: async () => assert.fail("login must remain embedded"),
      openLoginWebview: loginWebviewPort(trace),
    },
  );
  const outcome = handlers.get(OIDC_LOGIN_CHANNEL)!(event);
  // One event-loop turn is a scheduling barrier: the login reaches its pending begin.
  await new Promise<void>((resolve) => setImmediate(resolve));
  resolveBegin({ authorizationUrl: listenerAuthorizationUrl });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(trace.inputs.length, 1, "the grant is asked for before the page can navigate");
  await handlers.get(OIDC_CANCEL_LOGIN_CHANNEL)!(event);
  await assert.rejects(outcome, /cancelled/u);
  assert.equal(trace.released, 1, "cancelling releases the grant");
  assert.equal(sender.listenerCount("destroyed"), 0);
});

test("device approval resolves the current person's request and releases its embedded page on close", async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  const trace: LoginWebviewPortTrace = { inputs: [], partitionToken: "device-grant", released: 0 };
  const opened = Promise.withResolvers<unknown>();
  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    send: (_channel: string, page: unknown) => opened.resolve(page),
  });
  const event = { sender, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
  const url = "https://center.example/realms/harness/device?user_code=AAAA-BBBB";
  registerOidcAuthIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    { isTrustedWebContentsId: (id) => id === 7, rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" } },
    {
      daemonRequest: async (params) => {
        assert.deepEqual(params, { operation: "device-approval", code: "AAAA-BBBB" });
        return { ok: true, authorizationUrl: url, listener: null };
      },
      openExternal: async () => assert.fail("device approval must remain embedded"),
      openLoginWebview: loginWebviewPort(trace),
    },
  );
  const result = handlers.get(OIDC_LOGIN_CHANNEL)!(event, { userCode: "AAAA-BBBB" });
  assert.deepEqual(await opened.promise, { url, partitionToken: "device-grant" });
  assert.equal(trace.inputs[0]?.callbackOrigin, "https://center.example");
  await handlers.get(OIDC_CANCEL_LOGIN_CHANNEL)!(event);
  assert.deepEqual(await result, { ok: true });
  assert.equal(trace.released, 1);
  assert.equal(sender.listenerCount("destroyed"), 0);
});
