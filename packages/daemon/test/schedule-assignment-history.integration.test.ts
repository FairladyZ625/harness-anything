// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  makeTaskProjection,
  openSqliteEventStore,
  serializePersistedCanonicalEvent,
  sha256Text,
  validateCurrentCanonicalEvent,
  validateScheduleV1,
  type CanonicalEventV1,
} from "@harness-anything/kernel";
import { inspectScheduleProjection } from "../src/schedule-projection.ts";
import { readSchedulesGui } from "../src/schedules-gui-read.ts";

// Original accepted bytes from the Owner's eight counterexamples, before S8 rewrote current fixtures.
const samples = JSON.parse(
  readFileSync(new URL("./fixtures/schedule-assignment-history.json", import.meta.url), "utf8"),
) as {
  source: string;
  event: CanonicalEventV1 & {
    payload: { schedule: Record<string, unknown>; declarationDocumentClaim?: Record<string, unknown> };
  };
}[];

for (const sample of samples) {
  test(`historical Schedule replays and remains readable: ${sample.source}`, () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "schedule-assignment-history-")),
      store = openSqliteEventStore({ repoId: "schedule-history", databasePath: path.join(rootDir, "ledger.sqlite") }),
      historical = { ...structuredClone(sample.event), workspaceRevision: 1 },
      projectionPath = path.join(rootDir, "projection.sqlite");
    // Only stream placement and missing definition-blob evidence change; the historical Schedule is untouched.
    const blobs = [];
    if (historical.payload.declarationDocumentClaim) {
      const { status: _status, ...definition } = historical.payload.schedule,
        body = JSON.stringify(definition),
        blob = { sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "application/json", body };
      blobs.push(blob);
      historical.payload.declarationDocumentClaim = {
        ...historical.payload.declarationDocumentClaim,
        sha256: blob.sha256,
        size: blob.size,
      };
    }
    let projection: ReturnType<typeof makeTaskProjection> | undefined;
    try {
      assert.notDeepEqual(validateCurrentCanonicalEvent(historical), [], "new wire must reject the retired field");
      assert.notDeepEqual(validateScheduleV1(historical.payload.schedule), []);
      store.appendCommand({
        fence: { repoId: "schedule-history", holder: "fixture", epoch: 1 },
        intent: {
          opId: historical.opId,
          intentDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(historical))}`,
          summary: historical.type,
        },
        events: [historical],
        blobs,
      });
      const eventStore = {
        readHead: () => ({ revision: store.revision() }),
        readContentBlob: store.readContentObject,
        readBatch: (cursor: string | null, maxItems: number) => {
          const events = store.eventsAfter(Number(cursor ?? 0), maxItems),
            revision = events.at(-1)?.workspaceRevision ?? Number(cursor ?? 0);
          return {
            sourceRevision: store.revision(),
            events,
            cursor: String(revision),
            done: revision === store.revision(),
            accessedItems: events.length,
            prefetchContent: () => new Map(blobs.map((blob) => [blob.sha256, store.readContentObject(blob.sha256)])),
          };
        },
      };
      projection = makeTaskProjection({ rootDir, eventStore, projectionPath });
      assert.equal(projection.rebuild().watermark, 1);
      const id = String(historical.payload.schedule.scheduleId),
        expected = structuredClone(historical.payload.schedule),
        status = expected.status as Record<string, Record<string, unknown> | null>;
      delete expected.spec.target.runtimeInstanceId;
      delete expected.spec.target.model;
      for (const key of ["activeRun", "lastRun"]) if (status[key]) delete status[key].assignmentId;
      const assertReadable = () => {
        const row = projection!.getEntity("schedule", id);
        assert.ok(row);
        assert.deepEqual(
          row.value,
          expected,
          "retired assignment evidence and instance/model pins are omitted from the projection",
        );
        assert.equal(inspectScheduleProjection(row).valid, true);
        const gui = readSchedulesGui({
          rootDir,
          mode: "local",
          now: () => "2026-10-04T00:00:00.000Z",
          input: { repoId: "schedule-history" },
          projection: projection!,
        });
        assert.equal(gui.schedules.length, 1);
        assert.notEqual(gui.schedules[0]!.state, "invalid");
      };
      assertReadable();
      assert.deepEqual(
        validateCurrentCanonicalEvent({ ...historical, payload: { ...historical.payload, schedule: expected } }),
        [],
      );
      projection.close();
      // An already-built pre-cut cache must also recover, not just a new zero replay.
      const db = new DatabaseSync(projectionPath);
      db.prepare("UPDATE entity_projection SET value_json=? WHERE entity_kind='schedule'").run(
        JSON.stringify(historical.payload.schedule),
      );
      db.prepare("UPDATE projection_meta SET schema_version=24 WHERE singleton=1").run();
      db.close();
      projection = makeTaskProjection({ rootDir, eventStore, projectionPath });
      projection.catchUp();
      assertReadable();
      assert.deepEqual(store.event(historical.opId), historical, "accepted history remains immutable");
    } finally {
      projection?.close();
      store.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}
