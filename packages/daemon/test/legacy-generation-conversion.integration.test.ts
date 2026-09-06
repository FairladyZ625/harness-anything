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
  preflightCanonicalGeneration,
  preflightConvertedGenerationActivation,
  reconcileSqliteEvents,
  readSettingsFacet,
  serializeEventHead,
  sha256Text,
  sqliteContentObjectPath,
  type CanonicalEventV1,
  type CanonicalEventStore,
} from "../../kernel/src/index.ts";
import { actor, initRepo } from "./migration-import.fixtures.ts";

test("empty generation activation remains valid after its first accepted command", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-empty-generation-")),
    repoId = "empty-generation";
  try {
    initRepo(root);
    preflightCanonicalGeneration({ rootInput: root, repoId });
    const store = openSqliteEventStore({ repoId, rootInput: root }),
      seeded = seedLegacySettings(root),
      event = seeded.source.read().events[0]!,
      fence = { repoId, holder: "empty-generation-test", epoch: 1 };
    store.appendCommand({
      fence,
      intent: { opId: event.opId, intentDigest: `sha256:${sha256Text(JSON.stringify(event))}`, summary: event.type },
      events: [event],
      blobs: seeded.blobs,
    });
    store.close();
    assert.doesNotThrow(() => preflightCanonicalGeneration({ rootInput: root, repoId }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    const second = convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath });
    assert.equal(second.migratedEvents, 0);
    assert.doesNotThrow(() =>
      preflightConvertedGenerationActivation({ repoId, rootDir: root, snapshotPath, databasePath }),
    );
    assert.throws(() => convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath }), /active generation/u);
    assert.equal(seeded.eventBytes, originalBytes);

    const sqlite = openSqliteEventStore({ repoId, databasePath }),
      converted = sqlite.events(),
      convertedSource = arrayStore(converted, (sha256) => sqlite.readContentObject(sha256));
    assert.equal(Object.hasOwn(converted[0]!.payload.settings, "walFlush"), true);
    const rows = sqlite.eventRows(),
      last = rows.at(-1)!,
      gitReadback = {
        commitSha: "a".repeat(40),
        cut: {
          repoId,
          revision: rows.length,
          headDigest: `sha256:${sha256Text(
            serializeEventHead({ revision: last.revision, opId: last.opId, eventDigest: last.digest }),
          )}`,
        },
        documents: [],
        retirements: [],
      },
      reconciliation = reconcileSqliteEvents({ repoId, rootDir: root, snapshotPath, databasePath, gitReadback });
    assert.equal(reconciliation.matches, true, JSON.stringify(reconciliation));
    assert.equal(
      reconcileSqliteEvents({
        repoId,
        rootDir: root,
        snapshotPath,
        databasePath,
        gitReadback: { ...gitReadback, commitSha: "" },
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
    const objectDigest = sqlite.contentObjectDigests()[0]!;
    sqlite.close();
    rmSync(sqliteContentObjectPath(root, objectDigest), { force: true });
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
    blobs: compiled.blobs,
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
