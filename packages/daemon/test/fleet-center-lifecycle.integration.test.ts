// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, Server as TlsServer } from "node:tls";
import test, { type TestContext } from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { managedRbacVersions } from "@harness-anything/authorization-keycloak/managed-rbac-service";
import { createIdentityManagement, createIdentitySession } from "../src/authorization-provider.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import type { DaemonHostOpenInput } from "../src/daemon-host-types.ts";
import { openRepoCell } from "../src/repo-cell-open.ts";
import {
  fleetCenterConfigPath,
  parseFleetCenterExternalUrl,
  readFleetCenterCertificatePaths,
  readFleetCenterConfig,
  saveFleetCenterConfig,
} from "../src/fleet-center-config.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { fakeKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import type { DaemonLifecycleEntry } from "../src/lifecycle-log.ts";

function generateLocalhostCert(keyPath: string, certPath: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-lifecycle-")),
    userRoot = path.join(root, "user"),
    repo = path.join(root, "repo"),
    keyPath = path.join(root, "tls.key"),
    certPath = path.join(root, "tls.crt"),
    repoId = "center-lifecycle";
  rosterRepo(repo, repoId);
  registerBootstrappedDaemonRepo({ canonicalRoot: repo, repoId, userRoot, createConvenienceLinks: false });
  signInPolicyTestUser(userRoot, "writer", [repoId], "admin");
  generateLocalhostCert(keyPath, certPath);
  const hosts: Awaited<ReturnType<typeof openDaemonHost>>[] = [];
  t.after(async () => {
    for (const host of hosts) await host.close();
    rmSync(root, { recursive: true, force: true });
  });
  const open = async (
    daemonId: string,
    records: DaemonLifecycleEntry[] = [],
    openCell?: DaemonHostOpenInput["openCell"],
    managedRbac?: DaemonHostOpenInput["managedRbac"],
  ) => {
    const host = await openDaemonHost({
      daemonId,
      userRoot,
      openCell,
      ...(managedRbac ? { managedRbac } : {}),
      recordLifecycle: (entry) => records.push(entry),
    });
    hosts.push(host);
    return host;
  };
  return {
    root,
    userRoot,
    keyPath,
    certPath,
    open,
    request: { port: 0, keyPath, certPath, repoId, quotaBytes: 1024 * 1024 },
  };
}

async function handshake(port: number, certPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, ca: readFileSync(certPath), servername: "localhost" });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      socket.destroy();
      resolve();
    });
  });
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

test(
  "successful starts persist actual ports and restore separate daemon identities through host open",
  { timeout: 300_000 },
  async (t) => {
    const f = await fixture(t),
      first = await f.open("a/b");
    await first.attachmentsSettled();
    const a = await first.fleet.startCenter({ ...f.request, stateRoot: path.join(f.root, "a") }, auth),
      otherPort = await unusedPort();
    // Both identities share one canonical repository, whose writer belongs to only one host at a time.
    await first.close();
    const second = await f.open("a?b");
    await second.attachmentsSettled();
    const b = await second.fleet.startCenter(
        { ...f.request, port: otherPort, stateRoot: path.join(f.root, "b") },
        auth,
      ),
      aFile = fleetCenterConfigPath(f.userRoot, "a/b"),
      bFile = fleetCenterConfigPath(f.userRoot, "a?b");
    assert.notEqual(aFile, bFile);
    assert.notEqual(a.port, b.port);
    assert.equal(readFleetCenterConfig(f.userRoot, "a/b")?.port, a.port);
    assert.equal(readFleetCenterConfig(f.userRoot, "a?b")?.port, b.port);
    assert.equal(readFleetCenterConfig(path.join(f.root, "other-user"), "a/b"), null);
    const saved = JSON.parse(readFileSync(aFile, "utf8"));
    assert.deepEqual(
      Object.keys(saved).sort(),
      ["schema", "port", "bind", "keyPath", "certPath", "repoId", "quotaBytes", "stateRoot"].sort(),
    );
    assert.equal(saved.keyPath, f.keyPath);
    assert.equal(saved.certPath, f.certPath);
    await second.close();
    const restoredFirst = await f.open("a/b");
    await handshake(Number(a.port), f.certPath);
    await restoredFirst.close();
    const restoredSecond = await f.open("a?b");
    await handshake(Number(b.port), f.certPath);
    await restoredSecond.close();
    const records: DaemonLifecycleEntry[] = [];
    await f.open("never-enabled", records);
    assert.equal(existsSync(fleetCenterConfigPath(f.userRoot, "never-enabled")), false);
    assert.equal(
      records.some((r) => r.event === "fleet_center_restore_failed"),
      false,
    );
  },
);

