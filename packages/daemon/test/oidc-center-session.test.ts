// harness-test-tier: fast
import type { IdentitySessionPort } from "@harness-anything/kernel";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { managedRbacSessionStore } from "@harness-anything/authorization/keycloak/managed-rbac-service";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { localDefaultBinding } from "../src/daemon-host/daemon-host-binding.ts";
import { forward } from "../src/daemon-host/fleet/forwarding-port.ts";
import { forwardingIntentForAction } from "../src/daemon-host/fleet/forwarding-intent.ts";
import type { OidcLoginAuthority } from "@harness-anything/kernel";
import { writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { oidcCenterSelections } from "../src/daemon-host/oidc-center-selection.ts";
import { fleetEdgeConfigPath, writeFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { fetchWithTlsCa } from "../src/daemon-host/tls-ca-certificate.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

interface FixtureOptions {
  readonly tokenIssuer?: string;
  readonly legacySession?: boolean;
  readonly now?: () => number;
  readonly refreshOutcome?: () => "ok" | "network-timeout" | "http-503" | "invalid_grant";
}

function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-oidc-centers-")),
    userRoot = path.join(root, "user"),
    localRoot = path.join(root, "local-repo"),
    localSiblingRoot = path.join(root, "local-sibling-repo"),
    edgeRoot = path.join(root, "edge-repo"),
    localIssuer = "https://local-center.example.test/realms/harness",
    edgeIssuer = "https://edge-center.example.test/realms/harness",
    authorities = new Map<string, OidcLoginAuthority>([
      [localRoot, { url: "http://local-token.example.test", realm: "harness", clientId: "harness-gui" }],
      [localSiblingRoot, { url: "http://local-token.example.test", realm: "harness", clientId: "harness-gui" }],
      [edgeRoot, { url: "http://edge-token.example.test", realm: "harness", clientId: "harness-gui" }],
    ]),
    issuerByOrigin = new Map([
      ["http://local-token.example.test", localIssuer],
      ["http://edge-token.example.test", edgeIssuer],
    ]);
  mkdirSync(path.join(userRoot, "rbac"), { recursive: true });
  mkdirSync(localRoot);
  mkdirSync(localSiblingRoot);
  mkdirSync(edgeRoot);
  writeFileSync(
    path.join(userRoot, "rbac", "config.json"),
    JSON.stringify({ schema: "harness-managed-rbac/v1", mode: "external" }),
  );
  const legacyFile = path.join(userRoot, "rbac", "oidc-session.json");
  if (options.legacySession) writeFileSync(legacyFile, JSON.stringify({ schema: "harness-oidc-session/v2" }));
  let serial = 0;
  const service = createIdentitySession(userRoot, {
    ...(options.now ? { now: options.now } : {}),
    loginAuthority: async (target) => {
      const authority = target ? authorities.get(target) : undefined;
      if (!authority) throw new Error(`Unknown login target ${String(target)}.`);
      return authority;
    },
    fetch: (async (input, init) => {
      const url = new URL(input),
        issuer = issuerByOrigin.get(url.origin);
      if (!issuer) throw new Error(`Unexpected OIDC origin ${url.origin}.`);
      if (url.pathname.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer });
      if (url.pathname.endsWith("/userinfo"))
        return Response.json({ sub: `subject:${url.hostname}`, harness_person_id: `person:${url.hostname}` });
      if (url.pathname.endsWith("/token")) {
        const body = init?.body as URLSearchParams;
        if (body.get("grant_type") === "refresh_token") {
          const outcome = options.refreshOutcome?.() ?? "ok";
          if (outcome === "network-timeout")
            throw new TypeError("fetch failed", {
              cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
            });
          if (outcome === "http-503") return new Response(null, { status: 503 });
          if (outcome === "invalid_grant") return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const accessIssuer =
            url.origin === "http://edge-token.example.test" && options.tokenIssuer ? options.tokenIssuer : issuer,
          claims = {
            iss: accessIssuer,
            realm_access: { roles: ["access-admin"] },
            serial: ++serial,
          };
        return Response.json({
          access_token: `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`,
          refresh_token: `refresh-${serial}`,
          expires_in: 3_600,
          refresh_expires_in: 21_600,
          ...(body.get("grant_type") === "refresh_token" ? { scope: "openid" } : {}),
        });
      }
      throw new Error(`Unexpected OIDC request ${url}.`);
    }) as typeof fetch,
  });
  t.after(() => removeTempRepository(root));
  return { userRoot, localRoot, localSiblingRoot, edgeRoot, localIssuer, edgeIssuer, legacyFile, service };
}

async function signIn(service: IdentitySessionPort, root: string): Promise<void> {
  const pending = await service.begin("http://127.0.0.1:43123/callback", root);
  await service.complete("authorization-code", String(pending.state));
}

test("a fresh remote-edge registration on a builtin daemon binds without contacting an OIDC center", async (t) => {
  const active = fixture(t),
    repoId = "edge-repo",
    auth = { transportKind: "unix-socket" as const };
  mkdirSync(path.join(active.edgeRoot, "harness"));
  writeFileSync(path.join(active.edgeRoot, "harness", "harness.yaml"), "schema: harness-anything/v1\n");
  writeDaemonRegistryRepo({
    userRoot: active.userRoot,
    canonicalRoot: active.edgeRoot,
    repoId,
    mode: "remote-edge",
    authoredBranch: "main",
    createConvenienceLinks: false,
  });
  writeFileSync(
    path.join(active.userRoot, "rbac", "config.json"),
    JSON.stringify({ mode: "builtin", url: "builtin://local/identity", realm: "harness" }),
  );
  const service = createIdentitySession(active.userRoot);
  assert.deepEqual(await service.bind(auth, active.edgeRoot), auth);
  await assert.rejects(service.begin("http://127.0.0.1:43123/callback", active.edgeRoot), {
    code: "oidc_center_required",
  });

  const residue = path.join(active.edgeRoot, "fleet-edge.json");
  writeFileSync(residue, "invalid JSON that must never be parsed");
  await assert.rejects(service.bind(auth, active.edgeRoot), {
    code: "fleet_edge_config_workspace_residue",
  });
});

test("TLS fetch rejects non-HTTP URLs before invoking the underlying fetcher", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    return new Response();
  };
  for (const input of [
    "builtin://local/identity",
    new URL("ftp://example.test"),
    new Request("data:text/plain,fixture"),
  ])
    await assert.rejects(fetchWithTlsCa(fetcher, [], input), { code: "unsupported_http_protocol" });
  assert.equal(requests, 0);
  await fetchWithTlsCa(fetcher, [], "http://example.test");
  assert.equal(requests, 1);
});

