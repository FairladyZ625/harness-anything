// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";
import { OidcSessionService, type OidcSessionPorts, type OidcLoginAuthority } from "../src/oidc-session-service.ts";
import { evaluateKeycloakPerson } from "../src/repo-cell-authorization.ts";
import { localDefaultBinding } from "../src/daemon-host-binding.ts";
import type { DaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

const sessionLifetimeSeconds = 21_600,
  accessTokenSeconds = 60;

/** A Keycloak token endpoint whose refresh tokens slide with use and lapse after `lifetimeSeconds` idle. */
function fixture(start: number, ports: Partial<OidcSessionPorts>, t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-oidc-session-")),
    requests: Request[] = [],
    clock = { now: start },
    keycloak = { lifetimeSeconds: sessionLifetimeSeconds, refreshes: 0, issued: 0, reachable: true, revoked: false },
    live = { refreshToken: "", lapsesAt: 0 },
    issue = () => {
      const serial = ++keycloak.issued,
        claims = { realm_access: { roles: ["access-admin"] }, serial };
      live.refreshToken = `refresh-${serial}`;
      live.lapsesAt = clock.now + keycloak.lifetimeSeconds * 1_000;
      return Response.json({
        access_token: `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`,
        refresh_token: live.refreshToken,
        expires_in: accessTokenSeconds,
        refresh_expires_in: keycloak.lifetimeSeconds,
      });
    };
  // Register cleanup with the test lifecycle so cancellation releases the directory too.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "rbac"), { recursive: true });
  writeFileSync(
    path.join(root, "rbac", "config.json"),
    JSON.stringify({ url: "http://127.0.0.1:8080", realm: "harness" }),
  );
  let nonce = 0;
  return {
    root,
    requests,
    clock,
    keycloak,
    service: new OidcSessionService(root, {
      now: () => clock.now,
      randomBytes: ((size: number) => Buffer.alloc(size, ++nonce)) as typeof import("node:crypto").randomBytes,
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        if (!String(input).endsWith("/token"))
          return Response.json({ sub: "keycloak-subject", harness_person_id: "person-zeyu" });
        const form = init?.body as URLSearchParams;
        if (form.get("grant_type") !== "refresh_token") return issue();
        keycloak.refreshes += 1;
        if (!keycloak.reachable) throw new TypeError("fetch failed");
        if (keycloak.revoked || form.get("refresh_token") !== live.refreshToken || live.lapsesAt <= clock.now)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return issue();
      }) as typeof fetch,
      ...ports,
    }),
  };
}

async function signIn(active: ReturnType<typeof fixture>): Promise<Record<string, unknown>> {
  const begun = await active.service.begin("http://127.0.0.1:43123/callback");
  return active.service.complete("authorization-code", String(begun.state));
}

const serialOf = (accessToken: string | undefined): unknown =>
  JSON.parse(Buffer.from(accessToken!.split(".")[1]!, "base64url").toString("utf8")).serial;

test("PKCE login validates state, keeps tokens daemon-side, and binds the Keycloak person", async (t) => {
  const { service, requests, root } = fixture(1_000, {}, t),
    redirectUri = "http://127.0.0.1:43123/callback",
    begun = await service.begin(redirectUri),
    authorizationUrl = new URL(String(begun.authorizationUrl));
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), redirectUri);
  const completed = await service.complete("authorization-code", String(begun.state));
  // The session lapses one session lifetime after its last use, not when the access token does.
  assert.deepEqual(completed, {
    ok: true,
    authenticated: true,
    personId: "person-zeyu",
    expiresAt: 1_000 + sessionLifetimeSeconds * 1_000,
  });
  assert.match(await requests[0]!.text(), /code_verifier=/u);
  const bound = (await service.bind({ transportKind: "unix-socket" })).oidcPrincipal;
  assert.deepEqual(bound && { ...bound, accessToken: "<redacted>" }, {
    personId: "person-zeyu",
    subject: "keycloak-subject",
    expiresAt: 61_000,
    accessToken: "<redacted>",
    authority: { url: "http://127.0.0.1:8080", realm: "harness", clientId: "harness-center" },
  });
  assert.equal((await service.requireRole("access-admin")).personId, "person-zeyu");
  assert.equal("accessToken" in completed, false);
  assert.equal("refreshToken" in completed, false);
  // The refresh token stays in the daemon's own session file, readable by the daemon's user only.
  assert.equal(statSync(path.join(root, "rbac", "oidc-session.json")).mode & 0o777, 0o600);
});

