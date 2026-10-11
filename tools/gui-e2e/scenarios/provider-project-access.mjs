import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

export default {
  id: "provider-project-access",
  feature: "providers",
  lane: "isolated",
  description: "Project access persists across reload without changing the machine's enabled runtime instance.",
  // Use the resident fixture's witnessed Node executable, never discover or authenticate a real provider.
  runtimeInstance: {
    instanceId: "codex-project",
    name: "Codex project",
    kindId: "codex",
    providerId: "openai",
    models: ["test-model"],
    enabled: true,
    permissionMode: "read-only",
    codex: {},
  },
  async run({ page, app, fixture, shot }) {
    const hidden = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    );
    assert.equal(hidden, true);
    await page.getByRole("button", { name: /^(?:Provider|Providers|承运者)$/u }).click();
    const card = page.getByTestId("runtime-card-codex-project"),
      toggle = card.getByRole("switch", { name: /在此项目使用|Use in this project/u });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await shot("provider-project-blocked");
    await toggle.click();
    await page.waitForFunction(
      (element) => element.getAttribute("aria-checked") === "true",
      await toggle.elementHandle(),
    );
    const readSettings = () =>
      requestDaemonJsonRpcAt(fixture.endpoint, "repo.settings.read", { repo: { repoId: fixture.repoId } }, 1_000);
    assert.deepEqual((await readSettings()).settings.runtime.allowedInstances, ["codex-project"]);
    await shot("provider-project-allowed");
    await toggle.click();
    await page.waitForFunction(
      (element) => element.getAttribute("aria-checked") === "false",
      await toggle.elementHandle(),
    );
    assert.deepEqual((await readSettings()).settings.runtime.allowedInstances, []);
    const machine = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "daemon.runtimeInstance.list",
      { payload: {} },
      1_000,
    );
    assert.equal(machine.ok, true, JSON.stringify(machine));
    assert.equal(machine.instances.find((instance) => instance.instanceId === "codex-project").enabled, true);
    await page.reload();
    await page.getByRole("button", { name: /^(?:Provider|Providers|承运者)$/u }).click();
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await shot("provider-project-blocked-after-reload");
  },
};
