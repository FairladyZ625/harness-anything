// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
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
function projectionAt(rootDir: string, blob: string) {
  return makeTaskProjection({
    rootDir,
    projectionPath: path.join(rootDir, "projection.sqlite"),
    eventStore: {
      readHead: () => ({ revision: 1 }),
      readContentBlob: () => Buffer.from(blob),
      readBatch: (cursor) => ({
        sourceRevision: 1,
        events: cursor === "1" ? [] : [event],
        cursor: "1",
        done: true,
        accessedItems: cursor === "1" ? 0 : 1,
        prefetchContent: () => new Map([[event.payload.peopleDocumentClaim.sha256, Buffer.from(blob)]]),
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
    const projection = makeTaskProjection({
      rootDir,
      projectionPath: path.join(rootDir, "projection.sqlite"),
      eventStore: {
        readHead: () => ({ revision: 1 }),
        readContentBlob: () => Buffer.from(body),
        readBatch: (cursor) => ({
          sourceRevision: 1,
          events: cursor === "1" ? [] : [replayEvent],
          cursor: "1",
          done: true,
          accessedItems: cursor === "1" ? 0 : 1,
          prefetchContent: () => new Map([[replayEvent.payload.peopleDocumentClaim.sha256, Buffer.from(body)]]),
        }),
      },
    });
    try {
      assert.equal(projection.rebuild().watermark, 1);
      assert.equal(projection.readDocument("people.yaml").document, null);
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
