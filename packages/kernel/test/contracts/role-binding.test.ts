// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRoleBinding,
  projectDeclaredRoleBindings,
  roleBindingApplies,
  validateRoleBinding,
  type RoleBinding,
} from "../../src/domain/role-binding.ts";

const actor = {
  principal: { personId: "person_owner" },
  executor: { kind: "agent" as const, id: "implementer" },
};

test("declared roster roles project without expanding command classes", () => {
  const projected = projectDeclaredRoleBindings({
      actor,
      roleIds: ["owner"],
      target: "settings/repository",
    }),
    parsed = parseRoleBinding({
      actor: { kind: "person", id: "person_owner" },
      role: "arbiter",
      target: "decision/dec_declared",
      source: "declared",
      expiresAt: null,
    });
  assert.deepEqual(
    projected.map(({ role }) => role),
    ["owner"],
  );
  assert.ok(projected.every(({ source }) => source === "declared"));
  assert.deepEqual(Object.keys(projected[0]!).sort(), Object.keys(parsed).sort());
  assert.match(validateRoleBinding({ ...parsed, source: "derived" }).join("\n"), /source must be declared/u);
});

test("RoleBinding actor, target, and expiry are evaluated at the Policy cut", () => {
  const binding: RoleBinding = {
    actor: { kind: "person", id: actor.principal.personId },
    role: "repo-write",
    target: "settings/repository",
    source: "declared",
    expiresAt: "2026-09-01T00:00:00.000Z",
  };
  assert.equal(
    roleBindingApplies(binding, actor, "repo-write", ["settings/repository"], "2026-08-31T23:59:59.000Z"),
    true,
  );
  assert.equal(
    roleBindingApplies(binding, actor, "repo-write", ["settings/repository"], "2026-09-01T00:00:00.000Z"),
    false,
  );
  assert.equal(
    roleBindingApplies(binding, { ...actor, principal: { personId: "other" } }, "repo-write", ["settings/repository"]),
    false,
  );
});
