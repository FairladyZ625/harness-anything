// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { realizedDecisionBody, realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";

const workPlan = (title: string) =>
  realizedTaskPlan(
    title,
    [
      "Mission",
      "Usage Questions",
      "Wave Decomposition",
      "Exit Criteria",
      "Entry Conditions",
      "Dependencies",
      "Decision-Derived Authorization",
      "PR/merge Operations",
      "Constraints",
      "Checkpoint",
      "Implementation Plan",
      "Deliverable Contract",
      "Evidence Protocol",
      "Verification",
    ]
      .map((heading) => `## ${heading}\n\nThe edge-forward regression covers ${heading.toLowerCase()}.`)
      .join("\n\n"),
  );

function evidence(receipt: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}

test("edge fleet work create carries the plan policy and reaches the center writer", { timeout: 90_000 }, async (t) => {
  const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
  const vertical = await f.host.run("lease-repo", { kind: "vertical-declaration-migrate" }, localAuthFixture());
  assert.equal(vertical.outcome, "applied", JSON.stringify(vertical));
  await waitForFleetPublication(f.host, "lease-repo", String(vertical.opId), localAuthFixture());

  const proposed = await f.host.run(
    "lease-repo",
    {
      kind: "decision-propose",
      jsonInput: JSON.stringify({
        title: "Edge work direction",
        question: "Should the edge create a work root from this direction?",
        riskTier: "medium",
        urgency: "high",
        vertical: "software/coding",
        preset: "create-work",
        decisionClass: "ordinary",
        appliesTo: { modules: ["daemon"], productLines: [] },
        chosen: [{ id: "CH1", text: "Create the work on the center writer" }],
        rejected: [{ id: "RJ1", text: "Keep the work on the edge", whyNot: "It creates a second writer" }],
        claims: [],
        fulfillments: [],
      }),
      body: realizedDecisionBody("Edge work direction"),
    },
    localAuthFixture(),
  );
  assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
  const decisionId = String(evidence(proposed).decisionId);
  const accepted = await f.host.run(
    "lease-repo",
    {
      kind: "decision-accept",
      decisionId,
      rationale: "The edge work direction is accepted.",
      judgmentOnlyRationale: "The fixture records one accepted direction for the edge work.",
    },
    localAuthFixture(),
  );
  assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
  await waitForFleetPublication(f.host, "lease-repo", String(accepted.opId), localAuthFixture());

  const edge = await fleetEdgeHostFixture(t, f),
    created = await edge.command({
      kind: "task-create",
      title: "Edge work",
      decisionRef: decisionId,
      workKind: "feat",
      riskTier: "medium",
      urgency: "high",
      locale: "zh-CN",
      slug: "edge-work",
      presetId: "create-work",
      taskClass: "work",
      requirePlan: true,
      plan: workPlan("Edge work"),
    });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  const taskId = String(created.taskId);
  assert.match(taskId, /^task_/u);
  const shown = evidence(await f.host.run("lease-repo", { kind: "task-show", taskId }, localAuthFixture()));
  assert.equal((shown.task as Record<string, unknown>).title, "Edge work");
  assert.equal((shown.task as Record<string, unknown>).taskClass, "work");
});
