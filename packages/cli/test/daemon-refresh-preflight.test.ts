// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/index.ts";
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