test(
  "wildcard listeners use a separately configured external origin covered by the certificate",
  { timeout: 300_000 },
  async (t) => {
    const f = await fixture(t),
      host = await f.open("external-address"),
      port = await unusedPort(),
      externalUrl = `https://localhost:${port}`,
      started = await host.fleet.startCenter({ ...f.request, port, bind: "0.0.0.0", externalUrl }, auth);
    assert.equal(started.ok, true);
    assert.equal(started.bind, "0.0.0.0");
    assert.equal(readFleetCenterConfig(f.userRoot, "external-address")?.externalUrl, externalUrl);
    await handshake(port, f.certPath);
    await assert.rejects(
      host.fleet.startCenter(
        { ...f.request, port: await unusedPort(), bind: "0.0.0.0", externalUrl: "https://uncovered.invalid:7545" },
        auth,
      ),
      /TLS certificate SAN does not cover uncovered\.invalid/u,
    );
    const saved = await host.fleet.setCenterExternalAddress({ externalUrl }, auth);
    assert.equal(saved.externalUrl, externalUrl);
    assert.equal((await host.fleet.readCenterExternalAddress(auth)).externalUrl, externalUrl);
    const unreachableUrl = `https://127.0.0.1:${await unusedPort()}`,
      unreachable = await host.fleet.setCenterExternalAddress({ externalUrl: unreachableUrl }, auth);
    assert.equal(unreachable.externalUrl, unreachableUrl);
    assert.match(String(unreachable.warning), /could not reach/u);
    assert.equal(readFleetCenterConfig(f.userRoot, "external-address")?.externalUrl, unreachableUrl);
    assert.throws(() => parseFleetCenterExternalUrl("https://[::]:7545"), /complete HTTPS origin/u);
  },
);

test(
  "an unenabled successor does not listen and invalid saved references report restore failure",
  { timeout: 300_000 },
  async (t) => {
    const f = await fixture(t),
      first = await f.open("enabled"),
      started = await first.fleet.startCenter(f.request, auth);
    await first.close();
    await f.open("never-enabled");
    await assert.rejects(handshake(Number(started.port), f.certPath), { code: "ECONNREFUSED" });
    const file = fleetCenterConfigPath(f.userRoot, "enabled"),
      saved = readFileSync(file, "utf8");
    for (const body of [
      "{bad json",
      JSON.stringify({ schema: "fleet-center-config/v1", port: 0 }),
      JSON.stringify({ ...JSON.parse(saved), keyPath: path.join(f.root, "missing.key") }),
      JSON.stringify({ ...JSON.parse(saved), repoId: "not-registered" }),
    ]) {
      writeFileSync(file, body);
      const records: DaemonLifecycleEntry[] = [],
        host = await f.open("enabled", records);
      assert.equal(records.filter((r) => r.event === "fleet_center_restore_failed").length, 1);
      assert.ok(records.find((r) => r.event === "fleet_center_restore_failed")?.error);
      await assert.rejects(handshake(Number(started.port), f.certPath), { code: "ECONNREFUSED" });
      await host.close();
    }
    // The local control path remains reachable after a failed restore, so an authorized start repairs it.
    const repaired = await f.open("enabled");
    const result = await repaired.fleet.startCenter({ ...f.request, port: Number(started.port) }, auth);
    assert.equal(result.ok, true);
    await handshake(Number(result.port), f.certPath);
  },
);

test(
  "repair after failed restore waits for attachment before reading persisted replica status",
  { timeout: 300_000 },
  async (t) => {
    const f = await fixture(t),
      first = await f.open("warming-repair"),
      started = await first.fleet.startCenter(f.request, auth);
    await first.close();
    // The persisted-replica-status surface the old ack store seeded retired with it; the center
    // now reports slot state, and the parking-behind-attachment behavior below is what this case
    // proves without it.
    const file = fleetCenterConfigPath(f.userRoot, "warming-repair"),
      saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, keyPath: path.join(f.root, "missing.key") }));
    let entered!: () => void, release!: () => void;
    const opening = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      released = new Promise<void>((resolve) => {
        release = resolve;
      }),
      records: DaemonLifecycleEntry[] = [],
      host = await f.open("warming-repair", records, async (input) => {
        entered();
        await released;
        return openRepoCell(input);
      });
    assert.match(
      String(records.find((entry) => entry.event === "fleet_center_restore_failed")?.error),
      /missing\.key/u,
    );
    assert.equal(host.status().repos.find((repo) => repo.repoId === f.request.repoId)?.state, "warming");
    let settled = false;
    const repair = host.fleet.startCenter({ ...f.request, port: Number(started.port) }, auth);
    void repair.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      // The start itself must initiate and park behind attachment, without a test-side readiness call.
      await Promise.race([
        opening,
        repair.then(() => {
          throw new Error("repair completed before attachment");
        }),
      ]);
      assert.equal(settled, false);
    } finally {
      release();
      await repair.then(
        () => undefined,
        () => undefined,
      );
    }
    const result = await repair;
    assert.equal(result.ok, true);
    assert.equal(result.serviceStatus, "listening");
    assert.equal(host.status().repos.find((repo) => repo.repoId === f.request.repoId)?.state, "attached");
    await handshake(Number(result.port), f.certPath);
  },
);

