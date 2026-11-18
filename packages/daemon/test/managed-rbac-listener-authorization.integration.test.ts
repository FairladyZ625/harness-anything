// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { createIdentityManagement, createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { oidcCenterSelections } from "../src/daemon-host/oidc-center-selection.ts";
import { managedRbacVersions } from "@harness-anything/authorization-keycloak/managed-rbac-service";
import { daemonBuildStamp } from "../src/daemon-host/build-identity.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/daemon-host/protocol/version.ts";
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
  const runtimePlatform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    runtimeArch = process.arch === "x64" ? "x64" : "arm64";
  const managedRbac = createIdentityManagement(userRoot, {
    fetch: fetchPort,
    platform: runtimePlatform,
    arch: runtimeArch,
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

    // Remote fleet-tls, non-owner local sockets, and unix-socket callers missing owner boundary are all refused (RBAC-08).
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
    await assert.rejects(
      host.manageRbac({ operation: "listener-set", expectedVersion: brokenVersion }, { transportKind: "unix-socket" }),
      { code: "authentication_required" },
    );

    // Recover via self-signed over JSON-RPC from within the registered repository context (without rootDir too),
    // and verify recovery runs on the OIDC write queue and synchronously binds the new authority before returning (RBAC-09).
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
    const selfSignedConfig = JSON.parse(readFileSync(configFile, "utf8")) as {
      listener: { certificateFile: string; certificateKeyFile: string };
    };
    const selfSignedPem = readFileSync(selfSignedConfig.listener.certificateFile, "utf8");
    assert.equal(
      oidcCenterSelections(userRoot).read()?.authority.browserUrl,
      `https://center.example.test:${recoveredPort}`,
    );
    assert.equal(
      oidcCenterSelections(userRoot).read()?.authority.certificate,
      selfSignedPem,
      "recovered center selection carries the new listener certificate immediately",
    );

    // Corrupting the existing self-signed material (both files present with 0600 key) is also detected and repaired,
    // even when RPC explicitly passes mode=managed (RBAC-07), and serializes with concurrent OIDC queue work (RBAC-09).
    writeFileSync(selfSignedConfig.listener.certificateFile, "corrupted-pem\n");
    writeFileSync(selfSignedConfig.listener.certificateKeyFile, "corrupted-key\n", { mode: 0o600 });
    chmodSync(selfSignedConfig.listener.certificateKeyFile, 0o600);
    const corruptedRead = (await rpc.handle({
      jsonrpc: "2.0",
      id: "read-corrupted-listener",
      method: "daemon.rbac.manage",
      params: { operation: "listener", mode: "managed", rootDir },
    })) as { result?: { ok?: boolean; version?: string }; error?: unknown };
    assert.equal(corruptedRead.error, undefined, JSON.stringify(corruptedRead));
    assert.equal(corruptedRead.result?.ok, true);
    const repairedPort = await freePort();
    const repairPromise = host.manageRbac(
      {
        operation: "listener-set",
        mode: "managed",
        rootDir,
        certificateMode: "self-signed",
        listenAddress: "127.0.0.1",
        hostname: "center.example.test",
        port: repairedPort,
        expectedVersion: String(corruptedRead.result?.version),
      },
      auth,
    );
    const queuedAfter = oidc.serialize(async () => {
      // Because repairPromise enters OIDC's write queue synchronously before any await, queuedAfter cannot
      // execute until repairPromise has generated the new certificate, updated config, and synced #centerIdentity.
      const repairedConfig = JSON.parse(readFileSync(configFile, "utf8")) as {
        listener: { certificateFile: string; certificateKeyFile: string };
      };
      assert.notEqual(repairedConfig.listener.certificateFile, selfSignedConfig.listener.certificateFile);
      assert.equal(existsSync(selfSignedConfig.listener.certificateFile), false);
      const diskCert = readFileSync(repairedConfig.listener.certificateFile, "utf8");
      assert.notEqual(diskCert, "corrupted-pem\n");
      const authority = oidc.discovery("edge-node");
      assert.equal(authority?.url, `https://center.example.test:${repairedPort}`);
      const selection = oidcCenterSelections(userRoot).read(rootDir);
      assert.equal(selection?.authority.browserUrl, `https://center.example.test:${repairedPort}`);
      return { diskCert, authority, selection, repairedConfig };
    });
    const [repairedReply, queuedState] = await Promise.all([repairPromise, queuedAfter]);
    assert.equal(repairedReply.ok, true);
    const repairedPem = readFileSync(queuedState.repairedConfig.listener.certificateFile, "utf8");
    assert.equal(queuedState.diskCert, repairedPem);
    assert.equal(queuedState.authority?.certificate, repairedPem);
    assert.equal(queuedState.selection?.authority.certificate, repairedPem);

    // Delete the new self-signed key too and verify loopback recovery also succeeds and clears the listener binding.
    rmSync(queuedState.repairedConfig.listener.certificateKeyFile, { force: true });
    const loopbackVersion = String((await host.manageRbac({ operation: "listener", rootDir }, auth)).version);
    const loopbackRecovered = await host.manageRbac(
      { operation: "listener-set", rootDir, expectedVersion: loopbackVersion },
      auth,
    );
    assert.equal(loopbackRecovered.ok, true);
    assert.equal(loopbackRecovered.listener, null);
    assert.equal(oidcCenterSelections(userRoot).read(rootDir)?.authority.certificate, undefined);
    assert.equal(oidcCenterSelections(userRoot).read(rootDir)?.authority.url, "http://127.0.0.1:1");
    assert.equal((await host.manageRbac({ operation: "health" }, auth)).ready, true);

    // Once recovered and an administrator exists, non-broken listener-set enforces OIDC access-admin again.
    keycloak.account("person-owner");
    keycloak.accessAdmin("person-owner");
    assert.equal(existsSync(queuedState.repairedConfig.listener.certificateKeyFile), false);
    await assert.rejects(
      host.manageRbac({ operation: "listener-set", expectedVersion: String(loopbackRecovered.version) }, auth),
      { code: "authentication_required" },
    );
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("listener recovery rechecks authorization after both queues (RBAC-14)", { timeout: 90_000 }, async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-queue-toctou-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    sources = path.join(parent, "sources"),
    rbacRoot = path.join(userRoot, "rbac"),
    configFile = path.join(rbacRoot, "config.json"),
    repoId = "queue-toctou";
  rosterRepo(rootDir, repoId);
  registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  mkdirSync(path.join(rbacRoot, "runtime", "postgres", "bin"), { recursive: true });
  writeFileSync(path.join(rbacRoot, "runtime", "postgres", "bin", "postgres"), "");
  mkdirSync(sources, { recursive: true });
  const certA = path.join(sources, "a.crt"),
    keyA = path.join(sources, "a.key");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyA,
      "-out",
      certA,
      "-subj",
      "/CN=center.example.test",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:center.example.test,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  chmodSync(keyA, 0o600);
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
  keycloak.account("person-owner");
  keycloak.accessAdmin("person-owner");
  keycloak.account("person-member");
  let session: string | undefined, waitForManagedReadiness: (() => Promise<void>) | undefined;

  const fetchPort: typeof fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/realms/harness") {
      await waitForManagedReadiness?.();
      return Response.json({ realm: "harness" }, { status: 200 });
    }
    return keycloak.fetch(input, init);
  }) as typeof fetch;

  const runtimePlatform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    runtimeArch = process.arch === "x64" ? "x64" : "arm64";
  const managedRbac = createIdentityManagement(userRoot, {
    fetch: fetchPort,
    platform: runtimePlatform,
    arch: runtimeArch,
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
  const oidc = createIdentitySession(userRoot, {
    fetch: fetchPort,
    sessionStore: () => ({
      read: () => session,
      write: (value) => void (session = value),
      delete: () => void (session = undefined),
      retireBootstrap: () => undefined,
    }),
  });
  await managedRbac.run({
    operation: "listener-set",
    certificateMode: "domain",
    listenAddress: "127.0.0.1",
    hostname: "center.example.test",
    port: await freePort(),
    certificateFile: certA,
    certificateKeyFile: keyA,
    expectedVersion: String((await managedRbac.run({ operation: "listener" })).version),
  });
  const managedConfig = JSON.parse(readFileSync(configFile, "utf8")) as {
    listener: { certificateKeyFile: string };
  };
  const host = await openDaemonHost({
    daemonId: "queue-toctou",
    userRoot,
    oidc,
    managedRbac,
    runtimeDiscover: () => [],
  });
  try {
    await host.attachmentsSettled();
    // Break key permissions so owner recovery appears eligible at enqueue time.
    chmodSync(managedConfig.listener.certificateKeyFile, 0o644);
    const brokenVersion = String((await host.manageRbac({ operation: "listener", rootDir }, auth)).version);

    let releaseQueue!: () => void;
    const blockingWork = oidc.serialize(
      () =>
        new Promise<void>((resolve) => {
          releaseQueue = resolve;
        }),
    );
    const unauthenticatedQueued = host.manageRbac(
      {
        operation: "listener-set",
        rootDir,
        certificateMode: "self-signed",
        listenAddress: "127.0.0.1",
        hostname: "center.example.test",
        port: await freePort(),
        expectedVersion: brokenVersion,
      },
      auth,
    );
    // Repair key mode while the unauthenticated call waits behind blockingWork in OIDC's serializer.
    chmodSync(managedConfig.listener.certificateKeyFile, 0o600);
    releaseQueue();
    await blockingWork;
    await assert.rejects(unauthenticatedQueued, { code: "authentication_required" });

    // Now test a queued signed-in non-admin whose listener becomes healthy before reaching the queue head.
    chmodSync(managedConfig.listener.certificateKeyFile, 0o644);
    session = JSON.stringify({
      schema: "harness-oidc-session/v3",
      issuer: "http://127.0.0.1:1/realms/harness",
      accessToken: "token-person-member",
      refreshToken: "token-person-member",
      subject: "person-member",
      personId: "person-member",
      expiresAt: Date.now() + 3_600_000,
      sessionExpiresAt: Date.now() + 3_600_000,
      roles: ["access-admin"],
    });
    let releaseMemberQueue!: () => void;
    const blockingMemberWork = oidc.serialize(
      () =>
        new Promise<void>((resolve) => {
          releaseMemberQueue = resolve;
        }),
    );
    const memberQueued = host.manageRbac(
      {
        operation: "listener-set",
        rootDir,
        certificateMode: "self-signed",
        listenAddress: "127.0.0.1",
        hostname: "center.example.test",
        port: await freePort(),
        expectedVersion: brokenVersion,
      },
      auth,
    );
    chmodSync(managedConfig.listener.certificateKeyFile, 0o600);
    releaseMemberQueue();
    await blockingMemberWork;
    await assert.rejects(memberQueued, { code: "authorization_denied" });

    // The same non-admin can enter owner recovery while the key is missing. Hold a real
    // managed start in its readiness probe so that the lifecycle queue still owns the write.
    const probeEntered = Promise.withResolvers<void>(),
      releaseProbe = Promise.withResolvers<void>(),
      reachedLifecycle = Promise.withResolvers<void>(),
      previousKey = readFileSync(managedConfig.listener.certificateKeyFile),
      configBefore = readFileSync(configFile, "utf8"),
      recoveryPort = await freePort();
    waitForManagedReadiness = () => {
      probeEntered.resolve();
      return releaseProbe.promise;
    };
    const blockingStart = managedRbac.run({ operation: "start" });
    const originalRun = managedRbac.run.bind(managedRbac);
    t.mock.method(managedRbac, "run", (...args: Parameters<typeof managedRbac.run>) => {
      const queued = originalRun(...args);
      if (args[0].operation === "listener-set") reachedLifecycle.resolve();
      return queued;
    });
    try {
      await Promise.race([
        probeEntered.promise,
        blockingStart.then(() => assert.fail("managed start finished without entering readiness")),
      ]);
      rmSync(managedConfig.listener.certificateKeyFile);
      const recovery = host.manageRbac(
        {
          operation: "listener-set",
          rootDir,
          certificateMode: "self-signed",
          listenAddress: "127.0.0.1",
          hostname: "center.example.test",
          port: recoveryPort,
          expectedVersion: brokenVersion,
        },
        auth,
      );
      await Promise.race([
        reachedLifecycle.promise,
        recovery.then(() => assert.fail("recovery has not entered the lifecycle queue")),
      ]);
      writeFileSync(managedConfig.listener.certificateKeyFile, previousKey, { mode: 0o600 });
      releaseProbe.resolve();
      await assert.rejects(recovery, { code: "authorization_denied" });
      assert.equal(readFileSync(configFile, "utf8"), configBefore);
      assert.equal(await blockingStart.then((result) => result.ready), true);
    } finally {
      releaseProbe.resolve();
      await Promise.allSettled([blockingStart]);
    }
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("post-commit authority sync failures defer cleanly without RPC error or memory/disk split-brain (RBAC-17)", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-pending-sync-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    rbacRoot = path.join(userRoot, "rbac"),
    configFile = path.join(rbacRoot, "config.json"),
    repoId = "pending-sync";
  rosterRepo(rootDir, repoId);
  registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  mkdirSync(path.join(rbacRoot, "runtime", "postgres", "bin"), { recursive: true });
  writeFileSync(path.join(rbacRoot, "runtime", "postgres", "bin", "postgres"), "");
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
  let failDiscovery = false;
  const fetchPort: typeof fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/realms/harness") return Response.json({ realm: "harness" }, { status: 200 });
    if (failDiscovery && url.pathname.endsWith("/.well-known/openid-configuration"))
      return new Response("unavailable", { status: 503 });
    return keycloak.fetch(input, init);
  }) as typeof fetch;

  const runtimePlatform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    runtimeArch = process.arch === "x64" ? "x64" : "arm64";
  const managedRbac = createIdentityManagement(userRoot, {
    fetch: fetchPort,
    platform: runtimePlatform,
    arch: runtimeArch,
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
  const host = await openDaemonHost({
    daemonId: "pending-sync",
    userRoot,
    oidc,
    managedRbac,
    runtimeDiscover: () => [],
  });
  const selectionsDir = path.join(rbacRoot, "oidc-centers");
  try {
    await host.attachmentsSettled();
    // Seed initial loopback center selection before inducing post-commit discovery outage.
    await oidc.status(rootDir);
    const initialVersion = String((await host.manageRbac({ operation: "listener", rootDir }, auth)).version);
    const port1 = await freePort();
    failDiscovery = true;
    const partial = (await host.manageRbac(
      {
        operation: "listener-set",
        rootDir,
        certificateMode: "self-signed",
        listenAddress: "127.0.0.1",
        hostname: "center-1.example.test",
        port: port1,
        expectedVersion: initialVersion,
      },
      auth,
    )) as {
      ok?: boolean;
      version?: string;
      authoritySync?: { ok?: boolean; pending?: boolean; code?: string };
    };
    assert.equal(partial.ok, true);
    assert.equal(partial.authoritySync?.ok, false);
    assert.equal(partial.authoritySync?.pending, true);
    assert.equal(partial.authoritySync?.code, "oidc_discovery_unavailable");

    // Listener config is already committed on disk; reusing the old expectedVersion must conflict.
    const conflict = await host.manageRbac(
      {
        operation: "listener-set",
        rootDir,
        certificateMode: "self-signed",
        listenAddress: "127.0.0.1",
        hostname: "center-1.example.test",
        port: port1,
        expectedVersion: initialVersion,
      },
      auth,
    );
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "version_conflict");

    // Once discovery recovers, follow-up OIDC sync persists the pending target cleanly.
    failDiscovery = false;
    await oidc.status(rootDir);
    assert.equal(oidc.discovery("edge-node")?.url, `https://center-1.example.test:${port1}`);
    assert.equal(
      oidcCenterSelections(userRoot).read(rootDir)?.authority.browserUrl,
      `https://center-1.example.test:${port1}`,
    );

    // Now test oidc-centers directory write failure: selection must NOT stick in memory if disk write fails.
    if (process.platform !== "win32") {
      chmodSync(selectionsDir, 0o500);
      const port2 = await freePort();
      const writeDeferred = (await host.manageRbac(
        {
          operation: "listener-set",
          rootDir,
          certificateMode: "self-signed",
          listenAddress: "127.0.0.1",
          hostname: "center-2.example.test",
          port: port2,
          expectedVersion: String(partial.version),
        },
        auth,
      )) as {
        ok?: boolean;
        version?: string;
        authoritySync?: { ok?: boolean; pending?: boolean };
      };
      assert.equal(writeDeferred.ok, true);
      assert.equal(writeDeferred.authoritySync?.ok, false);
      assert.equal(writeDeferred.authoritySync?.pending, true);
      assert.equal(oidc.discovery("edge-node")?.url, `https://center-2.example.test:${port2}`);
      assert.equal(oidcCenterSelections(userRoot).read(rootDir), undefined);
      const selector = oidcCenterSelections(userRoot);
      assert.throws(() =>
        selector.write(rootDir, {
          issuer: `https://center-2.example.test:${port2}/realms/harness`,
          authority: { url: "http://127.0.0.1:1", realm: "harness", clientId: "harness-gui" },
        }),
      );
      assert.equal(selector.read(rootDir), undefined);

      chmodSync(selectionsDir, 0o700);
      await oidc.status(rootDir);
      assert.equal(oidc.discovery("edge-node")?.url, `https://center-2.example.test:${port2}`);
      assert.equal(
        oidcCenterSelections(userRoot).read(rootDir)?.authority.browserUrl,
        `https://center-2.example.test:${port2}`,
      );
    }
  } finally {
    if (existsSync(selectionsDir) && process.platform !== "win32") chmodSync(selectionsDir, 0o700);
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon host diagnoses and recovers a FIFO listener certificate without blocking (RBAC-18)", async () => {
  if (process.platform === "win32") return;
  const parent = mkdtempSync(path.join(tmpdir(), "ha-rbac-fifo-host-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    rbacRoot = path.join(userRoot, "rbac"),
    listenerDir = path.join(rbacRoot, "listener"),
    fifoCert = path.join(listenerDir, "blocked.fifo"),
    sources = path.join(parent, "sources"),
    certFile = path.join(sources, "cert.crt"),
    keyFile = path.join(sources, "cert.key"),
    configFile = path.join(rbacRoot, "config.json"),
    repoId = "fifo-recovery";
  rosterRepo(rootDir, repoId);
  registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  mkdirSync(path.join(rbacRoot, "runtime", "postgres", "bin"), { recursive: true });
  writeFileSync(path.join(rbacRoot, "runtime", "postgres", "bin", "postgres"), "");
  mkdirSync(listenerDir, { recursive: true, mode: 0o700 });
  mkdirSync(sources, { recursive: true });
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
      "/CN=center.example.test",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:center.example.test,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  chmodSync(keyFile, 0o600);
  execFileSync("mkfifo", [fifoCert]);
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
        listener: {
          address: "127.0.0.1",
          hostname: "center.example.test",
          port: 8443,
          certificateFile: fifoCert,
          certificateKeyFile: keyFile,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(rbacRoot, "center-client-secret"), "fixture-secret");
  const keycloak = fakeKeycloak("http://127.0.0.1:1/realms/harness"),
    fetchPort: typeof fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/realms/harness") return Response.json({ realm: "harness" }, { status: 200 });
      return keycloak.fetch(input, init);
    }) as typeof fetch,
    managedRbac = createIdentityManagement(userRoot, {
      fetch: fetchPort,
      platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
      arch: process.arch === "x64" ? "x64" : "arm64",
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
    }),
    oidc = createIdentitySession(userRoot, { fetch: fetchPort }),
    host = await openDaemonHost({
      daemonId: "fifo-recovery",
      userRoot,
      oidc,
      managedRbac,
      runtimeDiscover: () => [],
    });
  try {
    await host.attachmentsSettled();
    const diagnosed = await host.manageRbac({ operation: "listener", rootDir }, auth);
    assert.equal(diagnosed.ok, true);
    assert.equal(existsSync(fifoCert), true);
    const recovered = await host.manageRbac(
      { operation: "listener-set", rootDir, expectedVersion: String(diagnosed.version) },
      auth,
    );
    assert.equal(recovered.ok, true);
    assert.equal(recovered.listener, null);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
