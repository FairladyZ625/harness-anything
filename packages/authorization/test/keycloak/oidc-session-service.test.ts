// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { OidcSessionService } from "../../src/keycloak/oidc-session-service.ts";
import type { OidcLoginAuthority, OidcSessionPorts } from "@harness-anything/kernel";
import type { KeycloakEdgeLogin, KeycloakSessionHost } from "../../src/keycloak/session-host.ts";
import { removeTempRepository } from "../../../../tools/fixtures/remove-temp-repository.ts";

interface RefreshRequest {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
}

test("center discovery publishes the TLS name and browser login route", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-oidc-discovery-"));
  mkdirSync(path.join(root, "rbac"), { recursive: true });
  writeFileSync(
    path.join(root, "rbac", "config.json"),
    JSON.stringify({
      mode: "managed",
      url: "https://keycloak-internal.example.test",
      realm: "harness",
      clientId: "harness-center",
      servername: "keycloak-private.example.test",
      listener: {
        address: "0.0.0.0",
        hostname: "login.example.test",
        port: 9443,
        certificateFile: path.join(root, "login.crt"),
        certificateKeyFile: path.join(root, "login.key"),
      },
    }),
  );
  t.after(() => removeTempRepository(root));

  const authority = new OidcSessionService(root, {} as KeycloakSessionHost).discovery("node-a");
  assert.deepEqual(authority, {
    url: "https://login.example.test:9443",
    realm: "harness",
    clientId: "harness-node-node-a",
    servername: "login.example.test",
    browserUrl: "https://login.example.test:9443",
  });
});

function renewalFixture(
  t: TestContext,
  sessionAuthority: { readonly clientId?: string; readonly clientSecret?: string },
  expectedRequest: RefreshRequest,
) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-oidc-renewal-authority-")),
    issuer = "https://identity.example.test/realms/harness",
    authority = { url: "https://identity.example.test", realm: "harness", clientId: "harness-gui" },
    edge = {
      schema: "fleet-edge-config/v1",
      repoId: "repo-a",
      host: "edge.example.test",
      port: 443,
      caPath: path.join(root, "edge-ca.pem"),
      nodeId: "node-a",
      credential: "edge-credential",
      viewRoot: root,
      quotaBytes: 1_024,
    },
    requests: RefreshRequest[] = [];
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "fleet-edge.json"), JSON.stringify(edge));
  t.after(() => removeTempRepository(root));

  let stored: string | undefined = JSON.stringify({
    schema: "harness-oidc-session/v3",
    issuer,
    accessToken: "expired-access-token",
    refreshToken: "refresh-original",
    subject: "subject-a",
    personId: "person-a",
    expiresAt: 1_000,
    sessionExpiresAt: null,
    roles: [],
    loginTarget: root,
    authority: { url: authority.url, realm: authority.realm, ...sessionAuthority },
  });
  const store = {
    read: () => stored,
    write: (value: string) => {
      stored = value;
    },
    delete: () => {
      stored = undefined;
    },
    retireBootstrap: () => {},
  };
  const selections = new Map<string, { readonly authority: OidcLoginAuthority; readonly issuer: string }>([
    [root, { authority, issuer }],
  ]);
  const host: KeycloakSessionHost = {
    centers: {
      read: (target) => selections.get(target ?? ""),
      write: (target, selection) => selections.set(target ?? "", selection),
    },
    readFleetEdgeConfig: (target) => {
      const file = path.join(target, "fleet-edge.json");
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as KeycloakEdgeLogin) : null;
    },
    readFleetLoginAuthorityClient: async () => authority,
    reportFleetDeviceLogin: async () => {},
    errorMessageWithCause: (error) => String(error),
    rootCaFromCertificateChain: () => undefined,
    systemCaCertificates: () => [],
    probeSystemCaTrust: async () => true,
    fetchWithTlsCa: (fetcher, _ca, input, init) => fetcher(input, init),
  };
  const ports: Partial<OidcSessionPorts> = {
    now: () => 1_000,
    sessionStore: () => store,
    fetch: async (_input, init) => {
      const form = init?.body as URLSearchParams,
        request = { clientId: form.get("client_id"), clientSecret: form.get("client_secret") };
      requests.push(request);
      if (request.clientId !== expectedRequest.clientId || request.clientSecret !== expectedRequest.clientSecret)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: `x.${Buffer.from(JSON.stringify({ iss: issuer })).toString("base64url")}.x`,
        refresh_token: "refresh-next",
        expires_in: 3_600,
        refresh_expires_in: 0,
        scope: "openid profile email offline_access",
      });
    },
  };
  return {
    root,
    requests,
    store,
    service: new OidcSessionService(root, host, ports),
  };
}

test("renewal preserves an explicit login client after Fleet edge configuration appears", async (t) => {
  const cases = [
    {
      name: "harness-gui and its original client secret",
      authority: { clientId: "harness-gui", clientSecret: "gui-client-secret" },
      expected: { clientId: "harness-gui", clientSecret: "gui-client-secret" },
    },
    {
      name: "legacy authority without a client id",
      authority: {},
      expected: { clientId: "harness-node-node-a", clientSecret: "edge-credential" },
    },
    {
      name: "existing node authority",
      authority: { clientId: "harness-node-old" },
      expected: { clientId: "harness-node-node-a", clientSecret: "edge-credential" },
    },
  ];

  for (const example of cases) {
    await t.test(example.name, async (caseContext) => {
      const fixture = renewalFixture(caseContext, example.authority, example.expected),
        status = await fixture.service.status(fixture.root);
      assert.equal(status.authenticated, true);
      assert.deepEqual(fixture.requests, [
        { clientId: example.expected.clientId, clientSecret: example.expected.clientSecret },
      ]);
      assert.equal(JSON.parse(fixture.store.read()!).refreshToken, "refresh-next");
    });
  }
});
