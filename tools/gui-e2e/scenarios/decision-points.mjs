import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

export default {
  id: "decision-points",
  feature: "settings",
  lane: "isolated",
  description: "Review redacted outgoing data, replace a stale binding, enable and disable a declared advisory point.",
  async run({ page, app, fixture, shot }) {
    const rpc = (method, payload) =>
      requestDaemonJsonRpcAt(
        fixture.endpoint,
        method,
        { repo: { repoId: fixture.repoId }, ...(payload ? { payload } : {}) },
        10_000,
      );
    const settings = await rpc("repo.settings.read");
    assert.equal(settings.ok, true, JSON.stringify(settings));
    const point = settings.decisionPoints[0];
    assert.ok(point, "The bundled vertical must declare an advisory point");
    const staleBinding = `${point.pointId}@000000000000`;
    const stale = await rpc("repo.settings.update", {
      decisionsEnabledPoints: [staleBinding],
      expectedVersion: settings.revision,
      idempotencyKey: "decision-point-stale",
    });
    assert.equal(stale.ok, true, JSON.stringify(stale));
    assert.deepEqual((await rpc("repo.settings.read")).settings.decisions.enabledPoints, [staleBinding]);
    await page.reload();
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByRole("button", { name: /^Repository |^仓库 /u }).click();
    const editor = page.getByTestId("decision-points-editor");
    await editor.waitFor();
    await editor.scrollIntoViewIfNeeded();
    assert.match(await editor.innerText(), /000000000000 →/u);
    assert.match(await editor.innerText(), /\[LOCAL_PATH\]/u);
    assert.equal(await editor.locator("textarea").count(), 0);
    const background = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    );
    assert.equal(background, true);
    await shot("decision-points-stale");
    const save = page.getByRole("button", { name: /^(?:提交到仓库|Commit to repository)$/u });
    const commit = async () => {
      const button = await save.elementHandle();
      assert.ok(button, "The repository settings save button must be available");
      await page.evaluate((saveButton) => {
        globalThis.window.__decisionPointsSaveSettled = new Promise((resolve) => {
          let pendingObserved = saveButton.disabled;
          const observer = new globalThis.MutationObserver(() => {
            if (saveButton.disabled) pendingObserved = true;
            else if (pendingObserved) {
              observer.disconnect();
              resolve();
            }
          });
          observer.observe(saveButton, { attributes: true, attributeFilter: ["disabled"] });
        });
      }, button);
      await save.click();
      await page.evaluate(() => globalThis.window.__decisionPointsSaveSettled);
    };
    await page.getByTestId(`decision-point-reenable-${point.pointId}`).click();
    await commit();
    assert.deepEqual((await rpc("repo.settings.read")).settings.decisions.enabledPoints, [point.bindingKey]);
    const toggle = editor.getByRole("switch", { name: point.pointId, exact: true });
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await editor.scrollIntoViewIfNeeded();
    await shot("decision-points-enabled");
    await toggle.click();
    await commit();
    assert.deepEqual((await rpc("repo.settings.read")).settings.decisions.enabledPoints, []);
  },
};
