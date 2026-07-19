// harness-test-tier: integration
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import {
  createFixture,
  installProductionArtifactPreset
} from "./production-authority-canonical-ingress/fixture.ts";
import { verifyProductionPresetIngress } from "./production-authority-canonical-ingress/preset-ingress.ts";

test("production script ingress admits runtime evidence for a slugged task package", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000"
  };
  try {
    installProductionArtifactPreset(fixture.repoRoot);
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical", "--canonical-root", fixture.repoRoot,
      "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Observe the detached service when startup outlives the command reachability wait.
    }
    const status = await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (candidate) => candidate.reachable === true,
      (candidate, error) => JSON.stringify({ candidate, error: error instanceof Error ? error.message : String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    assert.equal(status.repoCount, 1, JSON.stringify(status));

    verifyProductionPresetIngress(fixture, env);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
