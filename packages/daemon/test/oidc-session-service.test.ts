// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { localDefaultBinding } from "../src/daemon-host-binding.ts";

function fixture(now = 1_000): { service: OidcSessionService; root: string; requests: Request[] } {
  const root = mkdtempSync(path.join(tmpdir(), "ha-oidc-session-")),
    requests: Request[] = [];
  mkdirSync(path.join(root, "rbac"), { recursive: true });
  writeFileSync(
    path.join(root, "rbac", "config.json"),
    JSON.stringify({ url: "http://127.0.0.1:8080", realm: "harness" }),
  );
  let nonce = 0;
  const jwt = `x.${Buffer.from(JSON.stringify({ realm_access: { roles: ["access-admin"] } })).toString("base64url")}.x`;
  return {
    root,
    requests,
    service: new OidcSessionService(root, {
      now: () => now,
      randomBytes: ((size: number) => Buffer.alloc(size, ++nonce)) as typeof import("node:crypto").randomBytes,
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        if (String(input).endsWith("/token"))
          return Response.json({ access_token: jwt, refresh_token: "refresh", expires_in: 60 });
        return Response.json({ sub: "keycloak-subject", harness_person_id: "person-zeyu" });
      }) as typeof fetch,
    }),
  };
}

test("PKCE login validates state, keeps tokens daemon-side, and binds the Keycloak person", async () => {
  const { service, requests } = fixture(),
    redirectUri = "http://127.0.0.1:43123/callback",
    begun = service.begin(redirectUri),
    authorizationUrl = new URL(String(begun.authorizationUrl));
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), redirectUri);
  const completed = await service.complete("authorization-code", String(begun.state));
  assert.deepEqual(completed, { ok: true, authenticated: true, personId: "person-zeyu", expiresAt: 61_000 });
  assert.match(await requests[0]!.text(), /code_verifier=/u);
  assert.deepEqual(service.bind({ transportKind: "unix-socket" }).oidcPrincipal, {
    personId: "person-zeyu",
    subject: "keycloak-subject",
    expiresAt: 61_000,
  });
  assert.equal(service.requireRole("access-admin").personId, "person-zeyu");
  assert.equal("accessToken" in completed, false);
});

test("mismatched callback state is rejected and expired sessions fail closed", async () => {
  const active = fixture();
  active.service.begin("http://localhost:1234/callback");
  await assert.rejects(active.service.complete("code", "wrong-state"), { code: "oidc_state_invalid" });

  const expired = fixture(100_000),
    begun = expired.service.begin("http://127.0.0.1:1234/callback");
  await expired.service.complete("code", String(begun.state));
  assert.deepEqual(expired.service.status(), {
    ok: true,
    authenticated: true,
    personId: "person-zeyu",
    expiresAt: 160_000,
  });
  assert.deepEqual(expired.service.logout(), { ok: true, authenticated: false });
  assert.equal(expired.service.bind({ transportKind: "unix-socket" }).oidcPrincipal, undefined);
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
        oidcPrincipal: { personId: "person-expired", subject: "subject", expiresAt: Date.now() - 1 },
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
            ? Response.json({ access_token: jwt, expires_in: 60 })
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
