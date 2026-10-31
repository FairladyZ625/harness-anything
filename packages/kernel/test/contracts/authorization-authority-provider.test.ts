// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeWithAuthority,
  currentActionEnvelopeVersion,
  type AuthorizationAuthority,
  type AuthorizationDecision,
} from "../../src/index.ts";

const actor = { principal: { personId: "local-person" }, executor: null },
  cut = "canonical:local-provider" as const,
  action = {
    version: currentActionEnvelopeVersion,
    actionId: "local-provider-action",
    kind: "task-create",
    target: "settings/repository" as const,
    actor,
    authorizationRef: "local-policy@1",
    idempotencyKey: "local-provider-action",
  };

test("a non-Keycloak authority completes the provider-to-port authorization loop", async () => {
  const provider: AuthorizationAuthority = {
    evaluate: (request, context): AuthorizationDecision => ({
      policyRef: "local-policy@1",
      actor: request.actor,
      subject: request.target,
      bindingsUsed: [{ authority: "local", scope: request.kind }],
      outcome: "allowed",
      reasonCodes: ["local_allowed"],
      nextActions: [],
      evaluatedAtCut: context.evaluatedAtCut,
    }),
  };
  const evaluated = await authorizeWithAuthority(provider, action, { evaluatedAtCut: cut });
  assert.equal(evaluated.outcome, "allowed");
});
