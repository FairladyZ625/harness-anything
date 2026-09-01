// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  entityActionCriterionFailure,
  evaluatePersonActionCapability,
  getExecutableEntityAction,
  parsePeopleRosterDocument,
  personActionUsage,
} from "../../src/index.ts";
import { explainEntityKind } from "../../src/domain/entity-kind-registry.ts";

const roster = parsePeopleRosterDocument(
  `${JSON.stringify(
    {
      schema: "harness-people/v1",
      people: [
        {
          personId: "person_owner",
          displayName: "Owner",
          roles: ["owner"],
          credentials: [],
        },
      ],
      roles: [{ roleId: "owner", commandClasses: ["admin"] }],
    },
    null,
    2,
  )}\n`,
);

test("Person declares all six executable People Action contracts", () => {
  const explanation = explainEntityKind("person"),
    delegate = getExecutableEntityAction("people-delegate"),
    revoke = getExecutableEntityAction("people-revoke-delegation");
  assert.deepEqual(explanation.transitions.available, [
    "add",
    "set-role",
    "bind",
    "delegate",
    "revoke-delegation",
    "remove",
  ]);
  assert.equal(delegate?.execution?.implementation, "catalog-runtime");
  assert.equal(revoke?.execution?.implementation, "catalog-runtime");
  assert.equal(delegate?.concurrency.expectedVersion.arbitration, "center-single-write-queue");
  assert.equal(delegate?.concurrency.artifactOwnership.repositoryDocument, "people.yaml");
  assert.match(personActionUsage(delegate!), /^ha people delegate /u);
});

test("Person capability evaluation preserves exact criterion identities", () => {
  const add = getExecutableEntityAction("people-add"),
    remove = getExecutableEntityAction("people-remove");
  assert.ok(add && remove);
  const addEvaluation = evaluatePersonActionCapability({
      action: add,
      roster,
      personId: "person_owner",
      actorPersonId: "person_owner",
      evaluatedAt: "2026-09-01T00:00:00.000Z",
    }),
    removeEvaluation = evaluatePersonActionCapability({
      action: remove,
      roster,
      personId: "person_owner",
      actorPersonId: "person_owner",
      evaluatedAt: "2026-09-01T00:00:00.000Z",
    });
  assert.deepEqual(
    addEvaluation.map(({ criterionRef, status }) => ({ criterionRef, status })),
    [
      { criterionRef: "people-roster/add.input", status: "invocation-required" },
      { criterionRef: "people-roster/add.invariants", status: "unmet" },
    ],
  );
  assert.equal(removeEvaluation[0]?.status, "met");
  assert.equal(removeEvaluation[1]?.criterionRef, "people-roster/remove.invariants");
  assert.equal(removeEvaluation[1]?.status, "unmet");
  assert.match(removeEvaluation[1]?.nextActions[0] ?? "", /bootstrap creator/u);
});

test("Person compiler attributes an invariant rejection without failure-code lookup", () => {
  const compile = getExecutableEntityAction("people-remove")?.execution?.compile;
  assert.ok(compile);
  assert.throws(
    () =>
      compile({
        action: { personId: "person_owner" },
        actor: { principal: { personId: "person_owner" }, executor: null },
        source: "local",
        session: { kind: "unavailable", reason: "contract-test" },
        opId: "person-remove-contract",
        occurredAt: "2026-09-01T00:00:00.000Z",
        workspaceRevision: 2,
        currentDocumentBody: JSON.stringify(roster),
      }),
    (error: unknown) => {
      const failure = entityActionCriterionFailure(error);
      assert.equal(failure?.actionId, "remove");
      assert.equal(failure?.criterionRef, "people-roster/remove.invariants");
      assert.match(failure?.nextActions[0] ?? "", /bootstrap creator person_owner.*ha people remove/u);
      assert.match(failure?.nextActions[0] ?? "", /--person-id person_owner/u);
      return true;
    },
  );
});
