// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  assignSampleFileNames,
  canonicalEventShape,
  deidentifyCanonicalEvent,
  payloadKeySet,
} from "../sample-canonical-events.mjs";

test("canonical sampler distinguishes nested payload-key shapes", () => {
  const migrated = {
      schema: "relation-event/v1",
      type: "relation_created",
      payload: { relation: { relation_id: "rel_fixture", targetObservedVersion: null } },
    },
    historical = {
      ...migrated,
      payload: { relation: { relation_id: "rel_fixture", strength: "strong" } },
    };

  assert.deepEqual(payloadKeySet(migrated.payload), [
    "relation",
    "relation.relation_id",
    "relation.targetObservedVersion",
  ]);
  assert.notDeepEqual(canonicalEventShape(migrated), canonicalEventShape(historical));
});

test("canonical sampler de-identifies people, prose, email, and local paths without changing keys", () => {
  const event = {
      schema: "fact-event/v1",
      type: "fact_recorded",
      actor: { principal: { personId: "person-private" }, executor: null },
      payload: {
        evidenceSource: "Sent by private@example.com from /Users/private/report.txt",
        factsDocumentClaim: { path: "tasks/task_123-private-slug/facts.md" },
        provenance: [{ sessionId: "transport:person-private" }],
        statement: "Private observation",
      },
    },
    scrubbed = deidentifyCanonicalEvent(event);

  assert.deepEqual(payloadKeySet(scrubbed.payload), payloadKeySet(event.payload));
  assert.equal(scrubbed.actor.principal.personId, "person-fixture");
  assert.equal(scrubbed.payload.statement, "Fixture statement");
  assert.equal(scrubbed.payload.evidenceSource, "Fixture evidence source");
  assert.equal(scrubbed.payload.provenance[0].sessionId, "transport:person-fixture");
  assert.equal(scrubbed.payload.factsDocumentClaim.path, "tasks/task_123-fixture/facts.md");
  assert.doesNotMatch(JSON.stringify(scrubbed), /private|\/Users/u);
});

test("canonical sampler assigns one conventional accepted file and stable shape names", () => {
  const samples = [
    { schema: "task-event/v1", type: "task_amended", payloadKeys: ["task"] },
    { schema: "task-event/v1", type: "task_completed", payloadKeys: ["execution", "task"] },
    { schema: "fact-event/v1", type: "fact_recorded", payloadKeys: ["statement"] },
  ];

  const names = assignSampleFileNames(samples).map(({ fileName }) => fileName);
  assert.equal(names[0], "accepted.json");
  assert.match(names[1], /^accepted-task-completed-[0-9a-f]{12}\.json$/u);
  assert.equal(names[2], "accepted.json");
});