test("logging into an edge center leaves local-center repository authorization on its own session", async (t) => {
  const active = fixture(t);
  await signIn(active.service, active.localRoot);
  await signIn(active.service, active.edgeRoot);

  const local = await active.service.bind({ transportKind: "unix-socket" }, active.localRoot),
    sibling = await active.service.bind({ transportKind: "unix-socket" }, active.localSiblingRoot),
    edge = await active.service.bind({ transportKind: "unix-socket" }, active.edgeRoot);
  assert.equal(local.oidcPrincipal?.personId, "person:local-token.example.test");
  assert.equal(sibling.oidcPrincipal?.personId, "person:local-token.example.test");
  assert.equal(edge.oidcPrincipal?.personId, "person:edge-token.example.test");
  assert.equal((await active.service.requireSession(active.localRoot)).personId, "person:local-token.example.test");
});

test("a token issued by another center is rejected without writing a center session", async (t) => {
  const active = fixture(t, { tokenIssuer: "https://attacker.example.test/realms/harness" });
  const pending = await active.service.begin("http://127.0.0.1:43123/callback", active.edgeRoot);

  await assert.rejects(active.service.complete("authorization-code", String(pending.state)), {
    code: "oidc_issuer_mismatch",
  });
  assert.equal(managedRbacSessionStore(active.userRoot, active.edgeIssuer, "harness").read(), undefined);
});

test("Fleet identity validation derives the authorized client from the authenticated node", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-human-azp-")),
    rbac = path.join(root, "rbac");
  mkdirSync(rbac, { recursive: true });
  writeFileSync(
    path.join(rbac, "config.json"),
    JSON.stringify({ url: "https://center.example.test", realm: "harness" }),
  );
  writeFileSync(path.join(rbac, "center-client-secret"), "fixture-center-secret");
  t.after(() => removeTempRepository(root));
  const service = createIdentitySession(root, {
    now: () => 10_000,
    fetch: (async (input) => {
      const url = String(input);
      if (url.endsWith("/protocol/openid-connect/token"))
        return Response.json({ access_token: "fixture-admin-token", expires_in: 300 });
      if (url.endsWith("/protocol/openid-connect/token/introspect"))
        return Response.json({
          active: true,
          exp: 100,
          iss: "https://center.example.test/realms/harness",
          azp: "harness-node-edge-node",
          aud: ["harness-center"],
          sub: "user-a",
          harness_person_id: "person-a",
        });
      if (url.endsWith("/admin/realms/harness/users/user-a"))
        return Response.json({ enabled: true, attributes: { harness_person_id: ["person-a"] } });
      throw new Error(`Unexpected Fleet identity request ${url}.`);
    }) as typeof fetch,
  });
  const bound = await service.bind({
    transportKind: "fleet-tls",
    humanAccessToken: "fixture-human-token",
    nodePrincipal: { nodeId: "edge-node", personId: "person-a" },
  });
  assert.equal(bound.oidcPrincipal?.personId, "person-a");
});

