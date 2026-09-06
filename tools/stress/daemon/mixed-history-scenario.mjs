import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  compileScheduleDefinitionEvent,
  compileSettingsChangedEvent,
  convertLegacyGeneration,
  createImmutableLegacyGenerationSnapshot,
  createScheduleV1,
  deriveRelationId,
  makeTaskProjection,
  openSqliteEventStore,
  readSettingsFacet,
  sha256Text,
  validateScheduleV1,
} from "../../../packages/kernel/src/index.ts";
import { actor, initRepo } from "../../../packages/daemon/test/migration-import.fixtures.ts";

const fixture = path.resolve("packages/daemon/test/stress/recovery/mixed-history-migration.fixture.mjs");

export async function runMixedHistoryScenario(root) {
  mkdirSync(root, { recursive: true });
  const repoId = "stress-s3-mixed-history";
  initRepo(root);
  const seeded = seedMixedHistory(root),
    source = arrayStore(seeded.events, seeded.objects),
    snapshotPath = path.join(root, ".harness/store/import/gen0.snapshot.json"),
    databasePath = path.join(root, ".harness/store/generations/1/ledger.sqlite"),
    sourceBytesBefore = seeded.events.map(JSON.stringify);
  let strictMessage = "";
  try {
    const strict = makeTaskProjection({
      rootDir: root,
      eventStore: source,
      projectionPath: path.join(root, "strict.sqlite"),
    });
    strict.rebuild();
    strict.close();
    assert.fail("strict cold rebuild accepted the mixed historical shapes");
  } catch (error) {
    strictMessage = error instanceof Error ? error.message : String(error);
    assert.match(strictMessage, /Relation facet fields|does not match the event definition|walFlush/u);
  }
  createImmutableLegacyGenerationSnapshot({ repoId, source, snapshotPath });
  const killed = spawnSync(process.execPath, [fixture, root, snapshotPath, databasePath], {
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  assert.equal(killed.signal, "SIGKILL", `${killed.stderr}\n${killed.stdout}`);
  assert.match(killed.stdout, /conversion-killpoint:before_event_2/u);
  const first = convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath }),
    second = convertLegacyGeneration({ rootDir: root, snapshotPath, databasePath });
  assert.equal(first.rewrittenEvents, 3);
  assert.equal(second.migratedEvents, 0);
  assert.deepEqual(seeded.events.map(JSON.stringify), sourceBytesBefore);

  const sqlite = openSqliteEventStore({ repoId, databasePath }),
    events = sqlite.events(),
    convertedSource = arrayStore(
      events,
      new Map(sqlite.contentObjectDigests().map((sha256) => [sha256, sqlite.readContentObject(sha256)])),
    ),
    coldPath = path.join(root, "cold.sqlite"),
    firstProjection = makeTaskProjection({ rootDir: root, eventStore: convertedSource, projectionPath: coldPath }),
    firstRebuild = firstProjection.rebuild();
  firstProjection.close();
  rmSync(coldPath, { force: true });
  const secondProjection = makeTaskProjection({ rootDir: root, eventStore: convertedSource, projectionPath: coldPath }),
    secondRebuild = secondProjection.rebuild();
  secondProjection.close();
  sqlite.close();
  assert.equal(firstRebuild.stateDigest, secondRebuild.stateDigest);
  const relation = events.find(({ opId }) => opId === "op-mixed-relation"),
    schedule = events.find(({ opId }) => opId === "op-mixed-schedule"),
    settings = events.find(({ opId }) => opId === "op-mixed-settings");
  assert.equal(Object.hasOwn(relation.payload.relation, "strength"), false);
  assert.equal(Object.hasOwn(relation.payload.relation, "targetObservedVersion"), true);
  assert.equal(Object.hasOwn(schedule.payload.schedule.spec.target, "cwd"), false);
  assert.deepEqual(
    validateScheduleV1({
      ...JSON.parse(
        new TextDecoder().decode(convertedSource.readContentBlob(schedule.payload.declarationDocumentClaim.sha256)),
      ),
      status: schedule.payload.schedule.status,
    }),
    [],
  );
  assert.equal(Object.hasOwn(settings.payload.settings, "walFlush"), true);
  return {
    redControl: {
      id: "F10/strict-reducer-rejects-mixed-history",
      observed: "FAIL",
      passed: strictMessage.length > 0,
      violations: [strictMessage],
    },
    caseResult: {
      id: "F10/immutable-gen0-to-inactive-gen1",
      boundaryHits: ["strict legacy rejection", "before event 2 SIGKILL", "two SQLite cold rebuilds"],
      faults: [{ kind: "SIGKILL", boundary: "inactive conversion before event 2" }],
      observations: {
        strictRejection: strictMessage,
        sourceDigest: first.sourceDigest,
        rewrittenEvents: first.rewrittenEvents,
        retryMigratedEvents: first.migratedEvents,
        secondConversionEvents: second.migratedEvents,
        requiredObjects: first.copiedObjects,
        firstDigest: firstRebuild.stateDigest,
        secondDigest: secondRebuild.stateDigest,
      },
      oracles: {
        strictReducer: "PASS",
        immutableSource: "PASS",
        interruptionRetry: "PASS",
        secondRunZeroConversions: "PASS",
      },
      verdict: "PASS",
    },
  };
}

