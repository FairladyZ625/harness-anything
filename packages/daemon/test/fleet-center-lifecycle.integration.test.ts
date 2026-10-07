// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "node:tls";
import test, { type TestContext } from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { fleetCenterConfigPath, readFleetCenterConfig } from "../src/fleet-center-config.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import type { DaemonLifecycleEntry } from "../src/lifecycle-log.ts";

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
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const hosts: Awaited<ReturnType<typeof openDaemonHost>>[] = [];
  t.after(async () => {
    for (const host of hosts) await host.close();
    rmSync(root, { recursive: true, force: true });
  });
  const open = async (daemonId: string, records: DaemonLifecycleEntry[] = []) => {
    const host = await openDaemonHost({ daemonId, userRoot, recordLifecycle: (entry) => records.push(entry) });
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

test("successful starts persist actual ports and restore separate daemon identities through host open", async (t) => {
  const f = await fixture(t),
    first = await f.open("a/b"),
    second = await f.open("a?b"),
    a = await first.fleet.startCenter({ ...f.request, stateRoot: path.join(f.root, "a") }, auth),
    b = await second.fleet.startCenter({ ...f.request, stateRoot: path.join(f.root, "b") }, auth),
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
  await first.close();
  await second.close();
  await f.open("a/b");
  await f.open("a?b");
  await handshake(Number(a.port), f.certPath);
  await handshake(Number(b.port), f.certPath);
  const records: DaemonLifecycleEntry[] = [];
  await f.open("never-enabled", records);
  assert.equal(existsSync(fleetCenterConfigPath(f.userRoot, "never-enabled")), false);
  assert.equal(
    records.some((r) => r.event === "fleet_center_restore_failed"),
    false,
  );
});

test("an unenabled successor does not listen and invalid saved references report restore failure", async (t) => {
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
});

test("a save failure rejects start and closes its unrecorded listener", async (t) => {
  const f = await fixture(t),
    host = await f.open("save-failure"),
    port = await unusedPort(),
    file = fleetCenterConfigPath(f.userRoot, "save-failure");
  mkdirSync(file, { recursive: true });
  await assert.rejects(host.fleet.startCenter({ ...f.request, port }, auth), /EISDIR|ENOTEMPTY|EPERM/u);
  await assert.rejects(handshake(port, f.certPath), { code: "ECONNREFUSED" });
  rmSync(file, { recursive: true });
  const retry = await host.fleet.startCenter({ ...f.request, port }, auth);
  assert.equal(retry.ok, true);
  await handshake(port, f.certPath);
});

test("concurrent authorized starts publish only one daemon listener and one enabled intent", async (t) => {
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
});
