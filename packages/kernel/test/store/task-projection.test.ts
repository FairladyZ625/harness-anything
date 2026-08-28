// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { makeTaskProjection } from "../../src/projection/task-projection.ts";
import {
  makeTaskEventStore,
  type CanonicalEventStore,
  type CanonicalWriteBundle,
} from "../../src/store/task-event-store.ts";
import { makeWalShadowEventStore } from "../../src/store/wal-shadow-event-store.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { compileEntityUpsert } from "../../src/domain/entity-event.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle.contract.ts";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
  decideDocWrite,
  parseDocWriteIntent,
  serializeCanonicalEvent,
  serializePersistedCanonicalEvent,
  type CanonicalEventV1,
  type DocEventV1,
} from "../../src/domain/doc-sync.contract.ts";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  MIGRATION_IMPORT_SOURCE,
  migrationImportWritePlan,
  type MigrationImportEventV1,
} from "../../src/domain/migration-import-event.ts";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../src/domain/artifact-text-classification.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { eventObjectRelativePath } from "../../src/layout/ledger-object-layout.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("a newer ledger epoch forces a complete projection cold rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const seed = lifecycleFixture().events,
      store = makeTaskEventStore({ repoId: "epoch-rebuild", rootDir });
    store.append({ event: seed[0]!, plan: taskLifecycleWritePlan(seed[0]!), blobs: [] });
    await store.drain();
    let edgeSource = store;
    const readCursors: (string | null)[] = [],
      edgeStore = {
        ...store,
        readHead: () => edgeSource.readHead(),
        readLedgerEpoch: () => edgeSource.readLedgerEpoch(),
        readBatch: (cursor: string | null, maxItems: number) => {
          readCursors.push(cursor);
          return edgeSource.readBatch(cursor, maxItems);
        },
        readContentBlob: (sha256: string) => edgeSource.readContentBlob(sha256),
      };
    const projection = makeTaskProjection({ rootDir, eventStore: edgeStore });
    assert.equal(projection.read("task-1").watermark, 1);
    assert.equal(projection.read("task-1").snapshot.task?.title, "Fixture");
    readCursors.length = 0;
    const rewrittenSeed = {
        ...seed[0]!,
        payload: {
          ...seed[0]!.payload,
          task: { ...seed[0]!.payload.task, title: "Rewritten fixture" },
        },
      },
      markerBody = '{"schema":"epoch-marker/v1"}\n',
      markerSha = sha256Text(markerBody),
      marker: MigrationImportEventV1 = {
        schema: "migration-import-event/v1",
        eventId: "event-epoch-marker",
        workspaceRevision: 2,
        opId: "op-epoch-marker",
        type: "entity_migrated",
        actor: { principal: { personId: "person-1" }, executor: null },
        source: MIGRATION_IMPORT_SOURCE,
        occurredAt: "2026-08-11T00:01:00.000Z",
        payload: {
          migratedFrom: "fact-rekey/v1",
          generation: "v0",
          ledgerEpoch: 1,
          entity: {
            kind: "id-map",
            importId: "epoch-marker",
            documentClaim: {
              path: "migration/epoch-marker.json",
              sha256: markerSha,
              size: Buffer.byteLength(markerBody),
              mediaType: "application/json",
              policyId: MIGRATION_DOCUMENT_POLICY_ID,
            },
          },
        },
      };
    store.append(
      {
        event: marker,
        plan: migrationImportWritePlan(marker),
        blobs: [
          { sha256: markerSha, size: Buffer.byteLength(markerBody), mediaType: "application/json", body: markerBody },
        ],
      },
      [
        {
          target: `harness/${eventObjectRelativePath(rewrittenSeed.opId, store.layout())}`,
          body: serializePersistedCanonicalEvent(rewrittenSeed),
          mode: "100644",
        },
      ],
    );
    store.append(batchDocumentBundle(store, 3));
    await store.drain();
    assert.equal(store.readLedgerEpoch(), 1);
    edgeSource = makeTaskEventStore({ repoId: "epoch-rebuild", rootDir });
    assert.equal(edgeSource.readLedgerEpoch(), 1);
    const replayed = projection.read("task-1");
    assert.equal(readCursors[0], null);
    assert.equal(replayed.watermark, 3);
    assert.equal(replayed.sourceRevision, 3);
    assert.equal(replayed.snapshot.task?.title, "Rewritten fixture");
    const db = new DatabaseSync(projection.path);
    try {
      assert.equal(
        (db.prepare("SELECT ledger_epoch FROM projection_meta WHERE singleton = 1").get() as { ledger_epoch: number })
          .ledger_epoch,
        1,
      );
    } finally {
      db.close();
      projection.close();
    }
  });
});

