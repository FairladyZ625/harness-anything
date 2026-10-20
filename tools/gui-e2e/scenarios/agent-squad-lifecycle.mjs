import assert from "node:assert/strict";
import { nav } from "./helpers.mjs";

// 界面语言随宿主:navigator.language 非英文时默认 zh-CN,所以控件名按双语匹配。
const AGENTS_SQUADS = /^(?:Agent · 含 Squad|Agents · Squads)$/u,
  IN_USE = /^(?:在用|In use)\s*\d+$/u,
  RETIRED = /^(?:已退役|Retired)\s*\d+$/u;

// Agent·Squad 页四项修复的验收(task_3c098ffe):筛选弹层宽度、候选模型清单型 model 的
// 行标签、退役分类、退役对话框与被引用删除禁用。种子走渲染层的 GUI 通道
// (harness.request)——与产品写路同一条,不另造种子路径。
async function setSize(app, page, width, height) {
  const actual = await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(size.width, size.height);
      return window.getContentSize();
    },
    { width, height },
  );
  await page.setViewportSize({ width: actual[0], height: actual[1] });
  await page.waitForFunction(([w, h]) => globalThis.innerWidth === w && globalThis.innerHeight === h, actual);
}

export default {
  id: "agent-squad-lifecycle",
  feature: "agent-squad",
  lane: "isolated",
  description:
    "The Agents & Squads filter popup stays wide at both window widths, candidate-list models read as first-candidate +N, retired agents form their own counted category, and the detail actions retire (reason required) and disable deletion of a referenced agent.",
  // 候选清单型 model 字符串必须与启用实例的 models 精确匹配才会过安装校验,
  // 所以实例目录同时列出候选串与单模型。
  runtimeInstance: {
    instanceId: "deepseek-gui",
    name: "DeepSeek Harness",
    kindId: "deepseek-harness",
    providerId: "deepseek",
    models: ['["deepseek-account","deepseek-flash"]', "deepseek-account"],
    enabled: true,
    permissionMode: "read-only",
    "deepseek-harness": {},
  },
  async run({ page, app, shot, fixture }) {
    const hidden = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    );
    assert.equal(hidden, true);
    const repoId = fixture.repoId,
      candidates = '["deepseek-account","deepseek-flash"]';
    const seeded = await page.evaluate(
      async ([repoIdValue, candidatesValue]) => {
        const request = (method, payload) => globalThis.harness.request(method, { repoId: repoIdValue, ...payload });
        const receipts = [];
        receipts.push(
          await request("saveAgent", {
            declaration: {
              schema: "agent-declaration/v1",
              id: "deepseek-reviewer",
              name: "DeepSeek Harness · 独立评审 Reviewer",
              instructions: "Review precisely.",
              runtimes: [{ type: "deepseek-harness", model: candidatesValue }],
              instance: "deepseek-gui",
            },
          }),
        );
        receipts.push(
          await request("saveAgent", {
            declaration: {
              schema: "agent-declaration/v1",
              id: "terra",
              name: "Terra",
              instructions: "Work the mission.",
              runtimes: [{ type: "deepseek-harness", model: "deepseek-account" }],
            },
          }),
        );
        receipts.push(
          await request("saveAgent", {
            declaration: {
              schema: "agent-declaration/v1",
              id: "luna",
              name: "Luna",
              instructions: "Retired fixture identity.",
              runtimes: [{ type: "deepseek-harness", model: "deepseek-account" }],
            },
          }),
        );
        receipts.push(
          await request("retireAgent", {
            agentId: "luna",
            reason: "Superseded by terra.",
            successor: "terra",
          }),
        );
        receipts.push(
          await request("saveSquad", {
            declaration: {
              schema: "squad-declaration/v1",
              id: "core-squad",
              name: "Core Squad",
              leader: "terra",
              workers: ["terra"],
              leaderTurnBudget: 4,
              roster: "# Core Squad\n",
            },
          }),
        );
        return receipts.map((receipt) => ({ ok: receipt.ok, outcome: receipt.outcome }));
      },
      [repoId, candidates],
    );
    for (const receipt of seeded) assert.equal(receipt.outcome, "applied", JSON.stringify(seeded));

    await nav(page, AGENTS_SQUADS, "agent-squad-view");

    // ① 筛选弹层:宽窗口与窄窗口下都是横排可读的弹层(宽度由工具栏行约束,
    //    不再被按钮容器压成窄条)。chips 的实测高度证明没有逐字竖排。
    const popupGeometry = () =>
      page.evaluate(() => {
        const popup = globalThis.document.querySelector('[data-testid="agent-squad-filter-bar"] [role="dialog"]');
        if (popup === null) return null;
        const chips = [...popup.querySelectorAll("button")];
        const tallestChip = Math.max(...chips.map((chip) => chip.offsetHeight));
        return { width: popup.offsetWidth, tallestChip, chips: chips.length };
      });
    await page.getByTestId("agent-squad-filter-toggle").click();
    let geometry = await popupGeometry();
    assert.ok(geometry !== null, "filter popup must be open");
    assert.equal(geometry.width >= 240, true, `popup width ${geometry.width}`);
    assert.equal(geometry.tallestChip <= 40, true, `tallest chip ${geometry.tallestChip}`);
    assert.equal(geometry.chips >= 4, true, `chip count ${geometry.chips}`);
    await shot("agent-squad-filter-popup");
    // 焦点可能不在弹层内(在 toggle 按钮上),Esc 是 no-op;开合一律走 toggle 本身。
    await page.getByTestId("agent-squad-filter-toggle").click();
    await setSize(app, page, 640, 720);
    await page.getByTestId("agent-squad-filter-toggle").click();
    geometry = await popupGeometry();
    assert.ok(geometry !== null, "narrow filter popup must be open");
    assert.equal(geometry.width >= 240, true, `narrow popup width ${geometry.width}`);
    assert.equal(geometry.tallestChip <= 40, true, `narrow tallest chip ${geometry.tallestChip}`);
    await shot("agent-squad-filter-popup-narrow");
    await page.getByTestId("agent-squad-filter-toggle").click();
    await setSize(app, page, 1440, 900);

    // ② 候选清单型 model:行上是「首候选 +N」,名字列完整,整串 JSON 不上栏。
    await page.getByTestId("rail-agent-deepseek-reviewer").waitFor();
    const deepseekRowText = (await page.getByTestId("rail-agent-deepseek-reviewer").innerText()).replace(/\n/gu, " ");
    assert.match(deepseekRowText, /deepseek-account\s*\+1/u);
    assert.match(deepseekRowText, /Reviewer/u);
    assert.doesNotMatch(deepseekRowText, /deepseek-flash/u);
    await shot("deepseek-candidates-row");
    // 详情:候选完整逐项列出。
    await page.getByTestId("rail-agent-deepseek-reviewer").click();
    const candidateTags = page.getByTestId("agent-runtime-model-candidates-deepseek-harness");
    await candidateTags.waitFor();
    const candidateText = await candidateTags.innerText();
    assert.match(candidateText, /deepseek-account/u);
    assert.match(candidateText, /deepseek-flash/u);
    await shot("deepseek-candidates-detail");

    // ③ 退役分类:默认不混退役项,筛选里有带计数的「已退役」,退役行显示接替者。
    assert.equal((await page.getByTestId("rail-agent-luna").count()) === 0, true);
    await page.getByTestId("agent-squad-filter-toggle").click();
    const retiredChip = page.getByTestId("agent-squad-filter-lifecycle").getByRole("button", { name: RETIRED });
    await retiredChip.click();
    await page.getByTestId("rail-agent-luna").waitFor();
    const retiredRowText = (await page.getByTestId("rail-agent-luna").innerText()).replace(/\n/gu, " ");
    assert.match(retiredRowText, /→\s*terra/u);
    await shot("retired-category");
    await page.getByTestId("agent-squad-filter-lifecycle").getByRole("button", { name: IN_USE }).click();
    await page.getByTestId("agent-squad-filter-toggle").click();

    // ④ 详情动作:被引用的 Agent 删除禁用并说明只能退役;退役对话框必填原因。
    await page.getByTestId("rail-agent-terra").click();
    const deleteEntry = page.getByTestId("agent-delete-entry");
    await deleteEntry.waitFor();
    assert.equal(await deleteEntry.isEnabled(), false, "referenced agent delete must be disabled");
    assert.match(await page.getByTestId("agent-card-terra").innerText(), /只能退役|retire instead of deleting/u);
    await shot("delete-referenced-disabled");
    await page.getByTestId("agent-retire-entry").click();
    const dialog = page.getByTestId("retire-agent-dialog");
    await dialog.waitFor();
    const confirm = page.getByTestId("retire-agent-confirm");
    assert.equal(await confirm.isEnabled(), false, "retire confirm requires a reason");
    await shot("retire-agent-dialog");
    await page.getByRole("button", { name: /^(?:取消|Cancel)$/u }).click();
  },
};
