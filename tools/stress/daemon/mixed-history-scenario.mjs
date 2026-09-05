import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compileScheduleDefinitionEvent,
  compileSettingsChangedEvent,
  contentObjectRelativePath,
  createScheduleV1,
  deriveRelationId,
  eventObjectRelativePath,
  eventShapeMigrations,
  makeTaskEventReader,
  makeTaskEventStore,
  makeTaskProjection,
  readSettingsFacet,
  relationEventWritePlan,
  runEventShapeMigration,
  sha256Text,
  validateScheduleV1,
} from "../../../packages/kernel/src/index.ts";
import { actor, initRepo } from "../../../packages/daemon/test/migration-import.fixtures.ts";

const migrationFixture = path.resolve("packages/daemon/test/stress/recovery/mixed-history-migration.fixture.mjs");

export async function runMixedHistoryScenario(root) {
  mkdirSync(root, { recursive: true });
  const repoId = "stress-s3-mixed-history",
    seeded = await seedMixedHistory(root, repoId),
    coldPath = path.join(root, ".harness/cache/stress-s3-cold.sqlite"),
    cold = () =>
      makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventReader({ repoId, rootDir: root }),
        projectionPath: coldPath,
      });
  let strictMessage = "";
  try {
    cold().rebuild();
    assert.fail("strict cold rebuild accepted the mixed historical shapes");
  } catch (error) {
    strictMessage = error instanceof Error ? error.message : String(error);
    assert.match(strictMessage, /Relation facet fields|does not match the event definition|walFlush/u);
  }

  const killed = spawnSync(
    process.execPath,
    [migrationFixture, root, repoId, "relation-events-migrate", "after_event_write"],
    { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" },
  );
  assert.equal(killed.signal, "SIGKILL", `${killed.stderr}\n${killed.stdout}`);
  assert.match(killed.stdout, /migration-killpoint:after_event_write/u);

  const migrationResults = [];
  for (const kind of ["relation-events-migrate", "schedule-definitions-migrate", "settings-wal-flush-migrate"]) {
    const store = makeTaskEventStore({ repoId, rootDir: root }),
      receipt = await runEventShapeMigration(eventShapeMigrations[kind], {
        dryRun: false,
        actor,
        rootDir: root,
        store,
        now: () => "2026-09-05T12:01:00.000Z",
      }),
      repeat = await runEventShapeMigration(eventShapeMigrations[kind], {
        dryRun: false,
        actor,
        rootDir: root,
        store,
        now: () => "2026-09-05T12:02:00.000Z",
      }),
      repeatReport = JSON.parse(String(repeat.evidence));
    assert.ok(["applied", "pending"].includes(receipt.outcome), JSON.stringify(receipt));
    assert.equal(repeat.outcome, "pending", JSON.stringify(repeat));
    assert.equal(repeatReport.rewrittenEvents, 0, `${kind} must be a zero-rewrite second run`);
    migrationResults.push({ kind, firstOutcome: receipt.outcome, secondRewrites: repeatReport.rewrittenEvents });
    await store.drain();
  }

  const firstProjection = cold(),
    first = firstProjection.rebuild(),
    firstDigest = first.stateDigest;
  firstProjection.close();
  rmSync(coldPath, { force: true });
  const secondProjection = cold(),
    second = secondProjection.rebuild(),
    secondDigest = second.stateDigest,
    reader = makeTaskEventReader({ repoId, rootDir: root }),
    events = reader.read().events,
    relation = events.find(({ opId }) => opId === seeded.relationOpId),
    schedule = events.find(({ opId }) => opId === seeded.scheduleOpId),
    settings = events.find(({ opId }) => opId === seeded.settingsOpId);
  assert.equal(firstDigest, secondDigest);
  assert.ok(relation?.schema === "relation-event/v1");
  assert.equal(Object.hasOwn(relation.payload.relation, "strength"), false);
  assert.equal(Object.hasOwn(relation.payload.relation, "targetObservedVersion"), true);
  assert.ok(schedule?.schema === "schedule-event/v1");
  assert.equal(Object.hasOwn(schedule.payload.schedule.spec.target, "cwd"), false);
  const claim = schedule.payload.declarationDocumentClaim,
    scheduleBlob = reader.readContentBlob(claim.sha256);
  assert.ok(scheduleBlob);
  assert.deepEqual(
    validateScheduleV1({
      ...JSON.parse(new TextDecoder().decode(scheduleBlob)),
      status: schedule.payload.schedule.status,
    }),
    [],
  );
  assert.ok(settings?.schema === "settings-event/v1");
  assert.equal(Object.hasOwn(settings.payload.settings, "walFlush"), true);
  const migrationMarkers = events.filter(
    (event) => event.schema === "migration-import-event/v1" && String(event.payload.migratedFrom).includes(":"),
  );
  assert.equal(migrationMarkers.length, 3);
  secondProjection.close();
  return {
    redControl: {
      id: "F10/strict-reducer-rejects-mixed-history",
      observed: "FAIL",
      passed: strictMessage.length > 0,
      violations: [strictMessage],
    },
    caseResult: {
      id: "F10/mixed-history-strict-replay",
      boundaryHits: [
        "relation strength without witness",
        "schedule cwd in event and declaration blob",
        "settings without walFlush",
        "migration after_event_write SIGKILL",
        "second cold rebuild",
      ],
      faults: [{ kind: "SIGKILL", boundary: "migration event write before head publication" }],
      observations: {
        strictRejection: strictMessage,
        migrationResults,
        migrationMarkers: migrationMarkers.length,
        firstDigest,
        secondDigest,
      },
      oracles: { strictReducer: "PASS", explicitMigration: "PASS", secondRunZeroRewrites: "PASS" },
      verdict: "PASS",
    },
  };
}

