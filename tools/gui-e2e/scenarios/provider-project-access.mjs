import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

export default {
  id: "provider-project-access",
  feature: "providers",
  lane: "isolated",
  description: "Project access persists across reload; read failures disable it and write conflicts remain visible.",
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
    await page.emulateMedia({ reducedMotion: "reduce" });
    const hidden = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    );
    assert.equal(hidden, true);
    const closeInspector = async () => {
      await page.getByRole("button", { name: /检查器|inspector/iu }).click();
      await page.getByTestId("runtime-inspector").waitFor({ state: "detached" });
    };
    await page.getByRole("button", { name: /^(?:Provider|Providers|承运者)$/u }).click();
    await closeInspector();
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
    await closeInspector();
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await shot("provider-project-blocked-after-reload");

    // Inject a stale token at the IPC boundary, retaining the real isolated daemon's CAS and
    // rejection receipt. The view must expose that receipt next to the project switch.
    await app.evaluate(
      ({ ipcMain }, bridgePath) => {
        const load = process.getBuiltinModule("module").createRequire(bridgePath),
          { createLocalGuiServiceBridge } = load(bridgePath),
          bridge = createLocalGuiServiceBridge();
        globalThis.__providerSettingsState = "conflict";
        globalThis.__providerSettingsWrites = 0;
        for (const method of ["getSettings", "updateSettings"]) {
          ipcMain.removeHandler(`harness:${method}`);
          ipcMain.handle(`harness:${method}`, async (_event, payload) => {
            if (method === "getSettings" && globalThis.__providerSettingsState === "read-error")
              return { ok: false, error: { code: "invalid_result", hint: "Settings runtime field is unknown." } };
            if (method === "updateSettings") {
              globalThis.__providerSettingsWrites += 1;
              return bridge.invoke(method, { ...payload, expectedVersion: 0 });
            }
            return bridge.invoke(method, payload);
          });
        }
      },
      fileURLToPath(new URL("../../../packages/gui/src/main/local-composition-root.ts", import.meta.url)),
    );
    await toggle.click();
    const error = page.getByTestId("provider-settings-error");
    await error.getByText(/revision_conflict/u).waitFor();
    assert.match(await error.innerText(), /current revision is/u);
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    assert.deepEqual((await readSettings()).settings.runtime.allowedInstances, []);
    await shot("provider-project-write-conflict");

    // A reader rejected by its client schema has no token. Reload clears the settings cache,
    // reproducing the missing-data state that previously manufactured expectedVersion=0.
    await app.evaluate(() => {
      globalThis.__providerSettingsState = "read-error";
    });
    await page.reload();
    await page.getByRole("button", { name: /^(?:Provider|Providers|承运者)$/u }).click();
    await closeInspector();
    await error.getByText(/invalid_result/u).waitFor();
    assert.equal(await toggle.isDisabled(), true);
    assert.equal(await app.evaluate(() => globalThis.__providerSettingsWrites), 1);
    await shot("provider-project-read-error");
  },
};
