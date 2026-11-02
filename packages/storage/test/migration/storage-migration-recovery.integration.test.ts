// harness-test-tier: integration
import { openSqliteEventStore } from "../../src/store/sqlite-event-store.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateStorage } from "../../src/migration/engine.ts";
import { openSqliteMigrationEndpoint } from "../../src/migration/sqlite-endpoint.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { bundle, eventAt, initRepo } from "../store/task-event-store.fixtures.ts";
import {
  validateStorageManifest,
  assertSqliteMigrationScope,
  storageMigrationVersions,
} from "../../src/migration/manifest.ts";

const scope = { tenantId: "migration-tenant", projectId: "migration-project", policyEpoch: 0, readers: [] },
  repoId = "migration";
async function fixture(seedTarget = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-migration-recovery-")),
    a = path.join(root, "a"),
    b = path.join(root, "b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  initRepo(a);
  initRepo(b);
  const writer = makeTaskEventStore({ repoId, rootDir: a });
  writer.append(bundle(eventAt(1)));
  await writer.drain();
  if (seedTarget) {
    const occupied = makeTaskEventStore({ repoId, rootDir: b });
    occupied.append(bundle(eventAt(1)));
    await occupied.drain();
  }
  let source = openSqliteMigrationEndpoint({ rootDir: a, repoId, scope }),
    target = openSqliteMigrationEndpoint({ rootDir: b, role: "target", repoId, scope });
  return {
    root,
    a,
    b,
    get source() {
      return source;
    },
    get target() {
      return target;
    },
    async reopen() {
      await source.close();
      await target.close();
      source = openSqliteMigrationEndpoint({ rootDir: a, repoId, scope });
      target = openSqliteMigrationEndpoint({ rootDir: b, role: "target", repoId, scope });
    },
    get input() {
      return { repoId, source, target, runId: "recovery", exportDirectory: path.join(root, "export") };
    },
    async close() {
      await source.close();
      await target.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
for (const boundary of [
  "source_frozen",
  "manifest_published",
  "target_prepared",
  "target_imported",
  "audit_passed",
  "source_sealed",
  "target_marker",
  "source_completed",
])
  test(`cold switch recovers durably after ${boundary}`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        migrateStorage({
          ...f.input,
          checkpoint: (point) => {
            if (point === boundary) throw new Error(`crash:${point}`);
          },
        }),
        new RegExp(`crash:${boundary}`),
      );
      await f.reopen();
      const result = await migrateStorage({ ...f.input, mode: "resume" });
      assert.equal(result.phase, "target_activated");
      assert.equal(await f.target.marker("recovery"), true);
      assert.deepEqual(await f.target.export("recovery"), await f.source.export("recovery"));
      await assert.rejects(migrateStorage({ ...f.input, mode: "abort" }), {
        code: "storage_migration_already_activated",
      });
      process.stdout.write(`MIGRATION_RECOVERY ${boundary} -> target_activated\n`);
    } finally {
      await f.close();
    }
  });
test("activation failure stays read-only; retry or new-epoch abort recovers, including interrupted abort", async () => {
  for (const recovery of ["resume", "abort"] as const) {
    const f = await fixture();
    let fail = true;
    const failing = {
      ...f.target,
      change: async (...args: Parameters<typeof f.target.change>) => {
        if (args[2] && fail) {
          fail = false;
          throw new Error("marker unavailable");
        }
        return f.target.change(...args);
      },
    };
    try {
      await assert.rejects(migrateStorage({ ...f.input, target: failing }), /marker unavailable/);
      assert.equal((await f.source.state())!.phase, "activation_failed");
      assert.equal((await f.target.state())!.phase, "activation_failed");
      const oldEpoch = await f.source.epoch();
      if (recovery === "abort")
        await assert.rejects(
          migrateStorage({
            ...f.input,
            mode: "abort",
            checkpoint: (p) => {
              if (p === "target_abandoned") throw new Error("abort crash");
            },
          }),
          /abort crash/,
        );
      const result = await migrateStorage({ ...f.input, mode: recovery });
      assert.equal(result.phase, recovery === "resume" ? "target_activated" : "source_resumed");
      if (recovery === "abort") {
        assert.ok((await f.source.epoch()) > oldEpoch);
        assert.equal((await f.target.state())!.phase, "abandoned");
        assert.equal(await f.target.marker("recovery"), false);
      }
      process.stdout.write(`MIGRATION_ACTIVATION_FAILED ${recovery} -> ${result.phase}\n`);
    } finally {
      await f.close();
    }
  }
});
test("export validation refuses version, event/blob/cut corruption and all three SQLite scope losses", async () => {
  const f = await fixture();
  try {
    const tuples = await f.source.export("recovery"),
      manifest = {
        schema: "storage-migration/v1",
        versions: storageMigrationVersions,
        repoId,
        runId: "recovery",
        source: f.source.id,
        target: f.target.id,
        tuples,
      } as const;
    validateStorageManifest(manifest);
    assert.throws(
      () => validateStorageManifest({ ...manifest, versions: { ...manifest.versions, reducer: 2 } as never }),
      { code: "storage_migration_version_unsupported" },
    );
    assert.throws(
      () =>
        validateStorageManifest({
          ...manifest,
          tuples: [{ ...tuples[0]!, events: [{ ...tuples[0]!.events[0]!, digest: "sha256:bad" }] }],
        }),
      { code: "storage_migration_mismatch" },
    );
    assert.throws(() => assertSqliteMigrationScope([...tuples, ...tuples]), {
      code: "storage_migration_multiple_tuples",
    });
    assert.throws(() => assertSqliteMigrationScope([{ ...tuples[0]!, scope: { ...scope, readers: ["reader"] } }]), {
      code: "storage_migration_readers",
    });
    assert.throws(() => assertSqliteMigrationScope([{ ...tuples[0]!, scope: { ...scope, policyEpoch: 1 } }]), {
      code: "storage_migration_policy_epoch",
    });
    process.stdout.write("MIGRATION_REFUSALS multiple_tuples/readers/policy_epoch: rejected\n");
  } finally {
    await f.close();
  }
});

test("a committed activation whose acknowledgement is lost is resolved only from the target marker", async () => {
  const f = await fixture();
  let once = true;
  const target = {
    ...f.target,
    change: async (...args: Parameters<typeof f.target.change>) => {
      await f.target.change(...args);
      if (args[2] && once) {
        once = false;
        throw new Error("lost acknowledgement");
      }
    },
  };
  try {
    await assert.rejects(migrateStorage({ ...f.input, target }), /lost acknowledgement/);
    assert.equal(await f.target.marker("recovery"), true);
    assert.equal((await f.source.state())!.phase, "source_sealed");
    await f.reopen();
    assert.equal((await migrateStorage({ ...f.input, mode: "resume" })).phase, "target_activated");
  } finally {
    await f.close();
  }
});

test("old edge replication cursors require a fresh full snapshot after activation", async () => {
  const f = await fixture();
  try {
    const old = openSqliteEventStore({ repoId, rootInput: f.a, readOnly: true }),
      cursor = old.replicationPosition();
    old.close();
    const result = await migrateStorage(f.input);
    assert.equal(result.replicaRecovery, "full_snapshot_required");
    const fresh = openSqliteEventStore({ repoId, rootInput: f.b, readOnly: true });
    try {
      assert.notEqual(fresh.replicationPosition().history, cursor.history);
      assert.throws(() => fresh.replicationCommits(cursor, 10), /replication_snapshot_required/);
    } finally {
      fresh.close();
    }
  } catch (error) {
    process.stderr.write(`MIGRATION_REPLICA_FAILURE ${String(error)}\n`);
    throw error;
  } finally {
    await f.close();
  }
});

for (const mode of ["preflight", "migrate"] as const) {
  test(`${mode} refuses a populated target before taking the source epoch`, async () => {
    const f = await fixture(true);
    try {
      const epoch = await f.source.epoch();
      await assert.rejects(migrateStorage({ ...f.input, mode }), { code: "storage_migration_target_not_empty" });
      assert.equal(await f.source.state(), null);
      assert.equal(await f.source.epoch(), epoch);
      assert.equal(await f.target.state(), null);
    } finally {
      await f.close();
    }
  });
}

test("a retained historical marker cannot reactivate an authority retired by a later reverse migration", async () => {
  const f = await fixture(),
    thirdRoot = path.join(f.root, "third");
  mkdirSync(thirdRoot);
  initRepo(thirdRoot);
  const third = openSqliteMigrationEndpoint({ rootDir: thirdRoot, repoId, scope, role: "target" });
  try {
    await migrateStorage(f.input);
    await migrateStorage({
      repoId,
      runId: "reverse",
      source: f.target,
      target: third,
      exportDirectory: path.join(f.root, "reverse"),
    });
    assert.equal(await f.target.marker("recovery"), true);
    await assert.rejects(migrateStorage({ ...f.input, mode: "resume" }), { code: "storage_migration_conflict" });
    assert.equal((await third.state())!.role, "target");
    assert.equal((await f.target.state())!.role, "source");
  } finally {
    await third.close();
    await f.close();
  }
});

test("epoch takeover refuses a newer writer even when its event cut did not change", async () => {
  const f = await fixture(),
    racing = openSqliteEventStore({ repoId, rootInput: f.a });
  try {
    const higher = (await f.source.epoch()) + 50;
    await assert.rejects(
      migrateStorage({
        ...f.input,
        source: {
          ...f.source,
          async change(expected, next, activate) {
            if (next.phase === "freezing") racing.claimWriter({ repoId, holder: "racing-writer", epoch: higher });
            return f.source.change(expected, next, activate);
          },
        },
      }),
      { code: "storage_migration_conflict" },
    );
    assert.equal(await f.source.state(), null);
    assert.equal(await f.source.epoch(), higher);
    assert.equal(await f.target.state(), null);
  } finally {
    racing.close();
    await f.close();
  }
});

test("configuration cannot select a permanently retired source for a fresh migration run", async () => {
  const f = await fixture(),
    thirdRoot = path.join(f.root, "third");
  mkdirSync(thirdRoot);
  initRepo(thirdRoot);
  const third = openSqliteMigrationEndpoint({ rootDir: thirdRoot, repoId, scope, role: "target" });
  try {
    await migrateStorage(f.input);
    await assert.rejects(
      migrateStorage({
        ...f.input,
        runId: "stale-config",
        target: third,
        exportDirectory: path.join(f.root, "stale-config"),
      }),
      { code: "storage_migration_source_retired" },
    );
    assert.equal(await third.state(), null);
    assert.equal((await f.source.state())!.runId, "recovery");
    assert.equal((await f.target.state())!.role, "target");
  } finally {
    await third.close();
    await f.close();
  }
});