test("edge connection changes do not select a different OIDC center", (t) => {
  const active = fixture(t),
    selection = oidcCenterSelections(active.userRoot),
    authority = { url: "https://login.example", realm: "harness", clientId: "harness-gui" },
    edgeConfig = {
      repoId: "edge-repo",
      host: "center",
      port: 7443,
      caPath: "/tmp/center-ca.pem",
      servername: "center.internal",
      nodeId: "edge-node",
      credential: "machine-credential",
      viewRoot: "/tmp/view",
      quotaBytes: 100,
      loginUrl: authority.url,
      loginServername: "login.internal",
      loginBrowserUrl: "https://login-browser.example",
      loginCertificate: "test-certificate",
    };
  mkdirSync(path.join(active.edgeRoot, "harness"), { recursive: true });
  writeFileSync(path.join(active.edgeRoot, "harness", "harness.yaml"), "schema: harness-anything/v1\n");
  writeDaemonRegistryRepo({
    userRoot: active.userRoot,
    canonicalRoot: active.edgeRoot,
    repoId: "edge-repo",
    mode: "remote-edge",
    authoredBranch: "main",
    createConvenienceLinks: false,
  });
  writeFleetEdgeConfig(active.userRoot, "edge-repo", edgeConfig);
  selection.write(active.edgeRoot, { issuer: active.edgeIssuer, authority });
  writeFleetEdgeConfig(active.userRoot, "edge-repo", {
    ...edgeConfig,
    viewRoot: "/tmp/new-view",
    quotaBytes: 200,
    loginUrl: "https://new-login.example",
    loginServername: "new-login.internal",
    loginBrowserUrl: "https://new-login-browser.example",
    loginCertificate: "new-test-certificate",
  });
  assert.deepEqual(selection.read(active.edgeRoot), { issuer: active.edgeIssuer, authority });
  writeFleetEdgeConfig(active.userRoot, "edge-repo", { ...edgeConfig, repoId: "another-edge-repo" });
  assert.equal(selection.read(active.edgeRoot), undefined, "a different repository target selects a new session");
  assert.equal(existsSync(fleetEdgeConfigPath(active.userRoot, "edge-repo")), true);
});

test("clearing all center selections tombstones every persisted entry", (t) => {
  const active = fixture(t),
    selection = oidcCenterSelections(active.userRoot),
    authority = { url: "https://login.example", realm: "harness", clientId: "harness-gui" },
    value = { issuer: active.edgeIssuer, authority };
  writeFleetEdgeConfig(active.userRoot, "edge-repo", {
    repoId: "edge-repo",
    host: "center",
    port: 7443,
    caPath: "/tmp/center-ca.pem",
    nodeId: "edge-node",
    credential: "machine-credential",
    viewRoot: "/tmp/view",
    quotaBytes: 100,
    loginUrl: authority.url,
    loginRealm: authority.realm,
  });
  selection.write(active.edgeRoot, value);
  selection.write(undefined, { issuer: active.localIssuer, authority });
  const edgeFile = path.join(active.userRoot, "rbac", "oidc-centers", `${selection.key(active.edgeRoot)}.json`),
    localFile = path.join(active.userRoot, "rbac", "oidc-centers", `${selection.key()}.json`);
  assert.deepEqual(selection.read(active.edgeRoot), value);
  assert.deepEqual(selection.read(undefined), { issuer: active.localIssuer, authority });
  selection.clearAll();
  assert.equal(JSON.parse(readFileSync(edgeFile, "utf8")), null);
  assert.equal(JSON.parse(readFileSync(localFile, "utf8")), null);
  assert.equal(selection.read(active.edgeRoot), undefined);
  assert.equal(selection.read(undefined), undefined);
});