test("a save failure rejects start and closes its unrecorded listener", { timeout: 300_000 }, async (t) => {
  const f = await fixture(t),
    host = await f.open("save-failure"),
    port = await unusedPort(),
    file = fleetCenterConfigPath(f.userRoot, "save-failure");
  mkdirSync(file, { recursive: true });
  await assert.rejects(
    host.fleet.startCenter({ ...f.request, port, externalUrl: `https://localhost:${port}` }, auth),
    /not listening.*EISDIR|not listening.*ENOTEMPTY|not listening.*EPERM/u,
  );
  await assert.rejects(handshake(port, f.certPath), { code: "ECONNREFUSED" });
  rmSync(file, { recursive: true });
  const retry = await host.fleet.startCenter({ ...f.request, port }, auth);
  assert.equal(retry.ok, true);
  await handshake(port, f.certPath);
});

test(
  "concurrent authorized starts publish only one daemon listener and one enabled intent",
  { timeout: 300_000 },
  async (t) => {
    const f = await fixture(t),
      host = await f.open("concurrent");
    const outcomes = await Promise.allSettled([
      host.fleet.startCenter(f.request, auth),
      host.fleet.startCenter(f.request, auth),
    ]);
    const applied = outcomes.filter((result) => result.status === "fulfilled");
    const rejected = outcomes.filter((result) => result.status === "rejected");
    assert.equal(applied.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.reason.code, "fleet_center_running");
    assert.equal(readFleetCenterConfig(f.userRoot, "concurrent")?.port, applied[0]!.value.port);
    await handshake(Number(applied[0]!.value.port), f.certPath);
  },
);

test(
  "restored centers replace the same and different ports only after valid input",
  { timeout: 300_000 },
  async (t) => {
    const f = await fixture(t),
      initial = await f.open("replace"),
      externalUrl = `https://localhost:${await unusedPort()}`,
      original = await initial.fleet.startCenter({ ...f.request, externalUrl }, auth);
    await initial.close();
    const restored = await f.open("replace"),
      file = fleetCenterConfigPath(f.userRoot, "replace"),
      saved = readFileSync(file, "utf8"),
      port = Number(original.port);
    // Bootstrap Git subprocesses can inherit the listener until exec; settle that fixture work before rebinding.
    await restored.read(f.request.repoId, "repo.tasks.list", {}, auth);
    await restored.settleMaterialization(f.request.repoId, "restored center replacement fixture ready");
    const badCert = path.join(f.root, "invalid.crt");
    writeFileSync(badCert, "not a certificate");
    const replacementKey = path.join(f.root, "replacement.key"),
      replacementCert = path.join(f.root, "replacement.crt");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        replacementKey,
        "-out",
        replacementCert,
        "-subj",
        "/CN=127.0.0.1",
        "-days",
        "1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    for (const invalid of [
      { port: -1 },
      { port: 65536 },
      { quotaBytes: 0 },
      { quotaBytes: 1.5 },
      { bind: "" },
      { bind: "invalid.invalid" },
      { stateRoot: "" },
      { keyPath: path.join(f.root, "missing.key") },
      { certPath: badCert },
      { certPath: replacementCert, keyPath: replacementKey },
      { repoId: "unknown" },
      { stateRoot: badCert },
      { keyPath: "bad\0path" },
    ]) {
      await assert.rejects(restored.fleet.startCenter({ ...f.request, ...invalid }, auth));
      await handshake(port, f.certPath);
      assert.equal(readFileSync(file, "utf8"), saved);
    }
    const same = await restored.fleet.startCenter({ ...f.request, port, quotaBytes: f.request.quotaBytes + 1 }, auth);
    assert.equal(same.replaced, true);
    assert.equal(same.serviceStatus, "listening");
    assert.equal(same.port, port);
    assert.equal(same.externalUrl, externalUrl);
    assert.equal(readFleetCenterConfig(f.userRoot, "replace")?.externalUrl, externalUrl);
    await handshake(port, f.certPath);
    const otherPort = await unusedPort(),
      different = await restored.fleet.startCenter({ ...f.request, port: otherPort }, auth);
    assert.equal(different.replaced, true);
    assert.equal(different.port, otherPort);
    assert.equal(different.externalUrl, externalUrl);
    assert.equal(readFleetCenterConfig(f.userRoot, "replace")?.externalUrl, externalUrl);
    await assert.rejects(handshake(port, f.certPath), { code: "ECONNREFUSED" });
    await handshake(otherPort, f.certPath);
    const changedUrl = `https://127.0.0.1:${otherPort}`,
      changed = await restored.fleet.startCenter({ ...f.request, port: otherPort, externalUrl: changedUrl }, auth);
    assert.equal(changed.externalUrl, changedUrl);
    assert.equal(readFleetCenterConfig(f.userRoot, "replace")?.externalUrl, changedUrl);
    await restored.close();
    await f.open("replace");
    await handshake(otherPort, f.certPath);
    assert.equal(readFleetCenterConfig(f.userRoot, "replace")?.port, otherPort);
    assert.equal(readFleetCenterConfig(f.userRoot, "replace")?.externalUrl, changedUrl);
  },
);

