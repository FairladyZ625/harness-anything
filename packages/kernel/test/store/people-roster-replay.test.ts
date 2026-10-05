// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parseCanonicalEvent } from "../../src/domain/doc-sync-canonical-events.ts";
import { isRetiredPeopleEvent } from "../../src/domain/people-event.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { withTempStore } from "./helpers.ts";

const historical = parseCanonicalEvent(
  readFileSync(new URL("../../fixtures/canonical-events/people-event-v1/accepted.json", import.meta.url), "utf8"),
);
assert.ok(isRetiredPeopleEvent(historical));
const event = { ...historical, workspaceRevision: 1 },
  body = JSON.stringify(event.payload.roster, null, 2) + "\n";
function projectionAt(rootDir: string, blob: string, replayEvent = event) {
  return makeTaskProjection({
    rootDir,
    projectionPath: path.join(rootDir, "projection.sqlite"),
    eventStore: {
      readHead: () => ({ revision: 1 }),
      readContentBlob: () => Buffer.from(blob),
      readBatch: (cursor) => ({
        sourceRevision: 1,
        events: cursor === "1" ? [] : [replayEvent],
        cursor: "1",
        done: true,
        accessedItems: cursor === "1" ? 0 : 1,
        prefetchContent: () => new Map([[replayEvent.payload.peopleDocumentClaim.sha256, Buffer.from(blob)]]),
      }),
    },
  });
}
test("retired People cold replay keeps the audit and never projects current people or permissions", () => {
  withTempStore((rootDir) => {
    const replayEvent = {
      ...event,
      payload: {
        ...event.payload,
        peopleDocumentClaim: { ...event.payload.peopleDocumentClaim, size: Buffer.byteLength(body) },
      },
    };
    const projection = projectionAt(rootDir, body, replayEvent);
    try {
      assert.equal(projection.rebuild().watermark, 1);
      assert.equal(projection.readDocument("people.yaml").document?.body, body);
      assert.deepEqual(projection.readReplicaBasis(null).documents, [
        {
          path: "people.yaml",
          blobSha256: replayEvent.payload.peopleDocumentClaim.sha256,
          size: Buffer.byteLength(body),
          mediaType: "application/yaml",
        },
      ]);
      assert.equal(projection.readEntityVersionWitness("person/person-fixture").currentVersion, null);
      assert.equal(projection.readCanonicalEvents(0, 1).events[0]?.schema, "people-event/v1");
    } finally {
      projection.close();
    }
  });
});
test("retired People replay still rejects mismatched historical snapshot content", () => {
  withTempStore((rootDir) => {
    const projection = projectionAt(rootDir, " ".repeat(event.payload.peopleDocumentClaim.size));
    try {
      assert.throws(() => projection.rebuild(), /audit snapshot/u);
    } finally {
      projection.close();
    }
  });
});

test("opening a version 25 cache replays the omitted audit document without changing event history", () => {
  withTempStore((rootDir) => {
    const replayEvent = {
      ...event,
      payload: {
        ...event.payload,
        peopleDocumentClaim: { ...event.payload.peopleDocumentClaim, size: Buffer.byteLength(body) },
      },
    };
    const original = projectionAt(rootDir, body, replayEvent);
    original.rebuild();
    const before = original.readCanonicalEvents(0, 1).events;
    original.close();
    const stale = new DatabaseSync(path.join(rootDir, "projection.sqlite"));
    stale.exec("DELETE FROM document; UPDATE projection_meta SET schema_version = 25");
    stale.close();
    const reopened = projectionAt(rootDir, body, replayEvent);
    try {
      reopened.catchUp();
      assert.equal(reopened.readDocument("people.yaml").document?.body, body);
      assert.deepEqual(reopened.readCanonicalEvents(0, 1).events, before);
      assert.equal(reopened.readEntityVersionWitness("person/person-fixture").currentVersion, null);
    } finally {
      reopened.close();
    }
  });
});