test("task/doc reducers share one SQLite transaction and L2 rebuild restores exact document bytes", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      body = "# Notes\n\nAppended prose.\n",
      hash = sha256Text(body),
      base = eventStore.currentCut();
    const event: DocEventV1 = {
      schema: "doc-event/v1",
      eventId: "doc-event",
      workspaceRevision: 1,
      opId: "doc-op",
      type: "documents_written",
      actor: { principal: { personId: "person-1" }, executor: null },
      source: "local",
      occurredAt: "2026-08-11T00:00:00.000Z",
      payload: {
        executionId: "execution-1",
        baseLedgerSha: base,
        changes: [
          {
            path: "context/notes.md",
            baseBlobSha256: null,
            candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" },
            policyId: DOC_POLICY_ID,
            regionProofs: [
              {
                regionId: "heading/notes",
                policyId: DOC_POLICY_ID,
                codecId: DOC_CODEC_ID,
                baseSha256: sha256Text(""),
                candidateSha256: hash,
                insertBytes: Buffer.byteLength(body),
              },
            ],
          },
        ],
      },
    };
    const plan = docSyncWritePlan(event);
    eventStore.append({
      event,
      plan,
      blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }],
    });
    assert.throws(() => projection.apply(event), /write plan/iu);
    assert.deepEqual(projection.apply(event, plan).metrics, { sqliteTransactions: 1, reducedItems: 1 });
    const first = projection.readDocument("context/notes.md");
    assert.equal(first.status, "ready");
    assert.equal(first.document?.body, body);
    assert.equal(first.document?.blobSha256, hash);
    const duplicate = {
      ...event,
      eventId: "duplicate-doc-event",
      opId: "duplicate-doc-op",
      workspaceRevision: 2,
      payload: { ...event.payload, baseLedgerSha: eventStore.currentCut() },
    } satisfies DocEventV1;
    eventStore.append({
      event: duplicate,
      plan: docSyncWritePlan(duplicate),
      blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }],
    });
    projection.apply(duplicate, docSyncWritePlan(duplicate));
    assert.equal(projection.readDocument("context/notes.md").document?.body, body);
    assert.equal(projection.readOperation(event.opId)?.event.schema, "doc-event/v1");
    projection.close();
    rmSync(projection.path, { force: true });
    const reopened = projection.readDocument("context/notes.md");
    assert.equal(reopened.status, "ready");
    assert.deepEqual(reopened.document, first.document);
    projection.close();
    rmSync(projection.path, { force: true });
    const rebuilt = projection.rebuild();
    assert.equal(rebuilt.watermark, 2);
    assert.deepEqual(projection.readDocument("context/notes.md").document, first.document);
  });
});

test("fact-rekey retirement deletes a facts document when its historical base claim is stale", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "fact-rekey-retirement", rootDir }),
      documentPath = "tasks/task-1/facts.md",
      body = "# Legacy facts\n",
      hash = sha256Text(body),
      physicalBody = "# Facts changed outside the event stream\n",
      physicalPath = path.join(rootDir, "harness", documentPath),
      seed: DocEventV1 = {
        schema: "doc-event/v1",
        eventId: "fact-rekey-seed",
        workspaceRevision: 1,
        opId: "fact-rekey-seed-op",
        type: "documents_written",
        actor: { principal: { personId: "person-1" }, executor: null },
        source: "local",
        occurredAt: "2026-08-11T00:00:00.000Z",
        payload: {
          executionId: null,
          baseLedgerSha: eventStore.currentCut(),
          changes: [
            {
              path: documentPath,
              baseBlobSha256: null,
              candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" },
              policyId: OPAQUE_TEXTUAL_POLICY_ID,
              regionProofs: [],
            },
          ],
        },
      };
    eventStore.append({
      event: seed,
      plan: docSyncWritePlan(seed),
      blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }],
    });
    mkdirSync(path.dirname(physicalPath), { recursive: true });
    writeFileSync(physicalPath, physicalBody);
    git(rootDir, "add", "harness");
    git(rootDir, "commit", "--quiet", "-m", "physical facts update");
    git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
    const retirementStore = makeTaskEventStore({ repoId: "fact-rekey-retirement", rootDir });
    const retirement: DocEventV1 = {
      ...seed,
      eventId: "fact-rekey-retirement",
      workspaceRevision: 2,
      opId: "fact-rekey-retirement-op",
      payload: {
        executionId: null,
        baseLedgerSha: retirementStore.currentCut(),
        changes: [
          {
            path: documentPath,
            baseBlobSha256: sha256Text(physicalBody),
            candidate: null,
            policyId: OPAQUE_TEXTUAL_POLICY_ID,
            regionProofs: [],
          },
        ],
        retirementReason: "fact records were re-keyed",
      },
    };
    retirementStore.append({ event: retirement, plan: docSyncWritePlan(retirement), blobs: [] });
    const projection = makeTaskProjection({ rootDir, eventStore: retirementStore });
    projection.close();
    rmSync(projection.path, { force: true });
    assert.equal(projection.rebuild().watermark, 2);
    assert.equal(projection.readDocument(documentPath).document, null);
  });
});

