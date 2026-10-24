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
  // dec_F01770FD0DCF72683B7C4C7A47/CH4: permission request lifecycle actions are durable host actions;
  // keep this count aligned with the protocol and G0-2 inventories.
  // dec_DBF9CCB96B1A7D35A3214615E1 CH2/CH6: explicit handoff export, claim and revoke.
  // dec_4190D5EA63D9DD208CE946F133 / dec_5EC2631352B17EE2BF4979E37E: four Task GateRun actions.
  // dec_2AAF1D0612D3295C80F87E49FE CH1: daemon-mediated task branch publication.
  // dec_12A87C0F08E4B8304C4BC25BA7/CH1,CH4: runtime steering is a canonical authorized action.
  // dec_4C06F7F902E91C4210020A9E75/CH2 retires task-ci; dec_FC266F3F44CD241481B7066540/CH1 authorizes six Decisions Provider actions.
  // Owner 2026-10-21 (W2, dec_E369B8616F50A6208B293997E7) deletes task-pr: PRs and CI waits move to worker skill scripts.
  // Owner 2026-10-21 B3 (task_8ebc730e board) deletes code-doc reconcile/repoint with the whole mechanism.
  // Owner 2026-10-23 (task_45b896d2) makes assign/unassign generic Actions for every assignable Entity kind;
  // the durable policy inventory therefore grows from the prior 154 to 165.
  assert.equal(durablePolicyActions.length, 165);
  assert.equal(durablePolicyActions.includes("task-code-doc-reconcile"), false);
  assert.equal(durablePolicyActions.includes("task-code-doc-repoint"), false);
  assert.equal(durablePolicyActions.includes("ci-observe-pull"), false);
  assert.equal(durablePolicyActions.includes("task-ci"), false);
  assert.equal(durablePolicyActions.includes("task-push"), true);
  assert.equal(durablePolicyActions.includes("task-pr"), false);
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