test("local repository selection retains its configured OIDC identity", (t) => {
  const active = fixture(t),
    selection = oidcCenterSelections(active.userRoot),
    configFile = path.join(active.userRoot, "rbac", "config.json"),
    config = { url: "https://local-center.example", realm: "harness", clientId: "harness-gui" };
  writeFileSync(configFile, JSON.stringify(config));
  selection.write(active.localRoot, {
    issuer: active.localIssuer,
    authority: { url: config.url, realm: config.realm, clientId: config.clientId },
  });
  writeFileSync(configFile, JSON.stringify({ ...config, lastCheckedAt: "2026-10-31T00:00:00Z" }));
  assert.deepEqual(selection.read(active.localRoot), {
    issuer: active.localIssuer,
    authority: { url: config.url, realm: config.realm, clientId: config.clientId },
  });
  writeFileSync(configFile, JSON.stringify({ ...config, url: "https://different-center.example" }));
  assert.equal(selection.read(active.localRoot), undefined, "changing the configured center invalidates its selection");
});

test("selection bindings match across canonicalized paths, Windows 8.3 short paths, and case differences", (t) => {
  const active = fixture(t),
    selection = oidcCenterSelections(active.userRoot),
    configFile = path.join(active.userRoot, "rbac", "config.json"),
    config = { url: "https://local-center.example", realm: "harness", clientId: "harness-gui" },
    longRoot = path.join(path.dirname(active.localRoot), "long-repository-target-name"),
    stored = {
      issuer: active.localIssuer,
      authority: { url: config.url, realm: config.realm, clientId: config.clientId },
    };
  mkdirSync(longRoot, { recursive: true });
  writeFileSync(configFile, JSON.stringify(config));
  const nonNormalized = path.join(longRoot, ".", "..", path.basename(longRoot));
  selection.write(nonNormalized, stored);
  assert.equal(selection.key(nonNormalized), selection.key(longRoot));
  assert.deepEqual(selection.read(longRoot), stored);
  if (process.platform === "win32") {
    const canonicalLong = realpathSync.native(longRoot),
      upper = canonicalLong.toUpperCase(),
      lower = canonicalLong.toLowerCase();
    assert.equal(selection.key(upper), selection.key(lower));
    assert.deepEqual(selection.read(upper), stored);
    assert.deepEqual(selection.read(lower), stored);
    const shortPath = execFileSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", `for %I in ("${canonicalLong}") do @echo %~sI`],
      { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
    ).trim();
    assert.ok(shortPath.length > 0);
    assert.equal(selection.key(shortPath), selection.key(canonicalLong));
    selection.write(shortPath, stored);
    assert.deepEqual(selection.read(canonicalLong), stored);
    assert.deepEqual(selection.read(shortPath), stored);
  }
});

test("an old single-session file is deleted and does not block the first center login", async (t) => {
  const active = fixture(t, { legacySession: true });
  await signIn(active.service, active.localRoot);

  assert.equal(existsSync(active.legacyFile), false);
  assert.equal(
    (await active.service.bind({ transportKind: "unix-socket" }, active.localRoot)).oidcPrincipal?.personId,
    "person:local-token.example.test",
  );
});

