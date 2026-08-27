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
  const bootstrapped = applyPeopleRosterAction(null, {
      kind: "people-add",
      person: owner,
      rolePolicy: { roleId: "owner", commandClasses: ["admin"] },
    }),
    added = applyPeopleRosterAction(bootstrapped.body, {
      kind: "people-add",
      person: { ...owner, personId: "person_alice", displayName: "Alice", roles: ["dispatcher"], credentials: [] },
      rolePolicy: { roleId: "dispatcher", commandClasses: ["repo-write"] },
    }),
    changed = applyPeopleRosterAction(added.body, {
      kind: "people-set-role",
      personId: "person_alice",
      rolePolicy: {
        roleId: "reviewer",
        commandClasses: ["repo-read"],
      },
    }),
    removed = applyPeopleRosterAction(changed.body, {
      kind: "people-remove",
      personId: "person_alice",
    });

  assert.equal(added.action, "people-add");
  assert.deepEqual(parsePeopleRosterDocument(changed.body).people[1]?.roles, ["reviewer"]);
  assert.deepEqual(parsePeopleRosterDocument(removed.body).people, [owner]);
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
        person: { ...owner, personId: "person_other", displayName: "Other", roles: ["reviewer"] },
        rolePolicy: { roleId: "reviewer", commandClasses: ["repo-read"] },
      }),
    /duplicate credential binding/u,
  );
});

test("roster transitions preserve the bootstrap owner and an enabled admin", () => {
  const bootstrapped = applyPeopleRosterAction(null, {
      kind: "people-add",
      person: owner,
      rolePolicy: { roleId: "owner", commandClasses: ["admin"] },
    }),
    alice = applyPeopleRosterAction(bootstrapped.body, {
      kind: "people-add",
      person: { ...owner, personId: "person_alice", displayName: "Alice", roles: ["admin"], credentials: [] },
      rolePolicy: { roleId: "admin", commandClasses: ["admin"] },
    }),
    ownerWithoutAdmin = applyPeopleRosterAction(alice.body, {
      kind: "people-set-role",
      personId: owner.personId,
      rolePolicy: { roleId: "owner", commandClasses: ["repo-read"] },
    });

  const rejected = [
    () =>
      applyPeopleRosterAction(bootstrapped.body, {
        kind: "people-set-role",
        personId: owner.personId,
        rolePolicy: { roleId: "reviewer", commandClasses: ["repo-read"] },
      }),
    () =>
      applyPeopleRosterAction(alice.body, {
        kind: "people-set-role",
        personId: "person_alice",
        rolePolicy: { roleId: "owner", commandClasses: ["admin"] },
      }),
    () => applyPeopleRosterAction(bootstrapped.body, { kind: "people-remove", personId: owner.personId }),
    () => applyPeopleRosterAction(ownerWithoutAdmin.body, { kind: "people-remove", personId: "person_alice" }),
  ];
  for (const transition of rejected)
    assert.throws(transition, (error) => {
      assert.equal((error as { code?: string }).code, "invalid_people_action");
      return true;
    });
});
