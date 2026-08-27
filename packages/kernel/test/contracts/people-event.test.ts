// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPeopleEventInputs,
  compilePeopleRosterActionEvent,
  validatePeopleEvent,
} from "../../src/domain/people-event.ts";

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
  assert.throws(
    () =>
      assertPeopleEventInputs(compiled.bundle!.event, compiled.bundle!.plan, [
        {
          ...compiled.bundle!.blobs[0],
          body: `${compiled.bundle!.blobs[0].body} `,
        },
      ]),
    /must be exact/u,
  );
});
