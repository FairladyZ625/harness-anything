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
  // 138 → 136: people-set-role and people-bind were deleted by RBAC v2 S4 (dec_D60FAA451F24160E970323B6F3).
  // 136 → 138: daemon-service-install and daemon-service-uninstall (dec_089F1AE27C5DC0A3969062FE0D CH5).
  // RBAC v2 CH1 retires people-add and people-remove.
  assert.equal(actionDeclarations.length, 136);
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

test("fleet, repository, and EntityRef resources round-trip without widening scope", () => {
  const fleet = { kind: "fleet" } as const,
    repository = { kind: "repository", repoId: "canonical" } as const,
    entity = { kind: "entity", repoId: "canonical", entityRef: "task/task_123" } as const,
    encoded = [fleet, repository, entity].map(encodeAuthorizationResource);
  assert.deepEqual(encoded, ["@fleet", "canonical", "canonical:task/task_123"]);
  assert.deepEqual(encoded.map(decodeAuthorizationResource), [fleet, repository, entity]);
  // The fleet name is outside the repository id alphabet, so no repository can be registered under it.
  for (const invalid of ["", "@other", "Repo", "canonical:not-an-entity-ref", ":task/task_123"])
    assert.throws(() => decodeAuthorizationResource(invalid), invalid);
});
