import assert from "node:assert/strict";
import { waitForEntrySettled } from "./helpers.mjs";

async function settleControlMotion(dialog) {
  await dialog.evaluate(async (element) => {
    await new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)));
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
    await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
  });
}

export default {
  id: "deepseek-harness-api-key",
  feature: "agent-runtime",
  lane: "isolated",
  description: "DeepSeek Harness switches from the shared App login to an isolated API-key form.",
  runtimeInstance: {
    instanceId: "deepseek-subscription",
    name: "DeepSeek subscription",
    kindId: "deepseek-harness",
    providerId: "deepseek",
    models: ["deepseek-v4-flash"],
    enabled: true,
    permissionMode: "read-only",
    "deepseek-harness": {},
  },
  async run({ page, app, shot }) {
    const hidden = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    );
    assert.equal(hidden, true);

    await page.getByRole("button", { name: /^(?:Provider|Providers|承运者)$/u }).click();
    await page.getByTestId("runtime-new-runtimes").click();
    await page.getByTestId("provider-type-llm").click();
    const dialog = page.getByTestId("new-runtime-dialog");
    await dialog.waitFor({ state: "visible" });
    await waitForEntrySettled(page, '[data-testid="new-runtime-dialog"] .glass-overlay');

    assert.equal(await dialog.getByText(/^(?:API override|API 覆盖)$/u).count(), 1);
    await dialog.getByRole("button", { name: /DeepSeek Harness/u }).click();
    await settleControlMotion(dialog);
    assert.equal(await dialog.getByText(/^(?:API override|API 覆盖)$/u).count(), 0);
    const apiKey = dialog.getByTestId("new-runtime-api-key"),
      baseUrl = dialog.getByTestId("new-runtime-base-url"),
      isolation = dialog.getByRole("combobox", { name: /Isolation|隔离/u });
    assert.equal(await apiKey.isEnabled(), false);
    assert.equal(await baseUrl.isEnabled(), false);
    assert.equal(await isolation.inputValue(), "operator-environment");

    await dialog.getByRole("button", { name: /^(?:API key|API 调用)$/u }).click();
    await settleControlMotion(dialog);
    assert.equal(await apiKey.isEnabled(), true);
    assert.equal(await baseUrl.isEnabled(), true);
    assert.equal(await isolation.inputValue(), "enforced");
    const wireApi = dialog.getByRole("combobox", { name: "wire_api" });
    assert.deepEqual(
      await wireApi.locator("option").evaluateAll((options) => options.map((option) => option.value).filter(Boolean)),
      ["openai-completions", "openai-responses", "anthropic-messages"],
    );
    await wireApi.selectOption("anthropic-messages");
    await baseUrl.fill("https://api.example.test/v1");
    await apiKey.fill("isolated-test-key");
    await shot("deepseek-harness-api-key-form");
  },
};
