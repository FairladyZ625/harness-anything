import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

export async function createAcceptedDecision(endpoint, repoId, title) {
  const proposed = await requestDaemonJsonRpcAt(
    endpoint,
    "repo.decision.propose",
    {
      repo: { repoId },
      payload: {
        title,
        question: `Should the work fixture ${title} track its source direction?`,
        riskTier: "low",
        urgency: "low",
        vertical: "software/coding",
        preset: "standard-task",
        decisionClass: "ordinary",
        appliesTo: { modules: ["gui-e2e"], productLines: [] },
        chosen: [{ id: "CH1", text: "Track the accepted direction" }],
        rejected: [{ id: "RJ1", text: "Leave work unlinked", whyNot: "The work loses its source" }],
        body:
          `# ${title}\n\n## Background\n\nThe fixture creates work from an accepted direction.\n\n` +
          "## Trade-offs\n\nAn implements relation keeps the source inspectable.\n\n" +
          "## Conclusion\n\nTrack the accepted direction.\n",
        claims: [],
        fulfillments: [],
      },
    },
    5_000,
  );
  assert.equal(proposed.ok, true, `decision proposal failed: ${JSON.stringify(proposed)}`);
  const decisionId = JSON.parse(String(proposed.evidence)).decisionId,
    accepted = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.run",
      {
        repo: { repoId },
        payload: {
          action: {
            kind: "decision-accept",
            decisionId,
            rationale: "The isolated fixture accepts this direction.",
            judgmentOnlyRationale: "The isolated fixture records an owner decision.",
          },
        },
      },
      5_000,
    );
  assert.equal(accepted.outcome, "applied", `decision acceptance failed: ${JSON.stringify(accepted)}`);
  return decisionId;
}
