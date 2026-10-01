// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { actionDeclarations } from "../../src/index.ts";
import {
  assertAcyclicPolicyGroups,
  decodeAuthorizationResource,
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  encodeAuthorizationResource,
  minimumBasePolicyGroup,
  type PolicyGroup,
} from "../../src/domain/policy-groups.ts";
import type { ActionDeclaration } from "../../src/domain/action-declaration.ts";

test("every declaration has one minimum Base tier and one unique Keycloak scope", () => {
  assert.equal(actionDeclarations.length, 138);
  assert.equal(new Set(actionDeclarations.map((item) => item.policyAction)).size, actionDeclarations.length);
  for (const declaration of actionDeclarations) {
    assert.equal(declaration.policyAction, declaration.kind);
    assert.ok(["contributor", "maintainer", "admin"].includes(minimumBasePolicyGroup(declaration)));
  }
  const groups = deriveBasePolicyGroups();
  for (const declaration of actionDeclarations) {
    const matching = groups.filter((group) => group.scopes.includes(declaration.kind));
    assert.deepEqual(
      matching.map((group) => group.id),
      [declaration.policyTier],
    );
  }
});

test("Base composite inheritance expands monotonically without a handwritten action mirror", () => {
  const groups = deriveBasePolicyGroups(),
    effective = (id: string) => effectivePolicyGroupScopes(groups, id);
  assert.deepEqual(effective("viewer"), []);
  assert.equal(effective("contributor").length < effective("maintainer").length, true);
  assert.equal(effective("maintainer").length < effective("admin").length, true);
  assert.deepEqual(effective("admin"), actionDeclarations.map((item) => item.kind).sort());
});

test("a missing or unknown policy tier cannot silently leave the generated groups", () => {
  const invalid = { ...actionDeclarations[0], kind: "new-action", policyAction: "new-action", policyTier: undefined };
  assert.throws(
    () => deriveBasePolicyGroups([...actionDeclarations, invalid as unknown as ActionDeclaration]),
    /undefined/u,
  );
});

test("custom group inheritance accepts composition and rejects direct and transitive cycles", () => {
  const base = deriveBasePolicyGroups(),
    custom: PolicyGroup = { id: "release", base: false, scopes: ["task-submit"], composites: ["contributor"] };
  assert.ok(effectivePolicyGroupScopes([...base, custom], "release").includes("fact-record"));
  assert.throws(() => assertAcyclicPolicyGroups([{ ...custom, composites: ["release"] }]), /cycle/u);
  assert.throws(
    () =>
      assertAcyclicPolicyGroups([
        { ...custom, composites: ["audit"] },
        { id: "audit", base: false, scopes: [], composites: ["release"] },
      ]),
    /cycle/u,
  );
});

test("repository and EntityRef resources round-trip without widening entity scope", () => {
  const repository = { kind: "repository", repoId: "canonical" } as const,
    entity = { kind: "entity", repoId: "canonical", entityRef: "task/task_123" } as const;
  assert.deepEqual(decodeAuthorizationResource(encodeAuthorizationResource(repository)), repository);
  assert.deepEqual(decodeAuthorizationResource(encodeAuthorizationResource(entity)), entity);
  assert.notEqual(encodeAuthorizationResource(entity), encodeAuthorizationResource(repository));
});
