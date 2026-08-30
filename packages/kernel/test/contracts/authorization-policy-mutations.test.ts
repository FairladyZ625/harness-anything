// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY } from "../../src/domain/default-policy.ts";
import type { PolicyDeclarationV1 } from "../../src/domain/policy.ts";
import { evaluateAuthorization } from "../../src/ports/authorization-port.ts";
import { currentActionEnvelopeVersion, type ActorIdentity, type AuthorizationContext } from "../../src/index.ts";

const actor: ActorIdentity = { principal: { personId: "mutation-actor" }, executor: null };

function evaluate(policy: PolicyDeclarationV1, kind: string, context: AuthorizationContext) {
  return evaluateAuthorization(
    policy,
    {
      version: currentActionEnvelopeVersion,
      actionId: `mutation-${kind}`,
      kind,
      target: "settings/repository",
      actor,
      authorizationRef: `${policy.id}@${policy.version}`,
      idempotencyKey: `mutation-${kind}`,
    },
    context,
  );
}

function roleContext(role: string): AuthorizationContext {
  return {
    roleBindings: [
      {
        actor: { kind: "person", id: actor.principal.personId },
        role,
        target: "settings/repository",
        source: "declared",
        expiresAt: null,
      },
    ],
    roleBindingTargets: ["settings/repository"],
    target: {},
    evaluatedAtCut: "canonical:mutation",
  };
}

test("every durable rule has a positive RoleBinding oracle", () => {
  for (const rule of DEFAULT_POLICY.rules ?? []) {
    const role = rule.anyOf
      .flatMap((clause) => clause.allOf)
      .find((predicate) => predicate.predicate === "hasRoleBinding" && predicate.role !== "owner");
    assert.ok(role && role.predicate === "hasRoleBinding", rule.action);
    assert.equal(evaluate(DEFAULT_POLICY, rule.action, roleContext(role.role)).outcome, "allowed", rule.action);
  }
});

test("deleting any durable rule is observed as a Policy denial", async (t) => {
  for (const [index, rule] of (DEFAULT_POLICY.rules ?? []).entries())
    await t.test(rule.action, () => {
      const rules = [...(DEFAULT_POLICY.rules ?? [])];
      rules.splice(index, 1);
      const mutant = {
        ...structuredClone(DEFAULT_POLICY),
        actions: DEFAULT_POLICY.actions.filter((item) => item !== rule.action),
        rules,
      };
      const denied = evaluate(mutant, rule.action, roleContext("owner"));
      assert.equal(denied.outcome, "denied");
      assert.ok(denied.reasonCodes.includes("policy_rule_missing"));
    });
});

test("changing a required role is killed without changing lease or state criteria", () => {
  const rules = (DEFAULT_POLICY.rules ?? []).map((rule) =>
    rule.action === "task-submit"
      ? { ...rule, anyOf: [{ allOf: [{ predicate: "hasRoleBinding" as const, role: "impossible-role" }] }] }
      : rule,
  );
  assert.equal(
    evaluate({ ...structuredClone(DEFAULT_POLICY), rules }, "task-submit", roleContext("repo-write")).outcome,
    "denied",
  );
});
