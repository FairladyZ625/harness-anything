// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";

test("edge binding health reads the selected login authority through fleet discovery", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-binding-")),
    userRoot = path.join(root, "user"),
    keyFile = path.join(root, "key.pem"),
    certFile = path.join(root, "cert.pem");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  let session: string | undefined,
    realmStatus = 200;
  const oidc = new OidcSessionService(userRoot, {
    sessionStore: {
      read: () => session,
      write: (value) => void (session = value),
      delete: () => void (session = undefined),
      retireBootstrap: () => undefined,
    },
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/token"))
        return Response.json({
          access_token: "header.e30.signature",
          refresh_token: "fixture-refresh",
          expires_in: 3600,
          refresh_expires_in: 3600,
        });
      if (url.endsWith("/userinfo")) return Response.json({ sub: "ordinary-person" });
      assert.match(url, /^https:\/\/center\.example\/realms\/node-(one|two)$/u);
      return new Response(null, { status: realmStatus });
    },
  });
  const host = await openDaemonHost({ daemonId: "edge-binding", userRoot, oidc });
  t.after(() => host.close());
  let discovery = "valid";
  const center = await listenFleetTls({
    host,
    stateRoot: path.join(root, "center"),
    key: readFileSync(keyFile),
    cert: readFileSync(certFile),
    authenticate: (_nodeId, credential) => credential === "fixture-machine-secret",
    nodeOwner: () => "ordinary-person",
    nodeSubject: async () => "service-node",
    loginAuthority: (nodeId) =>
      discovery === "missing"
        ? null
        : {
            url: discovery === "invalid" ? "http://center.example" : "https://center.example",
            realm: nodeId,
            clientId: `harness-node-${nodeId}`,
          },
  });
  t.after(() => center.close());
  for (const nodeId of ["node-one", "node-two"]) {
    const edgeRoot = path.join(root, nodeId);
    mkdirSync(edgeRoot);
    mkdirSync(path.join(edgeRoot, "harness"));
    writeFileSync(path.join(edgeRoot, "harness", "harness.yaml"), "schema: harness-anything/v1\n");
    writeFileSync(
      path.join(edgeRoot, "fleet-edge.json"),
      JSON.stringify({
        schema: "fleet-edge-config/v1",
        repoId: nodeId,
        host: "127.0.0.1",
        port: center.port,
        caPath: certFile,
        servername: "localhost",
        nodeId,
        credential: "fixture-machine-secret",
        viewRoot: edgeRoot,
        quotaBytes: 1024,
      }),
    );
    writeDaemonRegistryRepo({
      userRoot,
      canonicalRoot: edgeRoot,
      repoId: nodeId,
      mode: "remote-edge",
      authoredBranch: "main",
      createConvenienceLinks: false,
    });
  }
  const server = createJsonRpcProtocolServer({
    host,
    build: { commit: null },
    authContext: auth,
    emit: async () => undefined,
  });
  t.after(() => server.close());
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  const request = async (params: JsonObject): Promise<JsonObject> => {
    const reply = await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.rbac.manage", params });
    assert.ok(reply && !Array.isArray(reply) && "result" in reply);
    return reply.result as JsonObject;
  };
  const begun = await request({
    operation: "login-begin",
    repoId: "node-one",
    redirectUri: "http://127.0.0.1/callback",
  });
  assert.match(String(begun.authorizationUrl), /center\.example\/realms\/node-one/u);
  assert.equal(
    (await request({ operation: "login-complete", repoId: "node-one", code: "code", state: begun.state }))
      .authenticated,
    true,
  );
  assert.equal((await request({ operation: "session", repoId: "node-one" })).authenticated, true);
  await assert.rejects(oidc.requireRole("access-admin"), { code: "authorization_denied" });
  const binding = await request({ operation: "health", repoId: "node-one" });
  assert.equal(binding.ok, true);
  assert.equal(binding.ready, true, JSON.stringify(binding));
  assert.equal(binding.source, "fleet-center");
  assert.equal(binding.realm, "node-one");
  assert.equal(binding.clientId, "harness-node-node-one");
  assert.equal(JSON.stringify(binding).includes("secret"), false);
  assert.equal("clientSecret" in binding || "accessToken" in binding || "refreshToken" in binding, false);
  assert.equal(existsSync(path.join(userRoot, "rbac", "config.json")), false);
  assert.deepEqual(await request({ operation: "bootstrap-status", repoId: "node-one" }), {
    ...binding,
    required: false,
  });
  assert.equal((await request({ operation: "session-lifetime", repoId: "node-one" })).code, "authorization_denied");
  session = undefined;
  assert.equal((await request({ operation: "session" })).authenticated, false);
  assert.equal((await request({ operation: "health", repoId: "node-two" })).realm, "node-two");
  assert.equal((await request({ operation: "health", rootDir: path.join(root, "node-one") })).realm, "node-one");
  assert.equal((await request({ operation: "health", repoId: "unknown" })).code, "repo_namespace_unknown");
  assert.equal((await request({ operation: "health" })).code, "rbac_not_configured");
  realmStatus = 503;
  const unhealthy = await request({ operation: "health", repoId: "node-one" });
  assert.equal(unhealthy.ready, false);
  assert.equal(unhealthy.ok, false);
  assert.deepEqual(await request({ operation: "bootstrap-status", repoId: "node-one" }), {
    ...unhealthy,
    required: false,
  });
  for (const invalid of ["missing", "invalid"]) {
    discovery = invalid;
    const refused = await request({ operation: "health", repoId: "node-one" });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "oidc_listener_required");
  }
  await center.close();
  const unavailable = await request({ operation: "health", repoId: "node-one" });
  assert.equal(unavailable.ok, false);
  assert.notEqual(unavailable.code, "rbac_not_configured");
  assert.equal(unavailable.ready, undefined);
  const bootstrapUnavailable = await request({ operation: "bootstrap-status", repoId: "node-one" });
  assert.equal(bootstrapUnavailable.ok, false);
  assert.notEqual(bootstrapUnavailable.code, "rbac_not_configured");
});

test("local and center repository health still reads the daemon's managed RBAC binding", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-local-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const realm = createServer((request, response) => {
    assert.equal(request.url, "/realms/local-realm");
    response.writeHead(200, { "x-keycloak-version": "fixture" }).end();
  });
  await new Promise<void>((resolve) => realm.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => realm.close(() => resolve())));
  const url = `http://127.0.0.1:${(realm.address() as AddressInfo).port}`;
  mkdirSync(path.join(root, "rbac"));
  writeFileSync(
    path.join(root, "rbac", "config.json"),
    JSON.stringify({
      schema: "harness-managed-rbac/v1",
      mode: "external",
      url,
      realm: "local-realm",
      clientId: "local-client",
    }),
  );
  const host = await openDaemonHost({ daemonId: "local-binding", userRoot: root });
  t.after(() => host.close());
  for (const mode of ["local", "remote-center"] as const) {
    const repo = path.join(root, mode);
    mkdirSync(path.join(repo, "harness"), { recursive: true });
    writeFileSync(path.join(repo, "harness", "harness.yaml"), "schema: harness-anything/v1\n");
    writeDaemonRegistryRepo({
      userRoot: root,
      canonicalRoot: repo,
      repoId: mode,
      mode,
      authoredBranch: "main",
      createConvenienceLinks: false,
    });
    const binding = await host.manageRbac({ operation: "health", repoId: mode }, auth);
    assert.equal(binding.ready, true);
    assert.equal(binding.url, url);
    assert.equal(binding.clientId, "local-client");
    assert.equal(binding.source, undefined);
  }
});
