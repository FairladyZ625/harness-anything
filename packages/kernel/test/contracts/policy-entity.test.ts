// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY, durablePolicyActions } from "../../src/domain/default-policy.ts";
import { parsePolicyDeclarationV1, validatePolicyDeclarationV1 } from "../../src/domain/policy.ts";
import { explainEntityKind } from "../../src/index.ts";

test("the built-in v5 Policy registers only qualification predicates and all durable Actions", () => {
  assert.deepEqual(validatePolicyDeclarationV1(DEFAULT_POLICY), []);
  assert.equal(DEFAULT_POLICY.version, 5);
  assert.deepEqual(DEFAULT_POLICY.actions, durablePolicyActions);
  assert.deepEqual(
    [
      ...new Set(
        (DEFAULT_POLICY.rules ?? []).flatMap((rule) =>
          rule.anyOf.flatMap((clause) => clause.allOf.map((predicate) => predicate.predicate)),
        ),
      ),
    ],
    ["hasRoleBinding", "hasDefaultBinding", "hasAssignmentBinding"],
  );
  assert.equal(DEFAULT_POLICY.rules?.length, 107);
});

test("ha entity explain policy exposes the same predicate, Action, and rule authority", () => {
  const explanation = explainEntityKind("policy");
  assert.deepEqual(explanation.policy, {
    predicates: ["hasRoleBinding", "hasDefaultBinding", "hasAssignmentBinding"],
    actions: DEFAULT_POLICY.actions,
    rules: DEFAULT_POLICY.rules,
  });
  assert.equal(explanation.documentSchema.id, "policy/v1");
  assert.equal(explanation.id.refTemplate, "policy/{id}");
});

test("policy schema rejects missing coverage and unknown or unused predicates", () => {
  const rules = DEFAULT_POLICY.rules ?? [];
  assert.match(
    validatePolicyDeclarationV1({ ...DEFAULT_POLICY, version: undefined }).join("\n"),
    /missing required field "version"/u,
  );
  assert.match(
    validatePolicyDeclarationV1({
      ...DEFAULT_POLICY,
      rules: rules.filter((rule) => rule.action !== "task-submit"),
    }).join("\n"),
    /every applicable Action/u,
  );
  assert.throws(
    () => parsePolicyDeclarationV1({ ...DEFAULT_POLICY, predicates: [{ predicate: "sameWriteSource" }] }),
    /predicate/u,
  );
  assert.match(
    validatePolicyDeclarationV1({
      ...DEFAULT_POLICY,
      predicates: [...DEFAULT_POLICY.predicates, { predicate: "hasRoleBinding", role: "unused-role" }],
    }).join("\n"),
    /must be used/u,
  );
});
