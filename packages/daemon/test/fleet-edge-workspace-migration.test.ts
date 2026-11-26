// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { readFleetEdgeConfig, writeFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { migrateFleetEdgeWorkspace } from "../src/daemon-host/fleet-edge-workspace-migration.ts";

test("migrateFleetEdgeWorkspace relocates viewRoot across non-canonical path aliases and Windows drive casing", () => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ha-edge-migrate-")));
  try {
    const userRoot = path.join(root, "user"),
      oldRoot = path.join(root, "worker-edge"),
      newRoot = path.join(root, "worker-edge-moved"),
      oldView = `${oldRoot}-view`,
      expectedNewView = `${newRoot}-view`,
      caFile = path.join(userRoot, "center-ca.pem");
    mkdirSync(oldView, { recursive: true });
    mkdirSync(newRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(caFile, "fixture-ca\n");
    writeFileSync(path.join(oldView, "marker.txt"), "replica-state\n");

    const aliasedOldView = process.platform === "win32" ? `${oldView[0]!.toLowerCase()}${oldView.slice(1)}` : oldView;
    writeFleetEdgeConfig(userRoot, "migrate-repo", {
      host: "127.0.0.1",
      port: 8443,
      caPath: caFile,
      nodeId: "node-migrate",
      credential: "secret",
      repoId: "migrate-repo",
      viewRoot: aliasedOldView,
      quotaBytes: 1024 * 1024,
    });

    migrateFleetEdgeWorkspace(oldRoot, newRoot, "migrate-repo", userRoot);

    const updated = readFleetEdgeConfig(userRoot, "migrate-repo");
    assert.equal(updated?.viewRoot, expectedNewView);
    assert.equal(existsSync(oldView), false, "old default view directory should be moved");
    assert.equal(existsSync(path.join(expectedNewView, "marker.txt")), true, "moved view should retain replica state");
  } finally {
    removeTempRepository(root);
  }
});
