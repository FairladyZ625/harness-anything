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

test("people add and remove are the one deterministic roster transition catalog", () => {
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
    removed = applyPeopleRosterAction(added.body, {
      kind: "people-remove",
      personId: "person_alice",
    });

  assert.equal(added.action, "people-add");
  assert.deepEqual(parsePeopleRosterDocument(added.body).people[1]?.roles, ["dispatcher"]);
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
    aliceRoster = parsePeopleRosterDocument(alice.body),
    ownerWithoutAdmin = serializePeopleRosterDocument({
      ...aliceRoster,
      roles: aliceRoster.roles.map((role) =>
        role.roleId === "owner" ? { ...role, commandClasses: ["repo-read"] } : role,
      ),
    });

  const rejected = [
    () => applyPeopleRosterAction(bootstrapped.body, { kind: "people-remove", personId: owner.personId }),
    () => applyPeopleRosterAction(ownerWithoutAdmin, { kind: "people-remove", personId: "person_alice" }),
  ];
  for (const transition of rejected)
    assert.throws(transition, (error) => {
      assert.equal((error as { code?: string }).code, "invalid_people_action");
      return true;
    });
});

test("removing a person removes the RoleBindings an existing roster declares for them", () => {
  const bootstrapped = applyPeopleRosterAction(null, {
      kind: "people-add",
      person: owner,
      rolePolicy: { roleId: "owner", commandClasses: ["admin"] },
    }),
    added = applyPeopleRosterAction(bootstrapped.body, {
      kind: "people-add",
      person: { ...owner, personId: "person_alice", displayName: "Alice", roles: ["reviewer"], credentials: [] },
      rolePolicy: { roleId: "reviewer", commandClasses: ["repo-read"] },
    }),
    binding = {
      actor: { kind: "person", id: "person_alice" },
      role: "arbiter",
      target: "settings/repository",
      source: "declared",
      expiresAt: null,
    } as const,
    bound = serializePeopleRosterDocument({ ...parsePeopleRosterDocument(added.body), bindings: [binding] });
  assert.deepEqual(parsePeopleRosterDocument(bound).bindings, [binding]);
  assert.equal(
    parsePeopleRosterDocument(applyPeopleRosterAction(bound, { kind: "people-remove", personId: "person_alice" }).body)
      .bindings.length,
    0,
  );
});

test("people delegate and revoke mutate the same roster without a token store", () => {
  const bootstrapped = applyPeopleRosterAction(null, {
      kind: "people-add",
      person: owner,
      rolePolicy: { roleId: "owner", commandClasses: ["admin"] },
    }),
    token = {
      schema: "delegated-execution-token/v1" as const,
      tokenId: "det_owner_runtime_1",
      issuer: { personId: owner.personId },
      delegate: { runtimeSessionId: "runtime_1" },
      allowedActions: ["execution.start"],
      issuedAt: "2026-08-27T02:00:00.000Z",
      expiresAt: "2026-08-27T03:00:00.000Z",
      revokedAt: null,
    },
    delegated = applyPeopleRosterAction(bootstrapped.body, { kind: "people-delegate", token }),
    revoked = applyPeopleRosterAction(delegated.body, {
      kind: "people-revoke-delegation",
      tokenId: token.tokenId,
      issuerPersonId: owner.personId,
      revokedAt: "2026-08-27T02:30:00.000Z",
    });
  assert.equal(delegated.action, "people-delegate");
  assert.deepEqual(parsePeopleRosterDocument(delegated.body).delegatedExecutionTokens, [token]);
  assert.equal(
    parsePeopleRosterDocument(revoked.body).delegatedExecutionTokens[0]?.revokedAt,
    "2026-08-27T02:30:00.000Z",
  );
  assert.throws(
    () =>
      applyPeopleRosterAction(delegated.body, {
        kind: "people-revoke-delegation",
        tokenId: token.tokenId,
        issuerPersonId: "person_other",
        revokedAt: "2026-08-27T02:30:00.000Z",
      }),
    /Only DelegatedExecutionToken issuer person_owner may revoke it/u,
  );
});
