// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoPendingHistoricalRewrites,
  compileSettingsChangedEvent,
  convertLegacyGeneration,
  createImmutableLegacyGenerationSnapshot,
  makeTaskProjection,
  openSqliteEventStore,
  preflightConvertedGenerationActivation,
  reconcileSqliteEvents,
  sqliteContentObjectPath,
  readSettingsFacet,
  type CanonicalEventV1,
  type CanonicalEventStore,
} from "../../kernel/src/index.ts";
import { actor, initRepo } from "./migration-import.fixtures.ts";

test("immutable generation-0 conversion retries into inactive generation-1 without rewriting source", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-generation-conversion-")),
    repoId = "legacy-generation-conversion";
  try {
    initRepo(root);
    const seeded = seedLegacySettings(root),
      source = seeded.source,
      originalBytes = seeded.eventBytes,
      databasePath = path.join(root, ".harness/store/generations/1/ledger.sqlite"),
      snapshotPath = path.join(root, ".harness/store/import/gen0.snapshot.json");
    assert.throws(
      () => assertNoPendingHistoricalRewrites({ rootDir: root, store: source }),
      /zero pending historical rewrites/u,
    );
    createImmutableLegacyGenerationSnapshot({ repoId, source, snapshotPath });
    assert.throws(
      () =>
        convertLegacyGeneration({
          rootDir: root,
          snapshotPath,
          databasePath,
          beforeEvent: () => {
            throw new Error("conversion interruption");
          },
        }),
      /conversion interruption/u,
    );
    assert.equal(seeded.eventBytes, originalBytes);
    const first = convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath });
    assert.equal(first.rewrittenEvents, 1);
    assert.equal(first.migratedEvents, 1);
    assert.equal(first.active, false);
    assert.doesNotThrow(() =>
      preflightConvertedGenerationActivation({ repoId, rootDir: root, snapshotPath, databasePath }),
    );
    const second = convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath });
    assert.equal(second.migratedEvents, 0);
    assert.equal(seeded.eventBytes, originalBytes);

    const sqlite = openSqliteEventStore({ repoId, databasePath }),
      converted = sqlite.events(),
      convertedSource = arrayStore(converted, (sha256) => sqlite.readContentObject(sha256));
    assert.equal(Object.hasOwn(converted[0]!.payload.settings, "walFlush"), true);
    const rows = sqlite.eventRows(),
      gitReadback = {
        status: "verified" as const,
        revision: rows.length,
        eventDigests: rows.map(({ digest }) => digest),
        objectDigests: sqlite.contentObjectDigests(),
      },
      reconciliation = reconcileSqliteEvents({ repoId, rootDir: root, snapshotPath, databasePath, gitReadback });
    assert.equal(reconciliation.matches, true, JSON.stringify(reconciliation));
    assert.equal(
      reconcileSqliteEvents({
        repoId,
        rootDir: root,
        snapshotPath,
        databasePath,
        gitReadback: { ...gitReadback, status: "pending" },
      }).matches,
      false,
    );
    assert.doesNotThrow(() => assertNoPendingHistoricalRewrites({ rootDir: root, store: convertedSource }));
    const firstProjection = makeTaskProjection({
      rootDir: root,
      eventStore: convertedSource,
      projectionPath: path.join(root, "first.sqlite"),
    });
    const firstRebuild = firstProjection.rebuild();
    firstProjection.close();
    const secondProjection = makeTaskProjection({
      rootDir: root,
      eventStore: convertedSource,
      projectionPath: path.join(root, "second.sqlite"),
    });
    const secondRebuild = secondProjection.rebuild();
    secondProjection.close();
    assert.equal(firstRebuild.stateDigest, secondRebuild.stateDigest);
    sqlite.close();
    rmSync(sqliteContentObjectPath(root, gitReadback.objectDigests[0]!), { force: true });
    assert.throws(
      () => preflightConvertedGenerationActivation({ repoId, rootDir: root, snapshotPath, databasePath }),
      /missing object/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedLegacySettings(root: string) {
  const body = readFileSync(path.join(root, "harness/harness.yaml"), "utf8"),
    compiled = compileSettingsChangedEvent({
      settings: readSettingsFacet(body),
      baseDocumentBody: body,
      candidateDocumentBody: body,
      eventId: "event-legacy-settings",
      opId: "op-legacy-settings",
      workspaceRevision: 1,
      actor,
      source: "local",
      occurredAt: "2026-09-06T00:00:00.000Z",
    }),
    event = structuredClone(compiled.event);
  delete event.payload.settings.walFlush;
  const blobs = new Map(compiled.blobs.map((blob) => [blob.sha256, Buffer.from(blob.body)]));
  return {
    eventBytes: JSON.stringify(event),
    source: arrayStore([event], (sha256) => blobs.get(sha256) ?? null),
  };
}

function arrayStore(
  events: readonly CanonicalEventV1[],
  readContent: (sha256: string) => Uint8Array | null,
): CanonicalEventStore {
  return {
    read: () => ({ revision: events.length, events }),
    readHead: () =>
      events.length === 0
        ? null
        : {
            revision: events.length,
            eventDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          },
    readBatch: () => ({
      sourceRevision: events.length,
      events,
      cursor: null,
      done: true,
      accessedItems: events.length,
      prefetchContent: () =>
        new Map(
          events.flatMap((event) =>
            "harnessDocumentClaim" in event.payload
              ? [
                  [
                    event.payload.harnessDocumentClaim.sha256,
                    readContent(event.payload.harnessDocumentClaim.sha256)!,
                  ] as const,
                ]
              : [],
          ),
        ),
    }),
    readContentBlob: (sha256: string) => {
      return readContent(sha256);
    },
  } as CanonicalEventStore;
}
