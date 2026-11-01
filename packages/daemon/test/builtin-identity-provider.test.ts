// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BuiltinIdentitySession,
  BuiltinIdentityManagement,
  userRootFromBuiltinUrl,
} from "@harness-anything/authorization-builtin";
import { managedRbacSessionStore } from "@harness-anything/authorization-keycloak/managed-rbac-service";
import { AccessAdminService } from "../src/access-admin-service.ts";
import {
  createAuthorizationProvider,
  createIdentityManagement,
  createIdentitySession,
} from "../src/authorization-provider.ts";
import { createEdgeJoinStore } from "../src/fleet/edge-join.ts";

test("clean user roots select built-in identity without a managed runtime", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const management = createIdentityManagement(root);
  assert.ok(management instanceof BuiltinIdentityManagement);
  assert.deepEqual(await management.run({ operation: "bootstrap" }), {
    ok: true,
    command: "rbac-bootstrap",
    mode: "builtin",
    url: "builtin://local",
    downloaded: [],
  });
  assert.equal(JSON.parse(readFileSync(path.join(root, "rbac", "config.json"), "utf8")).mode, "builtin");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "rbac", "builtin-state.json"), "utf8")).schema,
    "harness-builtin-identity/v2",
  );
  const session = createIdentitySession(root);
  assert.ok(session instanceof BuiltinIdentitySession);
  assert.deepEqual(await session.bootstrapStatus(), { ok: true, required: true });
  const first = {
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "correct:horse",
    personId: "person-owner",
  };
  const outcomes = await Promise.allSettled([
    session.bootstrapAdmin(first),
    session.bootstrapAdmin({ ...first, personId: "person-second" }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    outcomes.filter(
      (item) => item.status === "rejected" && (item.reason as { code?: string }).code === "bootstrap_admin_closed",
    ).length,
    1,
  );
  const browserLogin = await session.begin("http://127.0.0.1:43123/callback");
  await assert.rejects(session.complete("owner", String(browserLogin.state)), { code: "oidc_identity_rejected" });
  const browserCode = await session.begin("http://127.0.0.1:43123/callback");
  const loginPage = new URL(String(browserCode.authorizationUrl));
  const response = await fetch(loginPage, {
    method: "POST",
    body: new URLSearchParams({ username: "owner", password: "correct:horse", state: String(browserCode.state) }),
    redirect: "manual",
  });
  // The callback code is opaque and one-time; the password never crosses the callback URL.
  const callback = new URL(response.headers.get("location")!);
  assert.equal(callback.searchParams.get("code")?.includes("correct:horse"), false);
  await assert.rejects(session.complete(callback.searchParams.get("code")!, `${browserCode.state}-wrong`), {
    code: "oidc_state_invalid",
  });
  assert.equal(
    (await session.complete(callback.searchParams.get("code")!, String(browserCode.state))).authenticated,
    true,
  );
  await assert.rejects(session.complete(callback.searchParams.get("code")!, String(browserCode.state)), {
    code: "oidc_state_invalid",
  });
  await session.logout();
  const login = await session.beginDevice();
  const retry = await session.beginDevice();
  await assert.rejects(session.deviceApproval(String(login.userCode)), { code: "oidc_device_missing" });
  assert.deepEqual(await session.pollDevice(), { ok: true, pending: true, interval: 1 });
  const verification = await session.deviceApproval(String(retry.userCode));
  assert.equal(verification.approved, false);
  const devicePage = new URL(String(verification.authorizationUrl));
  const wrongDeviceResponse = await fetch(devicePage, {
    method: "POST",
    body: new URLSearchParams({
      username: "owner",
      password: "wrong",
      userCode: devicePage.searchParams.get("value")!,
    }),
  });
  assert.equal(wrongDeviceResponse.status, 401);
  assert.deepEqual(await session.pollDevice(), { ok: true, pending: true, interval: 1 });
  const deviceResponse = await fetch(devicePage, {
    method: "POST",
    body: new URLSearchParams({
      username: "owner",
      password: "correct:horse",
      userCode: devicePage.searchParams.get("value")!,
    }),
  });
  assert.equal(deviceResponse.status, 200);
  assert.equal((await session.pollDevice()).authenticated, true);
  const start = Date.now();
  Date.now = () => start + 16 * 60_000;
  try {
    assert.equal((await session.status()).authenticated, true);
  } finally {
    Date.now = () => start;
  }
  const bound = await session.bind({ transportKind: "unix-socket" });
  assert.equal(bound.oidcPrincipal?.personId, "person-owner");
  const center = await session.center();
  assert.equal(center.provider.policyRef, "builtin-policy@1");
  await center.provider.claimRepositoryOwner(center.accessToken, "repo-1", "person-owner");
  assert.equal(
    (
      await center.provider.authorize({
        userAccessToken: bound.oidcPrincipal!.accessToken,
        action: "repository-read",
        resource: { kind: "repository", repoId: "repo-1" },
      })
    ).outcome,
    "allowed",
  );
  assert.equal(
    (
      await center.provider.authorize({
        userAccessToken: bound.oidcPrincipal!.accessToken,
        action: "repository-write",
        resource: { kind: "repository", repoId: "repo-1" },
      })
    ).outcome,
    "denied",
  );
  await assert.rejects(
    center.provider.createNode(center.accessToken, { nodeId: "edge-a", personId: "person-owner" }, "node-secret"),
    { code: "identity_plugin_required" },
  );
});