test("under a listener the browser signs in at its hostname while the daemon keeps to loopback", async (t) => {
  const { service, requests, root } = fixture(1_000, {}, t);
  writeFileSync(
    path.join(root, "rbac", "config.json"),
    JSON.stringify({
      url: "http://127.0.0.1:8080",
      realm: "harness",
      listener: { hostname: "center.example.test", port: 8443 },
    }),
  );
  const begun = await service.begin("http://127.0.0.1:43123/callback"),
    authorizationUrl = new URL(String(begun.authorizationUrl));
  assert.equal(authorizationUrl.origin, "https://center.example.test:8443");
  assert.equal(authorizationUrl.pathname, "/realms/harness/protocol/openid-connect/auth");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:43123/callback");
  await service.complete("authorization-code", String(begun.state));
  assert.deepEqual([...new Set(requests.map((request) => new URL(request.url).origin))], ["http://127.0.0.1:8080"]);
});

test("a session in use outlives its access token without signing in again", async (t) => {
  const active = fixture(1_000, {}, t);
  await signIn(active);
  const first = (await active.service.bind({ transportKind: "unix-socket" })).oidcPrincipal;
  assert.equal(serialOf(first?.accessToken), 1);
  // Three access token lifetimes of continued use: every use past the token's life gets a fresh one.
  for (const cycle of [1, 2, 3]) {
    active.clock.now += (accessTokenSeconds + 5) * 1_000;
    assert.deepEqual(await active.service.status(), {
      ok: true,
      authenticated: true,
      deviceLoginRequests: [],
      personId: "person-zeyu",
      expiresAt: active.clock.now + sessionLifetimeSeconds * 1_000,
    });
    const bound = (await active.service.bind({ transportKind: "unix-socket" })).oidcPrincipal;
    assert.equal(serialOf(bound?.accessToken), cycle + 1);
    assert.equal(bound!.expiresAt > active.clock.now, true);
    assert.equal((await active.service.requireRole("access-admin")).personId, "person-zeyu");
  }
  assert.equal(active.keycloak.refreshes, 3);
});

test("concurrent uses of a session whose access token lapsed renew it once", async (t) => {
  const active = fixture(1_000, {}, t);
  await signIn(active);
  active.clock.now += (accessTokenSeconds + 5) * 1_000;
  const [status, bound, session] = await Promise.all([
    active.service.status(),
    active.service.bind({ transportKind: "unix-socket" }),
    active.service.requireRole("access-admin"),
  ]);
  assert.equal(status.authenticated, true);
  assert.equal(serialOf(bound.oidcPrincipal?.accessToken), 2);
  assert.equal(session.personId, "person-zeyu");
  assert.equal(active.keycloak.refreshes, 1);
});

test("a session idle past the session lifetime is signed out, and not retried", async (t) => {
  const active = fixture(1_000, {}, t);
  await signIn(active);
  // Just inside the lifetime the session still renews; the renewal slides the lifetime forward.
  active.clock.now += sessionLifetimeSeconds * 1_000 - 1;
  assert.equal((await active.service.status()).authenticated, true);
  active.clock.now += sessionLifetimeSeconds * 1_000;
  assert.deepEqual(await active.service.status(), { ok: true, authenticated: false });
  assert.equal(managedRbacSessionStore(active.root).read(), undefined);
  assert.equal((await active.service.bind({ transportKind: "unix-socket" })).oidcPrincipal, undefined);
  await assert.rejects(active.service.requireRole("access-admin"), { code: "authentication_required" });
  assert.equal(active.keycloak.refreshes, 2);
});

test("a session whose refresh token Keycloak revoked is signed out instead of let through", async (t) => {
  const active = fixture(1_000, {}, t);
  await signIn(active);
  active.keycloak.revoked = true;
  // The access token it already holds stays usable until it lapses; the renewal is what Keycloak refuses.
  active.clock.now += (accessTokenSeconds + 5) * 1_000;
  assert.equal((await active.service.bind({ transportKind: "unix-socket" })).oidcPrincipal, undefined);
  assert.deepEqual(await active.service.status(), { ok: true, authenticated: false });
  await assert.rejects(active.service.requireRole("access-admin"), { code: "authentication_required" });
  assert.equal(active.keycloak.refreshes, 1);
});

