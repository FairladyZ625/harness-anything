import assert from "node:assert/strict";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { createRealizedTaskPlanFixture } from "../../fixtures/task-plan.mjs";
import { nav } from "./helpers.mjs";

// The WIP drill is a tab with an inline list (2026-10-07 rework): every counted task is visible
// on the region itself; clicking a row opens the focus layer with that row selected. Dialog
// detachment precedes the region's return to a settled state — wait for actual projection
// transforms to settle before measuring.
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
    "(attention order, in-region scroll); clicking a row opens the focus layer with that row selected, " +
    "keeps arrow-key navigation inside the filtered visible set, and navigates a row to task detail.",
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

    // 点行 → 放大层开着且选中的就是被点的那行(名单在层里,分组/搜索接管过滤)。
    const pickedId = inlineIds[0];
    await drill.locator(`[data-drill-row="${pickedId}"]`).getByRole("button").first().click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor();
    const list = dialog.getByTestId("overview-task-wip-list");
    await list.waitFor();
    await page.waitForFunction(
      (id) =>
        globalThis.document
          .querySelector("[data-focus-list] [data-dense-row][data-selected]")
          ?.getAttribute("title") === id,
      pickedId,
      { timeout: 10_000 },
    );

    // 放大层名单与 daemon 快照逐 ID 一致(顺序按状态重排,不比顺序)。
    await page.waitForFunction(
      ({ ids }) => {
        const rows = [...globalThis.document.querySelectorAll("[data-focus-list] [data-dense-row]")];
        const actual = rows
          .map((row) => {
            const title = row.querySelector("button[title*='task/']")?.getAttribute("title") ?? "";
            return title.slice(title.lastIndexOf("task/") + "task/".length);
          })
          .sort();
        return rows.length > 0 && JSON.stringify(actual) === JSON.stringify(ids);
      },
      { ids: snapshot.counted.map((entry) => entry.taskId).sort() },
      { timeout: 10_000 },
    );

    // 入口开放大层落选首行;放大层过滤后 ↑↓ 只在可见集合移动(隐藏的行不可被键盘选中)。
    const selectionStateOf = () =>
      dialog.locator("[data-focus-list] [data-dense-row]").evaluateAll((rows) =>
        rows.map((row) => ({
          selected: row.hasAttribute("data-selected"),
          id: (() => {
            const title = row.querySelector("button[title*='task/']")?.getAttribute("title") ?? "";
            return title.slice(title.lastIndexOf("task/") + "task/".length);
          })(),
        })),
      );
    let visible = await selectionStateOf();
    assert.equal(visible.filter(({ selected }) => selected).length, 1, "exactly one selected row after opening");
    assert.equal(visible[0]?.selected, true, "opening from the entry selects the first row");

    // 搜索把首行藏起,选中收敛到首个可见行;↓ 只在可见集合移动。
    await dialog.getByTestId("overview-task-wip-search").fill("占位导航");
    visible = await selectionStateOf();
    let visibleIds = visible.map(({ id }) => id);
    assert.deepEqual(visibleIds, ["task-wip-nav-a", "task-wip-nav-b"], "search must hide the non-matching row");
    await dialog.getByTestId("overview-task-wip-search").fill("导航甲");
    visible = await selectionStateOf();
    visibleIds = visible.map(({ id }) => id);
    assert.deepEqual(visibleIds, ["task-wip-nav-a"], "narrowing search must leave one visible row");
    assert.equal(visible[0]?.selected, true, "selection must clamp to the first visible row when hidden");
    await dialog.getByTestId("overview-task-wip-search").fill("占位导航");
    await page.keyboard.press("ArrowDown");
    const keyed = (await selectionStateOf()).filter(({ selected }) => selected).map(({ id }) => id);
    assert.deepEqual(keyed, ["task-wip-nav-b"], "arrow key must move to the next visible row");
    assert.notEqual(keyed[0], "task-gui-smoke", "a row hidden by the filter must not be selectable via keyboard");

    // 行点击 → 详情「打开任务」→ 真实任务详情;从详情页头的「总览」返回路径回到总览,
    // 再量紧凑入口的几何(侧栏也有同名「总览」按钮,nav helper 的严格定位会撞二义)。
    await dialog.getByTestId("overview-task-wip-search").fill("导航甲");
    await dialog.getByRole("button", { name: /打开任务|Open task/u }).click();
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