test("headless direct apply is instance-local and never preserves an ahead cache across reopen", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const event = lifecycleFixture().events[0]!,
      headlessStore = () => ({
        readHead: () => null,
        readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
        readContentBlob: () => null,
      });
    const live = makeTaskProjection({ rootDir, eventStore: headlessStore() });
    live.apply(event, taskLifecycleWritePlan(event));
    const hot = live.read(event.taskId);
    assert.deepEqual(
      { status: hot.status, watermark: hot.watermark, sourceRevision: hot.sourceRevision },
      { status: "pending", watermark: 1, sourceRevision: 0 },
    );
    assert.equal(hot.snapshot.task?.taskId, event.taskId);
    assert.equal(live.rebuild().watermark, 0);
    assert.equal(live.read(event.taskId).snapshot.task, null);
    live.apply(event, taskLifecycleWritePlan(event));
    live.close();

    const reopened = makeTaskProjection({ rootDir, eventStore: headlessStore() }),
      cold = reopened.read(event.taskId);
    assert.deepEqual(
      { status: cold.status, watermark: cold.watermark, sourceRevision: cold.sourceRevision },
      { status: "ready", watermark: 0, sourceRevision: 0 },
    );
    assert.equal(cold.snapshot.task, null);
    assert.equal(reopened.readOperation(event.opId), null);
  });
});

test("closing a projection through a filesystem alias releases every handle on its database", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const aliasRoot = `${rootDir}-alias`;
    symlinkSync(rootDir, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const source = () => ({
      readHead: () => null,
      readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
      readContentBlob: () => null,
    });
    try {
      const canonical = makeTaskProjection({ rootDir, eventStore: source() });
      const aliased = makeTaskProjection({ rootDir: aliasRoot, eventStore: source() });
      canonical.read("missing");
      aliased.read("missing");
      aliased.close();
      rmSync(canonical.path, { force: true });
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  });
});

test("cold projection reuses one batch tree scan and its verified blob prefetch", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const writer = makeTaskEventStore({ repoId: "batch-prefetch", rootDir }),
      count = 128;
    for (let revision = 1; revision <= count; revision += 1) writer.append(batchDocumentBundle(writer, revision));
    const reader = makeTaskEventStore({ repoId: "batch-prefetch", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: reader, catchUpLimit: 64 }),
      before = localGitObjectRefStore.processCount();
    let read = projection.readDocument(batchDocumentPath(count));
    for (let round = 1; read.status === "pending" && round < 4; round += 1)
      read = projection.readDocument(batchDocumentPath(count));
    assert.equal(read.status, "ready");
    assert.equal(read.document?.body, batchDocumentBody(count));
    const processes = localGitObjectRefStore.processCount() - before;
    assert.equal(
      processes <= 7,
      true,
      `cold projection opened ${processes} Git processes for ${count} claimed blobs across two batches`,
    );
  });
});

test("event batches are revision ordered even when the Git tree is hash ordered", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const writer = makeTaskEventStore({ repoId: "revision-ordered-batch", rootDir });
    for (const event of lifecycleFixture().events) writer.append(taskBundle(event));
    const batch = writer.readBatch(null, 4096);
    assert.deepEqual(
      batch.events.map((event) => event.workspaceRevision),
      [1, 2, 3, 4, 5, 6],
    );
  });
});

test("projection rebuild crosses a missing workspace revision after the source scan completes", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const fixture = lifecycleFixture().events,
      first = fixture[0]!,
      second = { ...fixture[1]!, workspaceRevision: 3 },
      source = {
        readHead: () => ({
          revision: second.workspaceRevision,
          eventDigest: `sha256:${sha256Text(serializeCanonicalEvent(second))}`,
        }),
        readBatch: (_cursor: string | null, _maxItems: number) => ({
          sourceRevision: second.workspaceRevision,
          events: [first, second],
          cursor: "done",
          done: true,
          accessedItems: 2,
          prefetchContent: () => new Map<string, Uint8Array | null>(),
        }),
        readContentBlob: () => null,
      },
      projection = makeTaskProjection({ rootDir, eventStore: source });
    const rebuilt = projection.rebuild();
    assert.equal(rebuilt.watermark, 3);
    assert.equal(projection.read(first.taskId).status, "ready");
    projection.close();
  });
});

test("cold replay still rejects a missing claimed blob after batch verification", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const writer = makeTaskEventStore({ repoId: "missing-prefetch", rootDir });
    writer.append(batchDocumentBundle(writer, 1));
    const source = makeTaskEventStore({ repoId: "missing-prefetch", rootDir }),
      broken = {
        ...source,
        readBatch: (cursor: string | null, maxItems: number) => {
          const batch = source.readBatch(cursor, maxItems);
          return { ...batch, prefetchContent: () => new Map<string, Uint8Array | null>() };
        },
      },
      projection = makeTaskProjection({ rootDir, eventStore: broken });
    assert.throws(() => projection.rebuild(), /blob .* unavailable|not reachable/u);
  });
});

test("cold rebuild resets the projection in place and accepts a larger bounded replay window", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "in-place-rebuild", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore });
    const first = lifecycleFixture().events[0]!;
    eventStore.append(taskBundle(first));
    projection.apply(first, taskLifecycleWritePlan(first));
    const before = statSync(projection.path).ino;
    const rebuilt = projection.rebuild();
    const after = statSync(projection.path).ino;
    assert.equal(rebuilt.watermark, 1);
    assert.equal(after, before);
    assert.equal(rebuilt.metrics.maxBatchItems <= 4096, true);
  });
});

