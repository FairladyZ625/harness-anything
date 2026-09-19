// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import type { EventStreamPort } from "../../src/projection/rebuildable-task-projection-types.ts";
import {
  makeTaskEventStore,
  type CanonicalEventStore,
  type CanonicalWriteBundle,
} from "../../src/store/task-event-store.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import { freezeDeclaredWritePlan } from "../../src/domain/write-chain.contract.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle.contract.ts";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
  decideDocWrite,
  parseDocWriteIntent,
  serializeCanonicalEvent,
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
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";
import { withTempStoreAsync } from "./helpers.ts";
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
    for (const invalidPlan of [
      { ...plan, targets: plan.targets.filter((target) => target.kind !== "content_blob") },
      {
        ...plan,
        targets: [
          ...plan.targets,
          { kind: "content_blob" as const, sha256: "f".repeat(64), size: 1, mediaType: "text/plain" },
        ],
      },
      { ...plan, commandType: "TaskCreate" as const },
    ]) {
      const frozen = freezeDeclaredWritePlan(invalidPlan, [invalidPlan.commandType]);
      assert.throws(() => projection.apply(event, frozen), /write plan/iu);
    }
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
    projection.rebuild();
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
test("query-only reader sessions keep one completed projection cut while the writer advances", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "projection-reader", rootDir }),
      writer = makeTaskProjection({ rootDir, eventStore }),
      template = lifecycleFixture().events[0]!;
    if (template.type !== "task_created") throw new Error("lifecycle fixture must begin with task_created");
    const second: TaskEventV1 = {
      ...template,
      eventId: "projection-reader-event-2",
      opId: "projection-reader-op-2",
      taskId: "projection-reader-task-2",
      workspaceRevision: 2,
      payload: {
        ...template.payload,
        task: { ...template.payload.task, taskId: "projection-reader-task-2", title: "Second task" },
      },
    };
    eventStore.append(taskBundle(template));
    writer.apply(template, taskLifecycleWritePlan(template));
    const reader = makeTaskProjectionReader({ rootDir });
    reader.withSession((queries) => {
      assert.equal("apply" in queries, false);
      assert.equal(queries.list().rows.length, 1);
      eventStore.append(taskBundle(second));
      writer.apply(second, taskLifecycleWritePlan(second));
      assert.equal(queries.list().rows.length, 1, "one request stays on its original SQLite snapshot");
    });
    assert.equal(
      reader.withSession((queries) => queries.list().rows.length),
      2,
    );
    reader.close();
    writer.close();
  });
});
test("document retirement rejects a base derived from worktree drift instead of projection state", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "stale-retirement", rootDir }),
      documentPath = "tasks/task-1/facts.md",
      body = "# Legacy facts\n",
      hash = sha256Text(body),
      physicalBody = "# Facts changed outside the event stream\n",
      physicalPath = path.join(rootDir, "harness", documentPath),
      seed: DocEventV1 = {
        schema: "doc-event/v1",
        eventId: "retirement-seed",
        workspaceRevision: 1,
        opId: "retirement-seed-op",
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
    const retirementStore = makeTaskEventStore({ repoId: "stale-retirement", rootDir }),
      retirement: DocEventV1 = {
        ...seed,
        eventId: "stale-retirement",
        workspaceRevision: 2,
        opId: "stale-retirement-op",
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
          retirementReason: "legacy records were migrated",
        },
      };
    assert.throws(() => retirementStore.append({ event: retirement, plan: docSyncWritePlan(retirement), blobs: [] }), {
      code: "revision_conflict",
    });
    assert.equal(retirementStore.read().revision, 1);
    assert.equal(retirementStore.readEvent(retirement.opId), null);
    const projection = makeTaskProjection({ rootDir, eventStore: retirementStore });
    assert.equal(projection.rebuild().watermark, 1);
    projection.close();
  });
});
test("headless direct apply retains its ahead cache and refuses reopen or rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const event = lifecycleFixture().events[0]!,
      headlessStore = () => ({
        readHead: () => null,
        readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
        readContentBlob: () => null,
      });
    const live = makeTaskProjection({ rootDir, eventStore: headlessStore() });
    live.apply(event, taskLifecycleWritePlan(event));
    live.close();
    const retained = readFileSync(live.path);
    const rejectsAheadCache = (error: unknown): boolean => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error & { code?: string }).code, "invalid_store");
      assert.match((error as Error).message, /event stream head is null.*revisions 1-1.*cache retained/iu);
      assert.deepEqual(
        {
          cacheWatermark: (error as { cacheWatermark?: number }).cacheWatermark,
          eventStreamHead: (error as { eventStreamHead?: number | null }).eventStreamHead,
          missingRange: (error as { missingRange?: unknown }).missingRange,
        },
        { cacheWatermark: 1, eventStreamHead: null, missingRange: { from: 1, to: 1 } },
      );
      return true;
    };
    assert.throws(() => live.read(event.taskId), rejectsAheadCache);
    assert.throws(() => live.rebuild(), rejectsAheadCache);
    assert.deepEqual(readFileSync(live.path), retained);
    live.close();

    assert.throws(() => makeTaskProjection({ rootDir, eventStore: headlessStore() }), rejectsAheadCache);
    assert.deepEqual(readFileSync(live.path), retained);
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
    for (let round = 0; read.status === "pending" && round < 4; round += 1) {
      projection.catchUp?.();
      read = projection.readDocument(batchDocumentPath(count));
    }
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
      [1, 2, 3, 4, 5, 6, 7],
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
test("cold rebuild replaces the projection database and accepts a larger bounded replay window", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "replacement-rebuild", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore });
    const first = lifecycleFixture().events[0]!;
    eventStore.append(taskBundle(first));
    projection.apply(first, taskLifecycleWritePlan(first));
    projection.close();
    const stale = new DatabaseSync(projection.path);
    stale.exec("CREATE TABLE stale_projection_ddl (value TEXT)");
    stale.close();
    const rebuilt = projection.rebuild();
    assert.equal(rebuilt.watermark, 1);
    assert.equal(rebuilt.metrics.maxBatchItems <= 4096, true);
    projection.close();
    const replacement = new DatabaseSync(projection.path, { readOnly: true });
    assert.equal(
      replacement.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stale_projection_ddl'").get(),
      undefined,
    );
    replacement.close();
  });
});
test("migration-sized catch-up reduces 5k events in bounded projection transactions", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const template = lifecycleFixture().events[0]!;
    if (template.type !== "task_created") throw new Error("lifecycle fixture must begin with task_created");
    const count = 5_000,
      events = Array.from({ length: count }, (_, index) => {
        const revision = index + 1,
          taskId = `catch-up-${revision}`;
        return {
          ...template,
          eventId: `catch-up-event-${revision}`,
          opId: `catch-up-op-${revision}`,
          taskId,
          workspaceRevision: revision,
          payload: { ...template.payload, task: { ...template.payload.task, taskId } },
        };
      }),
      eventStore: EventStreamPort = {
        readHead: () => ({ revision: count, eventDigest: `sha256:${"a".repeat(64)}` }),
        readBatch: (cursor, maxItems) => {
          const start = cursor === null ? 0 : events.findIndex((event) => event.opId === cursor) + 1,
            batch = events.slice(start, start + maxItems);
          return {
            sourceRevision: count,
            events: batch,
            cursor: batch.at(-1)?.opId ?? cursor,
            done: start + batch.length >= events.length,
            accessedItems: batch.length,
            prefetchContent: () => new Map(),
          };
        },
        readContentBlob: () => null,
      },
      projection = makeTaskProjection({ rootDir, eventStore });
    const receipt = projection.catchUp!();
    assert.equal(receipt.watermark, count);
    assert.deepEqual(receipt.metrics, { sqliteTransactions: 2, reducedItems: count, maxBatchItems: 4_096 });
    projection.close();
  });
});
test("a fresh projection stays query-only until explicit catch-up prefetches staged content", async () => {
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
    const before = first.readDocument(batchDocumentPath(1));
    assert.deepEqual(
      { status: before.status, watermark: before.watermark, sourceRevision: before.sourceRevision },
      { status: "pending", watermark: 0, sourceRevision: 2 },
    );
    first.catchUp?.();
    const resumed = first.readDocument(batchDocumentPath(2));
    assert.equal(resumed.status, "ready");
    assert.equal(resumed.document?.body, batchDocumentBody(2));
    first.close();
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
    projection.catchUp?.();
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

    projection.catchUp?.();
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
test("migration truth-gap archives remain queryable after a cold projection rebuild", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "migration-archive", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      migration: MigrationImportEventV1 = {
        schema: "migration-import-event/v1",
        eventId: "event-migration-archive",
        workspaceRevision: 1,
        opId: "op-migration-archive",
        type: "entity_migrated",
        actor: { principal: { personId: "person-1" }, executor: null },
        source: MIGRATION_IMPORT_SOURCE,
        occurredAt: "2026-08-11T00:00:00.000Z",
        payload: {
          migratedFrom: "execution/legacy:id",
          generation: "v0",
          entity: {
            kind: "archived-entity",
            entityKind: "execution",
            entityId: "legacy:id",
            disposition: "archived",
            reason: "truth_gap",
            provenance: "imported_snapshot",
            sourcePath: "tasks/task-1/executions/legacy:id.json",
            originalFields: { schema: "execution/legacy", opaque: true },
          },
        },
      };
    eventStore.append({ event: migration, plan: migrationImportWritePlan(migration), blobs: [] });
    projection.apply(migration, migrationImportWritePlan(migration));
    projection.close();
    projection.rebuild();
    projection.close();
    const db = new DatabaseSync(projection.path, { readOnly: true }),
      row = db
        .prepare("SELECT entity_id, workspace_revision, row_json FROM archived_entity WHERE entity_kind = ?")
        .get("execution") as { entity_id: string; workspace_revision: number; row_json: string };
    db.close();
    assert.equal(row.entity_id, "legacy:id");
    assert.equal(row.workspace_revision, 1);
    assert.deepEqual(JSON.parse(row.row_json), migration.payload.entity);
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