test("configured built-in session lifetime is used at the expiry boundary", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-session-lifetime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = new BuiltinIdentitySession(root);
  await session.bootstrapAdmin({
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "correct:horse",
    personId: "person-owner",
  });
  const center = await session.center();
  await center.provider.writeSessionLifetime(center.accessToken, 300);
  const login = await session.begin("http://127.0.0.1:43123/callback"),
    page = new URL(String(login.authorizationUrl)),
    response = await fetch(page, {
      method: "POST",
      body: new URLSearchParams({ username: "owner", password: "correct:horse", state: String(login.state) }),
      redirect: "manual",
    }),
    callback = new URL(response.headers.get("location")!);
  await session.complete(callback.searchParams.get("code")!, String(login.state));
  const start = Date.now();
  Date.now = () => start + 301_000;
  try {
    assert.equal((await session.status()).authenticated, false);
  } finally {
    Date.now = () => start;
  }
});

test("external mode remains an explicit Keycloak plugin selection", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-switch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input),
      pathName = url.pathname;
    if (pathName === "/realms/fleet") return Response.json({ realm: "fleet" });
    if (pathName.endsWith("/protocol/openid-connect/token"))
      return Response.json({ access_token: "center-token", expires_in: 300 });
    if (pathName === "/admin/realms/fleet/users") return Response.json([]);
    throw new Error(`Unexpected external identity request ${url} ${String(init?.method ?? "GET")}`);
  }) as typeof fetch;
  const management = createIdentityManagement(root, { fetch: fakeFetch });
  await management.run({ operation: "bootstrap" });
  const session = createIdentitySession(root, { fetch: fakeFetch });
  assert.ok(session instanceof BuiltinIdentitySession);
  await session.bootstrapAdmin({
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "correct:horse",
    personId: "person-owner",
  });
  const login = await session.begin("http://127.0.0.1:43123/callback");
  const loginPage = new URL(String(login.authorizationUrl));
  const loginResponse = await fetch(loginPage, {
    method: "POST",
    body: new URLSearchParams({ username: "owner", password: "correct:horse", state: String(login.state) }),
    redirect: "manual",
  });
  const callback = new URL(loginResponse.headers.get("location")!);
  await session.complete(callback.searchParams.get("code")!, String(login.state));
  const before = readFileSync(path.join(root, "rbac", "config.json"), "utf8");
  await session.logout();
  await assert.rejects(
    session.configureAuthority(() =>
      management.run({
        mode: "external",
        url: "https://identity.example.invalid",
        realm: "fleet",
        clientId: "harness-center",
        clientSecret: "synthetic-client-secret",
      }),
    ),
    { code: "authentication_required" },
  );
  assert.equal(readFileSync(path.join(root, "rbac", "config.json"), "utf8"), before);
  const relogin = await session.begin("http://127.0.0.1:43123/callback");
  const reloginPage = new URL(String(relogin.authorizationUrl));
  const reloginResponse = await fetch(reloginPage, {
    method: "POST",
    body: new URLSearchParams({ username: "owner", password: "correct:horse", state: String(relogin.state) }),
    redirect: "manual",
  });
  const reloginCallback = new URL(reloginResponse.headers.get("location")!);
  await session.complete(reloginCallback.searchParams.get("code")!, String(relogin.state));
  await management.run({
    mode: "external",
    url: "https://identity.example.invalid",
    realm: "fleet",
    clientId: "harness-center",
    clientSecret: "synthetic-client-secret",
  });
  assert.ok(session instanceof BuiltinIdentitySession);
  assert.equal(existsSync(path.join(root, "rbac", "center-client-secret")), true);
  const switched = await session.center();
  assert.equal(switched.provider.authority, "keycloak");
  assert.equal(session.centerConfigured(), true);
  assert.ok(session instanceof BuiltinIdentitySession);
  assert.equal(
    createAuthorizationProvider({
      mode: "external",
      userRoot: root,
      url: "builtin://local",
      realm: "fleet",
      resourceServerClientId: "harness-center",
    }).authority,
    "keycloak",
  );
  const provider = createAuthorizationProvider({
    mode: "builtin",
    userRoot: root,
    url: "builtin://local",
    realm: "local",
    resourceServerClientId: "harness-center",
  });
  assert.equal(provider.authority, "builtin");

  const configBeforeInvalidSwitch = readFileSync(path.join(root, "rbac", "config.json"), "utf8"),
    secretBeforeInvalidSwitch = readFileSync(path.join(root, "rbac", "center-client-secret"), "utf8"),
    invalidFetch = (async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/realms/fleet") return Response.json({ realm: "fleet" });
      if (url.pathname.endsWith("/protocol/openid-connect/token"))
        return new Response("bad credentials", { status: 401 });
      throw new Error(`Unexpected invalid external identity request ${url}`);
    }) as typeof fetch,
    invalidManagement = createIdentityManagement(root, { fetch: invalidFetch });
  await assert.rejects(
    invalidManagement.run({
      mode: "external",
      url: "https://identity.example.invalid",
      realm: "fleet",
      clientId: "harness-center",
      clientSecret: "invalid-secret",
    }),
    { code: "rbac_external_credentials_rejected" },
  );
  assert.equal(readFileSync(path.join(root, "rbac", "config.json"), "utf8"), configBeforeInvalidSwitch);
  assert.equal(readFileSync(path.join(root, "rbac", "center-client-secret"), "utf8"), secretBeforeInvalidSwitch);
});