test("WAL-shadow cold projection preserves Git batch content prefetch", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const writer = makeTaskEventStore({ repoId: "wal-shadow-batch-prefetch", rootDir }),
      count = 128;
    for (let revision = 1; revision <= count; revision += 1) writer.append(batchDocumentBundle(writer, revision));
    const reader = makeWalShadowEventStore({ repoId: "wal-shadow-batch-prefetch", rootDir, walFlushMs: 60_000 }),
      projection = makeTaskProjection({ rootDir, eventStore: reader, catchUpLimit: 64 }),
      before = localGitObjectRefStore.processCount();
    const rebuilt = projection.rebuild(),
      processes = localGitObjectRefStore.processCount() - before;
    t.diagnostic(JSON.stringify({ events: count, gitProcesses: processes, watermark: rebuilt.watermark }));
    assert.equal(rebuilt.watermark, count);
    assert.equal(
      processes <= 7,
      true,
      `WAL-shadow cold projection opened ${processes} Git processes for ${count} claimed blobs across two batches`,
    );
    projection.close();
  });
});

test("a fresh projection prefetches deferred staged content in one batch before replay", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const writer = makeTaskEventStore({ repoId: "deferred-prefetch", rootDir });
    writer.append(batchDocumentBundle(writer, 1, "resume-op-6"));
    writer.append(batchDocumentBundle(writer, 2, "resume-op-48"));

    const first = makeTaskProjection({
      rootDir,
      eventStore: makeTaskEventStore({ repoId: "deferred-prefetch", rootDir }),
      catchUpLimit: 1,
    });
    assert.equal(first.readDocument(batchDocumentPath(1)).status, "pending");
    first.close();

    const second = makeTaskProjection({
      rootDir,
      eventStore: makeTaskEventStore({ repoId: "deferred-prefetch", rootDir }),
      catchUpLimit: 1,
    });
    assert.equal(second.readDocument(batchDocumentPath(1)).watermark, 2);
    second.close();

    const third = makeTaskProjection({
      rootDir,
      eventStore: makeTaskEventStore({ repoId: "deferred-prefetch", rootDir }),
      catchUpLimit: 1,
    });
    const resumed = third.readDocument(batchDocumentPath(2));
    assert.equal(resumed.status, "ready");
    assert.equal(resumed.document?.body, batchDocumentBody(2));
    third.close();
  });
});

test("replica basis returns one exact L2 manifest and only post-cut applied events", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      body = "# Replica\n",
      hash = sha256Text(body),
      base = eventStore.currentCut();
    const event: DocEventV1 = {
        schema: "doc-event/v1",
        eventId: "replica-event",
        workspaceRevision: 1,
        opId: "replica-op",
        type: "documents_written",
        actor: { principal: { personId: "person-1" }, executor: null },
        source: "local",
        occurredAt: "2026-08-14T00:00:00.000Z",
        payload: {
          executionId: null,
          baseLedgerSha: base,
          changes: [
            {
              path: "context/replica.md",
              baseBlobSha256: null,
              candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" },
              policyId: DOC_POLICY_ID,
              regionProofs: [
                {
                  regionId: "heading/replica",
                  policyId: DOC_POLICY_ID,
                  codecId: DOC_CODEC_ID,
                  baseSha256: sha256Text(""),
                  candidateSha256: hash,
                  insertBytes: Buffer.byteLength(body),
                },
              ],
            },
          ],
        },
      },
      plan = docSyncWritePlan(event);
    eventStore.append({
      event,
      plan,
      blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }],
    });
    assert.deepEqual(projection.readReplicaBasis(null), {
      watermark: 0,
      sourceRevision: 1,
      headEvent: null,
      events: [],
      documents: [],
    });
    projection.apply(event, plan);
    assert.deepEqual(projection.readReplicaBasis(null), {
      watermark: 1,
      sourceRevision: 1,
      headEvent: event,
      events: [],
      documents: [
        { path: "context/replica.md", blobSha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" },
      ],
    });
    assert.deepEqual(projection.readReplicaBasis(0).events, [event]);
  });
});

