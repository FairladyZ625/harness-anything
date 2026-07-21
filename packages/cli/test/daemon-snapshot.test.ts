// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { calculateDaemonArtifactIdentity } from "@harness-anything/daemon";
import { installDaemonSnapshot } from "../src/commands/daemon/snapshot.ts";

test("daemon snapshot installation is idempotent and remains independent from mutable dist", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-snapshot-test-"));
  const packageRoot = path.join(root, "package");
  const sourceEntrypoint = path.join(packageRoot, "dist", "cli", "src", "index.js");
  const userRoot = path.join(root, "user");
  mkdirSync(path.dirname(sourceEntrypoint), { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "harness-anything", dependencies: {} }));
  writeFileSync(sourceEntrypoint, "export const daemonVersion = 'snapshot-v1';\n");
  const nodePtyRoot = path.join(packageRoot, "node_modules", "node-pty");
  mkdirSync(nodePtyRoot, { recursive: true });
  writeFileSync(path.join(nodePtyRoot, "package.json"), JSON.stringify({
    name: "node-pty",
    version: "1.0.0",
    optionalDependencies: { "node-pty-unavailable-platform": "1.0.0" }
  }));
  writeFileSync(path.join(nodePtyRoot, "index.js"), "module.exports = {};\n");

  try {
    const first = installDaemonSnapshot({
      sourceEntrypoint,
      userRoot,
      version: "release-1",
      now: () => new Date("2026-07-22T01:02:03.000Z")
    });
    const second = installDaemonSnapshot({ sourceEntrypoint, userRoot, version: "release-1" });

    assert.equal(first.installed, true);
    assert.equal(second.installed, false);
    assert.equal(second.snapshotDir, first.snapshotDir);
    assert.deepEqual(second.manifest, first.manifest);
    assert.equal(first.manifest.builtAt, "2026-07-22T01:02:03.000Z");
    assert.equal(calculateDaemonArtifactIdentity(first.entrypoint).identity, first.manifest.contentFingerprint);

    writeFileSync(sourceEntrypoint, "export const daemonVersion = 'mutable-dist-v2';\n");
    assert.match(readFileSync(first.entrypoint, "utf8"), /snapshot-v1/u);
    assert.doesNotMatch(readFileSync(first.entrypoint, "utf8"), /mutable-dist-v2/u);
    assert.equal(calculateDaemonArtifactIdentity(first.entrypoint).identity, first.manifest.contentFingerprint);
    assert.equal(readFileSync(first.manifestPath, "utf8").endsWith("\n"), true);
    assert.throws(
      () => installDaemonSnapshot({ sourceEntrypoint, userRoot, version: "release-1" }),
      /snapshot version already belongs to different source bytes/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
