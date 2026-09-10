// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateEmptyCanonicalGeneration,
  makeTaskEventReader,
  makeTaskEventStore,
  openSqliteEventStore,
} from "../../src/index.ts";
import {
  generationTwoActivationPath,
  resolveActiveGeneration,
  sqliteLedgerPath,
} from "../../src/store/sqlite-event-store.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { eventAt, initRepo } from "./task-event-store.fixtures.ts";

const repoId = "native-generation-init";

test("a truly empty repository is born on generation 2 and accepts its first write there", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-native-generation-"));
  initRepo(rootDir);
  const store = makeTaskEventStore({ repoId, rootDir, activationPreflight: activateEmptyCanonicalGeneration });
  try {
    assert.equal(resolveActiveGeneration({ rootInput: rootDir, repoId }), 2);
    assert.equal(store.ledgerMetadata().generation, 2);
    assert.equal(existsSync(sqliteLedgerPath(rootDir, 1)), false);
    assert.equal(existsSync(sqliteLedgerPath(rootDir, 2)), true);
    assert.equal(existsSync(generationTwoActivationPath(rootDir)), true);
    store.append({ event: eventAt(1), plan: taskLifecycleWritePlan(eventAt(1)), blobs: [] });
    assert.equal(store.read().revision, 1);
    assert.equal(store.canonicalRef, "sqlite:generation-2");
    await store.drain();
    const reader = makeTaskEventReader({ repoId, rootDir });
    try {
      assert.equal(reader.ledgerMetadata().generation, 2);
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
    assert.equal(resolveActiveGeneration({ rootInput: rootDir, repoId }), 1);
    assert.throws(
      () => activateEmptyCanonicalGeneration({ rootInput: rootDir, repoId }),
      /legacy generation exists without activation/u,
    );
    assert.equal(existsSync(sqliteLedgerPath(rootDir, 2)), false);
    assert.equal(existsSync(sqliteLedgerPath(rootDir, 1)), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