test("a migration policy upgrade replays identically in cold rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      standard = "governance/standards/notes-standard.md",
      actor = { principal: { personId: "person-1" }, executor: null } as const;
    const legacy = "# Standard\n\nLegacy wording.\n",
      legacyHash = sha256Text(legacy);
    const migration: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "event-migration",
      workspaceRevision: 1,
      opId: "op-migration",
      type: "entity_migrated",
      actor,
      source: MIGRATION_IMPORT_SOURCE,
      occurredAt: "2026-08-11T00:00:00.000Z",
      payload: {
        migratedFrom: standard,
        generation: "v0",
        entity: {
          kind: "repo-document",
          nodeKind: "file",
          documentClaim: {
            path: standard,
            sha256: legacyHash,
            size: Buffer.byteLength(legacy),
            mediaType: "text/markdown",
            policyId: MIGRATION_DOCUMENT_POLICY_ID,
          },
          referencedContentClaims: [],
        },
      },
    };
    eventStore.append({
      event: migration,
      plan: migrationImportWritePlan(migration),
      blobs: [{ sha256: legacyHash, size: Buffer.byteLength(legacy), mediaType: "text/markdown", body: legacy }],
    });
    const projection = makeTaskProjection({ rootDir, eventStore });
    const imported = projection.readDocument(standard);
    assert.equal(imported.status, "ready");
    assert.equal(imported.document?.policyId, MIGRATION_DOCUMENT_POLICY_ID);

    const authored = `${legacy}Replacement wording.\n`,
      intent = parseDocWriteIntent(
        {
          schema: "doc-write-intent/v1",
          executionId: null,
          baseLedgerSha: eventStore.currentCut(),
          changes: [
            {
              path: standard,
              baseBlobSha256: imported.document?.blobSha256 ?? null,
              policyId: DOC_POLICY_ID,
              candidate: {
                ref: `doc-sync-claims/${sha256Text(authored)}`,
                sha256: sha256Text(authored),
                size: Buffer.byteLength(authored),
                mediaType: "text/markdown",
              },
            },
          ],
        },
        "test-repo",
      );
    const decision = decideDocWrite({
      intent,
      opId: "op-upgrade",
      eventId: "event-upgrade",
      workspaceRevision: 2,
      actor,
      source: "local",
      occurredAt: "2026-08-11T00:01:00.000Z",
      currentLedgerSha: eventStore.currentCut(),
      lease: null,
      authorizationDecision: null,
      documents: [imported.document],
      claims: [Buffer.from(authored)],
    });
    assert.equal(decision.accepted, true, JSON.stringify(decision));
    if (!decision.accepted) return;
    assert.deepEqual(decision.event.payload.changes[0]?.policyUpgrade, {
      from: MIGRATION_DOCUMENT_POLICY_ID,
      to: DOC_POLICY_ID,
    });
    eventStore.append({ event: decision.event, plan: decision.plan, blobs: decision.blobs });

    const warm = projection.readDocument(standard);
    assert.equal(warm.status, "ready");
    assert.equal(warm.document?.policyId, DOC_POLICY_ID);
    assert.equal(warm.document?.body, authored);
    projection.close();
    rmSync(projection.path, { force: true });
    const rebuilt = projection.rebuild();
    assert.equal(rebuilt.watermark, 2);
    assert.deepEqual(projection.readDocument(standard).document, warm.document);
  });
});

test("steady apply and rebuild use the same reducer and reproduce watermark, op index, lease intervals", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    for (const event of lifecycleFixture().events) {
      eventStore.append(taskBundle(event));
      assert.deepEqual(projection.apply(event).metrics, { sqliteTransactions: 1, reducedItems: 1 });
    }

    const first = projection.read("task-1");
    assert.equal(first.status, "ready");
    assert.equal(first.watermark, 6);
    assert.equal(first.snapshot.task?.status, "done");
    assert.deepEqual(
      first.snapshot.executions.map((execution) => execution.state),
      ["accepted"],
    );
    const startOpId = lifecycleFixture().events[1]!.opId;
    assert.equal(projection.readOperation(startOpId)?.event.type, "execution_started");
    assert.deepEqual(projection.readWorkspaceSummary().summary.tasks, {
      total: 1,
      byStatus: { planned: 0, active: 0, blocked: 0, in_review: 0, done: 1, cancelled: 0, unknown: 0 },
    });
    assert.deepEqual(
      projection.readLeaseIntervals("task-1").map((interval) => ({
        executionId: interval.executionId,
        acquiredRevision: interval.acquiredRevision,
        releasedRevision: interval.releasedRevision,
        reason: interval.reason,
      })),
      [{ executionId: "execution-1", acquiredRevision: 2, releasedRevision: 3, reason: "initial_claim" }],
    );
    const firstDerivedRelations = projection
      .readRelationQuery()
      .rows.filter(({ relationType }) => relationType === "executes" || relationType === "reviews")
      .map(({ sourceRef, targetRef, relationType }) => ({ sourceRef, targetRef, relationType }))
      .sort((left, right) => left.relationType.localeCompare(right.relationType));
    assert.deepEqual(firstDerivedRelations, [
      { sourceRef: "execution/execution-1", targetRef: "task/task-1", relationType: "executes" },
      { sourceRef: "review/review-execution", targetRef: "execution/execution-1", relationType: "reviews" },
    ]);
    const incrementalStateDigest = projection.readStateDigest();
    if (incrementalStateDigest === null)
      assert.fail("a source-complete incremental projection must persist its state digest");

    projection.close();
    rmSync(projection.path, { force: true });
    const rebuilt = projection.rebuild();
    assert.equal(rebuilt.watermark, 6);
    assert.equal(rebuilt.stateDigest, incrementalStateDigest);
    assert.equal(projection.readStateDigest(), incrementalStateDigest);
    assert.equal(rebuilt.metrics.reducedItems, 6);
    assert.equal(rebuilt.metrics.maxBatchItems <= 64, true);
    assert.deepEqual(projection.read("task-1").snapshot, first.snapshot);
    assert.deepEqual(
      projection
        .readRelationQuery()
        .rows.filter(({ relationType }) => relationType === "executes" || relationType === "reviews")
        .map(({ sourceRef, targetRef, relationType }) => ({ sourceRef, targetRef, relationType }))
        .sort((left, right) => left.relationType.localeCompare(right.relationType)),
      firstDerivedRelations,
    );
    assert.equal(projection.readOperation(startOpId)?.event.type, "execution_started");

    const db = new DatabaseSync(projection.path);
    db.prepare("UPDATE task_snapshot SET snapshot_json = 'not-json'").run();
    db.close();
    assert.throws(() => projection.read("task-1"), /projection.*mismatch/u);
    projection.rebuild();
    assert.equal(projection.read("task-1").snapshot.executions[0]?.state, "accepted");
  });
});

