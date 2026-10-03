import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

/**
 * task_fb3ba20d66…:原页面内容区域可调布局的 Electron 实测(isolated lane)。
 *
 * 覆盖两处真实消费:
 *   1) 任务详情「文件树|正文」——默认自适应(无分隔条/内联模板);左右排列后拖真实
 *      指针调比例(窗口缩放后有界)、键盘微调、刷新记忆、折叠/召回、上下排列、重置回
 *      自适应;树里塞 120 个种子文件,展开后树在自己窗内滚动、不挤死正文。
 *   2) 工作概况「主区|最近进展」——通过 daemon 真实建一个子任务让夹具根任务成为工作根
 *      (时间线来自 triadic 种子的 fact 事件),拖真实指针调比例、刷新记忆、重置。
 *
 * 种法全部走隔离 daemon 的公共 RPC(repo.task.create / doc-submit / task-delete 软删),
 * 不碰夹具账本文件;场景结束删掉子任务,不留状态给后续场景。
 */

const CHILD_TASK_ID = "task-split-child",
  CHILD_TITLE = "分割布局子任务",
  SEED_FILES = 120;

async function setSize(app, page, width, height) {
  // Electron evaluate 不收额外参数(capture.mjs 同因),尺寸用字面量注入。
  await app.evaluate(`({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(${width}, ${height}); }`);
  // Hidden Electron does not reliably resize its renderer with the native window.
  await page.setViewportSize({ width, height });
  await page.waitForFunction((expected) => globalThis.innerWidth === expected, width);
}

/** 真实几何:两个 testid 盒子的宽/高与容器(去掉 6px 分隔条)的占比。 */
async function paneRatios(page, containerId, firstId, secondId, axis) {
  return page.evaluate(
    ([containerSelector, firstSelector, secondSelector, direction]) => {
      const pick = (selector) => {
        const element = globalThis.document.querySelector(selector);
        if (element === null) throw new Error(`missing element ${selector}`);
        return element.getBoundingClientRect();
      };
      const box = pick(containerSelector),
        first = pick(firstSelector),
        second = pick(secondSelector),
        span = (rect) => (direction === "row" ? rect.width : rect.height);
      const total = span(box) - 6;
      return {
        container: span(box),
        first: span(first),
        second: span(second),
        firstRatio: span(first) / total,
        secondRatio: span(second) / total,
      };
    },
    [`[data-testid="${containerId}"]`, `[data-testid="${firstId}"]`, `[data-testid="${secondId}"]`, axis],
  );
}

async function dragDivider(page, testId, delta, axis) {
  const handle = page.locator(`[data-testid="${testId}"]`);
  await handle.waitFor();
  const box = await handle.boundingBox();
  assert.ok(box, `divider ${testId} has no box`);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // 分几步走,模拟真实拖拽的 pointermove 序列。
  const steps = 8;
  for (let index = 1; index <= steps; index += 1) {
    await page.mouse.move(
      x + (axis === "row" ? (delta * index) / steps : 0),
      y + (axis === "row" ? 0 : (delta * index) / steps),
    );
  }
  await page.mouse.up();
}

async function openChildDetail(page) {
  await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
  const card = page.getByTestId("board-task-card").filter({ hasText: CHILD_TITLE }).first();
  await card.waitFor({ timeout: 20_000 });
  await card.click();
  await page.getByRole("button", { name: /打开完整详情|Open full details/u }).click();
  await page.getByTestId("task-detail-view").waitFor();
  await page.getByTestId("task-document-tree").waitFor();
}

