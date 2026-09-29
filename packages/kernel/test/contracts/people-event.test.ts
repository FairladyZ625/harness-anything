// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPeopleEventInputs,
  compilePeopleRosterActionEvent,
  validatePeopleEvent,
} from "../../src/domain/people-event.ts";
import { assertContentInputs } from "../../src/store/task-event-store-validation.ts";

test("people_changed carries the Action result, parent CAS, exact blob, and frozen write plan", () => {
  const compiled = compilePeopleRosterActionEvent({
    currentBody: null,
    action: {
      kind: "people-add",
      person: {
        personId: "person_owner",
        displayName: "Owner",
        roles: ["owner"],
        credentials: [],
      },
      rolePolicy: { roleId: "owner", commandClasses: ["admin"] },
    },
    eventId: "event-people-1",
    opId: "op-people-1",
    workspaceRevision: 1,
    actor: { principal: { personId: "person_owner" }, executor: null },
    source: "local",
    occurredAt: "2026-08-27T01:00:00.000Z",
  });
  assert.ok(compiled.bundle);
  assert.deepEqual(validatePeopleEvent(compiled.bundle.event), []);
  assert.equal(compiled.bundle.event.payload.baseDocumentSha256, null);
  assert.doesNotThrow(() =>
    assertPeopleEventInputs(compiled.bundle!.event, compiled.bundle!.plan, compiled.bundle!.blobs),
  );
  // Blob bytes are verified once, at the store boundary: a body that disagrees with its claim's SHA is
  // rejected there (assertContentInputs), not by a second hash inside the domain assertion.
  assert.throws(
    () =>
      assertContentInputs(
        [compiled.bundle!.event.payload.peopleDocumentClaim],
        [
          {
            ...compiled.bundle!.blobs[0],
            body: `${compiled.bundle!.blobs[0].body} `,
          },
        ],
        "people",
      ),
    /content inputs must exactly match/u,
  );
});

test("people_changed derives its roster snapshot from the canonical blob", () => {
  const sourceBody = `${JSON.stringify({
    schema: "harness-people/v1",
    people: [
      {
        personId: "person_owner",
        displayName: "Owner",
        roles: ["owner"],
        credentials: [],
        presentationOnly: "must not enter the canonical roster",
      },
    ],
    roles: [{ roleId: "owner", commandClasses: ["admin"] }],
  })}\n`;
  const compiled = compilePeopleRosterActionEvent({
    currentBody: sourceBody,
    action: {
      kind: "people-delegate",
      token: {
        schema: "delegated-execution-token/v1",
        tokenId: "det_owner_runtime_1",
        issuer: { personId: "person_owner" },
        delegate: { runtimeSessionId: "runtime_1" },
        allowedActions: ["execution.start"],
        issuedAt: "2026-08-27T01:00:00.000Z",
        expiresAt: "2026-08-27T02:00:00.000Z",
        revokedAt: null,
      },
    },
    eventId: "event-people-delegate-1",
    opId: "op-people-delegate-1",
    workspaceRevision: 2,
    actor: { principal: { personId: "person_owner" }, executor: null },
    source: "local",
    occurredAt: "2026-08-27T01:00:00.000Z",
  });

  assert.ok(compiled.bundle);
  assert.doesNotThrow(() =>
    assertPeopleEventInputs(compiled.bundle!.event, compiled.bundle!.plan, compiled.bundle!.blobs),
  );
});
