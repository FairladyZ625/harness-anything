// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDaemonStorageConfig } from "../src/storage-daemon-composition.ts";
import { makeTaskEventReader } from "../src/store/task-event-store.ts";
import { makeTaskProjectionReader } from "../src/projection/rebuildable-task-projection.ts";

const valid = {
  backend: "postgres" as const,
  connectionString: "postgresql://runtime@unused/database",
  authorityConnectionString: "postgresql://authority@unused/database",
  scope: { tenantId: "tenant", projectId: "project", policyEpoch: 1, readers: ["person"] },
};

test("absent deployment config preserves SQLite; explicit PG config preserves its independent Git and tree options", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-storage-config-"));
  try {
    assert.deepEqual(readDaemonStorageConfig(root), {});
    const config = { repo: { ...valid, materialize: false, gitFollower: { branch: "main" } } };
    writeFileSync(path.join(root, "daemon-storage.json"), JSON.stringify(config));
    assert.deepEqual(readDaemonStorageConfig(root), config);
    writeFileSync(path.join(root, "daemon-storage.json"), JSON.stringify({ repo: valid }));
    assert.deepEqual(readDaemonStorageConfig(root), { repo: valid });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed external PG scope is rejected before any connection or local fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-storage-config-invalid-"));
  try {
    for (const scope of [
      { ...valid.scope, tenantId: 4 },
      { ...valid.scope, projectId: ["project"] },
      { ...valid.scope, policyEpoch: -1 },
      { ...valid.scope, readers: "person" },
      { ...valid.scope, readers: [null] },
    ]) {
      const storage = { ...valid, scope } as never;
      writeFileSync(path.join(root, "daemon-storage.json"), JSON.stringify({ repo: storage }));
      assert.throws(() => readDaemonStorageConfig(root), TypeError);
      assert.throws(() => makeTaskEventReader({ rootDir: root, repoId: "repo", storage }), TypeError);
      assert.throws(() => makeTaskProjectionReader({ repoId: "repo", storage }), TypeError);
    }
    for (const config of [
      { ...valid, authorityConnectionString: undefined },
      { ...valid, backend: "unknown" },
      { ...valid, materialize: "false" },
      { ...valid, gitFollower: { branch: "" } },
    ]) {
      writeFileSync(path.join(root, "daemon-storage.json"), JSON.stringify({ repo: config }));
      assert.throws(() => readDaemonStorageConfig(root), TypeError);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
