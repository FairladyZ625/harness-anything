import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { nav } from "./helpers.mjs";

async function rpc(endpoint, repoId, method, payload) {
  return requestDaemonJsonRpcAt(endpoint, method, { repo: { repoId }, payload }, 2_000, 30_000);
}

export default {
  id: "overview-entity-unpin",
  feature: "overview",
  lane: "isolated",
  description: "The overview pinned tab removes a non-task entity through the GUI unpin action.",
  async run({ page, fixture, shot }) {
    const { endpoint, repoId } = fixture;
    const proposed = await rpc(endpoint, repoId, "repo.decision.propose", {
      title: "GUI overview entity unpin",
      question: "Can a pinned Decision be removed from the overview?",
      riskTier: "low",
      urgency: "low",
      vertical: "default",
      preset: "default",
      appliesTo: { modules: ["gui"], productLines: [] },
      decisionClass: "ordinary",
      chosen: [{ id: "CH1", text: "Unpin it in the overview" }],
      rejected: [{ id: "RJ1", text: "Keep it pinned", whyNot: "The overview needs an unpin action" }],
      body:
        "# GUI overview entity unpin\n\n" +
        "## Background\n\nA pinned Decision must be removable from the overview.\n\n" +
        "## Trade-offs\n\nUse the existing entity unpin write path.\n\n" +
        "## Conclusion\n\nThe overview exposes the entity unpin action.\n",
      claims: [],
      fulfillments: [],
    });
    assert.equal(proposed.ok, true, `decision proposal: ${JSON.stringify(proposed).slice(0, 500)}`);
    const decisionId = JSON.parse(String(proposed.evidence)).decisionId;
    const entityRef = `decision/${decisionId}`;
    const pinned = await rpc(endpoint, repoId, "repo.task.run", {
      action: { kind: "entity-pin", entityRef },
    });
    assert.equal(pinned.outcome, "applied", `entity pin: ${JSON.stringify(pinned).slice(0, 500)}`);

    await page.reload();
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");
    await page.getByTestId("overview-drill-pinned").click();
    const unpin = page.getByTestId(`overview-unpin-${entityRef}`);
    await unpin.waitFor({ timeout: 20_000 });
    await shot("overview-entity-unpin-before");

    await unpin.click();
    await unpin.waitFor({ state: "detached", timeout: 20_000 });
    const agenda = await rpc(endpoint, repoId, "repo.agenda.read", {});
    assert.equal(
      agenda.pinnedEntities.some(({ ref }) => ref === entityRef),
      false,
      "the GUI action must clear the Decision from the agenda projection",
    );
    await shot("overview-entity-unpin-after");
  },
};
