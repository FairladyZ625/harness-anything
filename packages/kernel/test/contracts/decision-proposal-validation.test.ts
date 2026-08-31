// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { getExecutableEntityAction } from "../../src/domain/index.ts";

const compile = getExecutableEntityAction("decision-propose")?.execution?.compile;

test("Decision proposal validation reports every independent packet violation in one failure", () => {
  assert.ok(compile);
  assert.throws(
    () =>
      compile({
        action: {
          title: "Decision",
          question: "?".repeat(500),
          riskTier: "urgent",
          urgency: "eventual",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "charter",
          appliesTo: [],
          chosen: [{ id: "chosen", text: "" }],
          rejected: [{ id: "RJ1", text: "Reject", whyNot: "" }],
          claims: [{ id: "claim", text: "", loadBearing: "yes" }],
          fulfillments: [{ claimId: "missing", mode: "later" }],
        },
        actor: { principal: { personId: "person-owner" }, executor: null },
        source: "local",
        session: { kind: "unavailable", reason: "test" },
        opId: "decision-validation-aggregate",
        occurredAt: "2026-09-01T00:00:00.000Z",
        workspaceRevision: 1,
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "invalid_command");
      const message = error instanceof Error ? error.message : String(error);
      for (const expected of [
        "question must be 1..499 code points",
        "riskTier must be low, medium, or high",
        "urgency must be low, medium, or high",
        "decisionClass must be ordinary or standing_policy",
        "appliesTo must carry exactly modules and productLines",
        "every chosen entry needs a CH id",
        "every rejected entry needs an RJ id",
        "every claim needs a C id",
        "every fulfillment needs a claimId and a mode of evidenced, delivered, standing_policy",
      ])
        assert.match(message, new RegExp(expected, "u"));
      return true;
    },
  );
});

test("shared choice validation lists every accepted value", () => {
  const fulfill = getExecutableEntityAction("decision-claim-fulfill")?.execution?.compile;
  assert.ok(fulfill);
  assert.throws(
    () =>
      fulfill({
        action: { decisionId: "dec_1", claimId: "C1", mode: "later" },
        actor: { principal: { personId: "person-owner" }, executor: null },
        source: "local",
        session: { kind: "unavailable", reason: "test" },
        opId: "decision-choice-candidates",
        occurredAt: "2026-09-01T00:00:00.000Z",
        workspaceRevision: 1,
      }),
    /mode is invalid; expected one of: evidenced, delivered, standing_policy\./u,
  );
});
