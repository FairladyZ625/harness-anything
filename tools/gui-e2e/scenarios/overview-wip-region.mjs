import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { createRealizedTaskPlanFixture } from "../../fixtures/task-plan.mjs";
import { nav } from "./helpers.mjs";

// The WIP drill is a tab with an inline list (2026-10-07 rework): every counted task is visible
// on the region itself and clicking a row navigates directly to task detail. Wait for actual
// projection transforms to settle before measuring after returning to the overview.
export async function settledWipGeometry(page) {
  await page.waitForFunction(() => {
    const drill = globalThis.document.querySelector('[data-testid="overview-region-drill"]');
    return (
      drill !== null &&
      [...drill.querySelectorAll("section, section > div")].every(
        (node) => globalThis.getComputedStyle(node).transform === "none",
      )
    );
  });
  const geometry = await page.getByTestId("overview-region-drill").evaluate((region) => {
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, right: rect.right, width: rect.width, scrollLeft: node.scrollLeft };
    };
    const section = region.querySelector("section");
    const title = section.querySelector("h2");
    const entry = region.querySelector('[data-testid="overview-drill-wip"]');
    return {
      viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
      region: box(region),
      section: box(section),
      title: box(title),
      titleFits: title.scrollWidth <= title.clientWidth,
      entry: entry === null ? null : box(entry),
      scrollLefts: [...region.querySelectorAll("section, section > div, [data-region-scroll]")].map(
        (node) => node.scrollLeft,
      ),
    };
  });
  assertWipGeometry(geometry);
  return geometry;
}

export function assertWipGeometry(geometry) {
  for (const box of [geometry.section, geometry.title, ...(geometry.entry ? [geometry.entry] : [])]) {
    assert.ok(
      box.x >= geometry.region.x - 1 && box.right <= geometry.region.right + 1,
      `WIP entry must stay inside its region: ${JSON.stringify(geometry)}`,
    );
  }
  assert.ok(geometry.titleFits, "drill region title must be fully readable");
  assert.ok(
    geometry.scrollLefts.every((left) => left === 0),
    "drill region must not scroll horizontally",
  );
}

/**
 * 总览「执行与下钻」WIP tab(#task_88003efc 三块区域返工后;W2-T1 task_097108d2 改接
 * AgentLanes):tab 计数仍带 WIP 占用/上限(来自 daemon 快照),但 tab 下不再是静态平铺
 * 名单,而是按 agent 分泳道的实时时间线——近期收口/运行块直接可见,旧 data-drill-row
 * 行必须消失。占用数、上限从 daemon 快照读出,泳道块来自隔离 lane 预置的近期派工夹具。
 */
export default {
  id: "overview-wip-region",
  feature: "overview",
  lane: "isolated",
  description:
    "The WIP drill tab still shows daemon occupancy, but the inline flat list is replaced by AgentLanes: " +
    "the seeded recent dispatch renders as a lane block and the legacy data-drill-row list is gone.",
  async run({ page, fixture, shot }) {
    const started = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.start",
      { repo: { repoId: fixture.repoId }, payload: { taskId: "task-gui-smoke", executionId: "exec-overview-wip-e2e" } },
      2_000,
      10_000,
    );
    assert.equal(started.ok, true, "fixture task must start through the real write path");
    // 两条导航用占位:让「点第 N 行保持 N」与「过滤后键盘只在可见集合」在 ≥3 行的名单上可判。
    for (const [taskId, title] of [
      ["task-wip-nav-a", "占位导航甲"],
      ["task-wip-nav-b", "占位导航乙"],
    ]) {
      await createRealizedTaskPlanFixture(
        fixture.rootDir,
        () =>
          requestDaemonJsonRpcAt(
            fixture.endpoint,
            "repo.task.create",
            { repo: { repoId: fixture.repoId }, payload: { taskId, title } },
            2_000,
            30_000,
          ),
        (planPath) =>
          requestDaemonJsonRpcAt(
            fixture.endpoint,
            "repo.task.run",
            { repo: { repoId: fixture.repoId }, payload: { action: { kind: "doc-submit", paths: [planPath] } } },
            2_000,
            30_000,
          ),
        title,
      );
      const occupied = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.task.start",
        { repo: { repoId: fixture.repoId }, payload: { taskId, executionId: `exec-${taskId}` } },
        2_000,
        10_000,
      );
      assert.equal(occupied.ok, true, `${taskId} must start through the real write path`);
    }
    await nav(page, /^(?:总览|Overview)$/u, "overview-view");
    const drill = page.getByTestId("overview-region-drill");
    await drill.waitFor();

    // The fixture is stable: wait for the page to render its authoritative snapshot.
    const snapshot = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.tasks.wip",
      { repo: { repoId: fixture.repoId } },
      2_000,
      10_000,
    );
    const wipTab = drill.getByTestId("overview-drill-wip");
    await wipTab.waitFor({ timeout: 10_000 });
    // tab 上的占用数必须来自 daemon 快照,不写死。
    await page.waitForFunction(
      ([count, limit]) => {
        const chip = globalThis.document.querySelector('[data-testid="overview-drill-wip"]');
        return chip !== null && chip.textContent.includes(`${count}/${limit}`);
      },
      [snapshot.counted.length, snapshot.limit],
      { timeout: 10_000 },
    );

    // W2-T1:旧静态平铺名单被 AgentLanes 替代——WIP tab 下不再有 data-drill-row 旧行。
    assert.equal(
      await page.locator('[data-testid="overview-drill-list"] [data-drill-row]').count(),
      0,
      "the legacy flat WIP list must not render beside AgentLanes",
    );
    // 隔离 lane 预置了 30 分钟前收口的一轮(task-e2e-lanes):总览 6h 窗口内必有泳道块。
    const lanes = page.getByTestId("overview-agent-lanes");
    await lanes.waitFor({ timeout: 15_000 });
    await page.waitForFunction(
      () => globalThis.document.querySelectorAll('[data-testid^="overview-agent-lanes-task-"]').length > 0,
      null,
      { timeout: 15_000 },
    );
    const blockStates = await page.evaluate(() =>
      [...globalThis.document.querySelectorAll('[data-testid^="overview-agent-lanes-task-"]')].map((block) =>
        block.getAttribute("data-lane-status"),
      ),
    );
    // 已收口块必须有确定状态(不冒充运行中):夹具那一轮是 succeeded → done。
    assert.ok(blockStates.includes("done"), `the seeded settled round must render as done: ${blockStates}`);
    await shot("overview-wip-lanes");

    await settledWipGeometry(page);
    await shot("overview-wip-settled");
  },
};
