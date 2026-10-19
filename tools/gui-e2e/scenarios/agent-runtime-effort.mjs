import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

// 界面语言随宿主:navigator.language 非英文时默认 zh-CN,所以导航名按双语匹配,
// 不假设跑在英文环境(业主机器与 CI 的默认语言不同)。
const AGENTS_SQUADS = /^(?:Agent · 含 Squad|Agents · Squads)$/u;

export default {
  id: "agent-runtime-effort",
  feature: "agent-runtime",
  lane: "isolated",
  description: "Agent runtime effort can be set in the declaration editor and survives a daemon read after reload.",
  // 空白 Agent 的 agent/runtime-compatibility 判据要求仓里至少有一个启用的运行时实例;
  // 后面的「+ codex / agent-runtime-effort-codex」也需要 codex 的 witness 安装。
  runtimeInstance: {
    instanceId: "codex-effort",
    name: "Codex effort",
    kindId: "codex",
    providerId: "openai",
    models: ["test-model"],
    enabled: true,
    permissionMode: "read-only",
    codex: {},
  },
  async run({ page, app, shot }) {
    const hidden = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    );
    assert.equal(hidden, true);

    await nav(page, AGENTS_SQUADS, "agent-squad-view");
    await page.getByTestId("runtime-new-agents").click();
    const dialog = page.getByTestId("new-agent-dialog");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: /Blank|空白/u }).click();
    await page.getByTestId("new-agent-id").fill("effort-probe");
    await page.getByTestId("new-agent-name").fill("Effort probe");
    await page.getByTestId("new-agent-create").click();

    await page.getByTestId("rail-agent-effort-probe").waitFor();
    await page.getByRole("button", { name: /^\+\s*codex$/u }).click();
    const effort = page.getByTestId("agent-runtime-effort-codex");
    await effort.waitFor();
    assert.equal(await effort.inputValue(), "");
    await effort.selectOption("high");
    const save = page.getByTestId("agent-save");
    assert.equal(await save.isEnabled(), true);
    await save.click();
    await page.waitForFunction((button) => /Saved|已保存/u.test(button.textContent ?? ""), await save.elementHandle());

    await page.reload();
    await page.getByRole("button", { name: AGENTS_SQUADS }).waitFor();
    await nav(page, AGENTS_SQUADS, "agent-squad-view");
    await page.getByTestId("rail-agent-effort-probe").click();
    const reloadedEffort = page.getByTestId("agent-runtime-effort-codex");
    await reloadedEffort.waitFor();
    assert.equal(await reloadedEffort.inputValue(), "high");
    await shot("agent-runtime-effort-roundtrip");
  },
};
