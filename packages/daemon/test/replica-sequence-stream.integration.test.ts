// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createReplicaSequence,
  readReplicaSequence,
  readReplicaRevision,
} from "../../kernel/test/store/replica-model.fixture.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { openReplicaCutSource } from "../src/fleet/replica-cut-store.ts";
import { makeOffer, offerFrames } from "../src/fleet/center-replica-offer.ts";

test("interrupted streamed publication rolls back; three deliveries fold repeated paths through the final page", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-stream-"));
  const db = new DatabaseSync(path.join(root, "sequence.sqlite"));
  createReplicaSequence(db);
  const event = lifecycleFixture().events[0]!;
  const revision = (value: number) =>
    db
      .prepare("INSERT INTO replica_revision VALUES (?,?)")
      .run(value, JSON.stringify({ ...event, workspaceRevision: value, opId: `revision-${value}` }));
  revision(1);
  const insert = db.prepare("INSERT INTO replica_entry VALUES (?,NULL,?,'model','')");
  for (let i = 0; i < 257; i++) insert.run(`rows/${String(i).padStart(3, "0")}`, `body-${i}`);
  let interrupt = true;
  const open = () =>
    openReplicaCutSource({
      repoId: "stream",
      localRoot: root,
      readSequence: (from, read) => {
        const sequence = readReplicaSequence(db, from);
        return read(
          sequence && {
            ...sequence,
            changes: (function* () {
              let count = 0;
              for (const change of sequence.changes) {
                if (interrupt && ++count === 129) throw new Error("interrupt uncommitted cut");
                yield change;
              }
            })(),
          },
        );
      },
      readRevision: (value) => readReplicaRevision(db, value),
      readContentBlob: () => null,
    });
  let source = open();
  try {
    assert.throws(() => source.activate(), /interrupt uncommitted cut/u);
    assert.equal(source.latest(), null);
    source.close();
    interrupt = false;
    source = open();
    const first = source.activate()!;
    assert.equal(first.manifest.entryCount, 257);
    revision(2);
    db.exec("INSERT INTO replica_change SELECT 2,path,NULL,text FROM replica_entry");
    revision(3);
    db.exec("INSERT INTO replica_change VALUES (3,'rows/000',NULL,'replacement'),(3,'rows/001',NULL,NULL)");
    const latest = await source.waitForCut(3);
    const changes = source.changes(1, 3)!;
    assert.equal(changes.count, 257);
    assert.equal(latest.manifest.entryCount, 256);
    const sizes: number[] = [];
    let advanced = false;
    const original = source.delivery.changes;
    source.delivery.changes = async (from, to) => {
      const sequence = await original(from, to);
      return (
        sequence && {
          ...sequence,
          page: (cursor) => {
            const page = sequence.page(cursor);
            sizes.push(page.changes.length);
            if (!advanced) {
              advanced = true;
              revision(4);
              db.exec("INSERT INTO replica_change VALUES (4,'rows/000',NULL,'later replacement')");
              assert.equal(source.activate()!.revision, 4, "publication can commit between delivery pages");
            }
            return page;
          },
        }
      );
    };
    const run = async (nodeId: string) => {
      const key = { repoId: "stream", nodeId, viewId: nodeId };
      const offer = {
        ...key,
        ...(await makeOffer(
          key,
          {
            revision: first.revision,
            headDigest: first.headDigest,
            manifestDigest: first.manifest.digest,
          } as Parameters<typeof makeOffer>[1],
          latest,
          source,
          new Date().toISOString(),
        )),
      };
      assert.equal(offer.kind, "delta");
      const pages: number[] = [];
      let chunks = 0;
      const delivered = [];
      for await (const frame of offerFrames(offer, source, { owner: "owner", digest: "shape" })) {
        if (frame.schema === "fleet.delta.page/v1") {
          pages.push(frame.changes.length);
          delivered.push(...frame.changes);
        }
        if (frame.schema === "fleet.delta.chunk/v1") chunks++;
      }
      assert.deepEqual(pages, [128, 128, 1]);
      assert.equal(new Set(delivered.map((change) => change.path)).size, 257);
      assert.deepEqual(
        delivered.find((change) => change.path === "rows/001"),
        { op: "delete", path: "rows/001" },
      );
      const replaced = delivered.find((change) => change.path === "rows/000")!;
      assert.equal(replaced.op, "put");
      if (replaced.op === "put") assert.equal(source.content(replaced.blob).toString(), "replacement");
      assert.equal(chunks, 256);
    };
    await Promise.all([run("one"), run("two"), run("three")]);
    assert.equal(sizes.length, 18, "each of three deliveries reads exactly three pages twice");
    assert.equal(sizes.filter((size) => size === 1).length, 6, "each reader reaches its final page");
    t.diagnostic("three independent delta deliveries: 128/128/1 pages, 256 blobs each; rollback/reopen succeeded");
  } finally {
    source.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
