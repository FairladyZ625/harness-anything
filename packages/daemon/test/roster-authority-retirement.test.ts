// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";

test("repository writes require online Keycloak authority even with an owner roster binding", async () => {
  const actor = { principal: { personId: "person_owner" }, executor: null },
    binding = {
      actor,
      source: "local" as const,
      roleBindings: [
        {
          actor: { kind: "person", id: "person_owner" },
          role: "owner",
          target: "settings/repository",
          source: "declared",
          expiresAt: null,
        },
      ],
    };
  for (const candidate of [binding, { actor, source: "local" as const }]) {
    const decision = await evaluateRepoCellAction({
      action: { kind: "task-create" },
      binding: candidate,
      actionId: "retired-roster",
      repoId: "repo",
      revision: 1,
      now: "2026-10-02T04:00:00.000Z",
    });
    assert.equal(decision.outcome, "denied");
    assert.ok(decision.reasonCodes.includes("authentication_required"));
  }
});

test("a supplied authorization receipt is not a substitute for online authority", async () => {
  const actor = { principal: { personId: "person_owner" }, executor: null };
  const decision = await evaluateRepoCellAction({
    action: { kind: "task-create" },
    binding: {
      actor,
      source: "local",
      authorizationDecision: {
        policyRef: "keycloak-policy@1",
        actor,
        subject: "settings/repository",
        bindingsUsed: [{ authority: "keycloak", scope: "task-create" }],
        outcome: "allowed",
        reasonCodes: ["keycloak_allowed"],
        nextActions: [],
        evaluatedAtCut: "canonical:1",
      },
    },
    actionId: "unverified-receipt",
    repoId: "repo",
    revision: 1,
    now: "2026-10-02T04:00:00.000Z",
  });
  assert.equal(decision.outcome, "denied");
  assert.deepEqual(decision.reasonCodes, ["authentication_required"]);
});
