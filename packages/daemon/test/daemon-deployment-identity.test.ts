// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  calculateDaemonArtifactIdentity,
  captureDaemonDeploymentStatus,
  daemonBuildProvenanceFilename,
  inspectDaemonSupervision
} from "../src/index.ts";

test("deployment identity binds commit, source bytes, loaded artifact bytes, and manager PID", () => {
  const fixture = deploymentFixture();
  try {
    const status = captureDaemonDeploymentStatus({
      entrypoint: fixture.entrypoint,
      loadedIdentity: fixture.artifactIdentity,
      installedIdentity: fixture.artifactIdentity,
      supervisor: "systemd-system:harness-anything-daemon.service",
      pid: 4242,
      runCommand: fixture.runCommand
    });
    assert.equal(status.healthy, true);
    assert.equal(status.provenance.sourceCommit, fixture.commit);
    assert.equal(status.checkout.matchesProvenance, true);
    assert.equal(status.supervision.matchesPid, true);
    assert.deepEqual(status.failures, []);
  } finally {
    fixture.cleanup();
  }
});

test("positive control: changed dist is reported as artifact drift", (t) => {
  const fixture = deploymentFixture();
  try {
    writeFileSync(fixture.entrypoint, "export const daemon = 'changed-after-start';\n");
    const installedIdentity = calculateDaemonArtifactIdentity(fixture.entrypoint).identity;
    const status = captureDaemonDeploymentStatus({
      entrypoint: fixture.entrypoint,
      loadedIdentity: fixture.artifactIdentity,
      installedIdentity,
      supervisor: "systemd-system:harness-anything-daemon.service",
      pid: 4242,
      runCommand: fixture.runCommand
    });
    assert.equal(status.healthy, false);
    assert.equal(status.provenance.contentMatchesLoaded, true);
    assert.deepEqual(status.failures, ["artifact-drift"]);
    assert.notEqual(installedIdentity, fixture.artifactIdentity);
    t.diagnostic(JSON.stringify({
      loadedIdentity: fixture.artifactIdentity,
      installedIdentity,
      healthy: status.healthy,
      failures: status.failures
    }));
  } finally {
    fixture.cleanup();
  }
});

test("positive control: changed checkout source is reported as checkout drift", () => {
  const fixture = deploymentFixture();
  try {
    writeFileSync(fixture.sourceEntrypoint, "export const source = 'changed-after-build';\n");
    const status = captureDaemonDeploymentStatus({
      entrypoint: fixture.entrypoint,
      loadedIdentity: fixture.artifactIdentity,
      installedIdentity: fixture.artifactIdentity,
      supervisor: "systemd-system:harness-anything-daemon.service",
      pid: 4242,
      runCommand: fixture.runCommand
    });
    assert.equal(status.healthy, false);
    assert.deepEqual(status.failures, ["checkout-drift"]);
    assert.equal(status.checkout.matchesProvenance, false);
  } finally {
    fixture.cleanup();
  }
});

test("dead or mismatched manager unit cannot validate a manually started daemon", () => {
  const status = inspectDaemonSupervision(
    "systemd-user:harness-anything-daemon.service",
    4242,
    () => "ActiveState=inactive\nMainPID=0\n"
  );
  assert.equal(status.matchesPid, false);
  assert.equal(status.managerState, "inactive");
  assert.equal(status.observedPid, null);
});

function deploymentFixture(): {
  readonly root: string;
  readonly entrypoint: string;
  readonly sourceEntrypoint: string;
  readonly artifactIdentity: string;
  readonly commit: string;
  readonly runCommand: (command: string, args: ReadonlyArray<string>) => string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-deployment-identity-"));
  const sourceEntrypoint = path.join(root, "packages/cli/src/index.ts");
  const entrypoint = path.join(root, "packages/cli/dist/cli/src/index.js");
  mkdirSync(path.dirname(sourceEntrypoint), { recursive: true });
  mkdirSync(path.dirname(entrypoint), { recursive: true });
  writeFileSync(sourceEntrypoint, "export const source = 'built';\n");
  writeFileSync(entrypoint, "export const daemon = 'built';\n");
  const sourceIdentity = calculateDaemonArtifactIdentity(sourceEntrypoint).identity;
  const artifact = calculateDaemonArtifactIdentity(entrypoint);
  const commit = "a".repeat(40);
  writeFileSync(path.join(artifact.artifactRoot, daemonBuildProvenanceFilename), `${JSON.stringify({
    schema: "daemon-build-provenance/v1",
    sourceRoot: root,
    sourceCommit: commit,
    sourceDirty: false,
    sourceFingerprint: sourceIdentity,
    contentFingerprint: artifact.identity,
    artifactFileCount: artifact.fileCount,
    builtAt: "2026-07-22T00:00:00.000Z"
  }, null, 2)}\n`);
  return {
    root,
    entrypoint,
    sourceEntrypoint,
    artifactIdentity: artifact.identity,
    commit,
    runCommand: (command, args) => {
      if (command === "systemctl") return "ActiveState=active\nMainPID=4242\n";
      if (command === "git" && args.includes("rev-parse")) return `${commit}\n`;
      if (command === "git" && args.includes("status")) return "";
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}