test("transient OIDC renewal unavailability on an edge surfaces oidc_session_unavailable instead of degrading to anonymous authentication_required", async (t) => {
  let now = Date.now(),
    refreshOutcome: "ok" | "network-timeout" | "http-503" | "invalid_grant" = "ok";
  const active = fixture(t, { now: () => now, refreshOutcome: () => refreshOutcome }),
    repoId = "edge-repo",
    caPath = path.join(active.userRoot, "center-ca.pem");
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n");
  mkdirSync(path.join(active.edgeRoot, "harness"), { recursive: true });
  writeFileSync(path.join(active.edgeRoot, "harness", "harness.yaml"), "schema: harness-anything/v1\n");
  writeDaemonRegistryRepo({
    userRoot: active.userRoot,
    canonicalRoot: active.edgeRoot,
    repoId,
    mode: "remote-edge",
    authoredBranch: "main",
    createConvenienceLinks: false,
  });
  writeFleetEdgeConfig(active.userRoot, repoId, {
    repoId,
    host: "127.0.0.1",
    port: 1,
    caPath,
    nodeId: "edge-node",
    credential: "machine-credential",
    viewRoot: path.join(active.edgeRoot, "view"),
    quotaBytes: 100,
  });
  await signIn(active.service, active.edgeRoot);

  // Move into the access-token renewal window while the session itself is still valid.
  now += 3_605_000;
  refreshOutcome = "network-timeout";

  const auth = { transportKind: "unix-socket" as const },
    online = await active.service.bind(auth, active.edgeRoot, false);
  assert.equal(online.oidcPrincipal, undefined);
  assert.equal(online.sessionUnavailable?.code, "oidc_session_unavailable");
  assert.throws(() => localDefaultBinding(online), { code: "oidc_session_unavailable" });

  // Offline replica reads keep working seamlessly with the preserved local session.
  const replica = await active.service.bind(auth, active.edgeRoot, true);
  assert.equal(replica.replicaReadPrincipal?.personId, "person:edge-token.example.test");
  assert.equal(replica.sessionUnavailable, undefined);
  assert.equal(localDefaultBinding(replica, null, true).actor.principal.personId, "person:edge-token.example.test");

  // Center-forwarded operational reads and commands fail fast with oidc_session_unavailable,
  // never stripping the principal to send an anonymous request that would report authentication_required.
  for (const method of [
    "repo.task.dispatches",
    "repo.events.read",
    "repo.fleet.overview.read",
    "repo.policy.metadata.read",
  ] as const) {
    await assert.rejects(
      forward({
        userRoot: active.userRoot,
        repoId,
        intent: { kind: "operational-read", method, inputs: {} },
        auth,
        oidc: active.service,
        runRuntime: async () => ({ ok: true }),
      }),
      { code: "oidc_session_unavailable" },
    );
  }
  await assert.rejects(
    forward({
      userRoot: active.userRoot,
      repoId,
      intent: forwardingIntentForAction("repo.task.create", { kind: "task-create", title: "Offline retry" }),
      auth,
      oidc: active.service,
      runRuntime: async () => ({ ok: true }),
    }),
    { code: "oidc_session_unavailable" },
  );

  // Reachable 503 during renewal must also propagate oidc_session_unavailable (never false authentication_required),
  // while continuing not to grant an offline replica identity.
  refreshOutcome = "http-503";
  const online503 = await active.service.bind(auth, active.edgeRoot, false);
  assert.equal(online503.sessionUnavailable?.code, "oidc_session_unavailable");
  const replica503 = await active.service.bind(auth, active.edgeRoot, true);
  assert.equal(replica503.replicaReadPrincipal, undefined);
  assert.equal(replica503.sessionUnavailable?.code, "oidc_session_unavailable");

  // Recovery: once IdP connectivity returns, the preserved session renews cleanly without re-login.
  refreshOutcome = "ok";
  const recovered = await active.service.bind(auth, active.edgeRoot, false);
  assert.equal(recovered.sessionUnavailable, undefined);
  assert.equal(recovered.oidcPrincipal?.personId, "person:edge-token.example.test");

  // Negative control 1: explicit invalid_grant deletes the session and fails closed with authentication_required.
  now += 3_605_000;
  refreshOutcome = "invalid_grant";
  const revoked = await active.service.bind(auth, active.edgeRoot, false);
  assert.equal(revoked.oidcPrincipal, undefined);
  assert.equal(revoked.sessionUnavailable, undefined);
  assert.throws(() => localDefaultBinding(revoked), { code: "authentication_required" });
  assert.equal(managedRbacSessionStore(active.userRoot, active.edgeIssuer, "harness").read(), undefined);

  // Negative control 2: unsigned request still fails closed with authentication_required.
  const unsigned = await active.service.bind(auth, active.edgeRoot, false);
  assert.equal(unsigned.sessionUnavailable, undefined);
  assert.throws(() => localDefaultBinding(unsigned), { code: "authentication_required" });
});

test("expired SSO session encountering network error during renewal still fails closed with authentication_required", async (t) => {
  let now = Date.now(),
    refreshOutcome: "ok" | "network-timeout" = "ok";
  const active = fixture(t, { now: () => now, refreshOutcome: () => refreshOutcome }),
    auth = { transportKind: "unix-socket" as const };
  await signIn(active.service, active.edgeRoot);
  now += 22_000_000;
  refreshOutcome = "network-timeout";
  const expired = await active.service.bind(auth, active.edgeRoot, false);
  assert.equal(expired.oidcPrincipal, undefined);
  assert.equal(expired.sessionUnavailable, undefined);
  assert.throws(() => localDefaultBinding(expired), { code: "authentication_required" });
});
