// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCurrentCanonicalEvent } from "../../src/domain/doc-sync-canonical-events.ts";
import type { CanonicalEventV1 } from "../../src/domain/doc-sync-types.ts";
import { GenerationThreeMigration } from "../../src/store/generation-three-migration.ts";
import type { SqliteEventStore } from "../../src/store/sqlite-event-store.ts";

const fixtureRoot = "packages/kernel/fixtures/migration-source";

function events(fixture: string): readonly CanonicalEventV1[] {
  return readFileSync(`${fixtureRoot}/${fixture}/events.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(JSON.parse(line).event_json) as CanonicalEventV1);
}

function processor(): GenerationThreeMigration {
  return new GenerationThreeMigration({ readContentObject: () => null } as unknown as SqliteEventStore);
}

test("the frozen lifecycle suite migrates digest bindings and invalidates all three X17 shapes", () => {
  const migration = processor(),
    source = events("f-lifecycle-suite"),
    migrated = source.map((event) => migration.rewrite(event));
  for (const rewrite of migrated) assert.deepEqual(validateCurrentCanonicalEvent(rewrite.event), []);
  const submitted = migrated.flatMap(({ event }) =>
    event.type === "execution_submitted" ? [event.payload.execution.submission!] : [],
  );
  assert.ok(submitted.length > 0);
  for (const submission of submitted)
    for (const gate of submission.completionContract.gates)
      if (gate.witness.adapterId === "github-actions") assert.equal(gate.witness.adapterOptions.coverage, "descendant");

  const lastOccurredAt = source.at(-1)!.occurredAt,
    invalidations = migration.invalidations(source.length + 1, lastOccurredAt);
  assert.deepEqual(
    invalidations.map((rewrite) => (rewrite.event as { readonly taskId: string }).taskId),
    ["task_fx17_held", "task_fx17_inreview", "task_fx17_released"],
  );
  for (const { event } of invalidations) {
    assert.equal(event.type, "execution_invalidated");
    if (event.type !== "execution_invalidated") continue;
    assert.equal(event.payload.execution.state, "abandoned");
    assert.equal(event.payload.task.status, "active");
    assert.equal(event.payload.task.currentNode, "implementation");
    assert.equal(event.payload.task.iteration, 1);
    assert.equal(event.payload.reason, "generation-migration");
    assert.deepEqual(validateCurrentCanonicalEvent(event), []);
  }
  const held = invalidations.find(({ event }) => "taskId" in event && event.taskId === "task_fx17_held")!.event;
  assert.equal(held.type === "execution_invalidated" ? held.payload.releasedLease?.phase : null, "held");
  assert.equal(
    invalidations.filter(({ event }) => event.type === "execution_invalidated" && event.payload.releasedLease === null)
      .length,
    2,
  );
});

test("migration rejects malformed historical witnesses instead of inventing evidence", () => {
  for (const fixture of ["s-x27-witness-missing-fields", "s-x27-witness-non-ci-gate", "s-x27-witness-non-pass"]) {
    const migration = processor();
    assert.throws(() => migration.rewrite(events(fixture)[0]!), /gate|submission|workflow|witness/u, fixture);
  }
});

test("X18 reviewer dispatch history remains opaque and unchanged", () => {
  for (const fixture of ["h-x18-reviewer-dispatch", "h-x18-complete-review-dispatch"]) {
    const migration = processor(),
      source = events(fixture),
      migrated = source.map((event) => migration.rewrite(event).event);
    assert.deepEqual(migrated, source, fixture);
    assert.deepEqual(migration.invalidations(source.length + 1, source.at(-1)!.occurredAt), [], fixture);
  }
});
