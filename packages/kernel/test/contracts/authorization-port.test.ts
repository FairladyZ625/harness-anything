// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { durablePolicyActions } from "../../src/domain/action-declaration.ts";
import { authorizationPort } from "../../src/ports/authorization-port.ts";
import { currentActionEnvelopeVersion, type AuthorizationDecision } from "../../src/index.ts";

const actor = { principal: { personId: "person-authorized" }, executor: null },
  cut = "canonical:17";
function action(kind: string) {
  return {
    version: currentActionEnvelopeVersion,
    actionId: `action-${kind}`,
    kind,
    target: "settings/repository" as const,
    actor,
    authorizationRef: "keycloak-policy@1",
    idempotencyKey: kind,
  };
}
function decision(kind: string): AuthorizationDecision {
  return {
    policyRef: "keycloak-policy@1",
    actor,
    subject: "settings/repository",
    outcome: "allowed",
    bindingsUsed: [{ authority: "keycloak", scope: kind }],
    reasonCodes: ["keycloak_allowed"],
    nextActions: [],
    evaluatedAtCut: cut,
  };
}
test("retired People mutations are absent from the durable authorization inventory", () => {
  // dec_CDDCFA8BB91A47BCE07B229E93 CH2.
  // dec_DBF9CCB96B1A7D35A3214615E1 CH2/CH6: explicit handoff export, claim and revoke.
  assert.equal(durablePolicyActions.length, 142);
  assert.equal(durablePolicyActions.includes("people-add"), false);
  assert.equal(durablePolicyActions.includes("people-remove"), false);
});
test("every durable action requires a matching authority decision", () => {
  assert.equal(new Set(durablePolicyActions).size, durablePolicyActions.length);
  for (const kind of durablePolicyActions) {
    assert.equal(authorizationPort.authorize(action(kind), { evaluatedAtCut: cut }).outcome, "denied");
    assert.equal(
      authorizationPort.authorize(action(kind), { decision: decision(kind), evaluatedAtCut: cut }).outcome,
      "allowed",
    );
  }
});
test("an authority decision cannot cross actor, action, target or write cut", () => {
  const request = action("task-create"),
    allowed = decision(request.kind);
  for (const candidate of [
    { ...allowed, policyRef: "default@5" },
    { ...allowed, actor: { principal: { personId: "another" }, executor: null } },
    { ...allowed, actor: { principal: actor.principal, executor: { kind: "agent" as const, id: "another-runtime" } } },
    { ...allowed, subject: "task/other" as const },
    { ...allowed, evaluatedAtCut: "canonical:16" },
    { ...allowed, bindingsUsed: [{ scope: "task-delete" }] },
  ])
    assert.equal(authorizationPort.authorize(request, { decision: candidate, evaluatedAtCut: cut }).outcome, "denied");
  const denied = { ...allowed, outcome: "denied" as const, reasonCodes: ["keycloak_denied"] };
  assert.deepEqual(authorizationPort.authorize(request, { decision: denied, evaluatedAtCut: cut }), denied);
});
