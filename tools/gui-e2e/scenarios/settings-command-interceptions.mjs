import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

export default {
  id: "settings-command-interceptions",
  feature: "settings",
  lane: "isolated",
  description:
    "Edit, persist and reload scoped command interception rules in the real settings page, with bilingual copy.",
  async run({ page, app, fixture, shot }) {
    const read = () =>
      requestDaemonJsonRpcAt(fixture.endpoint, "repo.settings.read", { repo: { repoId: fixture.repoId } }, 10_000);
    const openSettings = async () => {
      await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
      await page.getByRole("button", { name: /^Repository |^仓库 /u }).click();
      await page.getByTestId("settings-search").fill("runtimeCommandInterceptions");
      await page.getByTestId("command-interceptions-editor").waitFor();
    };
    const save = async (rules) => {
      await page.getByTestId("settings-repository-save").click();
      await page.evaluate(() => {
        globalThis.__interceptionRead = { pending: false, rules: null, error: null };
      });
      await page.waitForFunction(
        ({ repoId, expected }) => {
          const state = globalThis.__interceptionRead;
          if (state.error) throw new Error(state.error);
          if (!state.pending) {
            state.pending = true;
            globalThis.window.harness.getSettings({ repoId }).then(
              (result) => {
                state.rules = result.values?.runtimeCommandInterceptions;
                state.pending = false;
              },
              (error) => {
                state.error = String(error);
                state.pending = false;
              },
            );
          }
          return (
            Array.isArray(state.rules) &&
            state.rules.length === expected.length &&
            state.rules.every((rule, index) =>
              ["id", "pattern", "agent"].every((key) => rule[key] === expected[index][key]),
            )
          );
        },
        { repoId: fixture.repoId, expected: rules },
        { timeout: 10_000, polling: 100 },
      );
    };
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByRole("button", { name: /语言|Language/u }).click();
    await page.getByLabel(/^语言$|^Language$/u).selectOption("en-US");
    await openSettings();
    await page.getByTestId("command-interception-add").click();
    await page.getByTestId("command-interception-0-id").fill("block-release");
    await page.getByTestId("command-interception-0-pattern").fill("^npm run release(?: |$)");
    await page.getByTestId("command-interception-0-agent").fill("worker");
    const rules = [{ id: "block-release", pattern: "^npm run release(?: |$)", agent: "worker" }];
    await save(rules);
    console.log(
      "[command-interceptions] persisted rules:",
      JSON.stringify((await read()).values.runtimeCommandInterceptions),
    );
    assert.deepEqual((await read()).values.runtimeCommandInterceptions, rules);
    await page.reload();
    await openSettings();
    assert.equal(await page.getByTestId("command-interception-0-pattern").inputValue(), rules[0].pattern);
    await page.getByTestId("settings-runtimeCommandInterceptions-help").locator("summary").click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    assert.match(await page.getByTestId("settings-content").innerText(), /Blocked runtime commands/u);
    await shot("command-interceptions-en");
    await page.getByRole("button", { name: /外观|Appearance/u }).click();
    await page.getByRole("button", { name: /^(?:亮色|Light)$/u }).click();
    await page.getByRole("button", { name: /^Repository |^仓库 /u }).click();
    await page.getByTestId("settings-search").fill("runtimeCommandInterceptions");
    await shot("command-interceptions-en-light");
    await page.getByRole("button", { name: /语言|Language/u }).click();
    await page.getByLabel(/^语言$|^Language$/u).selectOption("zh-CN");
    await page.getByRole("button", { name: /^Repository |^仓库 /u }).click();
    await page.getByTestId("settings-search").fill("runtimeCommandInterceptions");
    assert.match(await page.getByTestId("settings-content").innerText(), /Runtime 命令拦截/u);
    await page.getByTestId("settings-runtimeCommandInterceptions-help").locator("summary").click();
    await shot("command-interceptions-zh");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 900));
    await page.getByTestId("command-interceptions-editor").scrollIntoViewIfNeeded();
    await shot("command-interceptions-zh-narrow");
    assert.ok(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    );
    // A bad regex reaches the existing authoritative write boundary and is visibly rejected.
    await page.getByTestId("command-interception-0-pattern").fill("[");
    await page.getByTestId("settings-repository-save").click();
    await page.getByText(/SyntaxError: Invalid regular expression/u).waitFor({ timeout: 10_000 });
    assert.deepEqual((await read()).values.runtimeCommandInterceptions, rules);
    assert.match(
      await page.getByTestId("settings-content").innerText(),
      /(?:regular expression|RegExp|SyntaxError|invalid_settings)/iu,
    );
    await page.getByTestId("settings-runtimeCommandInterceptions-restore").click();
    await save([]);
    assert.deepEqual((await read()).values.runtimeCommandInterceptions, []);

    // A GUI release stays attached while the daemon upgrades. Simulate the next daemon adding a
    // top-level field, a nested settings field and an action value this GUI has never declared;
    // the frozen main-process parser must still accept the read and the page must stay usable.
    await app.evaluate(
      ({ ipcMain }, paths) => {
        const load = process.getBuiltinModule("module").createRequire(paths.bridge),
          { createLocalGuiServiceBridge } = load(paths.bridge),
          { parseDaemonGuiReadResponse } = load(paths.parser),
          bridge = createLocalGuiServiceBridge();
        ipcMain.removeHandler("harness:getSettings");
        ipcMain.handle("harness:getSettings", async (_event, payload) => {
          const result = await bridge.invoke("getSettings", payload);
          return parseDaemonGuiReadResponse("repo.settings.read", {
            ...result,
            daemonAddedTopLevel: "ignored",
            settings: {
              ...result.settings,
              daemonAddedSection: { enabled: true },
              runtime: { ...result.settings.runtime, daemonAddedSetting: ["new-value"] },
            },
            values: { ...result.values, daemonAddedActionValue: [{ id: "new-value" }] },
          });
        });
      },
      {
        bridge: fileURLToPath(new URL("../../../packages/gui/src/main/local-composition-root.ts", import.meta.url)),
        parser: fileURLToPath(
          new URL("../../../packages/daemon/src/protocol/gui-result-validation.ts", import.meta.url),
        ),
      },
    );
    await page.reload();
    await openSettings();
    assert.equal(await page.getByTestId("command-interceptions-editor").isVisible(), true);
    assert.doesNotMatch(await page.getByTestId("settings-content").innerText(), /invalid_result|field is unknown/u);
    await shot("settings-newer-daemon-fields");
  },
};