test(
  "failed replacement startup leaves no listener and restart restores the last successful intent",
  { timeout: 300_000 },
  async (t) => {
    const f = await fixture(t),
      host = await f.open("bind-failure"),
      original = await host.fleet.startCenter(f.request, auth),
      file = fleetCenterConfigPath(f.userRoot, "bind-failure"),
      saved = readFileSync(file, "utf8"),
      occupied = net.createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    t.after(
      () => new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve()))),
    );
    const port = (occupied.address() as net.AddressInfo).port;
    await assert.rejects(host.fleet.startCenter({ ...f.request, port }, auth), (error: Error & { code?: string }) => {
      assert.equal(error.code, "fleet_center_start_failed");
      assert.match(error.message, /not listening.*EADDRINUSE/u);
      assert.match(error.message, /last successfully saved configuration.*no automatic rollback/u);
      return true;
    });
    assert.equal(readFileSync(file, "utf8"), saved);
    await assert.rejects(handshake(Number(original.port), f.certPath), { code: "ECONNREFUSED" });
    await host.close();
    await f.open("bind-failure");
    await handshake(Number(original.port), f.certPath);
  },
);

test(
  "failed replacement save closes the new listener and preserves last successful intent for restart",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX directory-permission semantics; Windows exposes ACL permissions instead of chmod semantics"
        : false,
  },
  async (t) => {
    const f = await fixture(t),
      host = await f.open("replace-save-failure"),
      original = await host.fleet.startCenter(f.request, auth),
      file = fleetCenterConfigPath(f.userRoot, "replace-save-failure"),
      saved = readFileSync(file, "utf8"),
      directory = path.dirname(file),
      port = await unusedPort();
    chmodSync(directory, 0o500);
    try {
      await assert.rejects(host.fleet.startCenter({ ...f.request, port }, auth), (error: Error & { code?: string }) => {
        assert.equal(error.code, "fleet_center_start_failed");
        assert.match(error.message, /not listening.*EACCES/u);
        return true;
      });
      assert.equal(readFileSync(file, "utf8"), saved);
      await assert.rejects(handshake(port, f.certPath), { code: "ECONNREFUSED" });
      await assert.rejects(handshake(Number(original.port), f.certPath), { code: "ECONNREFUSED" });
    } finally {
      chmodSync(directory, 0o700);
    }
    await host.close();
    await f.open("replace-save-failure");
    await handshake(Number(original.port), f.certPath);
  },
);

