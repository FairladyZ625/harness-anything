// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateEmptyCanonicalGeneration,
  makeTaskEventReader,
  makeTaskEventStore,
  openSqliteEventStore,
} from "../../src/index.ts";
import { resolveActiveGeneration, sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { eventAt, initRepo } from "./task-event-store.fixtures.ts";

const repoId = "native-generation-init";

test("a truly empty repository is born on generation 3 and accepts its first write there", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-native-generation-"));
  initRepo(rootDir);
  const store = makeTaskEventStore({ repoId, rootDir, activationPreflight: activateEmptyCanonicalGeneration });
  try {
    assert.equal(resolveActiveGeneration({ rootInput: rootDir, repoId }), 3);
    assert.equal(store.ledgerMetadata().generation, 3);
    assert.equal(existsSync(sqliteLedgerPath(rootDir, 1)), false);
    assert.equal(existsSync(sqliteLedgerPath(rootDir, 3)), true);
    assert.equal(existsSync(`${sqliteLedgerPath(rootDir, 3)}.activation.json`), true);
    store.append({ event: eventAt(1), plan: taskLifecycleWritePlan(eventAt(1)), blobs: [] });
    assert.equal(store.read().revision, 1);
    assert.equal(store.canonicalRef, "sqlite:generation-3");
    await store.drain();
    const reader = makeTaskEventReader({ repoId, rootDir });
    try {
      assert.equal(reader.ledgerMetadata().generation, 3);
      assert.equal(reader.read().revision, 1);
    } finally {
      await reader.drain();
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("an existing generation 1 ledger is not mistaken for an empty repository", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-native-generation-"));
  initRepo(rootDir);
  const legacy = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 1 });
  legacy.close();
  try {
    assert.throws(() => resolveActiveGeneration({ rootInput: rootDir, repoId }), /upgrade is incomplete/u);
    assert.throws(() => activateEmptyCanonicalGeneration({ rootInput: rootDir, repoId }), /upgrade is incomplete/u);
    assert.equal(existsSync(sqliteLedgerPath(rootDir, 3)), false);
    assert.equal(existsSync(sqliteLedgerPath(rootDir, 1)), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const previousGeneration of [1, 2]) {
  test(`restart republishes generation ${previousGeneration} follower at the same revision and exposes same-generation corruption`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gen3-follower-"));
    initRepo(rootDir);
    const initial = makeTaskEventStore({ repoId, rootDir });
    try {
      initial.append({ event: eventAt(1), plan: taskLifecycleWritePlan(eventAt(1)), blobs: [] });
      await initial.drain();
      assert.throws(() => makeTaskEventStore({ repoId, rootDir, generation: 2 }), /require generation 3/);
      assert.throws(() => makeTaskEventReader({ repoId, rootDir, generation: 1 }), /require generation 3/);
      const manifestPath = path.join(rootDir, "harness/events/segments/manifest.json");
      const prior = JSON.parse(readFileSync(manifestPath, "utf8"));
      writeFileSync(manifestPath, `${JSON.stringify({ ...prior, generation: previousGeneration })}\n`);
      execFileSync("git", ["-C", rootDir, "add", "harness/events/segments/manifest.json"]);
      execFileSync("git", ["-C", rootDir, "commit", "-qm", "old follower fixture"]);
      const restarted = makeTaskEventStore({ repoId, rootDir });
      try {
        assert.equal(restarted.materialize().status, "visible");
        assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).generation, 3);
        assert.equal(restarted.read().revision, 1);
      } finally {
        await restarted.drain();
      }
      const damaged = JSON.parse(readFileSync(manifestPath, "utf8"));
      damaged.cut.headDigest = `sha256:${"f".repeat(64)}`;
      writeFileSync(manifestPath, `${JSON.stringify(damaged)}\n`);
      const corrupt = makeTaskEventStore({ repoId, rootDir });
      try {
        assert.throws(() => corrupt.materialize(), /Git follower manifest cut differs from SQLite/);
        assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).cut.headDigest, damaged.cut.headDigest);
      } finally {
        await corrupt.drain();
      }
    } finally {
      await initial.drain();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}