/** 展开种子目录并等到树真的滚出窗(投影落定与点击有竞态,有界重试)。 */
async function expandSeedTree(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page
      .getByTestId("task-document-tree")
      .getByRole("button", { name: /split\//u })
      .click();
    try {
      await page.waitForFunction(
        () => {
          const node = globalThis.document.querySelector('[data-testid="task-document-tree-scroll"]');
          return node !== null && node.scrollHeight > node.clientHeight + 8;
        },
        null,
        { timeout: 3_000 },
      );
      return;
    } catch {
      // 展开态被清单落定重置,重试。
    }
  }
  throw new Error("seeded 120-file tree never stays expanded long enough to measure");
}

export default {
  id: "page-split-layout",
  feature: "split-layout",
  lane: "isolated",
  description:
    "Task detail and work overview panes resize by real drag with clamped ratios, keyboard steps, reload persistence, collapse and reset.",
  async run({ page, app, shot, fixture }) {
    const { endpoint, repoId, rootDir } = fixture;
    let cleanupError;

    // ---- 种子:子任务(让夹具根任务成为工作根)+ 120 个任务包文件喂文件树。 ----
    const created = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.create",
      {
        repo: { repoId },
        payload: { taskId: CHILD_TASK_ID, title: CHILD_TITLE, parentTaskId: "task-gui-smoke" },
      },
      1_000,
      30_000,
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    const packagePath = String(created.packagePath);
    const seedDir = path.join(rootDir, "harness", packagePath, "split");
    mkdirSync(seedDir, { recursive: true });
    const paths = [];
    for (let index = 0; index < SEED_FILES; index += 1) {
      const relative = `split/seed-${index}.md`;
      writeFileSync(
        path.join(rootDir, "harness", packagePath, relative),
        `# 种子文件 ${index}\n\n给文件树一个真实的长列表:第 ${index} 号占位正文。\n`,
      );
      paths.push(`${packagePath}/${relative}`);
    }
    const submitted = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.run",
      {
        repo: { repoId },
        payload: { action: { kind: "doc-submit", paths } },
      },
      1_000,
      60_000,
    );
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));

    try {
      await setSize(app, page, 1440, 900);
      await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
      await openChildDetail(page);
      // 等文件清单投影追平:树里出现种子目录。
      await page.getByTestId("task-document-tree").filter({ hasText: "split/" }).waitFor({ timeout: 30_000 });

      // ---- 任务详情:默认自适应,分隔条直接可拖。 ----
      const grid = page.getByTestId("task-detail-content-grid");
      assert.notEqual(await grid.evaluate((node) => node.style.gridTemplateColumns), "");
      assert.equal(await page.locator('[data-testid="task-doc-split-divider"]').count(), 1);
      await shot("task-split-auto-wide");
      // 自适应宽屏:树与正文按比例分配,首次拖动不跳变。
      let ratios = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "row",
      );
      assert.ok(Math.abs(ratios.firstRatio - 0.22) < 0.02, `auto proportional tree ${ratios.firstRatio}`);
      await dragDivider(page, "task-doc-split-divider", 20, "row");
      const firstDrag = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "row",
      );
      assert.ok(
        Math.abs(firstDrag.first - ratios.first - 20) < 4,
        `first drag must move only its pointer delta: ${firstDrag.first - ratios.first}`,
      );
      await page.getByTestId("task-doc-split-controls-reset").click();

      // ---- 左右排列:显式接管,默认 22%;展开 120 个文件,树在窗内滚、外部几何不变。 ----
      await page.getByTestId("task-doc-split-controls-row").click();
      await page.getByTestId("task-doc-split-divider").waitFor();
      ratios = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "row",
      );
      assert.ok(Math.abs(ratios.firstRatio - 0.22) < 0.03, `row default ratio, got ${ratios.firstRatio}`);
      const gridHeightBefore = await page
        .getByTestId("task-detail-content-grid")
        .evaluate((node) => node.getBoundingClientRect().height);
      await expandSeedTree(page);
      const treeScroll = page.getByTestId("task-document-tree-scroll");
      const treeGeometry = await treeScroll.evaluate((node) => {
        const gridBox = node.closest('[data-testid="task-detail-content-grid"]');
        node.scrollTop = node.scrollHeight;
        return {
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
          gridHeight: gridBox === null ? 0 : gridBox.getBoundingClientRect().height,
        };
      });
      assert.ok(
        treeGeometry.scrollHeight > treeGeometry.clientHeight,
        "expanded 120-file tree must scroll inside its pane",
      );
      assert.ok(Math.abs(treeGeometry.gridHeight - gridHeightBefore) < 2, "expanding the tree must not grow the card");
      await shot("task-split-row-expanded");

      // ---- 真实指针拖拽:拉到约 45%;窗口缩放后仍按比例(有界)。 ----
      const before = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "row",
      );
      await dragDivider(
        page,
        "task-doc-split-divider",
        Math.round((0.45 - before.firstRatio) * before.container),
        "row",
      );
      let after = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "row",
      );
      assert.ok(Math.abs(after.firstRatio - 0.45) < 0.04, `dragged ratio, got ${after.firstRatio}`);
      await setSize(app, page, 1000, 800);
      after = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "row",
      );
      assert.ok(Math.abs(after.firstRatio - 0.45) < 0.04, `resized ratio stays bounded, got ${after.firstRatio}`);
      await setSize(app, page, 1440, 900);
      await shot("task-split-row-dragged");

      // ---- 键盘微调:分隔条聚焦后 → 加 16px。 ----
      const handle = page.getByTestId("task-doc-split-divider");
      await handle.focus();
      const panePx = (
        await paneRatios(page, "task-detail-content-grid", "task-document-tree", "task-detail-panel-scroll", "row")
      ).first;
      await handle.press("ArrowRight");
      after = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "row",
      );
      assert.ok(Math.abs(after.first - (panePx + 16)) < 2, `keyboard step, got ${after.first} after ${panePx}`);
      assert.equal(await handle.getAttribute("role"), "separator");

      // ---- 拖到极限有界:首窗不超过 75%。 ----
      await dragDivider(page, "task-doc-split-divider", 4000, "row");
      after = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "row",
      );
      assert.ok(after.firstRatio <= 0.75 + 0.01, `clamped max ratio, got ${after.firstRatio}`);
      assert.ok(after.secondRatio >= 0.25 - 0.01, "content pane stays usable");

      // ---- 刷新记忆:重载后仍是显式左右与拖过的比例。 ----
      const persisted = after.firstRatio;
      await page.reload();
      await page.getByTestId("task-detail-view").waitFor({ timeout: 30_000 });
      await page.getByTestId("task-doc-split-divider").waitFor();
      after = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "row",
      );
      assert.ok(Math.abs(after.firstRatio - persisted) < 0.02, `ratio survives reload, got ${after.firstRatio}`);

      // ---- 上下排列:模板换轴,分隔条横置;已拖比例跟随(切换排列保留用户比例),
      //      再纵向拖一次到 35%。 ----
      await page.getByTestId("task-doc-split-controls-column").click();
      after = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "column",
      );
      assert.ok(
        Math.abs(after.firstRatio - persisted) < 0.02,
        `column keeps the dragged ratio, got ${after.firstRatio}`,
      );
      await dragDivider(
        page,
        "task-doc-split-divider",
        Math.round((0.35 - after.firstRatio) * after.container),
        "column",
      );
      after = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "column",
      );
      assert.ok(Math.abs(after.firstRatio - 0.35) < 0.04, `column dragged ratio, got ${after.firstRatio}`);
      const dividerTrack = page.getByTestId("task-doc-split-divider-track");
      const trackBox = await dividerTrack.boundingBox();
      assert.ok(trackBox !== null && trackBox.height < trackBox.width * 4, "column divider lies horizontally");
      await shot("task-split-column");

      // ---- 折叠与召回。 ----
      await page.getByTestId("task-doc-split-controls-collapse").click();
      assert.equal(await page.getByTestId("task-document-tree").count(), 0);
      await shot("task-split-collapsed");
      await page.getByTestId("task-doc-split-expand").click();
      await page.getByTestId("task-document-tree").waitFor();

      // ---- 重置:回自适应(分隔条仍可操作)。 ----
      await page.getByTestId("task-doc-split-controls-reset").click();
      assert.equal(await page.locator('[data-testid="task-doc-split-divider"]').count(), 1);
      assert.notEqual(await grid.evaluate((node) => node.style.gridTemplateColumns), "");

      // 最小受支持 Electron 窗宽1120:内容区不足1100,自动上下排列且正文保持可用。
      await setSize(app, page, 1120, 800);
      await page.waitForFunction(
        () =>
          globalThis.document
            .querySelector('[data-testid="task-doc-split-divider"]')
            ?.getAttribute("aria-orientation") === "horizontal",
      );
      const narrow = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "column",
      );
      assert.ok(narrow.second > 160, `narrow auto keeps the reader usable, body ${narrow.second}px`);
      await dragDivider(page, "task-doc-split-divider", 20, "column");
      const narrowDragged = await paneRatios(
        page,
        "task-detail-content-grid",
        "task-document-tree",
        "task-detail-panel-scroll",
        "column",
      );
      assert.ok(Math.abs(narrowDragged.first - narrow.first - 20) < 4, "narrow default drag follows its pointer delta");
      await page.getByTestId("task-doc-split-controls-reset").click();
      await shot("task-split-auto-narrow");
      await setSize(app, page, 1440, 900);

      // ---- 工作概况:根任务因有子任务成为工作根;概况板可调主区|最近进展。 ----
      await page.getByTestId("task-detail-work").click();
      await page.getByTestId("workspace-view").waitFor();
      await page.getByTestId("work-overview-board").waitFor();
      const board = page.getByTestId("work-overview-board");
      assert.notEqual(await board.evaluate((node) => node.style.gridTemplateColumns), "");
      await page.getByTestId("work-overview-split-bar").waitFor();
      await page.getByTestId("work-overview-split-divider").waitFor();
      let boardRatios = await paneRatios(page, "work-overview-board", "work-overview-main", "work-timeline", "row");
      assert.ok(Math.abs(boardRatios.firstRatio - 0.6) < 0.04, `board default ratio, got ${boardRatios.firstRatio}`);
      await shot("work-split-row");

      // 键盘先验证交互路径,再做真实指针拖拽(失败时区分交互失效与事件被吞)。
      const boardHandle = page.getByTestId("work-overview-split-divider");
      await boardHandle.focus();
      await boardHandle.press("ArrowLeft");
      let stepped = await paneRatios(page, "work-overview-board", "work-overview-main", "work-timeline", "row");
      assert.ok(stepped.firstRatio < boardRatios.firstRatio - 0.001, `board keyboard step, got ${stepped.firstRatio}`);

      // 真实指针拖拽时间线分隔条到约 45% 主区;重载记忆;重置回自适应。
      await dragDivider(
        page,
        "work-overview-split-divider",
        Math.round((0.45 - stepped.firstRatio) * stepped.container),
        "row",
      );
      boardRatios = await paneRatios(page, "work-overview-board", "work-overview-main", "work-timeline", "row");
      assert.ok(Math.abs(boardRatios.firstRatio - 0.45) < 0.04, `board dragged ratio, got ${boardRatios.firstRatio}`);
      const boardPersisted = boardRatios.firstRatio;
      await page.reload();
      await page.getByTestId("work-overview-split-divider").waitFor({ timeout: 30_000 });
      boardRatios = await paneRatios(page, "work-overview-board", "work-overview-main", "work-timeline", "row");
      assert.ok(
        Math.abs(boardRatios.firstRatio - boardPersisted) < 0.02,
        `board ratio survives reload, got ${boardRatios.firstRatio}`,
      );
      await shot("work-split-dragged");
      await page.getByTestId("work-overview-split-controls-reset").click();
      assert.notEqual(await board.evaluate((node) => node.style.gridTemplateColumns), "");
      assert.equal(await page.locator('[data-testid="work-overview-split-divider"]').count(), 1);
      await shot("work-split-reset-auto");

      // ---- 英文界面:语言偏好只写本会话的临时 profile(每次运行全新 user-data-dir)。 ----
      await page.evaluate(() => globalThis.localStorage.setItem("harness-locale", "en-US"));
      await page.reload();
      await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
      await openChildDetail(page);
      await page.getByTestId("task-doc-split-controls-row").click();
      await page.getByTestId("task-doc-split-divider").waitFor();
      await shot("task-split-row-en");
      await page.getByTestId("task-detail-work").click();
      await page.getByTestId("work-overview-board").waitFor();
      await shot("work-split-auto-en");
    } finally {
      // ---- 清理:软删子任务(soft 需要 reason),不留工作根结构给同轮后续场景;
      //      清理失败不吞原始错误,挪到 finally 之外抛。 ----
      cleanupError = await requestDaemonJsonRpcAt(
        endpoint,
        "repo.task.run",
        {
          repo: { repoId },
          payload: {
            action: {
              kind: "task-delete",
              taskId: CHILD_TASK_ID,
              mode: "soft",
              reason: "scenario cleanup after split verification",
            },
          },
        },
        1_000,
        30_000,
      ).then(
        () => null,
        (error) => error,
      );
    }
    if (cleanupError !== null) throw cleanupError;
  },
};