test(
  "a start without a certificate pair reuses the login listener pair and the status read reports it",
  { timeout: 300_000 },
  async (t) => {
    const f = await fixture(t),
      // Hermetic login service stand-in: only the certificate pair is answered; nothing is started.
      host = await f.open("reuse-login-certificate", [], undefined, {
        run: async () => {
          throw new Error("the login service lifecycle is not part of this test");
        },
        resume: async () => undefined,
        stop: async () => undefined,
        loginListenerCertificate: () => ({ certificateFile: f.certPath, certificateKeyFile: f.keyPath }),
      }),
      before = await host.fleet.readCenterState(auth);
    assert.equal(before.running, false);
    assert.equal(before.repoId, null);
    assert.equal(before.uploads, null);
    const started = await host.fleet.startCenter(
      { port: 0, repoId: f.request.repoId, quotaBytes: f.request.quotaBytes, bind: "127.0.0.1" },
      auth,
    );
    assert.equal(started.ok, true);
    assert.equal(started.serviceStatus, "listening");
    // The resolved pair is what gets persisted, so a daemon restart restores the same certificate.
    assert.equal(readFleetCenterConfig(f.userRoot, "reuse-login-certificate")?.keyPath, f.keyPath);
    assert.equal(readFleetCenterConfig(f.userRoot, "reuse-login-certificate")?.certPath, f.certPath);
    const status = await host.fleet.readCenterState(auth);
    assert.equal(status.running, true);
    assert.equal(status.port, started.port);
    assert.equal(status.bind, "127.0.0.1");
    assert.equal(status.repoId, f.request.repoId);
    assert.equal(status.certificateSource, "login-listener");
    assert.deepEqual(status.uploads, { limit: 64, receiving: 0, staged: 0, nodes: [] });
    await host.close();
    const restored = await f.open("reuse-login-certificate", [], undefined, {
      run: async () => {
        throw new Error("the login service lifecycle is not part of this test");
      },
      resume: async () => undefined,
      stop: async () => undefined,
      loginListenerCertificate: () => ({ certificateFile: f.certPath, certificateKeyFile: f.keyPath }),
    });
    assert.equal((await restored.fleet.readCenterState(auth)).running, true);
    await restored.close();
  },
);

test(
  "a start without any reusable login listener certificate is refused, not defaulted further",
  { timeout: 300_000 },
  async (t) => {
    const f = await fixture(t),
      host = await f.open("no-certificate");
    await assert.rejects(
      host.fleet.startCenter({ port: 0, repoId: f.request.repoId, quotaBytes: f.request.quotaBytes }, auth),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "rbac_listener_invalid");
        assert.match(error.message, /no listener certificate to reuse/u);
        return true;
      },
    );
    // Half a pair is a caller mistake, not a defaultable state.
    await assert.rejects(
      host.fleet.startCenter(
        { port: 0, repoId: f.request.repoId, quotaBytes: f.request.quotaBytes, keyPath: f.keyPath },
        auth,
      ),
      (error: Error & { code?: string }) => error.code === "invalid_field",
    );
    assert.equal(existsSync(fleetCenterConfigPath(f.userRoot, "no-certificate")), false);
  },
);

test(
  "host close cuts a peer that completed the TLS handshake but never sent its Fleet hello",
  { timeout: 300_000 },
  async (t) => {
    // The bug: `close()` cut only hello-registered sessions, so a peer that stalled after the
    // handshake held `server.close` until its own hello timer fired.
    const f = await fixture(t),
      host = await f.open("unhelled-close"),
      started = await host.fleet.startCenter(f.request, auth),
      // A peer that owns an accepted socket without ever becoming a session: `sessions` is populated
      // only when the hello frame is dispatched, so this connection belongs to the listener alone.
      // The handshake must complete first. A bare TCP connect does not hold `server.close` on Node
      // v24, so it cannot detect this regression; a TLS socket that never sends its hello does — its
      // `serve()` armed the hello timer, and `server.close` would wait out that whole window before
      // the timer cut the socket.
      silent = connect({
        host: "127.0.0.1",
        port: Number(started.port),
        ca: readFileSync(f.certPath),
        servername: "localhost",
      });
    t.after(() => silent.destroy());
    await new Promise<void>((resolve, reject) => {
      silent.once("secureConnect", resolve);
      silent.once("error", reject);
    });
    assert.equal(silent.destroyed, false, "the probe must hold a live socket when close starts");
    // A hello-less TLS peer must not hold the center close open. The test timeout is the hang guard;
    // the race against a resolving timer that used to encode the bound only decided by the wall clock.
    await host.close();
  },
);

