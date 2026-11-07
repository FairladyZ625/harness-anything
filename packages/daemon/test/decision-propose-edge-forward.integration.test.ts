// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";

// The CLI's fleet route resolves --from-file and --body-file on the edge and sends the decoded
// packet as direct action fields. These are the only two shapes that reach the center.
const requiredPacket = {
  title: "Edge decision",
  question: "Can the edge submit the same Decision packet as the center?",
  riskTier: "low",
  urgency: "medium",
  decisionClass: "ordinary",
  chosen: [{ id: "CH1", text: "Forward the decoded packet." }],
  rejected: [{ id: "RJ1", text: "Require the center's file path.", whyNot: "The edge owns that file." }],
  claims: [],
};

function evidence(receipt: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(String(receipt.evidence)) as Record<string, unknown>;
}

test(
  "edge fleet decision proposals with required fields, with and without a body, reach the center",
  { timeout: 90_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    const vertical = await f.host.run("lease-repo", { kind: "vertical-declaration-migrate" }, localAuthFixture());
    assert.equal(vertical.outcome, "applied", JSON.stringify(vertical));
    await waitForFleetPublication(f.host, "lease-repo", String(vertical.opId), localAuthFixture());
    const edge = await fleetEdgeHostFixture(t, f),
      defaulted = ["vertical", "preset", "appliesTo", "fulfillments", "relations"];

    const withBody = await edge.command({
      kind: "decision-propose",
      ...requiredPacket,
      body: realizedDecisionBody(requiredPacket.title),
    });
    assert.equal(withBody.outcome, "applied", JSON.stringify(withBody));
    assert.deepEqual(evidence(withBody).defaultedFields, defaulted);

    const withoutBody = await edge.command({
      kind: "decision-propose",
      ...requiredPacket,
      title: "Edge decision without prose",
    });
    assert.equal(withoutBody.outcome, "applied", JSON.stringify(withoutBody));
    assert.deepEqual(evidence(withoutBody).defaultedFields, defaulted);
    const decisionId = String(evidence(withoutBody).decisionId);
    assert.match(decisionId, /^dec_/u);
    const shown = await f.host.run("lease-repo", { kind: "decision-show", decisionId }, localAuthFixture());
    assert.equal(
      (evidence(shown).decision as Record<string, unknown>).title,
      "Edge decision without prose",
      "the center read projects the edge proposal",
    );
  },
);
