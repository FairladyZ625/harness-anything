// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseCanonicalEvent,
  serializePersistedCanonicalEvent,
  validateCurrentCanonicalEvent,
} from "../../src/domain/doc-sync-canonical-events.ts";
import { validateRetiredPeopleEvent } from "../../src/domain/people-event.ts";

const body = readFileSync(
  new URL("../../fixtures/canonical-events/people-event-v1/accepted.json", import.meta.url),
  "utf8",
);
test("frozen People audit bytes remain readable and cannot enter current admission", () => {
  const event = parseCanonicalEvent(body);
  assert.equal(event.schema, "people-event/v1");
  assert.equal(event.workspaceRevision, 39905);
  assert.equal(serializePersistedCanonicalEvent(event), body);
  assert.notEqual(validateCurrentCanonicalEvent(event).length, 0);
});
test("retired audit decoding still validates the envelope and document claim", () => {
  const event = JSON.parse(body);
  for (const invalid of [
    { ...event, actor: null },
    { ...event, payload: null },
    {
      ...event,
      payload: { ...event.payload, peopleDocumentClaim: { ...event.payload.peopleDocumentClaim, sha256: "wrong" } },
    },
  ])
    assert.notEqual(validateRetiredPeopleEvent(invalid).length, 0);
});
