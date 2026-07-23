// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";
import {
  defaultDaemonJsonRpcRequestTimeoutMs,
  requestLocalDaemonJsonRpc
} from "../../daemon/src/index.ts";
import { daemonLaunchSpecPath } from "../src/daemon/daemon-launch-spec.ts";
import {
  defaultDaemonUserRoot,
  runDaemonCommand,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";

const snapshotTestTimeoutMs = positiveIntegerEnv(
  "HARNESS_TEST_DAEMON_SNAPSHOT_TIMEOUT_MS",
  process.env.CI ? 180_000 : 90_000
);
const snapshotRequestTimeoutMs = positiveIntegerEnv(
  "HARNESS_TEST_DAEMON_SNAPSHOT_REQUEST_TIMEOUT_MS",
  process.env.CI ? 90_000 : defaultDaemonJsonRpcRequestTimeoutMs
);

test("daemon upgrade serves the installed snapshot identity and persists its entrypoint", { timeout: snapshotTestTimeoutMs }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: String(snapshotRequestTimeoutMs)
  };
  try {
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    const started = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    const upgrade = runDaemonCommand(fixture.repoRoot, [
      "daemon", "upgrade", "--version", "integration-snapshot",
      "--timeout-ms", "20000", "--user-root", userRoot, "--json"
    ], env);
    const snapshot = upgrade.snapshot as {
      readonly entrypoint: string;
      readonly manifestPath: string;
      readonly manifest: { readonly contentFingerprint: string };
    };
    const replacement = upgrade.replacement as {
      readonly pid: number;
      readonly service: {
        readonly build: { readonly loadedIdentity: string; readonly installedIdentity: string };
        readonly activeControl: unknown;
      };
    };

    assert.equal(upgrade.kind, "upgrade");
    assert.notEqual(replacement.pid, started.pid);
    assert.equal(replacement.service.build.loadedIdentity, snapshot.manifest.contentFingerprint);
    assert.equal(replacement.service.build.installedIdentity, snapshot.manifest.contentFingerprint);
    assert.equal(replacement.service.activeControl, null);
    assert.equal(
      (JSON.parse(readFileSync(snapshot.manifestPath, "utf8")) as { contentFingerprint: string }).contentFingerprint,
      snapshot.manifest.contentFingerprint
    );

    const launchReceipt = await requestLocalDaemonJsonRpc(
      fixture.repoRoot,
      "admin.daemon.launch-spec",
      {},
      1_000,
      { userRoot, allowLegacySocket: false }
    );
    const launchDetails = launchReceipt.details as Record<string, unknown>;
    const launchSpec = launchDetails.data as { readonly entrypoint?: unknown };
    assert.equal(launchSpec.entrypoint, snapshot.entrypoint);
    const persistedLaunchSpec = JSON.parse(readFileSync(
      daemonLaunchSpecPath(userRoot, String((replacement as Record<string, unknown>).endpoint ?? "")),
      "utf8"
    )) as { readonly launchConfiguration?: { readonly entrypoint?: unknown } };
    assert.equal(persistedLaunchSpec.launchConfiguration?.entrypoint, snapshot.entrypoint);

    const status = runDaemonCommand(fixture.repoRoot, [
      "daemon", "status", "--user-root", userRoot, "--json"
    ], env);
    assert.equal(typeof status.machineId, "string");
    assert.equal(typeof status.daemonGeneration, "number");
    process.kill(replacement.pid, 0);
    console.log(JSON.stringify({
      scenario: "snapshot-upgrade",
      beforePid: started.pid,
      afterPid: replacement.pid,
      entrypoint: snapshot.entrypoint,
      fingerprint: snapshot.manifest.contentFingerprint
    }));
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
