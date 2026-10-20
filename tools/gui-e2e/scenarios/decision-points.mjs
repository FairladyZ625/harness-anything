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
    const stale = await rpc("repo.settings.update", {
      decisionsEnabledPoints: [`${point.pointId}@000000000000`],
      expectedVersion: settings.revision,
      idempotencyKey: "decision-point-stale",
    });
    assert.equal(stale.ok, true, JSON.stringify(stale));
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
    await page.getByTestId(`decision-point-reenable-${point.pointId}`).click();
    const save = page.getByRole("button", { name: /^(?:提交到仓库|Commit to repository)$/u });
    await save.click();
    // The mutation remains pending through the settings refetch. Wait on that rendered
    // completion signal; Playwright waitForFunction treats a Promise as truthy.
    await save.waitFor({ state: "visible" });
    assert.deepEqual((await rpc("repo.settings.read")).settings.decisions.enabledPoints, [point.bindingKey]);
    const toggle = editor.getByRole("switch", { name: point.pointId, exact: true });
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await editor.scrollIntoViewIfNeeded();
    await shot("decision-points-enabled");
    await toggle.click();
    await save.click();
    await save.waitFor({ state: "visible" });
    assert.deepEqual((await rpc("repo.settings.read")).settings.decisions.enabledPoints, []);
  },
};