async function seedMixedHistory(root, repoId) {
  initRepo(root);
  const store = makeTaskEventStore({ repoId, rootDir: root }),
    relation = relationEvent(1),
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
      occurredAt: "2026-09-05T00:00:00.000Z",
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
    });
  store.append({ event: relation, plan: relationEventWritePlan(relation), blobs: [] });
  store.append(scheduleCompiled);
  store.append(settingsCompiled);
  await store.settlePendingMaterialization?.("mixed-history seed");
  const layout = store.layout();
  makeLegacyRelation(root, layout, relation.opId);
  makeLegacySchedule(root, layout, scheduleCompiled.event.opId);
  makeLegacySettings(root, layout, settingsCompiled.event.opId);
  git(root, "add", "harness");
  git(root, "commit", "--quiet", "-m", "mixed historical shapes");
  git(root, "update-ref", "refs/ha/canonical", "HEAD");
  await store.drain();
  return {
    relationOpId: relation.opId,
    scheduleOpId: scheduleCompiled.event.opId,
    settingsOpId: settingsCompiled.event.opId,
  };
}

function relationEvent(workspaceRevision) {
  const identity = {
    source: "task/task-source",
    target: "task/task-target",
    type: "depends-on",
    direction: "directed",
  };
  return {
    schema: "relation-event/v1",
    eventId: "event-mixed-relation",
    workspaceRevision,
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

function makeLegacyRelation(root, layout, opId) {
  mutateEvent(root, layout, opId, (stored) => {
    const { targetObservedVersion: _witness, ...facet } = stored.payload.relation;
    stored.payload.relation = { ...facet, strength: "strong" };
  });
}

function makeLegacySchedule(root, layout, opId) {
  mutateEvent(root, layout, opId, (stored) => {
    const target = { ...stored.payload.schedule.spec.target, cwd: ".worktrees/legacy" },
      schedule = { ...stored.payload.schedule, spec: { ...stored.payload.schedule.spec, target } },
      { status: _status, ...definition } = schedule,
      body = `${JSON.stringify(definition, null, 2)}\n`,
      sha256 = sha256Text(body),
      claim = { ...stored.payload.declarationDocumentClaim, sha256, size: Buffer.byteLength(body) },
      blobPath = path.join(root, "harness", contentObjectRelativePath(sha256, layout));
    mkdirSync(path.dirname(blobPath), { recursive: true });
    writeFileSync(blobPath, body);
    stored.payload = { schedule, declarationDocumentClaim: claim };
  });
}

function makeLegacySettings(root, layout, opId) {
  mutateEvent(root, layout, opId, (stored) => {
    delete stored.payload.settings.walFlush;
  });
}

function mutateEvent(root, layout, opId, mutate) {
  const eventPath = path.join(root, "harness", eventObjectRelativePath(opId, layout)),
    stored = JSON.parse(readFileSync(eventPath, "utf8"));
  mutate(stored);
  writeFileSync(eventPath, `${sortedJson(stored)}\n`);
}

function sortedJson(value) {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
      : entry,
  );
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
