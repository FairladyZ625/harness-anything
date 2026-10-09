// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { OidcSessionService, type OidcSessionPorts } from "../../daemon/src/oidc-session-service.ts";
import { registerOidcAuthIpc } from "../src/main/oidc-auth-ipc.ts";
import { OIDC_LOGIN_CHANNEL, OIDC_CANCEL_LOGIN_CHANNEL } from "../src/api/oidc-auth-contract.ts";

const authority = { url: "https://center.example.test", realm: "harness", clientId: "harness-node-fixture" };

/** Real service and IPC, loopback HTTP callback; only authority and provider I/O are controlled ports. */
function fixture(ports: Partial<OidcSessionPorts> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "gui-oidc-lifecycle-"));
  const urls: string[] = [];
  let navigation = Promise.withResolvers<string>();
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>();
  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    send: (_channel: string, page: { readonly url: string }) => {
      urls.push(page.url);
      navigation.resolve(page.url);
    },
  });
  const event = { sender, senderFrame: { url: "file:///renderer/index.html" } } as unknown as IpcMainInvokeEvent;
  const service = new OidcSessionService(root, {
    loginAuthority: async () => authority,
    fetch: (async (input, init) => {
      if (String(input).endsWith("/userinfo")) return Response.json({ sub: "fresh-person" });
      const form = init!.body as URLSearchParams;
      const url = new URL(urls.at(-1)!);
      assert.equal(form.get("redirect_uri"), url.searchParams.get("redirect_uri"));
      assert.equal(
        createHash("sha256").update(form.get("code_verifier")!).digest("base64url"),
        url.searchParams.get("code_challenge"),
      );
      return Response.json({
        access_token: "x.e30.x",
        refresh_token: "fixture-refresh",
        expires_in: 300,
        refresh_expires_in: 1800,
      });
    }) as typeof fetch,
    ...ports,
  });
  const begins: Promise<Record<string, unknown>>[] = [];
  const completes: Promise<Record<string, unknown>>[] = [];
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
        assert.equal(params.repoId, "remote-repo");
        if (params.operation === "login-begin") {
          const request = service.begin(String(params.redirectUri), "remote-repo");
          begins.push(request);
          return (await request) as never;
        }
        assert.equal(params.operation, "login-complete");
        const request = service.complete(String(params.code), String(params.state));
        completes.push(request);
        return (await request) as never;
      },
      openExternal: async () => assert.fail("must not open external browser"),
    },
  );
  return {
    root,
    service,
    sender,
    urls,
    begins,
    completes,
    start: () => {
      navigation = Promise.withResolvers<string>();
      const result = handlers.get(OIDC_LOGIN_CHANNEL)!(event, { repoId: "remote-repo" });
      // Attach rejection handling before the test deliberately interrupts it.
      const outcome = result.then(
        (reply) => reply,
        (error: unknown) => error,
      );
      return { result, outcome, navigation: navigation.promise };
    },
    cancel: () => handlers.get(OIDC_CANCEL_LOGIN_CHANNEL)!(event),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function callback(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  const redirect = new URL(url.searchParams.get("redirect_uri")!);
  redirect.search = new URLSearchParams({ code: "fixture-code", state: url.searchParams.get("state")! }).toString();
  assert.equal((await fetch(redirect)).status, 200);
}

for (const termination of ["cancel", "destroyed"] as const) {
  for (const late of ["success", "failure"] as const) {
    test(`real daemon: ${termination}, retry B, then authority A ${late} still completes B`, async () => {
      const deferred = Promise.withResolvers<typeof authority>();
      const entered = Promise.withResolvers<void>();
      let count = 0;
      const active = fixture({
        loginAuthority: async () => {
          if (++count === 1) {
            entered.resolve();
            return deferred.promise;
          }
          return authority;
        },
      });
      try {
        const first = active.start();
        await entered.promise;
        if (termination === "cancel") await active.cancel();
        else active.sender.emit("destroyed");
        const error = await first.outcome;
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Sign-in cancelled.");
        assert.equal(active.sender.listenerCount("destroyed"), 0);
        const second = active.start();
        const url = await second.navigation;
        const rejected = assert.rejects(
          active.begins[0]!,
          late === "success" ? { code: "oidc_login_superseded" } : /authority unavailable/u,
        );
        if (late === "success") deferred.resolve(authority);
        else deferred.reject(new Error("authority unavailable"));
        await rejected;
        assert.deepEqual(active.urls, [url]);
        await callback(url);
        assert.equal(((await second.result) as { authenticated: boolean }).authenticated, true);
        assert.equal((await active.service.status()).personId, "fresh-person");
        assert.equal(active.completes.length, 1);
      } finally {
        deferred.resolve(authority);
        await active.cancel();
        active.cleanup();
      }
    });
  }
}

for (const action of ["none", "retry", "logout"] as const) {
  test(`cancelling complete stops waiting, not a committed identity; subsequent action: ${action}`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const active = fixture({
      fetch: (async (input, init) => {
        if (String(input).endsWith("/revoke")) return new Response(null, { status: 204 });
        if (String(input).endsWith("/userinfo")) {
          const person = new Headers(init?.headers).get("authorization")!.split(".")[0]!.slice(7);
          return Response.json({ sub: person });
        }
        const person = ++calls === 1 ? "old-person" : "new-person";
        if (calls === 1) {
          entered.resolve();
          await release.promise;
        }
        return Response.json({
          access_token: `${person}.e30.x`,
          refresh_token: "fixture-refresh",
          expires_in: 300,
          refresh_expires_in: 1800,
        });
      }) as typeof fetch,
    });
    try {
      const first = active.start();
      const url = await first.navigation;
      await callback(url);
      await entered.promise;
      await active.cancel();
      const error = await first.outcome;
      assert.ok(error instanceof Error);
      assert.match(error.message, /already sent and may still complete/u);
      assert.equal(active.sender.listenerCount("destroyed"), 0);
      await assert.rejects(fetch(new URL(url).searchParams.get("redirect_uri")!));
      assert.equal((await active.service.status()).authenticated, false);
      if (action === "retry") {
        const second = active.start();
        await callback(await second.navigation);
        assert.equal(((await second.result) as { personId: string }).personId, "new-person");
      } else if (action === "logout") await active.service.logout();
      const completion =
        action === "none"
          ? active.completes[0]!
          : assert.rejects(active.completes[0]!, { code: "oidc_login_superseded" });
      release.resolve();
      await completion;
      const status = await active.service.status();
      if (action === "logout") assert.equal(status.authenticated, false);
      else assert.equal(status.personId, action === "none" ? "old-person" : "new-person");
    } finally {
      release.resolve();
      await active.cancel();
      active.cleanup();
    }
  });
}
