import assert from "node:assert/strict";
import { bridgeReady, nav } from "./helpers.mjs";
import { guiE2eDispatchId } from "./sessions-grouping.mjs";

/**
 * 工作页与任务详情页的 W3-T1 验收(dec_C0AF8CBBFFECF71F4F34FB76F9 CH4):
 * ① 工作卡展开血缘与成本树:工作根汇总子树 Token/耗时,子孙任务与 Squad/Worker
 *    派工轮都在树上;② 点击子任务节点落到任务详情;③ 派工页签把派工轮渲染成
 *    AgentPlan 步骤(失败步带「从此步重试」);④ 关系页签的血缘树可再次下钻。
 *
 * 数据来自隔离 lane 的公共种子(tools/gui-e2e/scenarios/sessions-grouping.mjs):
 * task-e2e-work 是工作根,下挂 task-e2e-rounds(4 轮:1 成功/1 取消/1 成功/1 失败)
 * 与 task-e2e-single(1 轮成功)。不在这里另造前端夹具。
 */
const WORK_TASK = "task-e2e-work";
const ROUNDS_TASK = "task-e2e-rounds";
const STATUS_BY_ROUND = [
  ["round-1", "done"],
  ["round-2", "skipped"],
  ["round-3", "done"],
  ["round-4", "failed"],
];

export default {
  id: "work-lineage-task-execution",
  feature: "work-lineage",
  lane: "isolated",
  description:
    "Work cards expand into the lineage tree with subtree cost/duration rollup and task/session jumps; task detail renders dispatch rounds as timed plan steps with a failed-step retry.",
  async run({ page, shot }) {
    await bridgeReady(page);
    await nav(page, /^(?:工作|Work)$/u, "work-view");

    const toggle = page.getByTestId(`work-lineage-toggle-${WORK_TASK}`);
    await toggle.waitFor();
    await toggle.click();
    const tree = page.getByTestId(`work-lineage-tree-${WORK_TASK}`);
    await tree.waitFor();
    // 工作根 Rollup(Σ)与子孙任务/派工轮都在同一棵树上。
    await page.getByTestId(`work-lineage-tree-${WORK_TASK}-tree-row-task:${ROUNDS_TASK}`).waitFor();
    await page.getByTestId(`work-lineage-tree-${WORK_TASK}-tree-row-dispatch:${guiE2eDispatchId("round-4")}`).waitFor();
    // 410K(4 轮)+ 70K(单轮任务)= 480K;own 各计一次、父级自动 Σ 子树。
    assert.match(await tree.innerText(), /Σ 480K tok/u, "work root must roll up subtree token cost");
    await shot("work-lineage-tree");

    // 子任务节点 → 对应任务详情。
    await page.getByTestId(`work-lineage-tree-${WORK_TASK}-tree-row-task:${ROUNDS_TASK}`).click();
    await page.getByTestId("task-detail-view").waitFor();

    // 派工页签:每轮一个步骤,失败轮可从该步重试。
    await page.getByRole("tab", { name: /^(?:派工|Dispatch)$/u }).click();
    const plan = page.getByTestId("task-execution-plan");
    await plan.waitFor();
    for (const [round, status] of STATUS_BY_ROUND) {
      const step = page.getByTestId(`task-execution-plan-step-${guiE2eDispatchId(round)}`);
      await step.waitFor();
      assert.equal(await step.getAttribute("data-plan-status"), status, `${round} plan status`);
    }
    await page.getByTestId(`task-execution-plan-retry-${guiE2eDispatchId("round-4")}`).waitFor();
    await shot("task-execution-plan");

    // 关系页签:同一棵血缘树挂在任务详情里,派工轮节点可下钻。
    await page.getByRole("tab", { name: /^(?:关系|Relations)$/u }).click();
    await page.getByTestId("task-relations-lineage").waitFor();
    const relationsTree = page.getByTestId("task-relations-lineage-tree");
    await relationsTree.waitFor();
    await page.getByTestId(`task-relations-lineage-tree-row-dispatch:${guiE2eDispatchId("round-1")}`).waitFor();
    assert.match(await relationsTree.innerText(), /Σ 410K tok/u, "task lineage must roll up its dispatch rounds");
    await shot("task-relations-lineage");
  },
};
