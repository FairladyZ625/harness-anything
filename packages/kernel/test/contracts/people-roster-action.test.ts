// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPeopleRosterAction,
  parsePeopleRosterDocument,
  serializePeopleRosterDocument,
} from "../../src/domain/people-roster.ts";

const owner = {
  personId: "person_owner",
  displayName: "Owner",
  roles: ["owner"],
  credentials: [
    {
      kind: "email-address" as const,
      issuer: "example.invalid",
      subject: "owner@example.invalid",
    },
  ],
};

test("people add, set-role, and remove are the one deterministic roster transition catalog", () => {
  const added = applyPeopleRosterAction(null, {
      kind: "people-add",
      person: owner,
      rolePolicy: { roleId: "owner", commandClasses: ["admin"] },
    }),
    changed = applyPeopleRosterAction(added.body, {
      kind: "people-set-role",
      personId: owner.personId,
      rolePolicy: {
        roleId: "dispatcher",
        commandClasses: ["repo-write", "repo-read"],
      },
    }),
    removed = applyPeopleRosterAction(changed.body, {
      kind: "people-remove",
      personId: owner.personId,
    });

  assert.equal(added.action, "people-add");
  assert.deepEqual(parsePeopleRosterDocument(changed.body).people[0]?.roles, ["dispatcher"]);
  assert.deepEqual(parsePeopleRosterDocument(removed.body).people, []);
});

test("manual YAML and Action JSON normalize to the same daemon-readable roster", () => {
  const manual = [
      "schema: harness-people/v1",
      "people:",
      "  - personId: person_owner",
      "    displayName: Owner",
      "    roles: [owner]",
      "    credentials:",
      "      - kind: email-address",
      "        issuer: example.invalid",
      "        subject: owner@example.invalid",
      "roles:",
      "  - roleId: owner",
      "    commandClasses: [admin]",
      "",
    ].join("\n"),
    action = applyPeopleRosterAction(null, {
      kind: "people-add",
      person: owner,
      rolePolicy: { roleId: "owner", commandClasses: ["admin"] },
    });
  assert.deepEqual(parsePeopleRosterDocument(manual), parsePeopleRosterDocument(action.body));
  assert.equal(serializePeopleRosterDocument(parsePeopleRosterDocument(manual)), action.body);
});

test("roster predicates reject dangling roles and duplicate credential principals", () => {
  assert.throws(
    () =>
      applyPeopleRosterAction(null, {
        kind: "people-add",
        person: { ...owner, roles: ["missing"] },
      }),
    /references unknown role missing/u,
  );
  const first = applyPeopleRosterAction(null, {
    kind: "people-add",
    person: owner,
    rolePolicy: { roleId: "owner", commandClasses: ["admin"] },
  });
  assert.throws(
    () =>
      applyPeopleRosterAction(first.body, {
        kind: "people-add",
        person: { ...owner, personId: "person_other", displayName: "Other" },
      }),
    /duplicate credential binding/u,
  );
});