function createManagedRbacFixture(userRoot: string, fetchPort: typeof fetch) {
  const rbacRoot = path.join(userRoot, "rbac"),
    postgres = path.join(rbacRoot, "runtime", "postgres", "bin", "postgres"),
    keycloak = path.join(rbacRoot, "runtime", "keycloak", "bin", "kc.sh"),
    configFile = path.join(rbacRoot, "config.json"),
    existing = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>) : {};
  mkdirSync(path.dirname(postgres), { recursive: true });
  mkdirSync(path.dirname(keycloak), { recursive: true });
  writeFileSync(postgres, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(keycloak, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    configFile,
    `${JSON.stringify(
      {
        ...existing,
        schema: "harness-managed-rbac/v1",
        mode: "managed",
        url: typeof existing.url === "string" ? existing.url : "http://127.0.0.1:1",
        realm: typeof existing.realm === "string" ? existing.realm : "harness",
        clientId: typeof existing.clientId === "string" ? existing.clientId : "harness-center",
        versions: managedRbacVersions,
        postgresPort: 2,
        managementPort: 3,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(path.join(rbacRoot, "center-client-secret"), "fixture-secret");
  return createIdentityManagement(userRoot, {
    protectedListenerPaths: () => readFleetCenterCertificatePaths(userRoot),
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
  });
}

async function managedRbacLifecycleFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-center-rbac-lifecycle-")),
    userRoot = path.join(root, "user"),
    repo = path.join(root, "repo"),
    keyPath = path.join(root, "tls.key"),
    certPath = path.join(root, "tls.crt"),
    repoId = "center-lifecycle",
    keycloak = fakeKeycloak("http://127.0.0.1:1/realms/harness"),
    writerToken = keycloak.account("writer"),
    originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith("http://127.0.0.1:1/") ? keycloak.fetch(input, init) : originalFetch(input, init);
  }) as typeof fetch;
  rosterRepo(repo, repoId);
  registerBootstrappedDaemonRepo({ canonicalRoot: repo, repoId, userRoot, createConvenienceLinks: false });
  generateLocalhostCert(keyPath, certPath);
  keycloak.permit("writer", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
  createManagedRbacFixture(userRoot, keycloak.fetch);
  signInAt(userRoot, "writer", ["access-admin"], writerToken);
  const hosts: Awaited<ReturnType<typeof openDaemonHost>>[] = [];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const host of hosts) await host.close();
    rmSync(root, { recursive: true, force: true });
  });
  const open = async (daemonId: string, records: DaemonLifecycleEntry[] = []) => {
    const managedRbac = createManagedRbacFixture(userRoot, keycloak.fetch),
      oidc = createIdentitySession(userRoot, { fetch: keycloak.fetch }),
      host = await openDaemonHost({
        daemonId,
        userRoot,
        oidc,
        managedRbac,
        runtimeDiscover: () => [],
        recordLifecycle: (entry) => records.push(entry),
      });
    hosts.push(host);
    return { host, managedRbac };
  };
  return {
    root,
    userRoot,
    keyPath,
    certPath,
    open,
    request: { port: 0, keyPath, certPath, repoId, quotaBytes: 1024 * 1024 },
  };
}

test(
  "login listener rotation and loopback reset preserve persisted fleet center certificates across cold restart (RBAC-12)",
  { timeout: 300_000 },
  async (t) => {
    const f = await managedRbacLifecycleFixture(t),
      altKeyPath = path.join(f.root, "alt.key"),
      altCertPath = path.join(f.root, "alt.crt");
    generateLocalhostCert(altKeyPath, altCertPath);
    chmodSync(altKeyPath, 0o600);

    const initial = await f.open("center-rotation-preserve"),
      managedRbac = initial.managedRbac,
      v0 = String((await managedRbac.run({ operation: "listener" })).version),
      l1 = await managedRbac.run({
        operation: "listener-set",
        certificateMode: "domain",
        listenAddress: "127.0.0.1",
        hostname: "localhost",
        port: await unusedPort(),
        certificateFile: f.certPath,
        certificateKeyFile: f.keyPath,
        expectedVersion: v0,
      });
    assert.equal(l1.ok, true);

    const started = await initial.host.fleet.startCenter(
        { port: 0, repoId: f.request.repoId, quotaBytes: f.request.quotaBytes, bind: "127.0.0.1" },
        auth,
      ),
      centerConfig = readFleetCenterConfig(f.userRoot, "center-rotation-preserve");
    assert.ok(centerConfig);
    assert.equal(path.basename(path.dirname(centerConfig.certPath)).startsWith("uploaded-"), true);
    await handshake(Number(started.port), centerConfig.certPath);

    // Rotate RBAC login listener to altCertPath/altKeyPath; fleet center's uploaded-<gen1> pair must survive.
    const l2 = await managedRbac.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "localhost",
      port: await unusedPort(),
      certificateFile: altCertPath,
      certificateKeyFile: altKeyPath,
      expectedVersion: String(l1.version),
    });
    assert.equal(l2.ok, true);
    const unusedPair = managedRbac.loginListenerCertificate();
    assert.ok(unusedPair);
    assert.equal(existsSync(centerConfig.certPath), true);
    assert.equal(existsSync(centerConfig.keyPath), true);

    const extUrl = `https://localhost:${started.port}`;
    assert.equal(
      (await initial.host.fleet.setCenterExternalAddress({ externalUrl: extUrl }, auth)).externalUrl,
      extUrl,
    );
    const alias = path.join(f.root, "fleet-certificate-alias"),
      aliasCertPath = path.join(alias, path.basename(centerConfig.certPath)),
      aliasKeyPath = path.join(alias, path.basename(centerConfig.keyPath));
    symlinkSync(path.dirname(centerConfig.certPath), alias, "junction");
    saveFleetCenterConfig(f.userRoot, "center-rotation-preserve", {
      ...centerConfig,
      externalUrl: extUrl,
      certPath: aliasCertPath,
      keyPath: aliasKeyPath,
    });

    // The direct alias keeps the first pair but lets the unreferenced second pair be pruned.
    const l3 = await managedRbac.run({
      operation: "listener-set",
      certificateMode: "self-signed",
      listenAddress: "127.0.0.1",
      hostname: "localhost",
      port: await unusedPort(),
      expectedVersion: String(l2.version),
    });
    assert.equal(existsSync(aliasCertPath), true);
    assert.equal(existsSync(aliasKeyPath), true);
    assert.equal(existsSync(unusedPair.certificateFile), false);

    const selfSignedPair = managedRbac.loginListenerCertificate();
    assert.ok(selfSignedPair);
    const generationHop = path.join(path.dirname(selfSignedPair.certificateFile), "current"),
      chainedAlias = path.join(f.root, "fleet-through-old-listener"),
      persistedCertPath = path.join(chainedAlias, path.basename(centerConfig.certPath)),
      persistedKeyPath = path.join(chainedAlias, path.basename(centerConfig.keyPath));
    symlinkSync(path.dirname(centerConfig.certPath), generationHop, "junction");
    symlinkSync(generationHop, chainedAlias, "junction");
    saveFleetCenterConfig(f.userRoot, "center-rotation-preserve", {
      ...centerConfig,
      externalUrl: extUrl,
      certPath: persistedCertPath,
      keyPath: persistedKeyPath,
    });
    assert.equal(existsSync(persistedCertPath), true);
    assert.equal(existsSync(persistedKeyPath), true);

    const reset = await managedRbac.run({
      operation: "listener-set",
      expectedVersion: String(l3.version),
    });
    assert.equal(reset.ok, true);
    assert.equal(existsSync(centerConfig.certPath), true);
    assert.equal(existsSync(centerConfig.keyPath), true);
    assert.equal(existsSync(persistedCertPath), true);
    assert.equal(existsSync(persistedKeyPath), true);
    await initial.host.close();

    // Cold daemon restart runs ManagedRbacService.start() and restores fleet center without errors.
    const recordsAfterRestart: DaemonLifecycleEntry[] = [],
      restored = await f.open("center-rotation-preserve", recordsAfterRestart);
    assert.equal(
      recordsAfterRestart.some((r) => r.event === "fleet_center_restore_failed"),
      false,
    );
    assert.equal(readFleetCenterConfig(f.userRoot, "center-rotation-preserve")?.certPath, persistedCertPath);
    const state = await restored.host.fleet.readCenterState(auth);
    assert.equal(state.running, true);
    await handshake(Number(state.port), persistedCertPath);
    await restored.host.close();
  },
);

