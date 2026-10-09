// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { READ_MODEL_SCHEMA_GENERATION } from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { openReplicaCutSource } from "../src/fleet/replica-cut-store.ts";

for (const size of [200, 2000]) {
  test(`GC scans each distinct retained manifest once (${size} entries)`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-cut-gc-"));
    const first = lifecycleFixture().events[0]!;
    const events = Array.from({ length: 72 }, (_, index) => ({
      ...first,
      workspaceRevision: index + 1,
      opId: `gc-${index + 1}`,
      eventId: `gc-event-${index + 1}`,
    }));
    const documents = Array.from({ length: size }, (_, index) => ({
      path: `context/d${String(index).padStart(6, "0")}.md`,
      blobSha256: "a".repeat(64),
      size: 128,
      mediaType: "text/plain",
    }));
    let head = 1,
      tick = 0,
      scans = 0;
    const parse = JSON.parse;
    // Every full manifest read parses this entry once; writing a manifest does not parse entries.
    t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      const value = parse(text, reviver);
      if (value?.path === documents[0]!.path) scans += 1;
      return value;
    });
    const source = openReplicaCutSource({
      repoId: "gc",
      localRoot: root,
      readBasis: (after) => ({
        watermark: head,
        sourceRevision: head,
        headEvent: events[head - 1]!,
        events: after === null ? [] : events.slice(after, head),
        documents,
      }),
      readContentBlob: () => null,
      monotonicNow: () => (tick += 101),
      readEdgeReadModel: (read) =>
        read({
          sourceRevision: head,
          rootThreshold: 0,
          rows: {
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
          },
        }),
    });
    try {
      assert.equal(source.activate()?.revision, 1);
      head = 72;
      const samples = [];
      for (let revision = 2; revision <= head; revision += 1) {
        const before = scans,
          started = performance.now();
        await source.waitForCut(revision);
        samples.push({ revision, scans: scans - before, wallMs: performance.now() - started });
      }
      t.diagnostic(JSON.stringify({ size, samples }));
      assert.equal(source.cut(8), null);
      assert.equal(source.cut(9)?.revision, 9);
      assert.equal(source.latest()?.revision, 72);
      for (const sample of samples) {
        // One build read, then one GC read per digest. Revision 72 adds a new read-model digest.
        assert.equal(sample.scans, sample.revision <= 64 ? 1 : sample.revision === 72 ? 3 : 2);
      }
    } finally {
      source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const corruptRetained of [false, true]) {
  test(`GC preserves distinct retained manifests and their validation (corrupt=${corruptRetained})`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-cut-gc-retained-"));
    const first = lifecycleFixture().events[0]!;
    const events = Array.from({ length: 96 }, (_, index) => ({
      ...first,
      workspaceRevision: index + 1,
      opId: `retained-${index + 1}`,
      eventId: `retained-event-${index + 1}`,
    }));
    let head = 1,
      tick = 0;
    const source = openReplicaCutSource({
      repoId: "gc",
      localRoot: root,
      readBasis: (after) => ({
        watermark: head,
        sourceRevision: head,
        headEvent: events[head - 1]!,
        events: after === null ? [] : events.slice(after, head),
        documents: [],
      }),
      readContentBlob: () => null,
      monotonicNow: () => (tick += 101),
      readEdgeReadModel: (read) =>
        read({
          sourceRevision: head,
          rootThreshold: 0,
          rows: {
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
          },
        }),
    });
    let database: DatabaseSync | undefined;
    try {
      const initial = source.activate()!;
      const oldEntry = source.manifestEntry(1, ".read-model/meta.json")!;
      const oldBytes = source.content(oldEntry.blob);
      head = 32;
      await source.waitForCut(32);
      const newerEntry = source.manifestEntry(32, ".read-model/meta.json")!;
      assert.notEqual(oldEntry.blob.sha256, newerEntry.blob.sha256);
      head = 96;
      await source.waitForCut(65);
      assert.equal(source.cut(1), null);
      assert.equal(source.cut(2)?.manifest.digest, initial.manifest.digest);
      assert.deepEqual(source.content(oldEntry.blob), oldBytes);
      assert.ok(source.content(newerEntry.blob).length > 0);
      database = new DatabaseSync(
        path.join(root, "replica/repos/gc", `g${READ_MODEL_SCHEMA_GENERATION}`, "cuts-v2.sqlite"),
      );
      if (corruptRetained) {
        // Corrupt an older digest, not the builder's latest manifest: only GC reads it next round.
        database
          .prepare("UPDATE manifest_entry SET entry_json = '{}' WHERE manifest_digest = ?")
          .run(initial.manifest.digest);
        await assert.rejects(source.waitForCut(66), /replica manifest .* is corrupt/u);
      } else {
        await source.waitForCut(96);
        assert.equal(source.cut(32), null);
        assert.equal(source.cut(33)?.revision, 33);
        assert.equal(
          database.prepare("SELECT 1 FROM manifest_entry WHERE manifest_digest = ?").get(initial.manifest.digest),
          undefined,
        );
        assert.equal(
          database.prepare("SELECT 1 FROM read_model_blob WHERE sha256 = ?").get(oldEntry.blob.sha256),
          undefined,
        );
        assert.ok(source.content(newerEntry.blob).length > 0);
        assert.ok(source.changes(33, 96));
        assert.equal(source.changes(32, 96), null);
      }
    } finally {
      database?.close();
      source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
