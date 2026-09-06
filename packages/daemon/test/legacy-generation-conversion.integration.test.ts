// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import {
  canonicalEventWritePlan,
  compileSettingsChangedEvent,
  compileScheduleDefinitionEvent,
  createScheduleV1,
  validateScheduleV1,
  convertLegacyGeneration,
  createImmutableLegacyGenerationSnapshot,
  deriveRelationId,
  makeTaskProjection,
  openSqliteEventStore,
  preflightCanonicalGeneration,
  reconcileSqliteEvents,
  readSettingsFacet,
  serializeEventHead,
  sha256Bytes,
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
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
        schema: string;
        eventBytes?: readonly string[];
        eventSegments: readonly { firstRevision: number; size: number }[];
        objects: readonly { sha256: string; size: number; bytesBase64?: string }[];
      },
      snapshotEventSegment = snapshot.eventSegments[0]!,
      snapshotEventPath = path.join(`${snapshotPath}.events`, `${snapshotEventSegment.firstRevision}.json`),
      snapshotEventBytes = readFileSync(snapshotEventPath),
      snapshotObject = snapshot.objects[0]!,
      snapshotObjectPath = path.join(`${snapshotPath}.objects`, snapshotObject.sha256),
      snapshotObjectBytes = readFileSync(snapshotObjectPath);
    assert.equal(snapshot.schema, "immutable-legacy-generation-snapshot/v2");
    assert.equal(snapshot.eventBytes, undefined);
    assert.equal(snapshotObject.bytesBase64, undefined);
    assert.equal(snapshotEventBytes.byteLength, snapshotEventSegment.size);
    assert.equal(snapshotObjectBytes.byteLength, snapshotObject.size);
    writeFileSync(snapshotObjectPath, Buffer.alloc(snapshotObject.size, 0x78));
    assert.throws(() => convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath }), /object .* differs/u);
    writeFileSync(snapshotObjectPath, snapshotObjectBytes);
    writeFileSync(snapshotEventPath, "[]\n");
    assert.throws(
      () => convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath }),
      /event segment .* differs/u,
    );
    writeFileSync(snapshotEventPath, snapshotEventBytes);
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

