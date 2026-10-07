import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync } from "node:fs";

export default {
  id: "edge-read-freshness",
  feature: "edge-replica-read",
  lane: "isolated",
  description: "Fresh/stale/unavailable replica envelopes remain visible in the hidden desktop shell.",
  async run({ app, page, fixture, shot, runRoot }) {
    // This is a presentation fixture: domain rows come from the isolated daemon, while the
    // IPC read envelopes are controlled here. Real offline B RPC and zero center calls are
    // covered separately by fleet-squad-canonical.integration.test.ts, not claimed by this screenshot.
    await app.evaluate(
      ({ ipcMain }, input) => {
        const load = process.getBuiltinModule("module").createRequire(input.bridge),
          { createLocalGuiServiceBridge } = load(input.bridge),
          { daemonGuiReadMethods } = load(input.protocol),
          bridge = createLocalGuiServiceBridge(input.rootDir);
        globalThis.__edgeReadPresentationState = "fresh";
        for (const facet of daemonGuiReadMethods.filter(({ method }) => method.startsWith("repo."))) {
          const channel = `harness:${facet.guiBridgeMethod}`;
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, async (_event, payload) => {
            const state = globalThis.__edgeReadPresentationState;
            if (state === "unavailable" && facet.method === "repo.tasks.list")
              return {
                ok: false,
                code: "replica_unavailable",
                error: { code: "replica_unavailable" },
                rejectionExplanation: "Replica task rows are unavailable at this cut.",
              };
            const value = await bridge.invoke(facet.guiBridgeMethod, payload);
            if (state === null || value.ok === false) return value;
            return {
              ...value,
              cut: { revision: value.sourceRevision ?? value.watermark ?? 42, headDigest: "presentation-fixture" },
              freshness: {
                state: state === "fresh" ? "fresh" : "stale",
                ageMs: state === "fresh" ? 0 : 120_000,
                lagRevisions: 0,
                maxAgeMs: 60_000,
                maxLagRevisions: 32,
                confirmedAt: "2026-10-07T00:00:00.000Z",
              },
              warning: state === "fresh" ? null : "可能过期：最后一次中心确认已过期。",
            };
          });
        }
      },
      {
        rootDir: fixture.rootDir,
        bridge: path.resolve("packages/gui/src/main/local-composition-root.ts"),
        protocol: path.resolve("packages/daemon/src/protocol/index.ts"),
      },
    );
    try {
      for (const state of ["fresh", "stale", "unavailable"]) {
        await app.evaluate((_electron, state) => {
          globalThis.__edgeReadPresentationState = state;
        }, state);
        await page.reload();
        await page.locator(`[data-testid="repository-read-state"][data-state="${state}"]`).waitFor();
        const notice = await page.getByTestId("repository-read-notice").innerText();
        assert.match(notice, /最后报告|last report/u);
        if (state === "unavailable") {
          await page.getByTestId("task-error-state").waitFor();
          assert.equal(await page.getByTestId("task-empty-state").count(), 0);
        } else await page.getByTestId("real-task-summary").waitFor();
        await shot(`edge-read-${state}`);
      }
      writeFileSync(
        path.join(runRoot, "edge-read-evidence.json"),
        JSON.stringify(
          {
            source: "isolated daemon rows with controlled IPC replica envelopes",
            states: ["fresh", "stale", "unavailable"],
            backendOfflineEvidence: "packages/daemon/test/fleet-squad-canonical.integration.test.ts",
          },
          null,
          2,
        ),
      );
    } finally {
      await app.evaluate(() => {
        globalThis.__edgeReadPresentationState = null;
      });
    }
  },
};
