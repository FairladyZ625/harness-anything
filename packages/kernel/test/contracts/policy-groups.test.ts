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
  // dec_CDDCFA8BB91A47BCE07B229E93 CH2 adds two maintainer actions.
  // F-8E80EE50: independently revocable repository reads belong to viewer.
  // dec_DBF9CCB96B1A7D35A3214615E1 CH2/CH6: the three handoff actions are owner-approved.
  // dec_4190D5EA63D9DD208CE946F133 / dec_5EC2631352B17EE2BF4979E37E: four Task GateRun actions.
  // dec_F01770FD0DCF72683B7C4C7A47/CH4: permission request lifecycle adds three host actions.
  // dec_12A87C0F08E4B8304C4BC25BA7/CH1,CH4: runtime steering is a canonical action declaration.
  // dec_4C06F7F902E91C4210020A9E75/CH2 retires task-ci; dec_FC266F3F44CD241481B7066540/CH1 authorizes six Decisions Provider actions.
  // Owner 2026-10-21 (W2, dec_E369B8616F50A6208B293997E7) deletes task-pr: PRs and CI waits move to the worker's gh.
  // Owner 2026-10-21 B3 (task_8ebc730e board) deletes task-code-doc-reconcile/repoint with the mechanism.
  // Owner 2026-10-23 (task_45b896d2) makes assign/unassign generic Actions for every assignable Entity kind;
  // the declaration inventory therefore grows from the prior 155 to 167; the two 2026-10-24
  // deletions (decision-supersede, task-adjudicate) land it at 165.
  // task_90599b2e80d7db778e96419a2f (agenda B15) adds runtime-incident-dismiss: the owner's explicit close of an incident receipt.
  // Owner 2026-10-24 (task_a242ec14) deletes decision-supersede: supersede is driven by the relation.
  // dec_E369B8616F50A6208B293997E7/CH5 (W2-2) deletes task-adjudicate with the manual forward/return commands.
  assert.equal(actionDeclarations.length, 165);
  assert.equal(
    actionDeclarations.some(
      ({ kind }) => kind === "ci-observe-pull" || kind === "task-ci" || kind.startsWith("task-code-doc-"),
    ),
    false,
  );
  assert.equal(new Set(actionDeclarations.map((item) => item.policyAction)).size, actionDeclarations.length);
  for (const declaration of actionDeclarations) {
    assert.equal(declaration.policyAction, declaration.kind);
    assert.ok(["viewer", "contributor", "maintainer", "admin"].includes(minimumBasePolicyGroup(declaration)));
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
  assert.deepEqual(effective("viewer"), ["repository-read"]);
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
