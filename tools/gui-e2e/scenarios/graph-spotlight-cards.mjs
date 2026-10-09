import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/client";
import { nav } from "./helpers.mjs";

/**
 * 关系图聚光灯卡片避让(2026-10-10 业主反馈):围绕 task-gui-smoke 复现截图场景
 * —— 展开两张 FACT 卡片与一张 DECISION 卡片,屏幕坐标上任意两张卡片包围盒不相交;
 * Esc 收起后画布回收为 chip。种入路径全部走真实 RPC(fact-record + relation-relate),
 * 第二条 FACT 由本场景种;F-ABCDEFGH 与 dec_gui_smoke 来自 lane 夹具。
 * 已知坑:ego 展开只在单击发生(event.detail 1),按钮/链接点击都已 stopPropagation;
 * 断言用 getBoundingClientRect(屏幕盒)——仿射缩放下屏幕相交 ⇔ 流坐标相交。
 */

const SEED_STATEMENT = "聚光灯卡片避让 e2e 种入的第二条观察:展开卡片不得互相重叠。";

async function rpc(endpoint, repoId, method, payload) {
  const receipt = await requestDaemonJsonRpcAt(endpoint, method, { repo: { repoId }, payload }, 2_000, 30_000);
  return receipt;
}

export default {
  id: "graph-spotlight-cards",
  feature: "graph-spotlight",
  lane: "isolated",
  description:
    "Spotlight cards expanded around a task (two FACTs and one DECISION) never overlap on screen and Esc collapses the canvas back to chips.",
  async run({ page, fixture, shot }) {
    const { endpoint, repoId } = fixture;

    // ——— 种第二条 FACT 并挂 produces 边(真实写路径) ———
    const recorded = await rpc(endpoint, repoId, "repo.task.run", {
      action: {
        kind: "fact-record",
        taskId: "task-gui-smoke",
        statement: SEED_STATEMENT,
        evidenceSource: "graph-spotlight-cards e2e",
      },
    });
    assert.equal(recorded.ok, true, `fact-record: ${JSON.stringify(recorded).slice(0, 300)}`);
    const factsRead = await rpc(endpoint, repoId, "repo.triadic.relationGraph", { facet: "facts", limit: 500 });
    const seeded = (factsRead.facts ?? []).find((row) => row.text === SEED_STATEMENT);
    assert.ok(seeded, "seeded fact must appear in the facts facet");
    const related = await rpc(endpoint, repoId, "repo.task.run", {
      action: {
        kind: "relation-relate",
        sourceRef: "task/task-gui-smoke",
        targetRef: seeded.anchor,
        relationType: "produces",
        rationale: "graph spotlight card avoidance e2e",
        expectedVersion: 0,
      },
    });
    assert.equal(related.ok, true, `relation-relate: ${JSON.stringify(related).slice(0, 300)}`);

    // ——— 领地 → 聚光灯:单击 task chip 进入 ———
    await nav(page, /^(?:关系图|Graph)/u, "territory-zone");
    const taskChip = page.locator('[data-testid="territory-chip"][data-nav-ref="task/task-gui-smoke"]');
    await taskChip.waitFor();
    await taskChip.first().click();
    await page.getByTestId("ego-card").first().waitFor();

    // ——— 依次展开两张 FACT + 一张 DECISION(每步之后都必须两两不相交) ———
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
    const expectDisjoint = async () => {
      const { bad, cards } = await cardOverlaps();
      assert.deepEqual(bad, [], `expanded cards must not overlap on screen (${cards} cards)`);
      return cards;
    };

    const factChips = page.locator('[data-testid="ego-chip"][data-entity="fact"]');
    // 基夹具的 F-ABCDEFGH + 本场景种入的第二条事实;夹具数据变化时如实报数,不硬编码 2。
    const factCount = await factChips.count();
    assert.ok(factCount >= 2, `expected at least two fact chips, saw ${factCount}`);
    for (let index = 0; index < 2; index += 1) {
      await factChips.nth(index).click();
      await page.waitForFunction(
        () => globalThis.document.querySelectorAll('[data-testid="ego-card"]').length >= 2 + index + 1,
      );
      await expectDisjoint();
    }
    const decisionChip = page.locator('[data-testid="ego-chip"][data-entity="decision"]').first();
    await decisionChip.waitFor();
    await decisionChip.click();
    await page.waitForFunction(() => globalThis.document.querySelectorAll('[data-testid="ego-card"]').length >= 4);
    const totalCards = await expectDisjoint();
    assert.ok(totalCards >= 4, `expected at least four cards (focus + 2 facts + decision), saw ${totalCards}`);

    // 缩一点再截屏,让被让开的卡片进画面(断言与截屏独立,断言已在上一步)。
    const canvas = page.locator(".react-flow");
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, 480);
    }
    await shot("graph-cards-expanded");

    // ——— Esc 收正文:全部回 chip,布局回收 ———
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => globalThis.document.querySelectorAll('[data-testid="ego-card"]').length === 0);
    await shot("graph-cards-collapsed");
  },
};
