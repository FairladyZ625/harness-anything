// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { currentActionEnvelopeVersion } from "../../src/domain/action-envelope.ts";
import { DEFAULT_POLICY } from "../../src/domain/default-policy.ts";
import {
  deriveRoleBindings,
  parseRoleBinding,
  roleBindingApplies,
  validateRoleBinding,
  type RoleBinding,
} from "../../src/domain/role-binding.ts";
import { evaluateAuthorization } from "../../src/ports/authorization-port.ts";

const implementer = {
    principal: { personId: "person_owner" },
    executor: { kind: "agent" as const, id: "implementer" },
  },
  reviewer = {
    principal: implementer.principal,
    executor: { kind: "agent" as const, id: "reviewer" },
  };

test("derived and declared RoleBindings share one closed contract", () => {
  const [derived] = deriveRoleBindings({
      actor: implementer,
      roleIds: ["owner"],
      roleDeclarations: [{ roleId: "owner", commandClasses: ["repo-write"] }],
      target: "settings/repository",
    }),
    declared = parseRoleBinding({
      actor: { kind: "person", id: "person_owner" },
      role: "arbiter",
      target: "decision/dec_declared",
      source: "declared",
      expiresAt: null,
    });
  assert.deepEqual(Object.keys(derived!).sort(), Object.keys(declared).sort());
  assert.equal(derived?.source, "derived");
  assert.equal(declared.source, "declared");
  assert.deepEqual(validateRoleBinding({ ...declared, expiresAt: undefined }), [
    "RoleBinding expiresAt must be null or an ISO-8601 UTC timestamp ending in Z",
  ]);
});

test("Policy command-class predicates consume RoleBindings and reject a removed derived role", () => {
  const action = {
      version: currentActionEnvelopeVersion,
      actionId: "action-start",
      kind: "execution.start",
      target: "execution/execution-1" as const,
      actor: implementer,
      authorizationRef: `${DEFAULT_POLICY.id}@${DEFAULT_POLICY.version}`,
      idempotencyKey: "action-start",
    },
    roleBindings = deriveRoleBindings({
      actor: implementer,
      roleIds: ["owner"],
      roleDeclarations: [{ roleId: "owner", commandClasses: ["repo-write"] }],
      target: "settings/repository",
    }),
    authorize = (bindings: readonly RoleBinding[]) =>
      evaluateAuthorization(DEFAULT_POLICY, action, {
        roleBindings: bindings,
        roleBindingTargets: ["settings/repository"],
        target: {},
        evaluatedAtCut: "canonical:1",
      });
  assert.equal(authorize(roleBindings).outcome, "allowed");
  assert.equal(authorize(roleBindings.filter((binding) => binding.role !== "repo-write")).outcome, "denied");
});

test("nullable RoleBinding expiry is evaluated at the Policy cut", () => {
  const binding: RoleBinding = {
    actor: { kind: "person", id: implementer.principal.personId },
    role: "repo-write",
    target: "settings/repository",
    source: "declared",
    expiresAt: "2026-09-01T00:00:00.000Z",
  };
  assert.equal(
    roleBindingApplies(binding, implementer, "repo-write", ["settings/repository"], "2026-08-31T23:59:59.000Z"),
    true,
  );
  assert.equal(
    roleBindingApplies(binding, implementer, "repo-write", ["settings/repository"], "2026-09-01T00:00:00.000Z"),
    false,
  );
});

test("review independence level is a Policy parameter: L1 is executor-axis and L2 adds person-axis", () => {
  const roleBinding: RoleBinding = {
      actor: { kind: "person", id: reviewer.principal.personId },
      role: "arbiter",
      target: "settings/repository",
      source: "declared",
      expiresAt: null,
    },
    action = {
      version: currentActionEnvelopeVersion,
      actionId: "action-review",
      kind: "execution.review",
      target: "execution/execution-1" as const,
      actor: reviewer,
      authorizationRef: "review-level@1",
      idempotencyKey: "action-review",
    },
    policy = (level: "L1" | "L2") => ({
      schema: "policy/v1" as const,
      id: "review-level",
      version: 1,
      predicates: [
        { predicate: "hasCommandClass" as const, commandClass: "arbiter" },
        { predicate: "reviewIndependence" as const, level },
      ],
      actions: ["execution.review"],
      rules: [
        {
          action: "execution.review",
          anyOf: [
            {
              allOf: [
                { predicate: "hasCommandClass" as const, commandClass: "arbiter" },
                { predicate: "reviewIndependence" as const, level },
              ],
            },
          ],
        },
      ],
    }),
    context = {
      roleBindings: [roleBinding],
      roleBindingTargets: ["settings/repository" as const],
      target: { executionActor: implementer, runtimeBinding: null },
      evaluatedAtCut: "canonical:1",
    };
  assert.equal(evaluateAuthorization(policy("L1"), action, context).outcome, "allowed");
  assert.equal(evaluateAuthorization(policy("L2"), action, context).outcome, "denied");
});