test(
  "an in-flight Fleet start protects its login certificates until a cold start can read center.json (RBAC-12)",
  { timeout: 90_000 },
  async (t) => {
    const f = await managedRbacLifecycleFixture(t),
      daemonId = "center-in-flight",
      { host, managedRbac } = await f.open(daemonId);
    await host.attachmentsSettled();
    const installed = await managedRbac.run({
      operation: "listener-set",
      certificateMode: "domain",
      listenAddress: "127.0.0.1",
      hostname: "localhost",
      port: await unusedPort(),
      certificateFile: f.certPath,
      certificateKeyFile: f.keyPath,
      expectedVersion: String((await managedRbac.run({ operation: "listener" })).version),
    });
    const pair = managedRbac.loginListenerCertificate();
    assert.ok(pair);
    const listening = Promise.withResolvers<void>(),
      publish = Promise.withResolvers<void>();
    const listen: (this: TlsServer, port: number, bind: string, callback: () => void) => TlsServer =
      TlsServer.prototype.listen;
    const mockListen = t.mock.method(
      TlsServer.prototype,
      "listen",
      function (this: TlsServer, port: number, bind: string, callback: () => void) {
        return listen.call(this, port, bind, () => {
          listening.resolve();
          void publish.promise.then(callback);
        });
      },
    );
    const starting = host.fleet.startCenter(
      { port: 0, repoId: f.request.repoId, quotaBytes: f.request.quotaBytes },
      auth,
    );
    try {
      await Promise.race([
        listening.promise,
        starting.then(() => assert.fail("Fleet start finished before its listening barrier")),
      ]);
      assert.equal(readFleetCenterConfig(f.userRoot, daemonId), null);
      const reset = await managedRbac.run({ operation: "listener-set", expectedVersion: String(installed.version) });
      assert.equal(reset.ok, true);
      assert.equal(reset.listener, null);
      assert.equal(existsSync(pair.certificateFile), true);
      assert.equal(existsSync(pair.certificateKeyFile), true);
    } finally {
      mockListen.mock.restore();
      publish.resolve();
      await Promise.allSettled([starting]);
    }
    const started = await starting;
    assert.equal(readFleetCenterConfig(f.userRoot, daemonId)?.certPath, pair.certificateFile);
    assert.equal(readFleetCenterConfig(f.userRoot, daemonId)?.keyPath, pair.certificateKeyFile);
    await host.close();
    const records: DaemonLifecycleEntry[] = [],
      restored = await f.open(daemonId, records);
    assert.equal(
      records.some((entry) => entry.event === "fleet_center_restore_failed"),
      false,
    );
    await handshake(Number(started.port), pair.certificateFile);
    await restored.host.close();
  },
);

