// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ciRunWindow } from "../src/domain/ci-rerun-statistics.ts";
import { decodeCiObservation } from "../src/domain/ci-run-observation-v4.ts";
import { repositoryEventQueries } from "../src/projection/repository-event-queries.ts";
import { createRepositoryReadModelTables } from "../src/projection/read-model-repository.ts";
import workflow from "../fixtures/canonical-events/ci-run-observation-v4/workflow.json" with { type: "json" };
import v2 from "../fixtures/canonical-events/ci-run-observation-v2/accepted.json" with { type: "json" };
import v3 from "../fixtures/canonical-events/ci-run-observation-v3/accepted.json" with { type: "json" };

function event(runId: string, revision: number, provider = "github-actions", time = "2026-10-01T00:00:00.000Z") {
  const value = structuredClone(workflow);
  return {
    ...value,
    eventId: `event-${revision}`,
    opId: `op-${revision}`,
    workspaceRevision: revision,
    occurredAt: time,
    payload: {
      ...value.payload,
      identity: { ...value.payload.identity, provider, databaseRunId: runId },
      run: { ...value.payload.run, branch: "main" },
    },
  } as Parameters<typeof decodeCiObservation>[0];
}
function permutations<T>(rows: readonly T[]): T[][] {
  return rows.length
    ? rows.flatMap((row, i) => permutations(rows.filter((_, j) => i !== j)).map((rest) => [row, ...rest]))
    : [[]];
}
test("mixed providers have one transitive window across every input permutation", () => {
  const rows = [
    event("200", 1),
    event("100", 2, "github-actions", "2026-10-03T00:00:00.000Z"),
    event("local", 3, "local", "2026-10-02T00:00:00.000Z"),
  ].map(decodeCiObservation);
  for (const input of permutations(rows)) assert.equal(ciRunWindow(input, 1)[0]?.eventId, "event-1");
});
test("indexed window matches the domain across legacy, bigint, ties and late imports", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRepositoryReadModelTables(db);
    const insert = db.prepare("INSERT INTO event_index(op_id, workspace_revision, event_json) VALUES (?, ?, ?)");
    const rows = [
      event("9007199254740993000000", 1),
      event("9007199254740992999999", 2),
      event("000200", 3),
      event("200", 4),
      event("local", 5, "local"),
      event("local2", 6, "local", "2026-10-02T00:00:00.000Z"),
      ...[v2, v3].map((e, i) => ({ ...e, eventId: `event-${i + 7}`, opId: `op-${i + 7}`, workspaceRevision: i + 7 })),
    ] as Parameters<typeof decodeCiObservation>[0][];
    for (const row of rows) insert.run(row.opId, row.workspaceRevision, JSON.stringify(row));
    const q = repositoryEventQueries((read) => read(db, { status: "ready", watermark: 8, sourceRevision: 8 }));
    for (const window of [1, 2, 3, 4, 6, 100]) {
      const result = q.readCiRunObservations(window, undefined, { familyWindow: window });
      assert.deepEqual(ciRunWindow(result.events, window), ciRunWindow(rows.map(decodeCiObservation), window));
      assert.equal(result.watermark, 8);
    }
    assert.equal(q.readCiRunObservations(1, undefined, { familyWindow: 1 }).events[0]?.eventId, "event-1");
    assert.throws(() => q.readCiRunObservations(1, undefined, { familyWindow: 101 }), /1\.\.100/);
  } finally {
    db.close();
  }
});
test("window event decoding stays constant as unrelated historical families grow", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createRepositoryReadModelTables(db);
    const insert = db.prepare("INSERT INTO event_index(op_id, workspace_revision, event_json) VALUES (?, ?, ?)");
    const q = repositoryEventQueries((read) => read(db, { status: "ready", watermark: 5000, sourceRevision: 5000 }));
    for (let revision = 1; revision <= 2000; revision++) {
      const row = event(String(revision === 1 ? 10000 : revision), revision);
      insert.run(row.opId, row.workspaceRevision, JSON.stringify(row));
      if (revision === 200 || revision === 2000) {
        const original = JSON.parse;
        let decodes = 0;
        JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
          decodes++;
          return original(...args);
        };
        try {
          assert.equal(q.readCiRunObservations(1, undefined, { familyWindow: 1 }).events.length, 1);
          assert.equal(decodes, 1);
        } finally {
          JSON.parse = original;
        }
      }
    }
  } finally {
    db.close();
  }
});
