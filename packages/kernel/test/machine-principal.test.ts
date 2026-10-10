// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { samePrincipal } from "../src/domain/actor-identity.ts";
import { isSameExecution } from "../src/domain/actor-domain-services.ts";
import { sameActorIdentity, validateActorIdentity } from "../src/domain/write-chain.contract.ts";
const principal = { kind: "machine", nodeId: "compute-a", subject: "service-account-a" } as const;
const machine = { principal, executor: null };
// dec_2665E58BA5AE42E37793193748/CH1: machine identity never aliases a person.
test("typed machine identity keeps person and machine equality separate", () => {
  assert.deepEqual(validateActorIdentity(machine), []);
  assert.equal(samePrincipal(machine.principal, { personId: principal.subject }), false);
  assert.equal(isSameExecution(machine, machine), true);
  for (const other of [
    { principal: { ...principal, subject: "other" }, executor: null },
    { principal: { ...principal, nodeId: "other" }, executor: null },
    { principal: { personId: principal.subject }, executor: null },
  ]) {
    assert.equal(isSameExecution(machine, other), false);
    assert.equal(sameActorIdentity(machine, other), false);
  }
  assert.notDeepEqual(validateActorIdentity({ ...machine, principal: { ...principal, personId: "owner" } }), []);
  assert.notDeepEqual(validateActorIdentity({ ...machine, principal: { kind: "machine", nodeId: "a" } }), []);
});