test("generic entity events project declaration documents without overriding lifecycle entities", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "generic-entity-projection", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      [created, started] = lifecycleFixture().events;
    if (created === undefined || started?.type !== "execution_started") throw new Error("fixture requires start event");
    eventStore.append(taskBundle(created));
    projection.apply(created);
    eventStore.append(taskBundle(started));
    projection.apply(started);
    const bundle = compileEntityUpsert({
      entityKind: "agent",
      entity: {
        schema: "agent-declaration/v1",
        id: "projection-agent",
        name: "Projection Agent",
        instructions: "Exercise the generic projection writer.",
        runtime_type: "codex",
      },
      eventId: "event-generic-agent",
      opId: "op-generic-agent",
      workspaceRevision: 3,
      actor: started.actor,
      source: started.source,
      occurredAt: "2026-08-11T00:03:00.000Z",
    });
    eventStore.append(bundle);
    projection.apply(bundle.event, bundle.plan);

    const listedAgents = projection.listEntities("agent");
    assert.deepEqual(
      listedAgents.map(({ kind, id, ownerId, workspaceRevision, value }) => ({
        kind,
        id,
        ownerId,
        workspaceRevision,
        name: value.name,
      })),
      [
        {
          kind: "agent",
          id: "projection-agent",
          ownerId: null,
          workspaceRevision: 3,
          name: "Projection Agent",
        },
      ],
    );
    assert.deepEqual(projection.getEntity("agent", "projection-agent"), listedAgents[0]);
    assert.equal(projection.getEntity("agent", "missing"), null);

    assert.equal(projection.read("task-1").snapshot.executions[0]?.state, "active");
    assert.deepEqual(
      projection
        .readRelationQuery()
        .rows.filter(({ relationType }) => relationType === "executes")
        .map(({ sourceRef, targetRef }) => ({ sourceRef, targetRef })),
      [{ sourceRef: "execution/execution-1", targetRef: "task/task-1" }],
    );
    const document = projection.readDocument("agents/projection-agent.json").document;
    assert.ok(document);
    assert.deepEqual(
      { path: document.path, workspaceRevision: document.workspaceRevision, id: JSON.parse(document.body).id },
      { path: "agents/projection-agent.json", workspaceRevision: 3, id: "projection-agent" },
    );
  });
});

test("historical agent entity envelopes replay into the generic entity projection", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const actor = lifecycleFixture().events[0]!.actor,
      bundle = compileEntityUpsert({
        entityKind: "agent",
        entity: {
          schema: "agent-declaration/v1",
          id: "historical-agent",
          name: "Historical Agent",
          instructions: "Remain readable after projection cutover.",
          runtime_type: "codex",
        },
        eventId: "event-historical-agent",
        opId: "op-historical-agent",
        workspaceRevision: 1,
        actor,
        source: "local",
        occurredAt: "2026-08-11T00:01:00.000Z",
      }),
      event = {
        ...bundle.event,
        schema: "agent-entity-event/v1",
        type: "agent_entity_written",
      } as unknown as CanonicalEventV1,
      body = bundle.blobs[0].body,
      bytes = new TextEncoder().encode(body),
      eventDigest = `sha256:${sha256Text(serializeCanonicalEvent(event))}` as const,
      eventStore = {
        readHead: () => ({ revision: 1, eventDigest }),
        readBatch: () => ({
          sourceRevision: 1,
          events: [event],
          cursor: null,
          done: true,
          accessedItems: 1,
          prefetchContent: () => new Map([[bundle.blobs[0].sha256, bytes]]),
        }),
        readContentBlob: (sha256: string) => (sha256 === bundle.blobs[0].sha256 ? bytes : null),
      },
      projection = makeTaskProjection({ rootDir, eventStore });
    try {
      const read = projection.getEntity("agent", "historical-agent");
      assert.deepEqual(
        read === null
          ? null
          : {
              kind: read.kind,
              id: read.id,
              ownerId: read.ownerId,
              workspaceRevision: read.workspaceRevision,
              name: read.value.name,
            },
        {
          kind: "agent",
          id: "historical-agent",
          ownerId: null,
          workspaceRevision: 1,
          name: "Historical Agent",
        },
      );
    } finally {
      projection.close();
    }
  });
});

test("stale persistent event projection schema is discarded and replayed from the ledger", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      created = lifecycleFixture().events[0]!;
    eventStore.append(taskBundle(created));
    const projectionPath = path.join(rootDir, ".harness/cache/task.sqlite");
    mkdirSync(path.dirname(projectionPath), { recursive: true });
    const stale = new DatabaseSync(projectionPath);
    stale.exec(
      "CREATE TABLE projection_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), watermark INTEGER NOT NULL, scan_cursor TEXT, scanned_revision INTEGER NOT NULL); INSERT INTO projection_meta VALUES (1, 1, NULL, 1)",
    );
    stale.close();

    const read = makeTaskProjection({ rootDir, eventStore }).read(created.taskId);
    assert.equal(read.status, "ready");
    assert.equal(read.snapshot.task?.taskId, created.taskId);
    assert.equal(read.watermark, 1);
  });
});