test("expired built-in owner sessions cannot change authority", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-expired-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = new BuiltinIdentitySession(root);
  await session.bootstrapAdmin({
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "correct:horse",
    personId: "person-owner",
  });
  const login = await session.begin("http://127.0.0.1:43123/callback"),
    page = new URL(String(login.authorizationUrl)),
    response = await fetch(page, {
      method: "POST",
      body: new URLSearchParams({ username: "owner", password: "correct:horse", state: String(login.state) }),
      redirect: "manual",
    }),
    callback = new URL(response.headers.get("location")!);
  await session.complete(callback.searchParams.get("code")!, String(login.state));
  const before = readFileSync(path.join(root, "rbac", "config.json"), "utf8"),
    now = Date.now();
  Date.now = () => now + 7 * 60 * 60_000;
  try {
    let callbackRan = false;
    await assert.rejects(
      session.configureAuthority(async () => {
        callbackRan = true;
        return { ok: true };
      }),
      { code: "authentication_required" },
    );
    assert.equal(callbackRan, false);
    assert.equal(readFileSync(path.join(root, "rbac", "config.json"), "utf8"), before);
  } finally {
    Date.now = () => now;
  }
});

test("built-in policy accepts live Artifact scopes and rejects unknown or unclaimed repositories", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-artifact-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactImport = "entity-kind/KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94/import",
    session = new BuiltinIdentitySession(root, async () => [artifactImport]);
  await session.bootstrapAdmin({
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "correct:horse",
    personId: "person-owner",
  });
  const login = await session.begin("http://127.0.0.1:43123/callback"),
    page = new URL(String(login.authorizationUrl)),
    response = await fetch(page, {
      method: "POST",
      body: new URLSearchParams({ username: "owner", password: "correct:horse", state: String(login.state) }),
      redirect: "manual",
    }),
    callback = new URL(response.headers.get("location")!);
  await session.complete(callback.searchParams.get("code")!, String(login.state));
  const center = await session.center();
  await center.provider.claimRepositoryOwner(center.accessToken, "repo-owned", "person-owner");
  const auth = await session.bind({ transportKind: "unix-socket" });
  const allowed = await center.provider.authorize({
    userAccessToken: auth.oidcPrincipal!.accessToken,
    action: artifactImport,
    resource: { kind: "repository", repoId: "repo-owned" },
  });
  assert.equal(allowed.outcome, "allowed");
  const unknown = await center.provider.authorize({
    userAccessToken: auth.oidcPrincipal!.accessToken,
    action: "entity-kind/KND-unknown/import",
    resource: { kind: "repository", repoId: "repo-owned" },
  });
  assert.equal(unknown.reasonCode, "unknown_scope");
  const unclaimed = await center.provider.authorize({
    userAccessToken: auth.oidcPrincipal!.accessToken,
    action: artifactImport,
    resource: { kind: "repository", repoId: "repo-other" },
  });
  assert.equal(unclaimed.outcome, "denied");
});

