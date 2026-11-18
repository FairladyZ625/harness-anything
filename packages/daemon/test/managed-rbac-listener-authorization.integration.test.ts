// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createIdentityManagement, createIdentitySession } from "../src/authorization-provider.ts";
import { managedRbacVersions } from "@harness-anything/authorization-keycloak/managed-rbac-service";
import { daemonBuildStamp } from "../src/build-identity.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { fakeKeycloak } from "./keycloak.fixtures.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";

test("the first-admin window closes and later listener changes require fleet policy", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-rbac-listener-auth-")),
    configFile = path.join(userRoot, "rbac", "config.json");
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(
    configFile,
    JSON.stringify({
      schema: "harness-managed-rbac/v1",
      mode: "managed",
      url: "http://127.0.0.1:1",
      realm: "harness",
      clientId: "harness-center",
      versions: managedRbacVersions,
      postgresPort: 2,
      managementPort: 3,
      stopped: true,
    }),
  );
  let session: string | undefined;
  const keycloak = fakeKeycloak("http://127.0.0.1:1/realms/harness");
  let invalidMembership = false;
  const signedIn = (roles: readonly string[], personId = "person-owner"): string =>
      JSON.stringify({
        schema: "harness-oidc-session/v3",
        issuer: "http://127.0.0.1:1/realms/harness",
        accessToken: `token-${personId}`,
        refreshToken: `token-${personId}`,
        subject: personId,
        personId,
        expiresAt: Date.now() + 3_600_000,
        sessionExpiresAt: Date.now() + 3_600_000,
        roles,
      }),
    oidc = createIdentitySession(userRoot, {
      fetch: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/.well-known/openid-configuration"))
          return Response.json({ issuer: "http://127.0.0.1:1/realms/harness" });
        if (invalidMembership && new URL(url).pathname === "/admin/realms/harness/users") return Response.json({});
        return keycloak.fetch(input, init);
      }) as typeof fetch,
      sessionStore: () => ({
        read: () => session,
        write: (value) => void (session = value),
        delete: () => void (session = undefined),
        retireBootstrap: () => undefined,
      }),
    });
  writeFileSync(path.join(userRoot, "rbac", "center-client-secret"), "fixture-secret");
  const before = readFileSync(configFile, "utf8"),
    host = await openDaemonHost({ daemonId: "listener-authorization", userRoot, oidc }),
    change = {
      rootDir: userRoot,
      operation: "listener-set",
      listenAddress: "127.0.0.1",
      hostname: "center.example.test",
      port: 8443,
      certificateFile: "/nonexistent/center.crt",
      certificateKeyFile: "/nonexistent/center.key",
    } as const;
  try {
    const current = String((await host.manageRbac({ operation: "listener" }, auth)).version);
    // D1 reaches the original TLS validation while there is no administrator.
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "rbac_listener_invalid",
    });
    assert.throws(() => host.manageRbac({ ...change, expectedVersion: current }, { transportKind: "fleet-tls" }), {
      code: "local_transport_required",
    });
    const administrator = {
      operation: "bootstrap-admin",
      username: "owner",
      email: "owner@example.invalid",
      displayName: "Owner",
      password: "private-test-password",
      personId: "person-owner",
    } as const;
    // Both operations are submitted before the first succeeds; the queued listener must observe its result.
    const results = await Promise.allSettled([
      host.manageRbac(administrator, auth),
      host.manageRbac(administrator, auth),
      host.manageRbac({ ...change, expectedVersion: current }, auth),
    ]);
    assert.equal(results[0]!.status, "fulfilled");
    assert.equal(JSON.stringify(results[0]).includes(administrator.password), false);
    assert.equal(results[1]!.status, "rejected");
    assert.equal((results[1] as PromiseRejectedResult).reason.code, "bootstrap_admin_closed");
    assert.equal(results[2]!.status, "rejected");
    assert.equal((results[2] as PromiseRejectedResult).reason.code, "authentication_required");
    assert.equal((await oidc.bootstrapStatus()).required, false);
    assert.equal(keycloak.realmRoles.has("access-admin"), false);
    keycloak.interactiveSession("person-owner", "bootstrap-login", "http://127.0.0.1:1");
    keycloak.account("person-member");
    session = signedIn(["access-admin"], "person-member");
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "authorization_denied",
    });
    await assert.rejects(
      host.manageRbac(
        {
          rootDir: userRoot,
          mode: "external",
          url: "https://identity.example.test",
          realm: "fleet",
          clientId: "harness-center",
          clientSecret: "unused",
        },
        auth,
      ),
      {
        code: "authorization_denied",
      },
    );
    // An access administrator's request is the one that reaches the listener: it is judged on its content.
    session = signedIn([]);
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "rbac_listener_invalid",
    });
    assert.equal((await host.manageRbac({ ...change, expectedVersion: "stale" }, auth)).code, "version_conflict");
    session = JSON.stringify({ ...JSON.parse(signedIn([])), expiresAt: Date.now() - 1 });
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      code: "rbac_listener_invalid",
    });
    assert.equal(
      JSON.parse(session!).refreshToken,
      "token-person-owner",
      "renewal inside the listener queue finishes without nesting the queue",
    );
    invalidMembership = true;
    await assert.rejects(host.manageRbac({ ...change, expectedVersion: current }, auth), {
      name: "TypeError",
    });
    await assert.rejects(host.manageRbac(administrator, auth), { name: "TypeError" });
    assert.equal(readFileSync(configFile, "utf8"), before);
  } finally {
    await host.close();
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

test("local socket owner recovers a managed listener whose private key was deleted from a registered repository context", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-listener-recover-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    externalDir = path.join(parent, "external-tls"),
    externalCert = path.join(externalDir, "oidc.crt"),
    externalKey = path.join(externalDir, "oidc.key"),
    rbacRoot = path.join(userRoot, "rbac"),
    configFile = path.join(rbacRoot, "config.json"),
    repoId = "listener-recovery";
  rosterRepo(rootDir, repoId);
  registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  mkdirSync(path.join(rbacRoot, "runtime", "postgres", "bin"), { recursive: true });
  writeFileSync(path.join(rbacRoot, "runtime", "postgres", "bin", "postgres"), "");
  mkdirSync(externalDir, { recursive: true });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      externalKey,
      "-out",
      externalCert,
      "-subj",
      "/CN=center.example.test",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:center.example.test,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  chmodSync(externalKey, 0o600);
  writeFileSync(
    configFile,
    `${JSON.stringify(
      {
        schema: "harness-managed-rbac/v1",
        mode: "managed",
        url: "http://127.0.0.1:1",
        realm: "harness",
        clientId: "harness-center",
        versions: managedRbacVersions,
        postgresPort: 2,
        managementPort: 3,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(rbacRoot, "center-client-secret"), "fixture-secret");
  const keycloak = fakeKeycloak("http://127.0.0.1:1/realms/harness");
  const fetchPort: typeof fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/realms/harness") return Response.json({ realm: "harness" }, { status: 200 });
    return keycloak.fetch(input, init);
  }) as typeof fetch;
  const managedRbac = createIdentityManagement(userRoot, {
    fetch: fetchPort,
    platform: "darwin",
    arch: "arm64",
    spawn: ((command: string) => {
      const name = path.basename(command),
        child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          kill: () => setImmediate(() => child.emit("exit", 0)),
        });
      setImmediate(() =>
        name.startsWith("postgres")
          ? child.stdout.emit("data", "database system is ready to accept connections")
          : child.stdout.emit("data", "Keycloak 26 started in 1s"),
      );
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
  });
  const oidc = createIdentitySession(userRoot, { fetch: fetchPort });
  const initialPort = await freePort();
  await managedRbac.run({
    operation: "listener-set",
    certificateMode: "domain",
    listenAddress: "127.0.0.1",
    hostname: "center.example.test",
    port: initialPort,
    certificateFile: externalCert,
    certificateKeyFile: externalKey,
    expectedVersion: String((await managedRbac.run({ operation: "listener" })).version),
  });
  // External deletion no longer breaks restarts because the listener cert/key were copied into rbac/listener/.
  rmSync(externalDir, { recursive: true, force: true });
  await managedRbac.stop();

  const managedConfig = JSON.parse(readFileSync(configFile, "utf8")) as {
    listener: { certificateFile: string; certificateKeyFile: string };
  };
  assert.equal(managedConfig.listener.certificateFile.startsWith(path.join(rbacRoot, "listener")), true);
  assert.equal(managedConfig.listener.certificateKeyFile.startsWith(path.join(rbacRoot, "listener")), true);
  // Now physically delete the managed private key so resume() fails with rbac_listener_key_exposed.
  rmSync(managedConfig.listener.certificateKeyFile, { force: true });

  const host = await openDaemonHost({
    daemonId: "listener-recovery",
    userRoot,
    oidc,
    managedRbac,
    runtimeDiscover: () => [],
  });
  try {
    await host.attachmentsSettled();
    // Normal repository RPCs still observe the broken resume failure.
    const blocked = await host.run(repoId, { kind: "task-list" }, auth);
    assert.equal(blocked.outcome, "op_rejected");
    assert.equal(blocked.code, "rbac_listener_key_exposed");

    // sessionPrincipal must not deadlock listener/listener-set inside a registered repository context.
    assert.equal(
      await host.sessionPrincipal(auth, "daemon.rbac.manage", { operation: "listener", rootDir }),
      undefined,
    );
    assert.equal(
      await host.sessionPrincipal(auth, "daemon.rbac.manage", { operation: "listener-set", rootDir }),
      undefined,
    );

    // JSON-RPC dispatch for listener and listener-set also skips sessionPrincipal deadlock.
    const protocolVersion = currentDaemonProtocolVersion;
    const rpc = createJsonRpcProtocolServer({
      host,
      authContext: { ...auth },
      sessionPrincipal: (method, params) => host.sessionPrincipal(auth, method, params),
      emit: async () => {},
      build: daemonBuildStamp(),
    });
    await rpc.handle({
      jsonrpc: "2.0",
      id: "hello",
      method: "protocol.hello",
      params: { protocolVersion },
    });
    const listenerReply = (await rpc.handle({
      jsonrpc: "2.0",
      id: "read-listener",
      method: "daemon.rbac.manage",
      params: { operation: "listener", rootDir },
    })) as { result?: { ok?: boolean; version?: string }; error?: unknown };
    assert.equal(listenerReply.error, undefined, JSON.stringify(listenerReply));
    assert.equal(listenerReply.result?.ok, true);
    const brokenVersion = String(listenerReply.result?.version);

    // Remote fleet-tls and non-owner local sockets are still refused even in broken state.
    assert.throws(
      () =>
        host.manageRbac({ operation: "listener-set", expectedVersion: brokenVersion }, { transportKind: "fleet-tls" }),
      {
        code: "local_transport_required",
      },
    );
    await assert.rejects(
      host.manageRbac(
        { operation: "listener-set", expectedVersion: brokenVersion },
        { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: (process.getuid?.() ?? 1000) + 1 } },
      ),
      { code: "authentication_required" },
    );

    // Recover via self-signed over JSON-RPC from within the registered repository context (without rootDir too).
    const recoveredPort = await freePort();
    const recoveredReply = (await rpc.handle({
      jsonrpc: "2.0",
      id: "recover-self-signed",
      method: "daemon.rbac.manage",
      params: {
        operation: "listener-set",
        certificateMode: "self-signed",
        listenAddress: "127.0.0.1",
        hostname: "center.example.test",
        port: recoveredPort,
        expectedVersion: brokenVersion,
      },
    })) as {
      result?: { ok?: boolean; certificateMode?: string; version?: string };
      error?: unknown;
    };
    assert.equal(recoveredReply.error, undefined, JSON.stringify(recoveredReply));
    assert.equal(recoveredReply.result?.ok, true);
    assert.equal(recoveredReply.result?.certificateMode, "self-signed");
    assert.equal((await host.manageRbac({ operation: "health" }, auth)).ready, true);

    // Delete the new self-signed key too and verify loopback recovery also succeeds.
    const selfSignedConfig = JSON.parse(readFileSync(configFile, "utf8")) as {
      listener: { certificateKeyFile: string };
    };
    rmSync(selfSignedConfig.listener.certificateKeyFile, { force: true });
    const loopbackVersion = String((await host.manageRbac({ operation: "listener", rootDir }, auth)).version);
    const loopbackRecovered = await host.manageRbac(
      { operation: "listener-set", expectedVersion: loopbackVersion },
      auth,
    );
    assert.equal(loopbackRecovered.ok, true);
    assert.equal(loopbackRecovered.listener, null);
    assert.equal((await host.manageRbac({ operation: "health" }, auth)).ready, true);

    // Once recovered and an administrator exists, non-broken listener-set enforces OIDC access-admin again.
    keycloak.account("person-owner");
    keycloak.accessAdmin("person-owner");
    assert.equal(existsSync(selfSignedConfig.listener.certificateKeyFile), false);
    await assert.rejects(
      host.manageRbac({ operation: "listener-set", expectedVersion: String(loopbackRecovered.version) }, auth),
      { code: "authentication_required" },
    );
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