test("squad run cache rows are replaceable, monotonic, and cleared for stream replay on rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      initial = {
        squadRunId: "squad_0123456789abcdef01234567",
        revision: 2,
        state: { schema: "squad-run/v1", phase: "leader_running" },
      };
    assert.equal(projection.squadRunProjectionReady(), false);
    projection.replaceSquadRuns([initial]);
    assert.equal(projection.squadRunProjectionReady(), true);
    assert.deepEqual(projection.readSquadRun(initial.squadRunId), initial);
    projection.upsertSquadRun({ ...initial, revision: 1, state: { phase: "stale" } });
    assert.deepEqual(projection.readSquadRun(initial.squadRunId), initial);
    projection.markSquadRunProjectionDirty();
    assert.equal(projection.squadRunProjectionReady(), false);
    projection.upsertSquadRun({ ...initial, revision: 3, state: { phase: "converged" } });
    assert.equal(projection.squadRunProjectionReady(), true);
    assert.equal(projection.readSquadRun(initial.squadRunId)?.revision, 3);
    projection.rebuild();
    assert.equal(projection.squadRunProjectionReady(), false);
    assert.deepEqual(projection.readSquadRuns(), []);
  });
});

// The title's "64-item/100ms" is pinned by check-implementation-contracts.mjs and no longer
// describes this test: it runs at catchUpLimit 2, and the 100ms budget was an unenforced
// literal removed with the receipt field that carried it. Renaming needs that gate updated.
test("completion lookup answers from the projection index and stays scoped to one task and execution", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      events = lifecycleFixture().events;
    const completion = events.find((event) => event.type === "task_completed")!;
    for (const event of events) {
      eventStore.append(taskBundle(event));
      projection.apply(event);
    }
    assert.deepEqual(
      projection.readTaskRuntimeBatch({ taskIds: ["task-1"] }).rows.map(({ taskId, title }) => ({ taskId, title })),
      [{ taskId: "task-1", title: "Fixture" }],
    );
    assert.deepEqual(projection.readTaskCompletion("task-1", "execution-1"), completion);
    assert.equal(projection.readTaskCompletion("task-1", "execution-2"), null);
    assert.equal(projection.readTaskCompletion("task-2", "execution-1"), null);
    // A completion published to the store but not yet reduced must still be found, or a crash between publication and
    // projection would report the write as unpublished and invite a duplicate attempt.
    const lagging = makeTaskProjection({ rootDir, eventStore, projectionPath: `${projection.path}.lagging` });
    for (const event of events.filter((event) => event.type !== "task_completed")) lagging.apply(event);
    assert.deepEqual(lagging.readTaskCompletion("task-1", "execution-1"), completion);
  });
});

test("projection catch-up processes at most one bounded round and never reports stale data ready", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    for (const event of lifecycleFixture().events) eventStore.append(taskBundle(event));
    const projection = makeTaskProjection({
      rootDir,
      eventStore,
      catchUpLimit: 2,
      now: () => "2026-08-11T00:30:00.000Z",
    });

    let previousWatermark = 0;
    for (let round = 0; round < 6; round += 1) {
      const read = projection.read("task-1");
      assert.equal(read.watermark >= previousWatermark, true);
      assert.equal(read.sourceRevision, 6);
      // The receipt must name the limit this projection actually runs under, not a constant:
      // it is constructed with catchUpLimit 2, so a hardcoded 64 would be a false bound.
      assert.equal(read.catchUp.maxItems, 2);
      assert.equal(read.catchUp.reducedItems <= read.catchUp.maxItems, true);
      if (read.status === "ready") {
        assert.equal(read.watermark, 6);
        return;
      }
      previousWatermark = read.watermark;
    }
    assert.fail("bounded catch-up did not drain its persisted deferred events");
  });
});

test("lease CAS rejects stale renew/release, marks expiry orphaned, and permits takeover", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const fixture = lifecycleFixture();
    eventStore.append(taskBundle(fixture.events[0]!));
    projection.apply(fixture.events[0]!);
    const started = fixture.events[1]!;
    if (started.type !== "execution_started") throw new Error("fixture requires execution_started");

    const reserving = projection.reserveLease({ ...started.payload.lease, phase: "reserving" }, started.occurredAt);
    const active = projection.activateLease(reserving);
    assert.equal(active.phase, "held");
    assert.throws(
      () => projection.renewLease({ ...active, version: active.version - 1 }, "2026-08-11T02:00:00.000Z"),
      /stale/u,
    );
    const renewed = projection.renewLease(active, "2026-08-11T02:00:00.000Z");
    assert.equal(renewed.version, active.version + 1);
    assert.equal(projection.currentLease("task-1", "2026-08-11T02:00:00.000Z")?.phase, "orphaned");
    assert.throws(() => projection.releaseLease(active), /stale/u);

    const takeover = projection.reserveLease(
      {
        ...started.payload.lease,
        executionId: "execution-2",
        phase: "reserving",
        expiresAt: "2026-08-11T03:00:00.000Z",
        version: renewed.version + 1,
      },
      "2026-08-11T02:00:00.000Z",
    );
    assert.equal(takeover.executionId, "execution-2");
  });
});

