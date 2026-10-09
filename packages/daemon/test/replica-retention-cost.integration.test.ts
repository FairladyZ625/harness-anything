// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { EdgeReadModelRows } from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { openReplicaCutSource } from "../src/fleet/replica-cut-store.ts";
import { openReplicaAckStore } from "../src/fleet/replica-ack-store.ts";
import { makeOffer } from "../src/fleet/center-replica-offer.ts";

test("pin admission and ACK-window pruning do not scan retained manifest entries", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-retention-cost-"));
  const leaseRoot = path.join(root, "center");
  // One metadata entry plus the same number of documents as the reported production cut.
  const count = 383347;
  const documents = Array.from({ length: count - 1 }, (_, i) => ({
    path: `context/d${String(i).padStart(6, "0")}.md`,
    blobSha256: i.toString(16).padStart(64, "0"),
    size: 9000,
    mediaType: "text/plain",
  }));
  const rows: EdgeReadModelRows = {
    tasks: [],
    taskGeneration: [],
    taskProgress: [],
    entities: [],
    leases: [],
    relations: [],
    decisions: [],
    facts: [],
    presetSnapshots: [],
    repository: [],
  };
  const first = lifecycleFixture().events[0]!;
  let revision = 1,
    pruning = false,
    admitting = false,
    scans = 0,
    pruneStarted = 0,
    pruneMs = 0;
  let coldOpening = false,
    coldManifestScans = 0;
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "SELECT revision FROM cut ORDER BY revision DESC LIMIT 64") {
      pruning = true;
      pruneStarted = performance.now();
    }
    if ((pruning || admitting) && /FROM manifest_entry/u.test(sql)) scans++;
    if (coldOpening && /FROM manifest_entry/u.test(sql)) coldManifestScans++;
    const statement = prepare.call(this, sql);
    if (sql === "DELETE FROM checkpoint_link WHERE from_revision < ?") {
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        const result = run(...args);
        pruneMs = performance.now() - pruneStarted;
        pruning = false;
        return result;
      };
    }
    return statement;
  });
  const open = () =>
    openReplicaCutSource({
      repoId: "cost",
      localRoot: root,
      readBasis: (after) => ({
        watermark: revision,
        sourceRevision: revision,
        headEvent: { ...first, workspaceRevision: revision, opId: `op-${revision}`, eventId: `event-${revision}` },
        documents,
        events: after === null ? [] : [{ ...first, workspaceRevision: revision }],
      }),
      readContentBlob: () => null,
      readEdgeReadModel: (read) => read({ sourceRevision: revision, rootThreshold: 0, rows }),
    });
  let source = open();
  const ack = openReplicaAckStore(leaseRoot);
  const key = { repoId: "cost", nodeId: "ack", viewId: "ack" };
  const samples = [];
  try {
    source.activate();
    const lease = ack.delivery.claim(key, "ack", now, 30_000)!;
    const target = await source.pin(lease, null, 16 * 1024 ** 3, leaseRoot);
    assert.equal(target.manifest.entryCount, count);
    const offer = ack.offer(key, await makeOffer(key, null, target, source, new Date(now).toISOString()));
    assert.equal(
      ack.ack(
        key,
        offer.transferId,
        offer.toCut,
        offer.manifestDigest,
        new Date(now).toISOString(),
        source.eventAt(1)!,
        lease,
      ).outcome,
      "applied",
    );
    ack.delivery.release(lease);
    const newcomer = ack.delivery.claim({ ...key, nodeId: "new", viewId: "new" }, "new", now, 30_000)!;
    for (revision = 1; revision <= 5; revision++) {
      const buildStarted = performance.now();
      if (revision > 1) await source.waitForCut(revision);
      const publicationMs = performance.now() - buildStarted;
      if (![1, 3, 5].includes(revision)) continue;
      assert.equal(
        new Set(Array.from({ length: revision }, (_, i) => source.cut(i + 1)!.manifest.digest)).size,
        revision,
      );
      const admissions = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        admitting = true;
        const started = performance.now();
        assert.equal((await source.pin(newcomer, 1, 16 * 1024 ** 3, leaseRoot)).revision, revision);
        admissions.push(performance.now() - started);
        admitting = false;
        source.releasePin(newcomer);
      }
      const sample = {
        entries: count,
        retainedManifests: revision,
        pinMs: admissions,
        ackPruneMs: revision === 1 ? null : pruneMs,
        publicationMs,
      };
      samples.push(sample);
      t.diagnostic(JSON.stringify(sample));
      assert.equal(source.pinActive(lease), true, "ACK window survives each publication");
    }
    revision = 5;
    source.close();
    source = open();
    coldOpening = true;
    const coldStarted = performance.now();
    source.activate();
    const coldActivationMs = performance.now() - coldStarted;
    coldOpening = false;
    admitting = true;
    const reopenedPinStarted = performance.now();
    assert.equal((await source.pin(newcomer, 1, 16 * 1024 ** 3, leaseRoot)).revision, 5);
    const reopenedPinMs = performance.now() - reopenedPinStarted;
    admitting = false;
    t.diagnostic(
      JSON.stringify({ samples, coldActivationMs, reopenedPinMs, coldManifestScans, hotManifestScans: scans }),
    );
    assert.equal(coldManifestScans, 1, "reopen seeds one manifest and replays the sparse change chain");
    assert.equal(scans, 0, "quota reads must use maintained bytes, not re-scan manifest entries");
  } finally {
    source.close();
    ack.close();
    rmSync(root, { recursive: true, force: true });
  }
});
