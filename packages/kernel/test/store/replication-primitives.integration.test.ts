// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openSqliteEventStore } from "../../src/store/sqlite-event-store.ts";
import { openReplicaStore } from "../../src/store/replica-store.ts";

test("online backup preserves pinned ledger and projection snapshots while another connection commits", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replication-primitives-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writers: DatabaseSync[] = [],
    readers: DatabaseSync[] = [];
  try {
    for (const name of ["ledger", "projection"]) {
      const file = path.join(root, `${name}.sqlite`),
        writer = new DatabaseSync(file);
      writers.push(writer);
      writer.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE position(n INTEGER, s INTEGER); INSERT INTO position VALUES(3,4); CREATE TABLE payload(id INTEGER PRIMARY KEY, value BLOB)",
      );
      writer.prepare("INSERT INTO payload VALUES(1, zeroblob(?))").run(1024 * 1024);
      const reader = new DatabaseSync(file, { readOnly: true });
      readers.push(reader);
      reader.exec("BEGIN");
      assert.deepEqual({ ...reader.prepare("SELECT * FROM position").get() }, { n: 3, s: 4 });
    }
    let wroteDuringBackup = false;
    for (const [index, reader] of readers.entries()) {
      const destination = path.join(root, `backup-${index}.sqlite`);
      await backup(reader, destination, {
        rate: 1,
        progress: () => {
          if (wroteDuringBackup) return;
          for (const writer of writers) writer.exec("UPDATE position SET n=5,s=7");
          wroteDuringBackup = true;
        },
      });
      const copied = new DatabaseSync(destination, { readOnly: true });
      try {
        assert.deepEqual({ ...copied.prepare("SELECT * FROM position").get() }, { n: 3, s: 4 });
        assert.equal(copied.prepare("SELECT length(value) AS size FROM payload").get()!.size, 1024 * 1024);
      } finally {
        copied.close();
      }
    }
    assert.equal(wroteDuringBackup, true);
    for (const writer of writers)
      assert.deepEqual({ ...writer.prepare("SELECT * FROM position").get() }, { n: 5, s: 7 });
  } finally {
    for (const reader of readers) reader.close();
    for (const writer of writers) writer.close();
  }
});

test("a rejected eventless commit advances replication and reaches a restored replica without changing event revision", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replication-outcome-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoId = "replication-test",
    databasePath = path.join(root, "center.sqlite"),
    replicaPath = path.join(root, "replica.sqlite"),
    fence = { repoId, holder: "center", epoch: 1 },
    center = openSqliteEventStore({ repoId, databasePath });
  try {
    center.claimWriter(fence);
    const base = center.replicationPosition();
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await backup(source, replicaPath);
    } finally {
      source.close();
    }
    const replica = openReplicaStore({ repoId, databasePath: replicaPath });
    try {
      const result = center.appendCommand({
        fence,
        events: [],
        rejectionCode: "test_rejected",
        intent: { opId: "rejected-command", intentDigest: `sha256:${"a".repeat(64)}`, summary: "eventless rejection" },
      });
      assert.equal(center.revision(), base.revision);
      assert.equal(center.replicationPosition().sequence, base.sequence + 1);
      const page = center.replicationCommits(base, 10);
      assert.equal(page.done, true);
      assert.equal(page.commits.length, 1);
      assert.deepEqual(page.commits[0]!.events, []);
      assert.deepEqual(page.commits[0]!.outcome, result);
      replica.apply(page.commits[0]!, []);
      assert.deepEqual(replica.position(), center.replicationPosition());
      const view = openSqliteEventStore({ repoId, databasePath: replicaPath, readOnly: true });
      try {
        assert.deepEqual(view.readCommandOutcome(result.opId), result);
        assert.equal(view.revision(), base.revision);
      } finally {
        view.close();
      }
      assert.deepEqual(replica.apply(page.commits[0]!, []), page.head);
      assert.throws(
        () => replica.apply({ ...page.commits[0]!, position: { ...page.head, sequence: page.head.sequence + 2 } }, []),
        /sequence gap/u,
      );
      const beforeFailure = center.replicationPosition();
      assert.throws(
        () =>
          center.appendCommand({
            fence,
            events: [],
            rejectionCode: "test_rejected",
            intent: { opId: "rolled-back", intentDigest: `sha256:${"b".repeat(64)}`, summary: "rollback" },
            beforeOutcome: () => {
              throw new Error("interrupted commit");
            },
          }),
        /interrupted commit/u,
      );
      assert.deepEqual(center.replicationPosition(), beforeFailure);
      assert.equal(center.outcome("rolled-back"), null);
      center.pruneReplicationLog(page.head.sequence);
      assert.throws(() => center.replicationCommits(base, 10), /snapshot_required/u);
      assert.equal(center.replicationCommits(page.head, 10).done, true);
      assert.throws(
        () => center.replicationCommits({ ...page.head, revision: page.head.revision + 1 }, 10),
        /snapshot_required/u,
      );
    } finally {
      replica.close();
    }
  } finally {
    center.close();
  }
});
