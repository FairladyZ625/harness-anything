// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";
import { OidcSessionService, type OidcLoginAuthority } from "../src/oidc-session-service.ts";
import { oidcCenterSelections } from "../src/oidc-center-selection.ts";
import { writeFleetEdgeConfig } from "../src/client/fleet-edge-config.ts";

interface FixtureOptions {
  readonly tokenIssuer?: string;
  readonly legacySession?: boolean;
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
  const legacyFile = path.join(userRoot, "rbac", "oidc-session.json");
  if (options.legacySession) writeFileSync(legacyFile, JSON.stringify({ schema: "harness-oidc-session/v2" }));
  let serial = 0;
  const service = new OidcSessionService(userRoot, {
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
        const body = init?.body as URLSearchParams,
          accessIssuer =
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
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { userRoot, localRoot, localSiblingRoot, edgeRoot, localIssuer, edgeIssuer, legacyFile, service };
}

async function signIn(service: OidcSessionService, root: string): Promise<void> {
  const pending = await service.begin("http://127.0.0.1:43123/callback", root);
  await service.complete("authorization-code", String(pending.state));
}

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
  assert.equal(
    (await active.service.requireRole("access-admin", active.localRoot)).personId,
    "person:local-token.example.test",
  );
});

test("a token issued by another center is rejected without writing a center session", async (t) => {
  const active = fixture(t, { tokenIssuer: "https://attacker.example.test/realms/harness" });
  const pending = await active.service.begin("http://127.0.0.1:43123/callback", active.edgeRoot);

  await assert.rejects(active.service.complete("authorization-code", String(pending.state)), {
    code: "oidc_issuer_mismatch",
  });
  assert.equal(managedRbacSessionStore(active.userRoot, active.edgeIssuer, "harness").read(), undefined);
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
  writeFleetEdgeConfig(active.edgeRoot, edgeConfig);
  selection.write(active.edgeRoot, { issuer: active.edgeIssuer, authority }, true);
  writeFleetEdgeConfig(active.edgeRoot, {
    ...edgeConfig,
    viewRoot: "/tmp/new-view",
    quotaBytes: 200,
    loginUrl: "https://new-login.example",
    loginServername: "new-login.internal",
    loginBrowserUrl: "https://new-login-browser.example",
    loginCertificate: "new-test-certificate",
  });
  assert.deepEqual(selection.read(active.edgeRoot), { issuer: active.edgeIssuer, authority });
  writeFleetEdgeConfig(active.edgeRoot, { ...edgeConfig, repoId: "another-edge-repo" });
  assert.equal(selection.read(active.edgeRoot), undefined, "a different repository target selects a new session");
});

test("local repository selection retains its configured OIDC identity", (t) => {
  const active = fixture(t),
    selection = oidcCenterSelections(active.userRoot),
    configFile = path.join(active.userRoot, "rbac", "config.json"),
    config = { url: "https://local-center.example", realm: "harness", clientId: "harness-gui" };
  writeFileSync(configFile, JSON.stringify(config));
  selection.write(
    active.localRoot,
    {
      issuer: active.localIssuer,
      authority: { url: config.url, realm: config.realm, clientId: config.clientId },
    },
    true,
  );
  writeFileSync(configFile, JSON.stringify({ ...config, lastCheckedAt: "2026-10-31T00:00:00Z" }));
  assert.deepEqual(selection.read(active.localRoot), {
    issuer: active.localIssuer,
    authority: { url: config.url, realm: config.realm, clientId: config.clientId },
  });
  writeFileSync(configFile, JSON.stringify({ ...config, url: "https://different-center.example" }));
  assert.equal(selection.read(active.localRoot), undefined, "changing the configured center invalidates its selection");
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
