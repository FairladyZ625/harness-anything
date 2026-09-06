// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileSettingsChangedEvent,
  convertLegacyGeneration,
  createImmutableLegacyGenerationSnapshot,
  deriveRelationId,
  makeTaskProjection,
  openSqliteEventStore,
  preflightCanonicalGeneration,
  reconcileSqliteEvents,
  readSettingsFacet,
  serializeEventHead,
  sha256Text,
  stableStringify,
  validateCurrentCanonicalEvent,
  type CanonicalEventV1,
  type CanonicalEventStore,
} from "../../kernel/src/index.ts";
import { assertNoPendingHistoricalRewrites } from "../../kernel/test/store/canonical-generation.fixtures.ts";
import {
  createImmutableLegacyGenerationSnapshotFromStoppedRepository,
  preflightConvertedGenerationActivation,
} from "../../kernel/test/store/canonical-generation.fixtures.ts";
import { sqliteContentObjectPath } from "../../kernel/test/store/canonical-generation.fixtures.ts";
import { actor, initRepo } from "./migration-import.fixtures.ts";

test("stopped legacy Git plus accepted WAL suffix converts without a strict reader", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-stopped-generation-")),
    repoId = "stopped-generation",
    snapshotPath = path.join(root, ".harness/store/imports/generation-0.snapshot.json"),
    databasePath = path.join(root, ".harness/store/generations/1/ledger.sqlite");
  try {
    initRepo(root);
    const first = physicalLegacyRelation(),
      second = physicalLegacySettings(root, 2),
      firstDigest = `sha256:${sha256Text(first.bytes)}`,
      secondDigest = `sha256:${sha256Text(second.bytes)}`;
    assert.ok(validateCurrentCanonicalEvent(first.event).length > 0);
    mkdirSync(path.join(root, "harness/events"), { recursive: true });
    writeFileSync(path.join(root, `harness/events/${first.event.opId}.json`), first.bytes);
    writeFileSync(
      path.join(root, "harness/events/head.json"),
      serializeEventHead({ revision: 1, opId: first.event.opId, eventDigest: firstDigest }),
    );
    for (const blob of first.blobs) {
      const target = path.join(root, "harness/objects/sha256", blob.sha256);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, blob.body);
    }
    git(root, "add", "harness");
    git(root, "commit", "-qm", "legacy git prefix");
    git(root, "update-ref", "refs/ha/canonical", git(root, "rev-parse", "HEAD"));
    const walRoot = path.join(root, ".harness/wal"),
      emptyCheckpoint = `${stableStringify({
        schema: "harness-wal-head/v1",
        revision: 0,
        lastSegment: null,
        lastOffset: 0,
        headDigest: null,
      })}\n`,
      emptySnapshotPath = path.join(root, ".harness/store/imports/empty-checkpoint.snapshot.json");
    mkdirSync(path.join(walRoot, "objects"), { recursive: true });
    writeFileSync(path.join(walRoot, "head.json"), emptyCheckpoint);
    const emptyCheckpointSnapshot = createImmutableLegacyGenerationSnapshotFromStoppedRepository({
      repoId,
      rootInput: root,
      snapshotPath: emptySnapshotPath,
    });
    assert.equal(emptyCheckpointSnapshot.eventCount, 1);
    assert.equal(emptyCheckpointSnapshot.sourceEvidence.walRevision, 0);
    rmSync(emptySnapshotPath);
    const walRecord = `${stableStringify({
        schema: "harness-wal/v1",
        revision: 2,
        opId: second.event.opId,
        event: second.event,
        blobs: second.blobs.map(({ sha256, size, mediaType }) => ({ sha256, size, mediaType })),
        eventDigest: secondDigest,
        previousDigest: firstDigest,
      })}\n`,
      resetWalRecord = walRecord.replace(JSON.stringify(firstDigest), "null"),
      writeWal = (body: string): void => {
        writeFileSync(path.join(walRoot, "seg-000000.log"), body);
        writeFileSync(
          path.join(walRoot, "head.json"),
          `${stableStringify({
            schema: "harness-wal-head/v1",
            revision: 2,
            lastSegment: "seg-000000.log",
            lastOffset: Buffer.byteLength(body),
            headDigest: secondDigest,
          })}\n`,
        );
      };
    for (const blob of second.blobs) writeFileSync(path.join(walRoot, "objects", blob.sha256), blob.body);
    writeWal(walRecord.replace(firstDigest, `sha256:${"0".repeat(64)}`));
    assert.throws(
      () => createImmutableLegacyGenerationSnapshotFromStoppedRepository({ repoId, rootInput: root, snapshotPath }),
      /not anchored/u,
    );
    writeWal(resetWalRecord);
    const sourceBefore = physicalSourceBytes(root),
      snapshot = createImmutableLegacyGenerationSnapshotFromStoppedRepository({
        repoId,
        rootInput: root,
        snapshotPath,
      });
    assert.deepEqual(
      {
        events: snapshot.eventCount,
        git: snapshot.sourceEvidence.gitRevision,
        wal: snapshot.sourceEvidence.walRevision,
      },
      { events: 2, git: 1, wal: 2 },
    );
    assert.throws(
      () =>
        convertLegacyGeneration({
          rootDir: root,
          snapshotPath,
          databasePath,
          beforeEvent: () => {
            throw new Error("stop");
          },
        }),
      /stop/u,
    );
    const converted = convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath });
    assert.equal(converted.rewrittenEvents, 2);
    assert.equal(convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath }).migratedEvents, 0);
    assert.equal(physicalSourceBytes(root), sourceBefore);
    const store = openSqliteEventStore({ repoId, databasePath });
    const events = store.events();
    assert.equal(Object.hasOwn(events[0]!.payload.relation, "strength"), false);
    assert.equal(Object.hasOwn(events[1]!.payload.settings, "walFlush"), true);
    const destinationObject = store.contentObjectDigests().find((digest) => digest === second.blobs[0]!.sha256)!,
      destinationObjectPath = sqliteContentObjectPath(root, destinationObject),
      destinationBytes = store.readContentObject(destinationObject)!;
    store.close();
    writeFileSync(destinationObjectPath, Buffer.alloc(destinationBytes.byteLength, 0x78));
    assert.throws(
      () => preflightConvertedGenerationActivation({ repoId, rootDir: root, snapshotPath, databasePath }),
      /invalid object/u,
    );
    assert.equal(existsSync(`${databasePath}.activation.json`), false);
    writeFileSync(destinationObjectPath, destinationBytes);
    assert.doesNotThrow(() =>
      preflightConvertedGenerationActivation({ repoId, rootDir: root, snapshotPath, databasePath }),
    );

    rmSync(snapshotPath, { force: true });
    rmSync(path.join(walRoot, "objects", second.blobs[0]!.sha256), { force: true });
    assert.throws(
      () => createImmutableLegacyGenerationSnapshotFromStoppedRepository({ repoId, rootInput: root, snapshotPath }),
      /missing object/u,
    );
    writeFileSync(path.join(walRoot, "objects", second.blobs[0]!.sha256), "corrupt");
    assert.throws(
      () => createImmutableLegacyGenerationSnapshotFromStoppedRepository({ repoId, rootInput: root, snapshotPath }),
      /content object/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty generation activation remains valid after its first accepted command", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-empty-generation-")),
    repoId = "empty-generation";
  try {
    initRepo(root);
    preflightCanonicalGeneration({ rootInput: root, repoId });
    const store = openSqliteEventStore({ repoId, rootInput: root }),
      seeded = seedLegacySettings(root, false),
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
    const objectDigest = sqlite.contentObjectDigests()[0]!,
      objectPath = sqliteContentObjectPath(root, objectDigest),
      objectBytes = sqlite.readContentObject(objectDigest)!;
    writeFileSync(objectPath, Buffer.alloc(objectBytes.byteLength, 0x78));
    assert.equal(
      reconcileSqliteEvents({ repoId, rootDir: root, snapshotPath, databasePath, gitReadback }).objectMatches,
      false,
    );
    writeFileSync(objectPath, objectBytes);
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
    rmSync(objectPath, { force: true });
    assert.equal(
      reconcileSqliteEvents({ repoId, rootDir: root, snapshotPath, databasePath, gitReadback }).objectMatches,
      false,
    );
    assert.throws(
      () => preflightConvertedGenerationActivation({ repoId, rootDir: root, snapshotPath, databasePath }),
      /invalid object/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedLegacySettings(root: string, legacy = true) {
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
  if (legacy) delete event.payload.settings.walFlush;
  const blobs = new Map(compiled.blobs.map((blob) => [blob.sha256, Buffer.from(blob.body)]));
  return {
    eventBytes: JSON.stringify(event),
    blobs: compiled.blobs,
    source: arrayStore([event], (sha256) => blobs.get(sha256) ?? null),
  };
}

function physicalLegacySettings(root: string, revision: number) {
  const body = readFileSync(path.join(root, "harness/harness.yaml"), "utf8"),
    compiled = compileSettingsChangedEvent({
      settings: readSettingsFacet(body),
      baseDocumentBody: body,
      candidateDocumentBody: `${body}\n# physical legacy revision ${revision}\n`,
      eventId: `event-legacy-settings-${revision}`,
      opId: `op-legacy-settings-${revision}`,
      workspaceRevision: revision,
      actor,
      source: "local",
      occurredAt: `2026-09-06T00:00:0${revision}.000Z`,
    }),
    event = structuredClone(compiled.event);
  delete event.payload.settings.walFlush;
  return {
    event,
    blobs: compiled.blobs,
    bytes: `${stableStringify(event)}\n`,
  };
}

function physicalLegacyRelation() {
  const identity = {
      source: "task/task-source",
      target: "task/task-target",
      type: "depends-on",
      direction: "directed",
    },
    relationId = deriveRelationId(identity),
    event = {
      schema: "relation-event/v1",
      eventId: "event-legacy-relation",
      workspaceRevision: 1,
      opId: "op-legacy-relation",
      relationId,
      type: "relation_created",
      actor,
      source: "local",
      occurredAt: "2026-09-06T00:00:01.000Z",
      payload: {
        relation: {
          relation_id: relationId,
          ...identity,
          origin: "declared",
          rationale: "Physical legacy relation.",
          state: "active",
          strength: "strong",
        },
      },
    } as unknown as CanonicalEventV1;
  return { event, blobs: [], bytes: `${stableStringify(event)}\n` };
}

function physicalSourceBytes(root: string): string {
  return sha256Text(
    [
      readFileSync(path.join(root, ".harness/wal/head.json"), "utf8"),
      readFileSync(path.join(root, ".harness/wal/seg-000000.log"), "utf8"),
      git(root, "show", "refs/ha/canonical:harness/events/head.json"),
      git(root, "show", "refs/ha/canonical:harness/events/op-legacy-relation.json"),
    ].join("\0"),
  );
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
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
