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
 * 总览「执行与下钻」WIP tab(#task_88003efc 三块区域返工后):tab 计数带占用/上限,tab 下
 * 是内联名单——每个占位任务直接可见、注意力分排序、区内滚动;点行弹既有放大层并选中
 * 该行。占用数、上限、名单长度全部从 daemon 快照读出,不在场景里写死。夹具任务经
 * repo.task.start 真实写路占位(planned 不占位,先启动)。
 */
export default {
  id: "overview-wip-region",
  feature: "overview",
  lane: "isolated",
  description:
    "The WIP drill tab shows the daemon occupancy and lists every counted task inline on the region " +
    "(attention order, in-region scroll); clicking a row navigates directly to that task's detail.",
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

    // 内联名单与 daemon 快照逐 ID 一致(顺序按注意力分,不比顺序):不再是「点开才有内容」。
    await page.waitForFunction(
      ({ ids }) => {
        const rows = [...globalThis.document.querySelectorAll('[data-testid="overview-drill-list"] [data-drill-row]')];
        return rows.length > 0 && rows.length === ids.length;
      },
      { ids: snapshot.counted },
      { timeout: 10_000 },
    );
    const inlineIds = await page.evaluate(() =>
      [...globalThis.document.querySelectorAll('[data-testid="overview-drill-list"] [data-drill-row]')].map((row) =>
        row.getAttribute("data-drill-row"),
      ),
    );
    assert.deepEqual(
      [...inlineIds].sort(),
      snapshot.counted.map(({ taskId }) => taskId).sort(),
      "the inline drill list must show every counted task",
    );

    // 点行直接进入对应任务详情；当前产品路由不打开 focus dialog。
    const pickedId = inlineIds[0];
    await drill.locator(`[data-drill-row="${pickedId}"]`).getByRole("button").first().click();
    // 行入口直接打开真实任务详情；从详情页头返回总览后继续验证紧凑入口几何。
    await page.getByTestId("task-detail-view").waitFor();
    await shot("overview-wip-task-detail");

    await page
      .getByTestId("task-detail-header")
      .getByRole("button", { name: /^(?:总览|Overview)$/u })
      .click();
    await page.getByTestId("overview-region-drill").waitFor();
    await settledWipGeometry(page);
    await shot("overview-wip-settled");
  },
};
