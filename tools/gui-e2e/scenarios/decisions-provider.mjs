import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

async function settleDialog(page, testId) {
  const dialog = page.getByTestId(testId);
  await dialog.waitFor({ state: "visible" });
  await dialog.evaluate(async (element) => {
    const surface = element.closest("dialog") ?? element;
    const content = surface.querySelector(".glass"),
      scrim = surface.querySelector(".glass-scrim");
    await new Promise((resolve) => {
      const inspect = () => {
        const contentOpacity = Number.parseFloat(globalThis.getComputedStyle(content).opacity),
          scrimOpacity = Number.parseFloat(globalThis.getComputedStyle(scrim).opacity),
          transform = globalThis.getComputedStyle(content).transform,
          offsetY = transform === "none" ? 0 : new globalThis.DOMMatrixReadOnly(transform).m42;
        if (contentOpacity >= 0.99 && scrimOpacity >= 0.99 && Math.abs(offsetY) < 0.1) resolve();
        else globalThis.requestAnimationFrame(inspect);
      };
      globalThis.requestAnimationFrame(inspect);
    });
  });
}

export default {
  id: "decisions-provider",
  feature: "providers",
  lane: "isolated",
  description:
    "Choose the provider type, configure a Decisions API connection, and keep it outside runtime dispatch candidates.",
  decisionProviderCredentials: true,
  runtimeInstance: {
    instanceId: "runtime-provider-example",
    name: "Runtime provider example",
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
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByRole("button", { name: /外观|Appearance/u }).click();
    await page.getByRole("button", { name: /亮色|Light/u }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    await page.getByRole("button", { name: /^(?:Provider|Providers|承运者)$/u }).click();
    await page.getByTestId("runtime-new-runtimes").click();
    await settleDialog(page, "provider-type-dialog");
    await shot("provider-type-selection-light");
    await page.getByTestId("provider-type-llm").click();
    await page.getByTestId("new-runtime-dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByTestId("new-runtime-dialog").waitFor({ state: "hidden" });
    await page.getByTestId("runtime-new-runtimes").click();
    await page.getByTestId("provider-type-decisions").click();
    await page.getByTestId("provider-type-dialog").waitFor({ state: "hidden" });
    await settleDialog(page, "decision-provider-form");
    await page.getByTestId("decision-provider-id").fill("decision-smoke");
    await page.getByTestId("decision-provider-name").fill("Advisory decisions");
    await page.getByTestId("decision-provider-model").fill("openai/gpt-4.1-mini");
    await page.getByTestId("decision-provider-api-key").fill("isolated-gui-test-key");
    await shot("decision-provider-form-light");
    await page.getByTestId("decision-provider-save").click();
    await page.getByTestId("decision-provider-form").waitFor({ state: "hidden" });
    const detail = page.getByTestId("decision-provider-detail");
    await detail.waitFor();
    await page.getByTestId("decision-provider-card").waitFor();
    assert.match(await detail.innerText(), /仅供判断，不能派工|Advisory only — cannot dispatch/u);
    await shot("decision-provider-detail-light");
    const runtime = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "daemon.runtimeInstance.list",
      { payload: {} },
      1_000,
    );
    assert.equal(runtime.ok, true, JSON.stringify(runtime));
    assert.equal(
      runtime.instances.some((instance) => instance.instanceId === "decision-smoke"),
      false,
    );
    const providers = await requestDaemonJsonRpcAt(fixture.endpoint, "daemon.provider.list", { payload: {} }, 1_000);
    assert.equal(providers.ok, true, JSON.stringify(providers));
    assert.equal(
      providers.providers.some((provider) => provider.providerId === "decision-smoke"),
      true,
    );

    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByRole("button", { name: /外观|Appearance/u }).click();
    await page.getByRole("button", { name: /暗色|Dark/u }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.getByRole("button", { name: /^(?:Provider|Providers|承运者)$/u }).click();
    await page.getByTestId("runtime-new-runtimes").click();
    await settleDialog(page, "provider-type-dialog");
    await shot("provider-type-selection-dark");
    await page.getByTestId("provider-type-decisions").click();
    await page.getByTestId("provider-type-dialog").waitFor({ state: "hidden" });
    await settleDialog(page, "decision-provider-form");
    await page.getByTestId("decision-provider-id").fill("decision-smoke-dark");
    await page.getByTestId("decision-provider-name").fill("Advisory decisions");
    await page.getByTestId("decision-provider-model").fill("openai/gpt-4.1-mini");
    await page.getByTestId("decision-provider-api-key").fill("isolated-gui-test-key");
    await shot("decision-provider-form-dark");
  },
};
