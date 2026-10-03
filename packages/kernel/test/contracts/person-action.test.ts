// harness-test-tier: contract
import { compileExecutionDelegation } from "../../src/domain/execution-delegation.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { getExecutableEntityAction, personActionUsage } from "../../src/index.ts";
import { explainEntityKind } from "../../src/domain/entity-kind-registry.ts";
import {
  validateExecutionDelegationEvent,
  validateCurrentExecutionDelegationEvent,
} from "../../src/domain/execution-delegation-event.ts";

const now = "2026-09-19T10:00:00.000Z",
  issuer = { principal: { personId: "person_owner" }, executor: null },
  input = {
    action: {
      tokenId: "det_contract",
      runtimeSessionId: "runtime-contract",
      action: ["task-amend"],
      expiresAt: "2026-09-19T11:00:00.000Z",
    },
    actor: issuer,
    source: "local" as const,
    session: { kind: "unavailable" as const, reason: "contract" },
    opId: "contract-issue",
    occurredAt: now,
    workspaceRevision: 1,
    currentEntity: { repoId: "contract", records: [] },
  };

test("Person exposes center private delegation and retires roster mutations", () => {
  assert.deepEqual(explainEntityKind("person").transitions.available, ["delegate", "revoke-delegation"]);
  assert.equal(getExecutableEntityAction("people-add"), undefined);
  assert.equal(getExecutableEntityAction("people-remove"), undefined);
  const delegate = getExecutableEntityAction("people-delegate");
  assert.ok(delegate);
  assert.equal(delegate.concurrency.expectedVersion.arbitration, "center-single-write-queue");
  assert.equal(delegate.concurrency.artifactOwnership.record, "execution-delegations/v1");
  assert.match(personActionUsage(delegate), /^ha people delegate /u);
});

test("delegation compiler binds issuer, source, runtime and expiry and rejects reuse", () => {
  const issued = compileExecutionDelegation("delegate", input),
    state = { repoId: "contract", records: [issued.record] };
  assert.equal(issued.record.token.issuer.personId, "person_owner");
  assert.equal(issued.record.token.delegate.runtimeSessionId, "runtime-contract");
  assert.throws(() => compileExecutionDelegation("delegate", { ...input, currentEntity: state }), /already exists/u);
  assert.throws(
    () => compileExecutionDelegation("delegate", { ...input, action: { ...input.action, expiresAt: now } }),
    /later than/u,
  );
  const revoke = { ...input, action: { tokenId: "det_contract" }, currentEntity: state };
  assert.throws(
    () =>
      compileExecutionDelegation("revoke-delegation", {
        ...revoke,
        actor: { principal: { personId: "other" }, executor: null },
      }),
    /issuing principal/u,
  );
  assert.throws(
    () =>
      compileExecutionDelegation("revoke-delegation", {
        ...revoke,
        source: { kind: "assignment", nodeId: "node", assignmentId: "assignment" },
      }),
    /source/u,
  );
  const revoked = compileExecutionDelegation("revoke-delegation", revoke);
  assert.equal(revoked.record.token.revokedAt, now);
  assert.equal(
    compileExecutionDelegation("revoke-delegation", {
      ...revoke,
      currentEntity: { ...state, records: [revoked.record] },
    }).changed,
    false,
  );
});

test("audit event rejects capability data so the ledger cannot become an authorization store", () => {
  const event = {
    schema: "execution-delegation-event/v1",
    type: "execution_delegation_changed",
    eventId: "event-contract",
    opId: "contract",
    workspaceRevision: 1,
    actor: issuer,
    source: "local",
    occurredAt: now,
    payload: { tokenId: "det_contract", operation: "issue" },
  };
  assert.deepEqual(validateExecutionDelegationEvent(event), []);
  assert.deepEqual(validateCurrentExecutionDelegationEvent(event), []);
  const capability = { ...event, payload: { ...event.payload, allowedActions: ["task-amend"] } };
  assert.deepEqual(validateExecutionDelegationEvent(capability), [], "historical envelopes remain readable");
  assert.ok(validateCurrentExecutionDelegationEvent(capability).length, "new writes cannot store capability data");
});
