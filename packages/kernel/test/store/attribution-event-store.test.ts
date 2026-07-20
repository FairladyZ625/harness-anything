// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  makeJournaledWriteCoordinator,
  rebuildTaskProjection
} from "../../src/index.ts";
import { readAttributionProjection } from "../../src/projection/sqlite-attribution-projection.ts";
import type { AttributionEventStore } from "../../src/write-coordination/attribution/legacy-attribution-event-store.ts";
import { makeLocalGitAttributionEventStore } from "../../src/write-coordination/attribution/legacy-attribution-event-store.ts";
import { readAttributionEvents } from "../../src/local/attribution-event-source.ts";
import { readJournal } from "../../src/write-coordination/journal/durable.ts";
import { testWriteAttribution } from "../test-attribution.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("attribution event is idempotent by opId and preserves every WAL attribution field", () => {
  withTempStore((rootDir) => {
    initializeAttributionGit(rootDir);
    const attribution = testWriteAttribution();
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution });
    const op = docWrite("op-attribution-fields", "task-fields", "progress.md", "field evidence\n");

    Effect.runSync(coordinator.enqueue(op));
    const journalRecord = readJournal(path.join(rootDir, ".harness/write-journal/writes.jsonl"), rootDir)[0]!;
    assert.equal(journalRecord.schema, "write-journal/v2");
    Effect.runSync(coordinator.flush("explicit"));

    const event = readAttributionEvents(rootDir)[0]!;
    assert.deepEqual({
      opId: event.opId,
      entityId: event.entityId,
      kind: event.kind,
      actor: event.actor,
      principalSource: event.principalSource,
      executorSource: event.executorSource,
      at: event.at,
      payloadHash: event.payloadHash,
      payloadRef: event.payloadRef
    }, {
      opId: journalRecord.opId,
      entityId: journalRecord.entityId,
      kind: journalRecord.kind,
      actor: journalRecord.actor,
      principalSource: journalRecord.principalSource,
      executorSource: journalRecord.executorSource,
      at: journalRecord.at,
      payloadHash: journalRecord.payload?.payloadHash,
      payloadRef: journalRecord.payloadRef
    });

    const replay = makeJournaledWriteCoordinator({ rootDir, attribution });
    Effect.runSync(replay.enqueue(op));
    assert.equal(Effect.runSync(replay.flush("explicit")).opCount, 0);
    assert.equal(readAttributionEvents(rootDir).length, 1);
    assert.equal(readdirSync(path.join(rootDir, "harness/attribution-events")).length, 1);
  });
});

test("crash before event append retains WAL until recovery confirms the immutable event", () => {
  withTempStore((rootDir) => {
    initializeAttributionGit(rootDir);
    const seedHead = attributionGit(rootDir, "rev-parse", "HEAD");
    const failingStore = failEventStore("before");
    const crashed = makeJournaledWriteCoordinator({ rootDir, attribution: testWriteAttribution(), attributionEventStore: failingStore });
    Effect.runSync(crashed.enqueue(docWrite("op-crash-before-event", "task-crash-before", "progress.md", "before\n")));

    const result = Effect.runSync(Effect.either(crashed.flush("explicit")));
    assert.equal(result._tag, "Left");
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8"), /op-crash-before-event/u);
    assert.equal(readAttributionEvents(rootDir).length, 0);
    assert.equal(attributionGit(rootDir, "rev-parse", "HEAD"), seedHead);

    Effect.runSync(makeJournaledWriteCoordinator({ rootDir, attribution: testWriteAttribution() }).recover);
    assert.equal(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8"), "");
    assert.equal(readAttributionEvents(rootDir)[0]?.opId, "op-crash-before-event");
    assert.match(attributionGit(rootDir, "log", "--oneline", "-1"), /task\(doc\): task-crash-before progress\.md \[op-crash-before-event\]/u);
    assert.equal(attributionGit(rootDir, "rev-list", "--count", "HEAD"), "2");
  });
});

test("crash after event append retains WAL, then recovery commits mutation and event together", () => {
  withTempStore((rootDir) => {
    initializeAttributionGit(rootDir);
    const seedHead = attributionGit(rootDir, "rev-parse", "HEAD");
    const failingStore = failEventStore("after");
    const crashed = makeJournaledWriteCoordinator({ rootDir, attribution: testWriteAttribution(), attributionEventStore: failingStore });
    Effect.runSync(crashed.enqueue(docWrite("op-crash-after-event", "task-crash-after", "progress.md", "after\n")));

    const result = Effect.runSync(Effect.either(crashed.flush("explicit")));
    assert.equal(result._tag, "Left");
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8"), /op-crash-after-event/u);
    assert.equal(readAttributionEvents(rootDir)[0]?.opId, "op-crash-after-event");
    assert.equal(attributionGit(rootDir, "rev-parse", "HEAD"), seedHead);

    Effect.runSync(makeJournaledWriteCoordinator({ rootDir, attribution: testWriteAttribution() }).recover);
    assert.equal(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8"), "");
    assert.match(attributionGit(rootDir, "log", "--oneline", "-1"), /task\(doc\): task-crash-after progress\.md \[op-crash-after-event\]/u);
    assert.equal(attributionGit(rootDir, "rev-list", "--count", "HEAD"), "2");
    assert.equal(readAttributionEvents(rootDir).length, 1);
  });
});

test("deleting WAL and SQLite rebuilds identical attribution rows only from event SoT", () => {
  withTempStore((rootDir) => {
    initializeAttributionGit(rootDir);
    const attribution = testWriteAttribution();
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution });
    Effect.runSync(coordinator.enqueue(docWrite("op-rebuild-one", "task-rebuild", "one.md", "one\n")));
    Effect.runSync(coordinator.enqueue(docWrite("op-rebuild-two", "task-rebuild", "two.md", "two\n")));
    Effect.runSync(coordinator.flush("explicit"));

    rebuildTaskProjection({ rootDir });
    const before = readAttributionProjection(rootDir);
    const journalPath = path.join(rootDir, ".harness/write-journal/writes.jsonl");
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");
    rmSync(journalPath, { force: true });
    rmSync(projectionPath, { force: true });
    assert.equal(existsSync(journalPath), false);
    assert.equal(existsSync(projectionPath), false);

    rebuildTaskProjection({ rootDir });
    const after = readAttributionProjection(rootDir);
    assert.deepEqual(after, before);
    assert.equal(after.length, 2);
    assert.deepEqual(after.map((row) => ({
      actor: row.actor,
      principalSource: row.principalSource,
      executorSource: row.executorSource
    })), [
      { actor: attribution.actor, principalSource: attribution.principalSource, executorSource: attribution.executorSource },
      { actor: attribution.actor, principalSource: attribution.principalSource, executorSource: attribution.executorSource }
    ]);
  });
});

function failEventStore(point: "before" | "after"): AttributionEventStore {
  const delegate = makeLocalGitAttributionEventStore();
  let failed = false;
  return {
    ...delegate,
    ensure: (record, context) => {
      if (!failed && point === "before") {
        failed = true;
        throw new Error("simulated crash before attribution event append");
      }
      const write = delegate.ensure(record, context);
      if (!failed && point === "after") {
        failed = true;
        throw new Error("simulated crash after attribution event append");
      }
      return write;
    }
  };
}

function initializeAttributionGit(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  execFileSync("git", ["-C", harnessRoot, "init", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  writeFileSync(path.join(harnessRoot, ".gitkeep"), "", "utf8");
  execFileSync("git", ["-C", harnessRoot, "add", "--", ".gitkeep"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], { stdio: "ignore" });
}

function attributionGit(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
