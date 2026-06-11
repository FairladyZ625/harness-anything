import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import type { LifecycleEngine } from "../../src/ports/index.js";

const forbiddenPortMembers = [
  ["request", "Transition"].join(""),
  ["sync", "Mode"].join(""),
  ["binding", "Role"].join("")
];

test("LifecycleEngine is a read-oriented snapshot port", () => {
  const engine = {
    name: "local",
    capabilities: Effect.succeed({
      snapshots: true,
      listTasks: false,
      publishNote: false
    }),
    snapshot: () => Effect.succeed({
      canonicalStatus: "active",
      rawStatus: "active",
      freshness: "fresh",
      fetchedAt: "2026-06-11T00:00:00.000Z",
      expiresAt: "2026-06-11T00:05:00.000Z",
      source: "local-document",
      engine: "local",
      ref: "task-1"
    })
  } satisfies LifecycleEngine;

  const snapshot = Effect.runSync(engine.snapshot({ engine: "local", ref: "task-1" }));
  assert.equal(snapshot.canonicalStatus, "active");
  assert.equal(snapshot.rawStatus, "active");
  assert.equal(snapshot.freshness, "fresh");
  assert.equal(snapshot.source, "local-document");
  assert.equal(snapshot.engine, "local");
  assert.equal(snapshot.ref, "task-1");
  assert.equal(snapshot.expiresAt, "2026-06-11T00:05:00.000Z");
});

test("LifecycleEngine contract does not expose old lifecycle coordination members", () => {
  const publicMembers = new Set([
    "name",
    "capabilities",
    "snapshot",
    "listTasks",
    "publishNote"
  ]);

  for (const member of forbiddenPortMembers) {
    assert.equal(publicMembers.has(member), false);
  }
});