test("an unreachable Keycloak fails the renewal without ending the session", async (t) => {
  const active = fixture(1_000, {}, t);
  await signIn(active);
  active.clock.now += (accessTokenSeconds + 5) * 1_000;
  active.keycloak.reachable = false;
  await assert.rejects(active.service.status(), { code: "oidc_session_unavailable" });
  await assert.rejects(active.service.requireRole("access-admin"), { code: "oidc_session_unavailable" });
  // A request is bound without a principal, so it fails closed while lifecycle operations still run.
  assert.equal((await active.service.bind({ transportKind: "unix-socket" })).oidcPrincipal, undefined);
  active.keycloak.reachable = true;
  assert.equal((await active.service.status()).authenticated, true);
});

test("a lowered session lifetime applies to a signed-in session at its next renewal", async (t) => {
  const active = fixture(1_000, {}, t);
  await signIn(active);
  active.keycloak.lifetimeSeconds = 300;
  active.clock.now += (accessTokenSeconds + 5) * 1_000;
  assert.equal((await active.service.status()).expiresAt, active.clock.now + 300_000);
});

test("a connection that outlives the access token carries the session as it is on each request", async (t) => {
  const active = fixture(1_000, {}, t),
    server = createJsonRpcProtocolServer({
      host: {
        manageRbac: async (_request: unknown, auth: DaemonAuthenticationContext) => ({
          ok: true,
          serial: auth.oidcPrincipal ? serialOf(auth.oidcPrincipal.accessToken) : null,
        }),
      } as unknown as DaemonHost,
      build: { buildId: "test", commit: null } as never,
      authContext: { transportKind: "unix-socket" },
      sessionPrincipal: async () => (await active.service.bind({ transportKind: "unix-socket" })).oidcPrincipal,
      emit: async () => undefined,
    }),
    serial = async () =>
      (
        (await server.handle({
          jsonrpc: "2.0",
          id: 2,
          method: "daemon.rbac.manage",
          params: { operation: "health" },
        })) as {
          result: { serial: unknown };
        }
      ).result.serial;
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  assert.equal(await serial(), null);
  await signIn(active);
  assert.equal(await serial(), 1);
  active.clock.now += (accessTokenSeconds + 5) * 1_000;
  assert.equal(await serial(), 2);
  active.keycloak.revoked = true;
  active.clock.now += (accessTokenSeconds + 5) * 1_000;
  assert.equal(await serial(), null);
});

test("mismatched callback state is rejected and logout ends the session", async (t) => {
  const active = fixture(1_000, {}, t);
  await active.service.begin("http://localhost:1234/callback");
  await assert.rejects(active.service.complete("code", "wrong-state"), { code: "oidc_state_invalid" });

  const signedIn = fixture(100_000, {}, t);
  await signIn(signedIn);
  assert.equal((await signedIn.service.status()).authenticated, true);
  assert.deepEqual(await signedIn.service.logout(), { ok: true, authenticated: false });
  assert.equal((await signedIn.service.bind({ transportKind: "unix-socket" })).oidcPrincipal, undefined);
});

test("login rejects non-loopback callbacks", async (t) => {
  const { service } = fixture(1_000, {}, t);
  await assert.rejects(() => service.begin("https://example.com/callback"), { code: "oidc_redirect_invalid" });
});

test("repository actions fail closed without a live OIDC principal", () => {
  assert.throws(() => localDefaultBinding({ transportKind: "unix-socket" }), { code: "authentication_required" });
  assert.throws(
    () =>
      localDefaultBinding({
        transportKind: "unix-socket",
        oidcPrincipal: {
          personId: "person-expired",
          subject: "subject",
          expiresAt: Date.now() - 1,
          accessToken: "expired",
          authority: { url: "http://127.0.0.1:8080", realm: "harness", clientId: "harness-center" },
        },
      }),
    { code: "authentication_required" },
  );
});