function seedMixedHistory(root) {
  const relation = relationEvent(),
    schedule = createScheduleV1({
      scheduleId: "legacy-schedule",
      name: "Legacy schedule",
      mode: "detect",
      spec: {
        mission: "Exercise mixed historical replay.",
        trigger: { kind: "interval", everyMs: 60_000, anchorAt: "2026-09-05T00:00:00.000Z" },
        target: { kind: "agent", agentId: "worker", runtimeInstanceId: "codex" },
      },
      actor,
      occurredAt: "2026-09-05T00:01:00.000Z",
    }),
    scheduleCompiled = compileScheduleDefinitionEvent({
      type: "schedule_created",
      schedule,
      eventId: "event-mixed-schedule",
      opId: "op-mixed-schedule",
      workspaceRevision: 2,
      actor,
      source: "local",
      occurredAt: "2026-09-05T00:01:00.000Z",
    }),
    harnessBody = readFileSync(path.join(root, "harness/harness.yaml"), "utf8"),
    settingsCompiled = compileSettingsChangedEvent({
      settings: readSettingsFacet(harnessBody),
      baseDocumentBody: harnessBody,
      candidateDocumentBody: harnessBody,
      eventId: "event-mixed-settings",
      opId: "op-mixed-settings",
      workspaceRevision: 3,
      actor,
      source: "local",
      occurredAt: "2026-09-05T00:02:00.000Z",
    }),
    legacyRelation = structuredClone(relation),
    legacySchedule = structuredClone(scheduleCompiled.event),
    legacySettings = structuredClone(settingsCompiled.event),
    target = { ...legacySchedule.payload.schedule.spec.target, cwd: ".worktrees/legacy" },
    scheduleWithCwd = { ...legacySchedule.payload.schedule, spec: { ...legacySchedule.payload.schedule.spec, target } },
    { status: _status, ...definition } = scheduleWithCwd,
    definitionBody = `${JSON.stringify(definition, null, 2)}\n`,
    definitionSha = sha256Text(definitionBody);
  const { targetObservedVersion: _witness, ...facet } = legacyRelation.payload.relation;
  legacyRelation.payload.relation = { ...facet, strength: "strong" };
  legacySchedule.payload.schedule = scheduleWithCwd;
  legacySchedule.payload.declarationDocumentClaim = {
    ...legacySchedule.payload.declarationDocumentClaim,
    sha256: definitionSha,
    size: Buffer.byteLength(definitionBody),
  };
  delete legacySettings.payload.settings.walFlush;
  const blobs = [...scheduleCompiled.blobs, ...settingsCompiled.blobs],
    objects = new Map(blobs.map((blob) => [blob.sha256, Buffer.from(blob.body)]));
  objects.set(definitionSha, Buffer.from(definitionBody));
  return { events: [legacyRelation, legacySchedule, legacySettings], objects };
}

function relationEvent() {
  const identity = {
    source: "task/task-source",
    target: "task/task-target",
    type: "depends-on",
    direction: "directed",
  };
  return {
    schema: "relation-event/v1",
    eventId: "event-mixed-relation",
    workspaceRevision: 1,
    opId: "op-mixed-relation",
    relationId: deriveRelationId(identity),
    type: "relation_created",
    actor,
    source: "local",
    occurredAt: "2026-09-05T00:00:00.000Z",
    payload: {
      relation: {
        relation_id: deriveRelationId(identity),
        ...identity,
        origin: "declared",
        rationale: "Mixed historical relation.",
        state: "active",
        targetObservedVersion: null,
      },
    },
  };
}

function arrayStore(events, objects) {
  return {
    read: () => ({ revision: events.length, events }),
    readHead: () => ({ revision: events.length, eventDigest: `sha256:${sha256Text(JSON.stringify(events.at(-1)))}` }),
    readBatch: () => ({
      sourceRevision: events.length,
      events,
      cursor: null,
      done: true,
      accessedItems: events.length,
      prefetchContent: () => objects,
    }),
    readContentBlob: (sha256) => objects.get(sha256) ?? null,
  };
}
