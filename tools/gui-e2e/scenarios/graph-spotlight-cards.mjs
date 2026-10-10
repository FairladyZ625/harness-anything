import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/client";
import { nav } from "./helpers.mjs";

/**
 * 关系图聚光灯卡片避让(2026-10-10 业主反馈):围绕 task-gui-smoke 复现截图场景
 * —— 展开两张 FACT 卡片与一张 DECISION 卡片,屏幕坐标上任意两张卡片包围盒不相交;
 * Esc 收起后画布回收为 chip。种入路径走真实 fact-record RPC(F-ABCDEFGH 与
 * dec_gui_smoke 来自 lane 夹具)。已知坑:
 *   - 裸 RPC 没有 CLI 缺省:fact-record 必须带 confidence/memoryClass,且它在
 *     taskId 上自动建立 produces 关系(再 relation-relate 会 revision_conflict)。
 *   - 修复前的旧布局里,展开的卡片会盖住同列相邻 chip,Playwright hit-target
 *     检查拒绝点击被盖元素 —— 所以挑「列内最上/最下」两条 FACT(中间隔一个
 *     槽位)展开:旧布局两卡恰好上下叠压(业主截图形态),新布局两不相交。
 *   - 断言用 getBoundingClientRect(屏幕盒):仿射缩放下屏幕相交 ⇔ 流坐标相交。
 */

const SEED_STATEMENTS = [
  "聚光灯卡片避让 e2e 种入的观察甲:展开卡片不得互相重叠。",
  "聚光灯卡片避让 e2e 种入的观察乙:被挡节点要让开,收起后回收。",
];

async function rpc(endpoint, repoId, method, payload) {
  return requestDaemonJsonRpcAt(endpoint, method, { repo: { repoId }, payload }, 2_000, 30_000);
}

export default {
  id: "graph-spotlight-cards",
  feature: "graph-spotlight",
  lane: "isolated",
  description:
    "Spotlight cards expanded around a task (two FACTs and one DECISION) never overlap on screen and Esc collapses the canvas back to chips.",
  async run({ page, fixture, shot }) {
    const { endpoint, repoId } = fixture;

    // ——— 种两条 FACT + 一条 decision→task 边(真实写路径) ———
    // fact-record 在 taskId 上自动建立 produces 关系(再 relation-relate 同名边会
    // revision_conflict)。夹具的 derives 边是离线事件种入,投影判 current:false,
    // GUI 的 adaptRelationRows 收口会丢弃 —— 所以这里在线补一条 relates 边,
    // 让 DECISION 真正进入聚光灯邻域。
    for (const statement of SEED_STATEMENTS) {
      const recorded = await rpc(endpoint, repoId, "repo.task.run", {
        action: {
          kind: "fact-record",
          taskId: "task-gui-smoke",
          statement,
          evidenceSource: "graph-spotlight-cards e2e",
          confidence: "medium",
          memoryClass: "episodic",
        },
      });
      assert.equal(recorded.ok, true, `fact-record: ${JSON.stringify(recorded).slice(0, 300)}`);
    }
    const related = await rpc(endpoint, repoId, "repo.task.run", {
      action: {
        kind: "relation-relate",
        sourceRef: "decision/dec_gui_smoke",
        targetRef: "task/task-gui-smoke",
        relationType: "relates",
        rationale: "graph spotlight card avoidance e2e",
        expectedVersion: 0,
      },
    });
    assert.equal(related.ok, true, `relation-relate: ${JSON.stringify(related).slice(0, 300)}`);
    const factsRead = await rpc(endpoint, repoId, "repo.triadic.relationGraph", { facet: "facts", limit: 500 });
    for (const statement of SEED_STATEMENTS)
      assert.ok(
        (factsRead.facts ?? []).some((row) => row.text === statement),
        `seeded fact missing from the facts facet: ${statement}`,
      );

    // ——— 领地 → 聚光灯:单击 task chip 进入 ———
    await nav(page, /^(?:关系图|Graph)/u, "territory-zone");
    const taskChip = page.locator('[data-testid="territory-chip"][data-nav-ref="task/task-gui-smoke"]');
    await taskChip.waitFor();
    await taskChip.first().click();
    await page.getByTestId("ego-card").first().waitFor();

    // ——— 展开两张 FACT + 一张 DECISION ———
    const cardOverlaps = () =>
      page.evaluate(() => {
        const boxes = [...globalThis.document.querySelectorAll('[data-testid="ego-card"]')].map((el) => {
          const rect = el.getBoundingClientRect();
          const node = el.closest(".react-flow__node");
          return {
            id: node ? node.getAttribute("data-id") : "?",
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          };
        });
        const bad = [];
        for (let i = 0; i < boxes.length; i += 1)
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i];
            const b = boxes[j];
            if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
              bad.push(`${a.id}×${b.id}`);
          }
        return { bad, cards: boxes.length };
      });

    const factChips = page.locator('[data-testid="ego-chip"][data-entity="fact"]');
    // 夹具 F-ABCDEFGH + 两条种入 = 至少 3 条;取「最上/最下」两条展开(隔一个槽位)。
    const factCount = await factChips.count();
    assert.ok(factCount >= 3, `expected at least three fact chips, saw ${factCount}`);
    for (const pick of ["top", "bottom"]) {
      const order = await factChips.evaluateAll((els) =>
        els.map((el, index) => {
          const rect = el.getBoundingClientRect();
          return { index, top: rect.top };
        }),
      );
      order.sort((a, b) => a.top - b.top);
      const target = pick === "top" ? order[0] : order[order.length - 1];
      await factChips.nth(target.index).click();
      await page.waitForFunction(
        (expected) => globalThis.document.querySelectorAll('[data-testid="ego-card"]').length >= expected,
        pick === "top" ? 2 : 3,
      );
    }
    const decisionChip = page.locator('[data-testid="ego-chip"][data-entity="decision"]').first();
    await decisionChip.waitFor();
    await decisionChip.click();
    await page.waitForFunction(() => globalThis.document.querySelectorAll('[data-testid="ego-card"]').length >= 4);

    // 缩一点再截屏,让被让开的卡片进画面(截图展示用;断言在缩放后仍成立——
    // 仿射变换不改变相交性)。
    const canvas = page.locator(".react-flow");
    const canvasBox = await canvas.boundingBox();
    if (canvasBox) {
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, 480);
    }
    await shot("graph-cards-expanded");

    const { bad, cards } = await cardOverlaps();
    assert.deepEqual(bad, [], `expanded cards must not overlap on screen (${cards} cards)`);
    assert.ok(cards >= 4, `expected at least four cards (focus + 2 facts + decision), saw ${cards}`);

    // ——— Esc 收正文:全部回 chip,布局回收 ———
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => globalThis.document.querySelectorAll('[data-testid="ego-card"]').length === 0);
    await shot("graph-cards-collapsed");
  },
};