test("first administrator closes after one success and access-admin can invite", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-oidc-admin-")),
    rbac = path.join(root, "rbac"),
    users: string[] = [];
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(rbac, { recursive: true });
  writeFileSync(path.join(rbac, "config.json"), JSON.stringify({ url: "http://127.0.0.1:8080", realm: "harness" }));
  writeFileSync(path.join(rbac, "center-client-secret"), "fixture-secret");
  const jwt = `x.${Buffer.from(JSON.stringify({ realm_access: { roles: ["access-admin"] } })).toString("base64url")}.x`,
    service = new OidcSessionService(root, {
      fetch: (async (input, init) => {
        const url = String(input),
          method = init?.method ?? "GET";
        if (url.endsWith("/protocol/openid-connect/token")) {
          const body = String(init?.body ?? "");
          return body.includes("authorization_code")
            ? Response.json({ access_token: jwt, refresh_token: "refresh", expires_in: 60, refresh_expires_in: 21_600 })
            : Response.json({ access_token: "center-token" });
        }
        if (url.endsWith("/protocol/openid-connect/userinfo"))
          return Response.json({ sub: "owner-subject", harness_person_id: "person-owner" });
        if (url.endsWith("/roles/access-admin/users")) return Response.json(users.map((id) => ({ id })));
        if (url.endsWith("/roles/access-admin") && method === "GET")
          return users.length === 0
            ? new Response(null, { status: 404 })
            : Response.json({ id: "role-access-admin", name: "access-admin" });
        if (url.endsWith("/roles") && method === "POST") return new Response(null, { status: 201 });
        if (url.endsWith("/users") && method === "POST") {
          const id = `user-${users.length + 1}`;
          users.push(id);
          return new Response(null, { status: 201, headers: { location: `${url}/${id}` } });
        }
        if (url.includes("/role-mappings/realm")) return new Response(null, { status: 204 });
        if (url.includes("username=harness-bootstrap")) return Response.json([]);
        if (url.endsWith("/execute-actions-email")) return new Response(null, { status: 204 });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
  const admin = {
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "fixture-password",
    personId: "person-owner",
  };
  assert.deepEqual(await service.bootstrapAdmin(admin), { ok: true, created: true, personId: "person-owner" });
  await assert.rejects(service.bootstrapAdmin(admin), { code: "bootstrap_admin_closed" });
  const login = await service.begin("http://127.0.0.1:1234/callback");
  await service.complete("code", String(login.state));
  assert.deepEqual(
    await service.invite({
      username: "alice",
      email: "alice@example.invalid",
      displayName: "Alice",
      personId: "person-alice",
    }),
    { ok: true, invited: true, personId: "person-alice" },
  );
});

const remoteAuthority: OidcLoginAuthority = {
  url: "https://center.example.test",
  realm: "harness",
  clientId: "harness-node-fixture",
};

for (const late of ["success", "failure"] as const) {
  test(`late authority ${late} cannot replace a newer PKCE attempt`, async (t) => {
    const authority = Promise.withResolvers<OidcLoginAuthority>();
    let calls = 0;
    const active = fixture(
      1_000,
      {
        loginAuthority: async () => (++calls === 1 ? authority.promise : remoteAuthority),
      },
      t,
    );
    const first = active.service.begin("http://127.0.0.1:1111/callback", "old-target");
    const rejected = assert.rejects(
      first,
      late === "success" ? { code: "oidc_login_superseded" } : /authority unavailable/u,
    );
    const fresh = await active.service.begin("http://127.0.0.1:2222/callback", "new-target");
    if (late === "success") authority.resolve(remoteAuthority);
    else authority.reject(new Error("authority unavailable"));
    await rejected;
    assert.equal((await active.service.complete("fresh-code", String(fresh.state))).authenticated, true);
    const form = new URLSearchParams(await active.requests[0]!.text());
    assert.equal(form.get("redirect_uri"), "http://127.0.0.1:2222/callback");
    assert.equal(form.get("code"), "fresh-code");
    assert.equal(JSON.parse(managedRbacSessionStore(active.root).read()!).loginTarget, "new-target");
  });
}

test("an old or unknown callback does not consume the current attempt", async (t) => {
  const { service, requests } = fixture(1_000, {}, t);
  const old = await service.begin("http://localhost:1111/callback");
  const fresh = await service.begin("http://localhost:2222/callback");
  for (const state of [String(old.state), "unknown-state"]) {
    await assert.rejects(service.complete("old-code", state), { code: "oidc_state_invalid" });
  }
  assert.equal(requests.length, 0);
  assert.equal((await service.complete("fresh-code", String(fresh.state))).authenticated, true);
  await assert.rejects(service.complete("replay", String(fresh.state)), { code: "oidc_state_invalid" });
});

for (const stage of ["token", "userinfo"] as const) {
  test(`an old complete delayed at ${stage} cannot overwrite a newer identity`, async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const active = fixture(
      1_000,
      {
        fetch: (async (input, init) => {
          const token = String(input).endsWith("/token");
          const code = token
            ? (init!.body as URLSearchParams).get("code")
            : JSON.parse(
                Buffer.from(new Headers(init?.headers).get("authorization")!.split(".")[1]!, "base64url").toString(),
              ).person;
          if (code === "old" && (stage === "token") === token) {
            entered.resolve();
            await release.promise;
          }
          return Response.json(
            token
              ? {
                  access_token: `x.${Buffer.from(JSON.stringify({ person: code })).toString("base64url")}.x`,
                  refresh_token: "fixture-refresh",
                  expires_in: 300,
                  refresh_expires_in: 1800,
                }
              : { sub: code, harness_person_id: code },
          );
        }) as typeof fetch,
      },
      t,
    );
    const first = await active.service.begin("http://localhost:1111/callback");
    const completed = active.service.complete("old", String(first.state));
    const rejected = assert.rejects(completed, { code: "oidc_login_superseded" });
    await entered.promise;
    const fresh = await active.service.begin("http://localhost:2222/callback");
    assert.equal((await active.service.complete("fresh", String(fresh.state))).personId, "fresh");
    release.resolve();
    await rejected;
    assert.equal((await active.service.status()).personId, "fresh");
  });
}

test("logout invalidates authority discovery before it can publish a pending login", async (t) => {
  const authority = Promise.withResolvers<OidcLoginAuthority>();
  const { service } = fixture(1_000, { loginAuthority: () => authority.promise }, t);
  const begun = service.begin("http://localhost:1111/callback", "remote-target");
  const rejected = assert.rejects(begun, { code: "oidc_login_superseded" });
  await service.logout();
  authority.resolve(remoteAuthority);
  await rejected;
  assert.equal((await service.status()).authenticated, false);
});

test("independent daemons reject each other's state without consuming their own login", async (t) => {
  const first = fixture(
    1_000,
    {
      randomBytes: ((size: number) => Buffer.alloc(size, 10)) as OidcSessionPorts["randomBytes"],
    },
    t,
  );
  const second = fixture(
    1_000,
    {
      randomBytes: ((size: number) => Buffer.alloc(size, 20)) as OidcSessionPorts["randomBytes"],
    },
    t,
  );
  const a = await first.service.begin("http://localhost:1111/callback");
  const b = await second.service.begin("http://localhost:2222/callback");
  await assert.rejects(first.service.complete("wrong-node", String(b.state)), { code: "oidc_state_invalid" });
  await assert.rejects(second.service.complete("wrong-node", String(a.state)), { code: "oidc_state_invalid" });
  assert.equal(first.requests.length + second.requests.length, 0);
  assert.equal((await first.service.complete("a", String(a.state))).authenticated, true);
  assert.equal((await second.service.complete("b", String(b.state))).authenticated, true);
});

test("offline identity is confined to replica reads and expires independently of the token", async (t) => {
  const active = fixture(Date.now(), {}, t);
  await signIn(active);
  active.clock.now += 65_000;
  active.keycloak.reachable = false;
  const auth = { transportKind: "unix-socket" as const };
  const bound = await active.service.bind(auth, true);
  assert.equal(bound.oidcPrincipal, undefined);
  assert.equal(bound.replicaReadPrincipal?.personId, "person-zeyu");
  assert.equal(localDefaultBinding(bound, null, true).actor.principal.personId, "person-zeyu");
  const sessionEnvironment = { TEST_OFFLINE_SESSION: "retained" };
  const replicaBinding = localDefaultBinding({ ...bound, sessionEnvironment }, null, true);
  assert.deepEqual(replicaBinding.sessionEnvironment, sessionEnvironment);
  assert.equal(replicaBinding.keycloakAuthorization, undefined);
  const withOnlinePrincipal = {
    ...bound,
    oidcPrincipal: {
      personId: "online-person",
      subject: "online-subject",
      accessToken: "online-token",
      expiresAt: Date.now() + 60_000,
      authority: { url: "https://keycloak.example", realm: "harness", clientId: "harness-center" },
    },
  };
  const preferredReplica = localDefaultBinding(withOnlinePrincipal, null, true);
  assert.equal(preferredReplica.actor.principal.personId, "person-zeyu");
  assert.equal(preferredReplica.keycloakAuthorization, undefined);
  assert.equal(localDefaultBinding(withOnlinePrincipal).actor.principal.personId, "online-person");
  const expiredReplica = {
    ...withOnlinePrincipal,
    replicaReadPrincipal: { personId: "expired-person", sessionExpiresAt: Date.now() - 1 },
  };
  assert.equal(localDefaultBinding(expiredReplica, null, true).actor.principal.personId, "online-person");
  assert.throws(() => localDefaultBinding({ ...expiredReplica, oidcPrincipal: undefined }, null, true), {
    code: "authentication_required",
  });
  assert.throws(() => localDefaultBinding(bound), { code: "authentication_required" });
  assert.equal((await active.service.bind(auth)).replicaReadPrincipal, undefined);
  const store = managedRbacSessionStore(active.root);
  const saved = JSON.parse(store.read()!);
  active.clock.now = saved.sessionExpiresAt;
  assert.equal((await active.service.bind(auth, true)).replicaReadPrincipal, undefined);
  assert.equal(JSON.parse(store.read()!).expiresAt, saved.expiresAt);
});

for (const end of ["expiry", "logout"] as const)
  for (const response of ["unreachable", "success"] as const) {
    test(`a session ending by ${end} while renewal waits for ${response} cannot bind a replica read`, async (t) => {
      let started!: () => void, finish!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const active = fixture(
        Date.now(),
        {
          fetch: (async (input, init) => {
            const grant = (init?.body as URLSearchParams | undefined)?.get("grant_type");
            if (grant === "refresh_token") {
              started();
              await waiting;
              if (response === "unreachable") throw new TypeError("unreachable");
              return Response.json({
                access_token: "x.e30.x",
                refresh_token: "new",
                expires_in: 60,
                refresh_expires_in: 120,
              });
            }
            if (String(input).endsWith("/token"))
              return Response.json({
                access_token: "x.e30.x",
                refresh_token: "refresh",
                expires_in: 60,
                refresh_expires_in: 120,
              });
            return Response.json({ sub: "subject", harness_person_id: "person-zeyu" });
          }) as typeof fetch,
        },
        t,
      );
      await signIn(active);
      active.clock.now += 65_000;
      const bound = active.service.bind({ transportKind: "unix-socket" }, true);
      await entered;
      const logout = end === "logout" ? active.service.logout() : undefined;
      if (end === "expiry") active.clock.now += 120_000;
      finish();
      const result = await bound;
      assert.equal(result.oidcPrincipal, undefined);
      assert.equal(result.replicaReadPrincipal, undefined);
      if (logout) {
        await logout;
        assert.equal(managedRbacSessionStore(active.root).read(), undefined);
      }
    });
  }

test("HTTP 400 clears the session for offline reads and subsequent online uses", async (t) => {
  const active = fixture(Date.now(), {}, t);
  await signIn(active);
  active.clock.now += 65_000;
  active.keycloak.revoked = true;
  const bound = await active.service.bind({ transportKind: "unix-socket" }, true);
  assert.equal(bound.replicaReadPrincipal, undefined);
  assert.equal(bound.oidcPrincipal, undefined);
  assert.equal(managedRbacSessionStore(active.root).read(), undefined);
  assert.equal((await active.service.status()).authenticated, false);
  assert.equal(active.keycloak.refreshes, 1);
});

test("a reachable token endpoint error does not grant an offline identity", async (t) => {
  const active = fixture(Date.now(), {}, t);
  await signIn(active);
  const store = managedRbacSessionStore(active.root);
  store.write(JSON.stringify({ ...JSON.parse(store.read()!), expiresAt: Date.now() - 1 }));
  const service = new OidcSessionService(active.root, {
    fetch: (async () => new Response(null, { status: 503 })) as typeof fetch,
  });
  assert.equal((await service.bind({ transportKind: "unix-socket" }, true)).replicaReadPrincipal, undefined);
});

test("replica reads reject an ended session even when its access token has time remaining", async (t) => {
  const active = fixture(Date.now(), {}, t);
  await signIn(active);
  const store = managedRbacSessionStore(active.root);
  store.write(JSON.stringify({ ...JSON.parse(store.read()!), sessionExpiresAt: active.clock.now - 1 }));
  const bound = await active.service.bind({ transportKind: "unix-socket" }, true);
  assert.equal(bound.oidcPrincipal, undefined);
  assert.equal(bound.replicaReadPrincipal, undefined);
  assert.equal(active.keycloak.refreshes, 0);
});

test("authorization after delayed preparation renews the originally bound local session before UMA", async (t) => {
  const startedAt = Date.now(),
    active = fixture(startedAt, {}, t);
  await signIn(active);
  const auth = await active.service.bind({ transportKind: "unix-socket" }),
    binding = localDefaultBinding(auth),
    seen: unknown[] = [],
    evaluate = () =>
      evaluateKeycloakPerson({
        credential: binding.keycloakAuthorization!,
        personId: binding.actor.principal.personId,
        action: "task-complete",
        resource: { kind: "repository", repoId: "repo-delayed" },
        fetchPort: (async (_url, init) => {
          const token = new Headers(init?.headers).get("authorization")!.slice("Bearer ".length),
            serial = serialOf(token);
          seen.push(serial);
          return serial === active.keycloak.issued && active.clock.now < startedAt + active.keycloak.issued * 60_000
            ? Response.json({ result: true })
            : Response.json({ error: "invalid_token" }, { status: 401 });
        }) as typeof fetch,
      });
  assert.equal((await evaluate()).outcome, "allowed", "negative control: no preparation delay");
  active.clock.now += 65_000;
  assert.equal((await evaluate()).outcome, "allowed", "the write cut must use a live token");
  assert.deepEqual(seen, [1, 2]);
  assert.equal(active.keycloak.refreshes, 1, "one normal session renewal, no UMA retry");
});

for (const endedBy of ["revoked", "expired", "logout", "new-login", "unreachable"] as const) {
  test(`delayed authorization refuses a session ended by ${endedBy} before sending UMA`, async (t) => {
    const active = fixture(Date.now(), {}, t);
    await signIn(active);
    const binding = localDefaultBinding(await active.service.bind({ transportKind: "unix-socket" }));
    active.clock.now += 65_000;
    if (endedBy === "revoked") active.keycloak.revoked = true;
    if (endedBy === "expired") active.clock.now += sessionLifetimeSeconds * 1_000;
    if (endedBy === "logout") await active.service.logout();
    if (endedBy === "new-login") await signIn(active);
    if (endedBy === "unreachable") active.keycloak.reachable = false;
    let evaluations = 0;
    await assert.rejects(
      evaluateKeycloakPerson({
        credential: binding.keycloakAuthorization!,
        personId: binding.actor.principal.personId,
        action: "task-complete",
        resource: { kind: "repository", repoId: "repo-delayed" },
        fetchPort: (async () => {
          evaluations += 1;
          return Response.json({ result: true });
        }) as typeof fetch,
      }),
      { code: endedBy === "unreachable" ? "oidc_session_unavailable" : "authentication_required" },
    );
    assert.equal(evaluations, 0);
  });
}

for (const transportCode of [undefined, "ECONNREFUSED"] as const) {
  test(`center token transport failure stays daemon_error (${transportCode ?? "fetch failed"})`, async (t) => {
    const cause = new TypeError("fetch failed", {
      cause: transportCode ? Object.assign(new Error("connection refused"), { code: transportCode }) : undefined,
    });
    const active = fixture(
      Date.now(),
      {
        fetch: async () => {
          throw cause;
        },
      },
      t,
    );
    writeFileSync(path.join(active.root, "rbac", "center-client-secret"), "fixture-secret");
    await assert.rejects(active.service.center(), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "daemon_error");
      assert.equal(error.cause, cause);
      return true;
    });
  });
}

test("center token HTTP rejection retains its service authentication code", async (t) => {
  const active = fixture(Date.now(), { fetch: async () => new Response(null, { status: 401 }) }, t);
  writeFileSync(path.join(active.root, "rbac", "center-client-secret"), "fixture-secret");
  await assert.rejects(active.service.center(), { code: "rbac_admin_unavailable" });
});