test(
  "legacy flat self-signed listener files referenced by fleet center survive rotation and cold restart (RBAC-12)",
  { timeout: 300_000 },
  async (t) => {
    const f = await managedRbacLifecycleFixture(t),
      listenerDir = path.join(f.userRoot, "rbac", "listener"),
      legacyCert = path.join(listenerDir, "self-signed.pem"),
      legacyKey = path.join(listenerDir, "self-signed.key"),
      altKeyPath = path.join(f.root, "alt2.key"),
      altCertPath = path.join(f.root, "alt2.crt");
    mkdirSync(listenerDir, { recursive: true, mode: 0o700 });
    copyFileSync(f.certPath, legacyCert);
    copyFileSync(f.keyPath, legacyKey);
    chmodSync(legacyKey, 0o600);
    generateLocalhostCert(altKeyPath, altCertPath);
    chmodSync(altKeyPath, 0o600);
    const legacyConfigFile = path.join(f.userRoot, "rbac", "config.json"),
      existingLegacy = JSON.parse(readFileSync(legacyConfigFile, "utf8")) as Record<string, unknown>;
    writeFileSync(
      legacyConfigFile,
      `${JSON.stringify(
        {
          ...existingLegacy,
          certificateMode: "self-signed",
          listener: {
            address: "127.0.0.1",
            hostname: "localhost",
            port: await unusedPort(),
            certificateFile: legacyCert,
            certificateKeyFile: legacyKey,
          },
        },
        null,
        2,
      )}\n`,
    );
    const initial = await f.open("legacy-self-signed"),
      managedRbac = initial.managedRbac,
      started = await initial.host.fleet.startCenter(
        { port: 0, repoId: f.request.repoId, quotaBytes: f.request.quotaBytes, bind: "127.0.0.1" },
        auth,
      );
    assert.equal(readFleetCenterConfig(f.userRoot, "legacy-self-signed")?.certPath, legacyCert);
    await handshake(Number(started.port), legacyCert);

    const v0 = String((await managedRbac.run({ operation: "listener" })).version),
      rotated = await managedRbac.run({
        operation: "listener-set",
        certificateMode: "domain",
        listenAddress: "127.0.0.1",
        hostname: "localhost",
        port: await unusedPort(),
        certificateFile: altCertPath,
        certificateKeyFile: altKeyPath,
        expectedVersion: v0,
      });
    assert.equal(existsSync(legacyCert), true);
    assert.equal(existsSync(legacyKey), true);

    const regenerated = await managedRbac.run({
      operation: "listener-set",
      certificateMode: "self-signed",
      listenAddress: "127.0.0.1",
      hostname: "localhost",
      port: await unusedPort(),
      expectedVersion: String(rotated.version),
    });
    assert.equal(existsSync(legacyCert), true);
    assert.equal(existsSync(legacyKey), true);

    await managedRbac.run({
      operation: "listener-set",
      expectedVersion: String(regenerated.version),
    });
    assert.equal(existsSync(legacyCert), true);
    assert.equal(existsSync(legacyKey), true);
    await initial.host.close();

    const records: DaemonLifecycleEntry[] = [],
      restored = await f.open("legacy-self-signed", records);
    assert.equal(
      records.some((r) => r.event === "fleet_center_restore_failed"),
      false,
    );
    const restoredState = await restored.host.fleet.readCenterState(auth);
    assert.equal(restoredState.running, true);
    await handshake(Number(restoredState.port), legacyCert);
    await restored.host.close();
  },
);