test("builtin authority URLs reject malformed or non-absolute roots", () => {
  assert.equal(userRootFromBuiltinUrl("builtin://local/not-base64!"), undefined);
  assert.equal(userRootFromBuiltinUrl("builtin://local/"), undefined);
  assert.equal(userRootFromBuiltinUrl("https://identity.example.invalid"), undefined);
});

test("builtin sessions reject remote edge targets at the identity boundary", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-remote-target-")),
    edgeRoot = mkdtempSync(path.join(tmpdir(), "ha-builtin-edge-target-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(edgeRoot, { recursive: true, force: true });
  });
  writeFileSync(path.join(edgeRoot, "fleet-edge.json"), "{}\n");
  const session = new BuiltinIdentitySession(root),
    pluginRequired = (error: unknown) => (error as { code?: string }).code === "identity_plugin_required";
  await assert.rejects(session.beginDevice(edgeRoot), pluginRequired);
  await assert.rejects(session.deviceApproval("123456", edgeRoot), pluginRequired);
  await assert.rejects(session.status(edgeRoot), pluginRequired);
  await assert.rejects(session.bindingHealth(edgeRoot), pluginRequired);
  assert.throws(() => session.logout(edgeRoot), pluginRequired);
  await assert.rejects(session.bind({ transportKind: "unix-socket" }, edgeRoot), pluginRequired);
  await assert.rejects(session.requireSession(edgeRoot), pluginRequired);
  await assert.rejects(session.requireRole("access-admin", edgeRoot), pluginRequired);
  assert.throws(() => session.configureAuthority(async () => ({ ok: true }), edgeRoot), pluginRequired);
});

test("legacy Keycloak edges keep their session port until an explicit selector is written", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-legacy-edge-")),
    edgeRoot = mkdtempSync(path.join(tmpdir(), "ha-builtin-legacy-workspace-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(edgeRoot, { recursive: true, force: true });
  });
  writeFileSync(
    path.join(edgeRoot, "fleet-edge.json"),
    JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId: "legacy-repo",
      host: "127.0.0.1",
      port: 7443,
      caPath: "/tmp/ca.pem",
      nodeId: "edge-old",
      credential: "edge-credential",
      viewRoot: "/tmp/view",
      quotaBytes: 1024,
    }),
  );
  const service = createIdentitySession(root, {
    loginAuthority: async () => ({ url: "https://identity.example.invalid", realm: "fleet", clientId: "harness-gui" }),
    fetch: (async (input) => {
      assert.match(String(input), /\.well-known\/openid-configuration/u);
      return Response.json({ issuer: "https://identity.example.invalid/realms/fleet" });
    }) as typeof fetch,
  });
  const pending = await service.begin("http://127.0.0.1:43123/callback", edgeRoot);
  assert.match(String(pending.authorizationUrl), /identity\.example\.invalid/u);
  assert.equal(existsSync(path.join(root, "rbac", "config.json")), false);
});