test("canonical-scale snapshot streams event digests and object sidecars through repeat conversion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-generation-scale-")),
    repoId = "canonical-scale-generation",
    snapshotPath = path.join(root, ".harness/store/import/gen0.snapshot.json"),
    databasePath = path.join(root, ".harness/store/generations/1/ledger.sqlite"),
    eventCount = 61_618,
    objectCount = 43_802,
    totalObjectBytes = 434_700_000,
    largestObjectBytes = 20_000_000;
  try {
    initRepo(root);
    const seeded = seedLegacySettings(root, false),
      baseEvent = seeded.source.read().events[0]!,
      remainingBytes = totalObjectBytes - largestObjectBytes,
      regularSize = Math.floor(remainingBytes / (objectCount - 1)),
      remainder = remainingBytes % (objectCount - 1),
      bodyFor = (index: number, size: number): string => {
        const prefix = `# canonical-scale-object-${index}\n`;
        return `${prefix}${"x".repeat(size - prefix.length)}`;
      },
      objects = Array.from({ length: objectCount }, (_, index) => {
        const size = index === 0 ? largestObjectBytes : regularSize + (index <= remainder ? 1 : 0),
          sha256 = sha256Text(bodyFor(index, size));
        return { index, sha256, size };
      }),
      events = Array.from({ length: eventCount }, (_, index) => {
        const revision = index + 1,
          object = objects[index % objectCount]!;
        return {
          ...baseEvent,
          eventId: `event-canonical-scale-${revision}`,
          opId: `op-canonical-scale-${revision}`,
          workspaceRevision: revision,
          payload: {
            ...baseEvent.payload,
            harnessDocumentClaim: {
              ...baseEvent.payload.harnessDocumentClaim,
              sha256: object.sha256,
              size: object.size,
            },
          },
        } as CanonicalEventV1;
      }),
      byDigest = new Map(objects.map((object) => [object.sha256, object])),
      source = arrayStore(events, (sha256) => {
        const object = byDigest.get(sha256);
        return object ? Buffer.from(bodyFor(object.index, object.size)) : null;
      }),
      written = createImmutableLegacyGenerationSnapshot({ repoId, source, snapshotPath }),
      manifest = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
        eventSegments: readonly { count: number }[];
        objects: readonly { sha256: string; size: number; bytesBase64?: string }[];
      };
    assert.equal(written.eventCount, eventCount);
    assert.equal(written.objectCount, objectCount);
    assert.equal(
      manifest.eventSegments.reduce((total, segment) => total + segment.count, 0),
      eventCount,
    );
    assert.equal(manifest.objects.length, objectCount);
    assert.equal(
      manifest.objects.some((object) => object.bytesBase64 !== undefined),
      false,
    );
    assert.equal(
      manifest.objects.reduce((total, object) => total + object.size, 0),
      totalObjectBytes,
    );
    assert.equal(Math.max(...manifest.objects.map((object) => object.size)), largestObjectBytes);
    for (const object of manifest.objects) {
      const bytes = readFileSync(path.join(`${snapshotPath}.objects`, object.sha256));
      assert.equal(bytes.byteLength, object.size);
      assert.equal(sha256Bytes(bytes), object.sha256);
    }
    const first = convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath }),
      second = convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath });
    assert.equal(first.sourceEvents, eventCount);
    assert.equal(first.copiedObjects, objectCount);
    assert.equal(first.migratedEvents, eventCount);
    assert.equal(second.migratedEvents, 0);
    assert.equal(second.sourceDigest, first.sourceDigest);
    const marker = JSON.parse(readFileSync(`${databasePath}.import-source.json`, "utf8")) as {
      sourceDigest: string;
    };
    assert.equal(marker.sourceDigest, written.sourceDigest);
    assert.ok(process.resourceUsage().maxRSS < 1_400_000, `maxRSS=${process.resourceUsage().maxRSS} KiB`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inactive generation conversion repairs schedule definition bytes without rewriting its source", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-generation-schedule-")),
    repoId = "generation-schedule",
    snapshotPath = path.join(root, "generation-0.snapshot.json"),
    databasePath = path.join(root, ".harness/store/generations/1/ledger.sqlite");
  try {
    initRepo(root);
    const schedule = createScheduleV1({
        scheduleId: "legacy-schedule",
        name: "Legacy schedule",
        mode: "detect",
        spec: {
          mission: "Exercise the historical target shape.",
          trigger: { kind: "interval", everyMs: 60_000, anchorAt: "2026-09-01T00:00:00.000Z" },
          target: { kind: "agent", agentId: "worker", runtimeInstanceId: "codex" },
        },
        actor,
        occurredAt: "2026-09-01T00:00:00.000Z",
      }),
      compiled = compileScheduleDefinitionEvent({
        type: "schedule_created",
        schedule,
        eventId: "event-legacy-schedule",
        opId: "op-legacy-schedule",
        workspaceRevision: 1,
        actor,
        source: "local",
        occurredAt: "2026-09-01T00:00:00.000Z",
      }),
      legacyTarget = { ...schedule.spec.target, cwd: ".worktrees/legacy" },
      legacySchedule = { ...schedule, spec: { ...schedule.spec, target: legacyTarget } },
      legacyDefinition = { ...JSON.parse(compiled.blobs[0]!.body), spec: { ...schedule.spec, target: legacyTarget } },
      legacyBody = `${JSON.stringify(legacyDefinition, null, 2)}\n`,
      legacyClaim = {
        ...compiled.event.payload.declarationDocumentClaim,
        sha256: sha256Text(legacyBody),
        size: Buffer.byteLength(legacyBody),
      },
      legacy = {
        ...compiled.event,
        payload: { schedule: legacySchedule, declarationDocumentClaim: legacyClaim },
      },
      source = arrayStore([legacy], (digest) => (digest === legacyClaim.sha256 ? Buffer.from(legacyBody) : null)),
      rejectedProjection = makeTaskProjection({
        rootDir: root,
        eventStore: source,
        projectionPath: path.join(root, "legacy.sqlite"),
      });
    try {
      assert.throws(() => rejectedProjection.rebuild(), /does not match the event definition facet/u);
    } finally {
      rejectedProjection.close();
    }
    createImmutableLegacyGenerationSnapshot({ repoId, source, snapshotPath });
    const immutableBytes = readFileSync(snapshotPath, "utf8"),
      converted = convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath });
    assert.equal(converted.rewrittenEvents, 1);
    assert.equal(converted.active, false);
    assert.equal(convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath }).migratedEvents, 0);
    assert.equal(readFileSync(snapshotPath, "utf8"), immutableBytes);
    const sqlite = openSqliteEventStore({ repoId, databasePath });
    try {
      const migrated = sqlite.events()[0]! as typeof compiled.event,
        claim = migrated.payload.declarationDocumentClaim,
        bytes = sqlite.readContentObject(claim.sha256);
      assert.ok(bytes);
      assert.equal(bytes.byteLength, claim.size);
      assert.equal(sha256Text(Buffer.from(bytes).toString("utf8")), claim.sha256);
      const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
      assert.deepEqual(validateScheduleV1({ ...value, status: migrated.payload.schedule.status }), []);
      assert.equal(Object.hasOwn(migrated.payload.schedule.spec.target, "cwd"), false);
      assert.deepEqual(value, JSON.parse(compiled.blobs[0]!.body));
      const projection = makeTaskProjection({
        rootDir: root,
        eventStore: arrayStore(sqlite.events(), (digest) => sqlite.readContentObject(digest)),
        projectionPath: path.join(root, "converted.sqlite"),
      });
      try {
        assert.equal(projection.rebuild().watermark, 1);
      } finally {
        projection.close();
      }
    } finally {
      sqlite.close();
    }
    preflightConvertedGenerationActivation({ repoId, rootDir: root, snapshotPath, databasePath });
    assert.throws(() => convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath }), /active generation/u);
    assert.equal(readFileSync(snapshotPath, "utf8"), immutableBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inactive generation conversion witnesses separated legacy relations at their own historical cuts", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-generation-witness-")),
    sourceRoot = path.join(scratch, "source"),
    root = path.join(scratch, "destination"),
    repoId = "generation-witness",
    snapshotPath = path.join(root, "generation-0.snapshot.json"),
    databasePath = path.join(root, ".harness/store/generations/1/ledger.sqlite"),
    binding = { actor, source: "local" as const };
  let cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>> | undefined;
  try {
    initRepo(sourceRoot);
    initRepo(root);
    cell = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(sourceRoot),
      ownerId: "generation-witness",
      now: () => "2026-09-02T12:00:00.000Z",
    });
    const run = async (action: Record<string, unknown>) => {
        const receipt = await cell!.run(action as never, binding);
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        return receipt;
      },
      bump = async (times: number) => {
        for (let index = 0; index < times; index += 1)
          await run({
            kind: "task-amend",
            taskId: "task_target",
            patches: [{ field: "pinned", value: index % 2 === 0 ? "true" : "false" }],
          });
      },
      relate = (sourceRef: string) =>
        run({
          kind: "relation-relate",
          sourceRef,
          targetRef: "task/task_target",
          relationType: "depends-on",
          rationale: "Batched replay witness sample.",
          expectedVersion: 0,
        });
    await run({ kind: "task-create", taskId: "task_first", title: "First source" });
    await run({ kind: "task-create", taskId: "task_target", title: "Target" });
    await bump(3);
    const first = await relate("task/task_first");
    await run({ kind: "task-create", taskId: "task_second", title: "Second source" });
    await bump(3);
    const second = await relate("task/task_second");
    await bump(2);
    await cell.close();
    cell = undefined;
    const sourceSqlite = openSqliteEventStore({ repoId, rootInput: sourceRoot, readOnly: true });
    let expected: readonly (readonly [string, number])[];
    try {
      const original = sourceSqlite.events(),
        witness = (opId: string) => {
          const event = original.find((candidate) => candidate.opId === opId)!;
          assert.equal(event.schema, "relation-event/v1");
          return Number(event.payload.relation.targetObservedVersion);
        },
        firstWitness = witness(first.opId),
        secondWitness = witness(second.opId);
      assert.ok(firstWitness > 0);
      assert.ok(secondWitness > firstWitness);
      expected = [
        ["task/task_first", firstWitness],
        ["task/task_second", secondWitness],
      ];
      const legacy = original.map((event) => {
        if (event.opId !== first.opId && event.opId !== second.opId) return event;
        const { targetObservedVersion: _witness, ...relation } = event.payload.relation;
        return { ...event, payload: { ...event.payload, relation: { ...relation, strength: "strong" } } };
      });
      createImmutableLegacyGenerationSnapshot({
        repoId,
        snapshotPath,
        source: arrayStore(legacy, (digest) => sourceSqlite.readContentObject(digest)),
      });
      assert.deepEqual(sourceSqlite.events(), original);
    } finally {
      sourceSqlite.close();
    }
    const immutableBytes = readFileSync(snapshotPath, "utf8"),
      report = convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath });
    assert.equal(report.active, false);
    assert.equal(report.rewrittenEvents, 2);
    assert.equal(convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath }).migratedEvents, 0);
    const sqlite = openSqliteEventStore({ repoId, databasePath });
    try {
      const events = sqlite.events(),
        relations = events.filter((event) => event.opId === first.opId || event.opId === second.opId);
      assert.deepEqual(
        relations.map((event) => [event.payload.relation.source, event.payload.relation.targetObservedVersion]),
        expected,
      );
      assert.ok(relations.every((event) => !Object.hasOwn(event.payload.relation, "strength")));
      const coldPath = path.join(root, "cold.sqlite"),
        cold = makeTaskProjection({
          rootDir: root,
          eventStore: arrayStore(events, (digest) => sqlite.readContentObject(digest)),
          projectionPath: coldPath,
        });
      try {
        assert.equal(cold.rebuild().watermark, report.destinationRevision);
      } finally {
        cold.close();
      }
      const db = new DatabaseSync(coldPath, { readOnly: true });
      try {
        const rows = db
          .prepare(
            "SELECT source_ref, target_observed_version FROM relation_edge " +
              "WHERE source_ref IN ('task/task_first', 'task/task_second') ORDER BY workspace_revision",
          )
          .all();
        assert.deepEqual(
          rows.map((row) => [row.source_ref, row.target_observed_version]),
          expected,
        );
      } finally {
        db.close();
      }
    } finally {
      sqlite.close();
    }
    preflightConvertedGenerationActivation({ repoId, rootDir: root, snapshotPath, databasePath });
    assert.equal(readFileSync(snapshotPath, "utf8"), immutableBytes);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
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
            canonicalEventWritePlan(event, "fixture", "fixture")
              .targets.filter((target) => target.kind === "content_blob")
              .map((claim) => [claim.sha256, readContent(claim.sha256)!] as const),
          ),
        ),
    }),
    readContentBlob: (sha256: string) => {
      return readContent(sha256);
    },
  } as CanonicalEventStore;
}
