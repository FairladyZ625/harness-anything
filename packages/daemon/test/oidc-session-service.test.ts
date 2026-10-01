// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { localDefaultBinding } from "../src/daemon-host-binding.ts";
import type { DaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

const sessionLifetimeSeconds = 21_600,
  accessTokenSeconds = 60;

/** A Keycloak token endpoint whose refresh tokens slide with use and lapse after `lifetimeSeconds` idle. */
function fixture(start = 1_000) {
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
    }),
  };
}

async function signIn(active: ReturnType<typeof fixture>): Promise<Record<string, unknown>> {
  const begun = active.service.begin("http://127.0.0.1:43123/callback");
  return active.service.complete("authorization-code", String(begun.state));
}

const serialOf = (accessToken: string | undefined): unknown =>
  JSON.parse(Buffer.from(accessToken!.split(".")[1]!, "base64url").toString("utf8")).serial;

test("PKCE login validates state, keeps tokens daemon-side, and binds the Keycloak person", async () => {
  const { service, requests, root } = fixture(),
    redirectUri = "http://127.0.0.1:43123/callback",
    begun = service.begin(redirectUri),
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

test("under a listener the browser signs in at its hostname while the daemon keeps to loopback", async () => {
  const { service, requests, root } = fixture();
  writeFileSync(
    path.join(root, "rbac", "config.json"),
    JSON.stringify({
      url: "http://127.0.0.1:8080",
      realm: "harness",
      listener: { hostname: "center.example.test", port: 8443 },
    }),
  );
  const begun = service.begin("http://127.0.0.1:43123/callback"),
    authorizationUrl = new URL(String(begun.authorizationUrl));
  assert.equal(authorizationUrl.origin, "https://center.example.test:8443");
  assert.equal(authorizationUrl.pathname, "/realms/harness/protocol/openid-connect/auth");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "http://127.0.0.1:43123/callback");
  await service.complete("authorization-code", String(begun.state));
  assert.deepEqual([...new Set(requests.map((request) => new URL(request.url).origin))], ["http://127.0.0.1:8080"]);
});

test("a session in use outlives its access token without signing in again", async () => {
  const active = fixture();
  await signIn(active);
  const first = (await active.service.bind({ transportKind: "unix-socket" })).oidcPrincipal;
  assert.equal(serialOf(first?.accessToken), 1);
  // Three access token lifetimes of continued use: every use past the token's life gets a fresh one.
  for (const cycle of [1, 2, 3]) {
    active.clock.now += (accessTokenSeconds + 5) * 1_000;
    assert.deepEqual(await active.service.status(), {
      ok: true,
      authenticated: true,
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

test("concurrent uses of a session whose access token lapsed renew it once", async () => {
  const active = fixture();
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

test("a session idle past the session lifetime is signed out, and not retried", async () => {
  const active = fixture();
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

test("a session whose refresh token Keycloak revoked is signed out instead of let through", async () => {
  const active = fixture();
  await signIn(active);
  active.keycloak.revoked = true;
  // The access token it already holds stays usable until it lapses; the renewal is what Keycloak refuses.
  active.clock.now += (accessTokenSeconds + 5) * 1_000;
  assert.equal((await active.service.bind({ transportKind: "unix-socket" })).oidcPrincipal, undefined);
  assert.deepEqual(await active.service.status(), { ok: true, authenticated: false });
  await assert.rejects(active.service.requireRole("access-admin"), { code: "authentication_required" });
  assert.equal(active.keycloak.refreshes, 1);
});

test("an unreachable Keycloak fails the renewal without ending the session", async () => {
  const active = fixture();
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

test("a lowered session lifetime applies to a signed-in session at its next renewal", async () => {
  const active = fixture();
  await signIn(active);
  active.keycloak.lifetimeSeconds = 300;
  active.clock.now += (accessTokenSeconds + 5) * 1_000;
  assert.equal((await active.service.status()).expiresAt, active.clock.now + 300_000);
});

test("a connection that outlives the access token carries the session as it is on each request", async () => {
  const active = fixture(),
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

test("mismatched callback state is rejected and logout ends the session", async () => {
  const active = fixture();
  active.service.begin("http://localhost:1234/callback");
  await assert.rejects(active.service.complete("code", "wrong-state"), { code: "oidc_state_invalid" });

  const signedIn = fixture(100_000);
  await signIn(signedIn);
  assert.equal((await signedIn.service.status()).authenticated, true);
  assert.deepEqual(await signedIn.service.logout(), { ok: true, authenticated: false });
  assert.equal((await signedIn.service.bind({ transportKind: "unix-socket" })).oidcPrincipal, undefined);
});

test("login rejects non-loopback callbacks", () => {
  const { service } = fixture();
  assert.throws(() => service.begin("https://example.com/callback"), { code: "oidc_redirect_invalid" });
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

test("first administrator closes after one success and access-admin can invite", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-oidc-admin-")),
    rbac = path.join(root, "rbac"),
    users: string[] = [];
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
  const login = service.begin("http://127.0.0.1:1234/callback");
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
