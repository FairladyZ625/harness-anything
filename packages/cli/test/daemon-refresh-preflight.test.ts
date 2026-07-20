// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { localUserDaemonEndpoint, requestLocalDaemonJsonRpc } from "../../daemon/src/index.ts";
import { readDaemonRegistry } from "../../kernel/src/index.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";
import { initializeHarness } from "../src/commands/init.ts";

test("refresh preflight reports the real manifest failure and leaves the running daemon unchanged", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000"
  };
  const validManifest = readFileSync(fixture.manifestPath, "utf8");
  try {
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register",
      "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot,
      "--user-root", userRoot,
      "--no-link",
      "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const started = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service",
      "--authority-manifest", fixture.manifestPath,
      "--json"
    ], env);
    assert.equal(started.started, true, JSON.stringify(started));
    const before = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
    assert.equal(before.reachable, true, JSON.stringify(before));
    assert.equal(typeof before.pid, "number");
    const launchReceipt = await requestLocalDaemonJsonRpc(
      fixture.repoRoot,
      "admin.daemon.launch-spec",
      {},
      1_000,
      { userRoot, allowLegacySocket: false }
    );
    const launchDetails = launchReceipt.details as Record<string, unknown>;
    const launchSpec = launchDetails.data as { readonly args?: ReadonlyArray<string> };
    const manifestIndex = launchSpec.args?.indexOf("--authority-manifest") ?? -1;
    assert.notEqual(manifestIndex, -1, JSON.stringify(launchSpec));
    assert.equal(launchSpec.args?.[manifestIndex + 1], fixture.manifestPath);

    writeFileSync(fixture.manifestPath, "{}\n", "utf8");
    const refresh = runRawJsonMaybeFail(fixture.repoRoot, [
      "daemon", "refresh",
      "--trigger", "post-merge",
      "--timeout-ms", "10000",
      "--user-root", userRoot
    ], env);
    assert.notEqual(refresh.status, 0, JSON.stringify(refresh.receipt));
    assert.match(JSON.stringify(refresh.receipt), /AUTHORITY_PRODUCTION_MANIFEST_SCHEMA_INVALID/u);
    assert.doesNotMatch(JSON.stringify(refresh.receipt), /did not become reachable/u);

    const after = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
    assert.equal(after.reachable, true, JSON.stringify(after));
    assert.equal(after.pid, before.pid);
    process.kill(before.pid as number, 0);
    console.log(JSON.stringify({ scenario: "preflight-failure", beforePid: before.pid, afterPid: after.pid, reachable: after.reachable, refresh: refresh.receipt }));
  } finally {
    writeFileSync(fixture.manifestPath, validManifest, "utf8");
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refresh derives the explicit manifest across a mixed registry and leaves a replacement reachable", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const classicRoot = path.join(fixture.root, "classic-repo");
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000"
  };
  try {
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    const started = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    assert.equal(started.started, true, JSON.stringify(started));
    const before = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
    assert.equal(typeof before.pid, "number");

    mkdirSync(classicRoot, { recursive: true });
    initializeHarness({ rootDir: classicRoot }, false, "Classic");
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "classic",
      "--canonical-root", classicRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    const registry = readDaemonRegistry({ userRoot });
    assert.equal(registry.repos.find((repo) => repo.repoId === "canonical")?.authorityManifestPath, fixture.manifestPath);
    assert.equal(registry.repos.find((repo) => repo.repoId === "classic")?.authorityManifestPath, undefined);

    const refresh = runRawJsonMaybeFail(fixture.repoRoot, [
      "daemon", "refresh", "--trigger", "post-merge", "--timeout-ms", "10000", "--user-root", userRoot
    ], env);
    assert.equal(refresh.status, 0, JSON.stringify(refresh.receipt));
    assert.equal(refresh.receipt.ok, true, JSON.stringify(refresh.receipt));
    const after = await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (status) => status.reachable === true && typeof status.pid === "number" && status.pid !== before.pid,
      (status, error) => JSON.stringify({ refresh, status, error: String(error ?? "") }),
      { timeoutMs: 15_000 }
    );
    assert.equal(after.reachable, true, JSON.stringify({ refresh, after }));
    assert.notEqual(after.pid, before.pid);
    const beforeService = before.service as { readonly build: { readonly loadedIdentity: string } };
    const afterService = after.service as {
      readonly build: { readonly loadedIdentity: string; readonly installedIdentity: string };
      readonly activeControl: unknown;
    };
    assert.equal(afterService.build.loadedIdentity, afterService.build.installedIdentity);
    assert.equal(afterService.build.loadedIdentity, beforeService.build.loadedIdentity);
    assert.equal(afterService.activeControl, null);
    process.kill(after.pid as number, 0);
    console.log(JSON.stringify({ scenario: "derived-manifest-refresh", beforePid: before.pid, afterPid: after.pid, reachable: after.reachable, refresh: refresh.receipt }));
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refresh explicitly exits the old owner after safe shutdown even with an active resource", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const markerPath = path.join(fixture.root, "old-owner-resource.marker");
  const evidencePath = path.join(fixture.root, "old-owner-resources.json");
  const preloadPath = path.resolve("packages/cli/test/fixtures/daemon-owner-active-resource-preload.mjs");
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_TEST_DAEMON_OWNER_RESOURCE_MARKER: markerPath,
    HARNESS_TEST_DAEMON_OWNER_RESOURCE_EVIDENCE: evidencePath,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preloadPath).href}`.trim()
  };
  let oldPid: number | undefined;
  let persistentClient: net.Socket | undefined;
  try {
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    const started = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    oldPid = started.pid as number;
    assert.equal(typeof oldPid, "number", JSON.stringify(started));
    persistentClient = net.createConnection(localUserDaemonEndpoint(userRoot));
    await new Promise<void>((resolve, reject) => {
      persistentClient!.once("connect", resolve);
      persistentClient!.once("error", reject);
    });
    const persistentClientClosed = new Promise<void>((resolve) => persistentClient!.once("close", () => resolve()));

    const refresh = runRawJsonMaybeFail(fixture.repoRoot, [
      "daemon", "refresh", "--trigger", "post-merge", "--timeout-ms", "10000", "--user-root", userRoot
    ], env);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      readonly pid: number;
      readonly resources: ReadonlyArray<string>;
    };
    console.log(JSON.stringify({ scenario: "old-owner-active-resource", oldPid, evidence, refresh: refresh.receipt }));
    assert.equal(refresh.status, 0, JSON.stringify(refresh.receipt));
    const replacement = refresh.receipt.replacement as { readonly pid?: unknown };
    assert.equal(typeof replacement.pid, "number", JSON.stringify(refresh.receipt));
    assert.notEqual(replacement.pid, oldPid);
    await persistentClientClosed;
    await pollUntil(
      () => processIsAlive(oldPid),
      (alive) => !alive,
      (alive, error) => JSON.stringify({ oldPid, alive, error: String(error ?? "") }),
      { timeoutMs: 5_000 }
    );
    assert.equal(evidence.pid, oldPid);
    assert.equal(evidence.resources.includes("Timeout"), true, JSON.stringify(evidence));
    console.log(JSON.stringify({ scenario: "old-owner-explicit-exit", oldPid, replacementPid: replacement.pid, refresh: refresh.receipt }));
  } finally {
    persistentClient?.destroy();
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    if (oldPid !== undefined && processIsAlive(oldPid)) process.kill(oldPid, "SIGKILL");
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refresh reports a stuck drain and leaves the old owner alive", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const markerPath = path.join(fixture.root, "old-owner-stuck-drain.marker");
  const preloadPath = path.resolve("packages/cli/test/fixtures/daemon-stuck-drain-preload.mjs");
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_TEST_DAEMON_STUCK_DRAIN_MARKER: markerPath,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preloadPath).href}`.trim()
  };
  let oldPid: number | undefined;
  try {
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    const started = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    oldPid = started.pid as number;
    assert.equal(typeof oldPid, "number", JSON.stringify(started));

    const refresh = runRawJsonMaybeFail(fixture.repoRoot, [
      "daemon", "refresh", "--trigger", "post-merge", "--timeout-ms", "1000", "--user-root", userRoot
    ], env);
    const status = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
    assert.notEqual(refresh.status, 0, JSON.stringify(refresh.receipt));
    assert.match(JSON.stringify(refresh.receipt), /daemon_queue_drain_timeout/u);
    assert.match(JSON.stringify(refresh.receipt), /in-flight operations failed to settle in time/u);
    assert.equal(processIsAlive(oldPid), true);

    const service = status.service as {
      readonly pid?: unknown;
      readonly activeControl?: { readonly phase?: unknown; readonly failure?: { readonly code?: unknown } };
    };
    assert.equal(status.reachable, true, JSON.stringify(status));
    assert.equal(service.pid, oldPid);
    assert.equal(service.activeControl?.phase, "failed");
    assert.equal(service.activeControl?.failure?.code, "daemon_queue_drain_timeout");
    console.log(JSON.stringify({ scenario: "stuck-drain-owner-remains", oldPid, refresh: refresh.receipt, activeControl: service.activeControl }));
  } finally {
    if (oldPid !== undefined && processIsAlive(oldPid)) process.kill(oldPid, "SIGKILL");
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
