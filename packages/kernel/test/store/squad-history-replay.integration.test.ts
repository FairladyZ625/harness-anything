// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  normalizePersistedCanonicalEvent,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  serializeCanonicalEventUnchecked,
  serializePersistedCanonicalEvent,
  type PersistedCanonicalEventV1,
} from "../../src/domain/doc-sync.contract.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import type { EventStreamPort } from "../../src/projection/rebuildable-task-projection-types.ts";
import { withTempStoreAsync } from "./helpers.ts";

// Frozen canonical revisions 150958/150960: real dispatch + first observation of one run.
// Identity, mission, provider configuration, cwd and artifact refs are redacted; the flat schema is unchanged.
// Exact original bytes and full-ledger copy evidence belong to the private task's migration report.
const events = JSON.parse(
  readFileSync(new URL("../../fixtures/squad-history/flat-task-identity.json", import.meta.url), "utf8"),
) as PersistedCanonicalEventV1[];

for (const event of events) {
  test(`frozen flat ${event.type} survives historical serialization without rewriting bytes`, () => {
    const body = serializeCanonicalEventUnchecked(event);
    assert.equal(serializePersistedCanonicalEvent(event), body);
    assert.deepEqual(parseCanonicalEvent(body), event);
    assert.throws(
      () => serializeCanonicalEvent(event),
      /Squad (dispatch context|run observation) is invalid/u,
      "new writes must still reject retired flat identity",
    );
    const normalized = normalizePersistedCanonicalEvent(event);
    assert.deepEqual(normalizePersistedCanonicalEvent(normalized), normalized);
    assert.doesNotThrow(() => serializePersistedCanonicalEvent(normalized));
    assert.throws(() => parseCanonicalEvent(JSON.stringify(event)), /bytes are not canonical/u);
    const bad = structuredClone(event) as unknown as { payload: Record<string, unknown> };
    const identity = (bad.payload.squadRun ?? bad.payload) as Record<string, unknown>;
    delete identity.executionId;
    assert.throws(
      () => serializePersistedCanonicalEvent(bad as unknown as PersistedCanonicalEventV1),
      /Squad (dispatch context|run observation) is invalid/u,
    );
  });
}

test("frozen flat events pass canonical staging and fresh projection catch-up", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const head = events.at(-1)!.workspaceRevision;
    const source: EventStreamPort = {
      readHead: () => ({ revision: head }),
      readContentBlob: () => null,
      readBatch: (cursor, limit) => {
        const offset = Number(cursor ?? 0),
          batch = events.slice(offset, offset + limit),
          next = offset + batch.length;
        return {
          sourceRevision: head,
          events: batch,
          cursor: String(next),
          done: next === events.length,
          accessedItems: batch.length,
          prefetchContent: () => new Map(),
        };
      },
    };
    const projection = makeTaskProjection({
      rootDir,
      eventStore: source,
      projectionPath: path.join(rootDir, "history.sqlite"),
      catchUpLimit: 1,
    });
    try {
      assert.equal(projection.catchUp().watermark, head);
      const warm = projection.readSquadRuns();
      assert.equal(warm.length, 1);
      assert.deepEqual(warm[0]!.state.subject, {
        kind: "task",
        taskId: "task_000000000000000000000001",
        executionId: "exe_000000000000000000000001",
      });
      const dispatch = projection.readRuntimeDispatchById("dispatch_000000000000000000000001");
      assert.ok(dispatch);
      const historicalIdentity = dispatch.event.payload.squadRun as unknown as Record<string, unknown>;
      assert.equal(historicalIdentity.taskId, "task_000000000000000000000001");
      assert.equal(historicalIdentity.executionId, "exe_000000000000000000000001");
      assert.equal("subject" in historicalIdentity, false, "event reads preserve the original canonical bytes");
      const taskEvents = projection.readEventList({ entity: "task/task_000000000000000000000001", limit: 50 });
      const executionEvents = projection.readEventList({ entity: "execution/exe_000000000000000000000001", limit: 50 });
      assert.deepEqual(
        taskEvents.rows.filter(({ type }) => type.startsWith("runtime_squad_run")).map(({ revision }) => revision),
        [150960],
        "historical Squad observations remain indexed by their task after cold replay",
      );
      assert.deepEqual(
        executionEvents.rows.filter(({ type }) => type.startsWith("runtime_squad_run")).map(({ revision }) => revision),
        [150960],
        "historical Squad observations remain indexed by their execution after cold replay",
      );
      const observationSummary = projection
        .readEventSummaries(150959, 10)
        .events.find(({ type }) => type === "runtime_squad_run_observed");
      assert.equal(observationSummary?.payload.taskId, "task_000000000000000000000001");
      assert.deepEqual(taskEvents.rows.find(({ revision }) => revision === 150960)?.entityRefs, [
        "task/task_000000000000000000000001",
        "execution/exe_000000000000000000000001",
      ]);
    } finally {
      projection.close();
    }
  });
});