test("renewed lease survives database rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const [created, started] = lifecycleFixture().events;
    if (created === undefined || started?.type !== "execution_started") throw new Error("fixture requires start event");
    eventStore.append(taskBundle(created));
    projection.apply(created);
    eventStore.append(taskBundle(started));
    projection.apply(started);
    const renewed = {
      schema: "task-event/v1",
      eventId: "event-renew",
      workspaceRevision: 3,
      opId: "op-renew",
      taskId: started.taskId,
      type: "lease_renewed",
      actor: started.actor,
      source: started.source,
      occurredAt: "2026-08-11T00:02:00.000Z",
      payload: {
        task: started.payload.task,
        execution: started.payload.execution,
        lease: {
          ...started.payload.lease,
          expiresAt: "2026-08-11T02:00:00.000Z",
          version: started.payload.lease.version + 1,
        },
        previousHolder: {
          taskId: started.taskId,
          executionId: started.payload.execution.executionId,
          actor: started.actor,
          source: started.source,
        },
        leaseExpiresAt: "2026-08-11T02:00:00.000Z",
        reason: "same_principal_reconnect",
      },
    } as unknown as TaskEventV1;
    eventStore.append(taskBundle(renewed));
    projection.apply(renewed);
    const beforeLease = projection.currentLease("task-1");
    const beforeIntervals = projection.readLeaseIntervals("task-1");

    projection.close();
    rmSync(projection.path, { force: true });
    const rebuilt = projection.rebuild();

    assert.equal(rebuilt.watermark, 3);
    assert.deepEqual(projection.currentLease("task-1"), beforeLease);
    assert.deepEqual(projection.readLeaseIntervals("task-1"), beforeIntervals);
  });
});
test("a lapsed reservation stops being a lease while a lapsed active lease stays orphaned", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const [created, started] = lifecycleFixture().events;
    if (created === undefined || started?.type !== "execution_started") throw new Error("fixture requires start event");
    eventStore.append(taskBundle(created));
    projection.apply(created);

    // A reservation whose execution was never published: the CAS row is the only trace it ever existed.
    projection.reserveLease(
      {
        ...started.payload.lease,
        executionId: "execution-unpublished",
        phase: "reserving",
        expiresAt: "2026-08-11T01:00:00.000Z",
        version: 0,
      },
      "2026-08-11T00:00:00.000Z",
    );
    // Still inside its TTL it must keep protecting the round against a concurrent claim.
    assert.equal(projection.currentLease("task-1", "2026-08-11T00:30:00.000Z")?.phase, "reserving");
    // Past its TTL it can never be published, so it is not a lease and must not wedge the task.
    assert.equal(projection.currentLease("task-1", "2026-08-11T02:00:00.000Z"), null);
    // The snapshot a daemon reads after the TTL lapsed is what task show and task release act on.
    assert.equal(
      makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T02:00:00.000Z" }).read("task-1").snapshot.lease,
      null,
    );

    // Contrast, holding every other input fixed and varying only the phase: a published lease that
    // lapsed is still a lease, because a real execution stands behind it and release must audit it.
    eventStore.append(taskBundle(started));
    projection.apply(started);
    assert.equal(projection.currentLease("task-1", "2026-08-11T02:00:00.000Z")?.phase, "orphaned");
    assert.equal(
      projection.currentLease("task-1", "2026-08-11T02:00:00.000Z")?.executionId,
      started.payload.execution.executionId,
    );
  });
});

function taskBundle(event: TaskEventV1): CanonicalWriteBundle {
  return { event, plan: taskLifecycleWritePlan(event), blobs: [] };
}

function batchDocumentBundle(
  store: CanonicalEventStore,
  revision: number,
  opId = `batch-op-${String(revision).padStart(4, "0")}`,
): CanonicalWriteBundle {
  const body = batchDocumentBody(revision),
    sha256 = sha256Text(body),
    path = batchDocumentPath(revision);
  const event: DocEventV1 = {
    schema: "doc-event/v1",
    eventId: `batch-event-${revision}`,
    workspaceRevision: revision,
    opId,
    type: "documents_written",
    actor: { principal: { personId: "person-1" }, executor: null },
    source: "local",
    occurredAt: "2026-08-19T00:00:00.000Z",
    payload: {
      executionId: null,
      baseLedgerSha: store.currentCut(),
      changes: [
        {
          path,
          baseBlobSha256: null,
          candidate: { sha256, size: Buffer.byteLength(body), mediaType: "text/markdown" },
          policyId: DOC_POLICY_ID,
          regionProofs: [
            {
              regionId: `heading/batch ${revision}`,
              policyId: DOC_POLICY_ID,
              codecId: DOC_CODEC_ID,
              baseSha256: sha256Text(""),
              candidateSha256: sha256,
              insertBytes: Buffer.byteLength(body),
            },
          ],
        },
      ],
    },
  };
  return {
    event,
    plan: docSyncWritePlan(event),
    blobs: [{ sha256, size: Buffer.byteLength(body), mediaType: "text/markdown", body }],
  };
}

function batchDocumentPath(revision: number): string {
  return `context/batch-${String(revision).padStart(4, "0")}.md`;
}
function batchDocumentBody(revision: number): string {
  return `# Batch ${revision}\n`;
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Projection Test");
  git(rootDir, "config", "user.email", "projection-test@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
