// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { serializePersistedCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { compilePeopleRosterActionEvent } from "../../src/domain/people-event.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import type { EventStreamPort } from "../../src/projection/rebuildable-task-projection-types.ts";
import { contentClaims, objectPath } from "../../src/store/task-event-store-claims-layout.ts";
import { openSqliteEventStore } from "../../src/store/sqlite-event-store.ts";
import { writeFileSync } from "node:fs";
import { withTempStore } from "./helpers.ts";

const actor = { principal: { personId: "person_owner" }, executor: null } as const,
  ownerBody = `${JSON.stringify({
    schema: "harness-people/v1",
    people: [{ personId: "person_owner", displayName: "Owner", roles: ["owner"], credentials: [] }],
    roles: [{ roleId: "owner", commandClasses: ["admin"] }],
  })}\n`;

function delegatedPeopleEvent(expiresAt: string) {
  return compilePeopleRosterActionEvent({
    currentBody: ownerBody,
    action: {
      kind: "people-delegate",
      token: {
        schema: "delegated-execution-token/v1",
        tokenId: "det_owner_runtime_1",
        issuer: { personId: "person_owner" },
        delegate: { runtimeSessionId: "runtime_1" },
        allowedActions: ["execution.start"],
        // Operator-supplied --expires-at text is the only timestamp that enters the ledger
        // without daemon-generated millisecond precision.
        issuedAt: "2026-09-29T20:45:42.000Z",
        expiresAt,
        revokedAt: null,
      },
    },
    eventId: "event-people-delegate-1",
    opId: "op-people-delegate-1",
    workspaceRevision: 1,
    actor,
    source: "local",
    occurredAt: "2026-09-29T20:45:45.616Z",
  });
}

test("a people_changed roster with second-precision timestamps survives cold replay", () => {
  withTempStore((rootDir) => {
    const store = openSqliteEventStore({ repoId: "people-roster", databasePath: path.join(rootDir, "ledger.sqlite") });
    const compiled = delegatedPeopleEvent("2026-10-02T20:45:42Z");
    assert.ok(compiled.bundle);
    store.appendCommand({
      fence: { repoId: "people-roster", holder: "fixture", epoch: 1 },
      intent: {
        opId: compiled.bundle.event.opId,
        intentDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(compiled.bundle.event))}`,
        summary: compiled.bundle.event.type,
      },
      events: [compiled.bundle.event],
      blobs: compiled.bundle.blobs,
    });
    const eventStore: EventStreamPort = {
      readHead: () => ({ revision: store.revision() }),
      readContentBlob: store.readContentObject,
      readBatch: (cursor, maxItems) => {
        const events = store.eventsAfter(Number(cursor ?? 0), maxItems);
        const revision = events.at(-1)?.workspaceRevision ?? Number(cursor ?? 0);
        return {
          sourceRevision: store.revision(),
          events,
          cursor: String(revision),
          done: revision === store.revision(),
          accessedItems: events.length,
          prefetchContent: (batch) =>
            new Map(
              batch.flatMap((event) =>
                contentClaims(event).map((claim) => [claim.sha256, store.readContentObject(claim.sha256)] as const),
              ),
            ),
        };
      },
    };
    const projection = makeTaskProjection({
      rootDir,
      eventStore,
      projectionPath: path.join(rootDir, "projection.sqlite"),
    });
    assert.equal(projection.rebuild().watermark, 1);
    assert.equal(projection.readDocument("people.yaml").document?.body, compiled.bundle.blobs[0].body);
    projection.close();
    store.close();
  });
});

test("a people.yaml blob whose roster genuinely differs from the event snapshot is still rejected", () => {
  withTempStore((rootDir) => {
    const store = openSqliteEventStore({ repoId: "people-roster", databasePath: path.join(rootDir, "ledger.sqlite") });
    const compiled = delegatedPeopleEvent("2026-10-02T20:45:42.000Z");
    assert.ok(compiled.bundle);
    store.appendCommand({
      fence: { repoId: "people-roster", holder: "fixture", epoch: 1 },
      intent: {
        opId: compiled.bundle.event.opId,
        intentDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(compiled.bundle.event))}`,
        summary: compiled.bundle.event.type,
      },
      events: [compiled.bundle.event],
      blobs: compiled.bundle.blobs,
    });
    // Same byte length, different roster: the content-addressed object no longer parses to
    // the event's roster snapshot, and the replay comparison must still refuse it.
    const claim = compiled.bundle.event.payload.peopleDocumentClaim,
      objectFile = objectPath(path.join(rootDir, "objects", "sha256"), claim.sha256);
    writeFileSync(objectFile, compiled.bundle.blobs[0].body.replace("Owner", "Owmer"));
    const eventStore: EventStreamPort = {
      readHead: () => ({ revision: store.revision() }),
      readContentBlob: store.readContentObject,
      readBatch: (cursor, maxItems) => {
        const events = store.eventsAfter(Number(cursor ?? 0), maxItems);
        const revision = events.at(-1)?.workspaceRevision ?? Number(cursor ?? 0);
        return {
          sourceRevision: store.revision(),
          events,
          cursor: String(revision),
          done: revision === store.revision(),
          accessedItems: events.length,
          prefetchContent: (batch) =>
            new Map(
              batch.flatMap((event) =>
                contentClaims(event).map((claim) => [claim.sha256, store.readContentObject(claim.sha256)] as const),
              ),
            ),
        };
      },
    };
    const projection = makeTaskProjection({
      rootDir,
      eventStore,
      projectionPath: path.join(rootDir, "projection.sqlite"),
    });
    assert.throws(() => projection.rebuild(), /does not match the event roster snapshot/u);
    projection.close();
    store.close();
  });
});
