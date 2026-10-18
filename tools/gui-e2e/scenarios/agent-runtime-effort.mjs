import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

export default {
  id: "agent-runtime-effort",
  feature: "agent-runtime",
  lane: "isolated",
  description: "Agent runtime effort can be set in the declaration editor and survives a daemon read after reload.",
  async run({ page, app, shot }) {
    const hidden = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    );
    assert.equal(hidden, true);

    await nav(page, "Agents · Squads", "agent-squad-view");
    await page.getByTestId("runtime-new-agents").click();
    const dialog = page.getByTestId("new-agent-dialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: /Blank|空白/u }).click();
    await page.getByTestId("new-agent-id").fill("effort-probe");
    await page.getByTestId("new-agent-name").fill("Effort probe");
    await page.getByTestId("new-agent-create").click();

    await page.getByTestId("rail-agent-effort-probe").waitFor();
    await page.getByRole("button", { name: /\+\s*codex/u }).click();
    const effort = page.getByTestId("agent-runtime-effort-codex");
    await effort.waitFor();
    assert.equal(await effort.inputValue(), "");
    await effort.selectOption("high");
    const save = page.getByTestId("agent-save");
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await page.waitForFunction((button) => /Saved|已保存/u.test(button.textContent ?? ""), await save.elementHandle());

    await page.reload();
    await page.getByRole("button", { name: "Agents · Squads", exact: true }).waitFor();
    await nav(page, "Agents · Squads", "agent-squad-view");
    await page.getByTestId("rail-agent-effort-probe").click();
    const reloadedEffort = page.getByTestId("agent-runtime-effort-codex");
    await reloadedEffort.waitFor();
    assert.equal(await reloadedEffort.inputValue(), "high");
    await shot("agent-runtime-effort-roundtrip");
  },
};