test("legacy edge roots reopen through Keycloak without a selector and preserve their session file", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-legacy-reopen-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "rbac"), { recursive: true });
  writeFileSync(
    path.join(root, "fleet-edge.json"),
    JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId: "legacy-repo",
      host: "127.0.0.1",
      port: 7443,
      caPath: "/tmp/ca.pem",
      nodeId: "edge-old",
      credential: "edge-credential",
      viewRoot: "/tmp/view",
      quotaBytes: 1024,
    }),
  );
  const legacySession = JSON.stringify({ schema: "harness-oidc-session/v2", accessToken: "legacy-token" });
  writeFileSync(path.join(root, "rbac", "oidc-session.json"), legacySession);
  const service = createIdentitySession(root, {
    loginAuthority: async () => ({ url: "https://identity.example.invalid", realm: "fleet", clientId: "harness-gui" }),
    fetch: (async (input) => {
      assert.match(String(input), /\.well-known\/openid-configuration/u);
      return Response.json({ issuer: "https://identity.example.invalid/realms/fleet" });
    }) as typeof fetch,
  });
  const pending = await service.begin("http://127.0.0.1:43123/callback", root);
  assert.match(String(pending.authorizationUrl), /identity\.example\.invalid/u);
  assert.equal(
    managedRbacSessionStore(root, "https://identity.example.invalid/realms/fleet", "fleet").read(),
    legacySession,
  );
  writeFileSync(
    path.join(root, "rbac", "config.json"),
    JSON.stringify({
      schema: "harness-builtin-rbac/v1",
      mode: "builtin",
      url: "builtin://local",
      realm: "local",
      clientId: "harness-center",
    }),
  );
  assert.ok(createIdentitySession(root) instanceof BuiltinIdentitySession);
  assert.equal(readFileSync(path.join(root, "rbac", "oidc-session.json"), "utf8"), legacySession);
});

test("builtin collaboration entry points require the Keycloak plugin", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-builtin-collaboration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const center = new BuiltinIdentitySession(root);
  await center.bootstrapAdmin({
    username: "owner",
    email: "owner@example.invalid",
    displayName: "Owner",
    password: "correct horse",
    personId: "person-owner",
  });
  assert.throws(() => center.requireCollaboration(), { code: "identity_plugin_required" });
  await assert.rejects(center.interactiveAuthority(), { code: "identity_plugin_required" });
  const authority = await center.center(),
    centerToken = authority.accessToken;
  await assert.rejects(authority.provider.readPolicyGroups(centerToken), { code: "identity_plugin_required" });
  await assert.rejects(authority.provider.readGrants(centerToken), { code: "identity_plugin_required" });
  await assert.rejects(authority.provider.readPeople(centerToken), { code: "identity_plugin_required" });
  const store = createEdgeJoinStore({ randomToken: () => "builtin-edge-invite" }),
    created = store.create({
      centerOrigin: "https://center.example.invalid:7545",
      repoIds: ["repo-one"],
      personId: "person-owner",
      permissionSnapshot: [{ groupId: "admin", version: "v1" }],
      spkiSha256: "a".repeat(64),
      loginUrl: "builtin://local",
      loginRealm: "local",
      loginClientId: "harness-center",
      createdBy: "person-owner",
      ttlMs: 60_000,
    });
  const admin = new AccessAdminService(center, root, { edgeJoins: store });
  await assert.rejects(admin.run({ operation: "team-create", teamName: "Builders" }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "identity_plugin_required");
    assert.match((error as Error).message, /Keycloak/);
    return true;
  });
  await assert.rejects(
    admin.admitEdgeJoin({
      joinId: created.record.joinId,
      inviteToken: created.link.token!,
      accessToken: "unused-builtin-token",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "identity_plugin_required");
      assert.match((error as Error).message, /Keycloak/);
      return true;
    },
  );
  assert.equal(store.status(created.record.joinId).state, "pending");
  await admin.close();
});
