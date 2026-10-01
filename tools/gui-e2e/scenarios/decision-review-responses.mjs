import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady } from "./helpers.mjs";

export default {
  id: "decision-review-responses",
  feature: "decisions",
  lane: "isolated",
  description:
    "Adopt and rebut independent review findings, save, and read both response histories back from the daemon.",
  async run({ page, fixture, shot, runRoot }) {
    await bridgeReady(page);
    // Enter the review route using the existing persisted navigation state.
    await page.waitForFunction(() =>
      Object.keys(globalThis.sessionStorage).some((key) => key.startsWith("harness-view-history")),
    );
    await page.evaluate(() => {
      const key = Object.keys(globalThis.sessionStorage).find(
        (key) => key.startsWith("harness-view-history") && key.includes("gui-e2e-catalog"),
      );
      const value = JSON.parse(globalThis.sessionStorage.getItem(key));
      const base = value.history.entries[value.history.index];
      value.history = {
        entries: [{ ...base, view: "decisionDetail", focusedEntityRef: "decisionreview/dec_gui_smoke/review" }],
        index: 0,
      };
      globalThis.sessionStorage.setItem(key, JSON.stringify(value));
    });
    await page.reload();
    await page.getByTestId("decision-review-tab").waitFor();
    await shot("decision-review-responses-1-review");
    const respond = page.getByRole("tab", { name: /意见回应|Respond/u });
    await respond.click();
    await page.getByTestId("decision-respond-tab").waitFor();
    assert.equal(await respond.getAttribute("aria-selected"), "true");
    const expected = [
      {
        findingId: "F1",
        disposition: "adopt",
        rationale: "采纳:补上读面名称 repo.relation.graph。",
        label: /已采纳|Adopted/u,
      },
      {
        findingId: "F2",
        disposition: "rebut",
        rationale: "反驳:被否方案的理由已在 whyNot。",
        label: /已反驳|Rebutted/u,
      },
    ];
    for (const response of expected) {
      const prefix = `decision-respond-review-gui-flow-1/${response.findingId}`;
      assert.equal(await page.getByTestId(`${prefix}-history`).count(), 0);
      await page.getByTestId(`${prefix}-${response.disposition}`).check();
      await page.getByTestId(`${prefix}-rationale`).fill(response.rationale);
    }
    await shot("decision-review-responses-2-filled");
    await page.getByTestId("decision-respond-save").click();
    for (const response of expected) {
      const history = page.getByTestId(`decision-respond-review-gui-flow-1/${response.findingId}-history`);
      await history.waitFor();
      assert.equal(await history.locator("p").count(), 2, "one heading and exactly one response");
      assert.match(await history.innerText(), response.label);
      assert.ok((await history.innerText()).includes(response.rationale));
    }
    assert.equal(await respond.getAttribute("aria-selected"), "true");
    await shot("decision-review-responses-3-saved");
    const read = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.decisions.list",
      {
        repo: { repoId: fixture.repoId },
        payload: { projection: "full" },
      },
      1_000,
      5_000,
    );
    writeFileSync(path.join(runRoot, "decision-review-responses-readback.json"), `${JSON.stringify(read, null, 2)}\n`);
    assert.equal(read.ok, true);
    const decision = read.decisions.find((row) => row.decisionId === "dec_gui_smoke");
    assert.deepEqual(
      decision.reviewResponses.map(({ reviewId, findingId, disposition, rationale }) => ({
        reviewId,
        findingId,
        disposition,
        rationale,
      })),
      expected.map(({ findingId, disposition, rationale }) => ({
        reviewId: "review-gui-flow-1",
        findingId,
        disposition,
        rationale,
      })),
    );
  },
};
