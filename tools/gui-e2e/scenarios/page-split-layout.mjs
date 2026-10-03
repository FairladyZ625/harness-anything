import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertUnscrolledLayout } from "./helpers.mjs";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

/** Real route coverage for page region order and proportional seams. Isolated daemon data,
 * hidden Electron, actual 1440/1120 content sizes; no production mutations or host focus.
 */

const CHILD_TASK_ID = "task-split-child",
  CHILD_TITLE = "分割布局子任务",
  SEED_FILES = 120;

async function setSize(app, page, width, height) {
  const actual = await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(size.width, size.height);
      return window.getContentSize();
    },
    { width, height },
  );
  // Hidden Electron may not resize its renderer; match the real, min-width-clamped content size.
  await page.setViewportSize({ width: actual[0], height: actual[1] });
  await page.waitForFunction(([w, h]) => globalThis.innerWidth === w && globalThis.innerHeight === h, actual);
  return { requested: [width, height], actual };
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

async function checkLayout(page, shot, boardId, first, second, label, reopen) {
  const board = page.getByTestId(boardId);
  const box = (id) => board.locator(`[data-region="${id}"]`).first().boundingBox();
  const handle = (id) => board.getByTestId(`region-handle-${id}`);
  if (boardId === "task-detail-content-grid") {
    const geometry = await page.getByTestId("task-detail-panel-scroll").evaluate((node) => {
      const rect = node.getBoundingClientRect(),
        style = globalThis.getComputedStyle(node);
      return {
        width: rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: rect.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      };
    });
    await shot(`${label}-usable-${Math.round(geometry.width)}x${Math.round(geometry.height)}`);
  }
  await handle(first).waitFor();
  await board.getByTestId(`${boardId}-controls-row`).click();
  const initial = await box(first),
    other = await box(second);
  assert.ok(initial && other && initial.width > 0 && initial.height > 0, label);
  await shot(`${label}-before`);
  const source = await handle(first).boundingBox(),
    target = await handle(second).boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await board.locator('[data-drop-preview="true"]').first().waitFor();
  await shot(`${label}-preview`);
  await page.mouse.up();
  await page.waitForFunction(
    ({ boardId, first, x, y }) => {
      const rect = globalThis.document
        .querySelector(`[data-testid="${boardId}"] [data-region="${first}"]`)
        .getBoundingClientRect();
      return Math.abs(rect.x - x) < 3 && Math.abs(rect.y - y) < 3;
    },
    { boardId, first, x: other.x, y: other.y },
  );
  await shot(`${label}-moved`);
  // Reload preserves actual placement, not just a serialized preference.
  await page.reload();
  if (reopen) await reopen();
  await handle(first).waitFor({ timeout: 30000 });
  const reloaded = await box(first);
  assert.ok(
    Math.abs(reloaded.x - other.x) < 3 && Math.abs(reloaded.y - other.y) < 3,
    `${label} reload ${JSON.stringify(reloaded)}`,
  );
  await shot(`${label}-reloaded`);
  // Cancellation cannot commit a new order.
  const cancelFrom = await handle(first).boundingBox(),
    cancelTo = await handle(second).boundingBox();
  await page.mouse.move(cancelFrom.x + 12, cancelFrom.y + 12);
  await page.mouse.down();
  await page.mouse.move(cancelTo.x + 12, cancelTo.y + 12, { steps: 8 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  const cancelled = await box(first);
  assert.ok(Math.abs(cancelled.x - reloaded.x) < 3 && Math.abs(cancelled.y - reloaded.y) < 3, `${label} cancel`);
  await board.getByTestId(`${boardId}-controls-reset`).click();
  await board.getByTestId(`${boardId}-controls-row`).click();
  await page.waitForFunction(
    ({ boardId, first, x, y }) => {
      const rect = globalThis.document
        .querySelector(`[data-testid="${boardId}"] [data-region="${first}"]`)
        .getBoundingClientRect();
      return Math.abs(rect.x - x) < 3 && Math.abs(rect.y - y) < 3;
    },
    { boardId, first, x: initial.x, y: initial.y },
    { timeout: 5000 },
  );
  const reset = await box(first);
  assert.ok(
    Math.abs(reset.x - initial.x) < 3 && Math.abs(reset.y - initial.y) < 3,
    `${label} reset: initial=${JSON.stringify(initial)} actual=${JSON.stringify(reset)} storage=${await page.evaluate(() => globalThis.localStorage.getItem("harness:gui:split-layout"))}`,
  );
  await handle(first).press("ArrowRight");
  const keyboard = await box(first);
  assert.ok(Math.abs(keyboard.x - reset.x) > 3 || Math.abs(keyboard.y - reset.y) > 3, `${label} keyboard move`);
  await board.getByTestId(`${boardId}-controls-reset`).click();
  await board.getByTestId(`${boardId}-controls-row`).click();
  const divider = board.getByTestId(`${boardId}-divider`);
  if (await divider.count()) {
    const before = Number(await divider.getAttribute("aria-valuenow"));
    await divider.press("ArrowRight");
    assert.equal(Number(await divider.getAttribute("aria-valuenow")), before + 16, `${label} keyboard resize`);
    const start = await box(first);
    await dragDivider(page, `${boardId}-divider`, 25, "row");
    const resized = await box(first);
    assert.ok(Math.abs(resized.width - start.width) > 10, `${label} pointer resize`);
  }
  await board.getByTestId(`${boardId}-controls-column`).click();
  await shot(`${label}-column`);
  await board.getByTestId(`${boardId}-controls-reset`).click();
  await assertUnscrolledLayout(board);
  const contained = await board.evaluate((node) => {
    const outer = node.getBoundingClientRect();
    return [...node.querySelectorAll("[data-region]")].every((region) => {
      const box = region.getBoundingClientRect();
      return (
        box.left >= outer.left - 1 &&
        box.right <= outer.right + 1 &&
        box.top >= outer.top - 1 &&
        box.bottom <= outer.bottom + 1
      );
    });
  });
  assert.ok(contained, `${label} all regions remain inside the page`);
  await shot(`${label}-reset`);
}

export default {
  id: "page-split-layout",
  feature: "split-layout",
  lane: "isolated",
  description:
    "Overview, work and nested task regions move by title drag and keyboard, resize, persist, cancel and reset in hidden Electron.",
  async run({ page, app, shot, fixture, runRoot }) {
    const { endpoint, repoId, rootDir } = fixture;
    let cleanupError;
    const sizes = [];
    const resize = async (width, height) => {
      sizes.push(await setSize(app, page, width, height));
      writeFileSync(path.join(runRoot, "page-split-window-sizes.json"), `${JSON.stringify(sizes, null, 2)}\n`);
    };

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
    const paths = [`${packagePath}/task_plan.md`];
    const sections = [
      "Brief",
      "Goal",
      "Context",
      "Required Reading",
      "Entry Conditions",
      "Dependencies",
      "Execution Surface",
      "Constraints",
      "Checkpoint",
      "Implementation Plan",
      "Deliverable Contract",
      "Evidence Protocol",
      "Verification",
    ];
    writeFileSync(
      path.join(rootDir, "harness", packagePath, "task_plan.md"),
      `# ${CHILD_TITLE}\n\nTask Contract: harness-task v1\n\n` +
        sections
          .map(
            (heading) =>
              `## ${heading}\n\nVerify page region movement in the isolated Electron fixture. Read packages/gui/src/renderer/components/primitives/page-regions.tsx. Keep all test data in this dedicated fixture repository; do not contact production services. Capture actual geometry, reload preferences, and reset the layout.\n`,
          )
          .join("\n") +
        "\n" +
        Array.from(
          { length: 80 },
          (_, index) =>
            `Layout evidence paragraph ${index}: the plan remains readable while its region scrolls independently.\n`,
        ).join("\n"),
    );
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

    // The isolated repository starts without a commit. Seed a real delivery like work-progress-chain.
    writeFileSync(path.join(rootDir, "layout-fixture.txt"), "Isolated page layout delivery fixture.\n");
    execFileSync("git", ["-C", rootDir, "add", "layout-fixture.txt"], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-C",
        rootDir,
        "-c",
        "user.name=gui-e2e",
        "-c",
        "user.email=gui-e2e@local",
        "commit",
        "-m",
        "test: seed layout fixture",
      ],
      { stdio: "pipe" },
    );
    writeFileSync(path.join(rootDir, "layout-fixture.txt"), "Isolated page layout delivery with history.\n");
    execFileSync("git", ["-C", rootDir, "add", "layout-fixture.txt"], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-C",
        rootDir,
        "-c",
        "user.name=gui-e2e",
        "-c",
        "user.email=gui-e2e@local",
        "commit",
        "-m",
        "test: deliver layout fixture",
      ],
      { stdio: "pipe" },
    );
    const commitSha = execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    for (const taskId of [CHILD_TASK_ID, "task-gui-smoke"]) {
      const started = await requestDaemonJsonRpcAt(
        endpoint,
        "repo.task.run",
        {
          repo: { repoId },
          payload: { action: { kind: "task-start", taskId, executionId: `execution-layout-${taskId}` } },
        },
        1000,
        30000,
      );
      assert.equal(started.ok, true, JSON.stringify(started));
    }

    // Submit/return creates real lifecycle history; releasing a lease does not end an execution.
    for (const [taskId, taskPackage] of [
      [CHILD_TASK_ID, packagePath],
      ["task-gui-smoke", fixture.packagePath],
    ]) {
      const closeoutPath = `${taskPackage}/closeout.md`;
      writeFileSync(
        path.join(rootDir, "harness", closeoutPath),
        "# Closeout\n\n## Summary\n\nIsolated GUI layout fixture round, with no production changes.\n\n## Verification\n\nThe fixture validates public lifecycle receipts before rendering history.\n\n## Residual Risk\n\nSynthetic fixture content is only used for layout verification.\n\n## Same Mechanism Elsewhere\n\nRegion overflow is shared by the task and work timeline views.\n",
      );
      const authored = await requestDaemonJsonRpcAt(
        endpoint,
        "repo.task.run",
        { repo: { repoId }, payload: { action: { kind: "doc-submit", paths: [closeoutPath] } } },
        1000,
        30000,
      );
      assert.equal(authored.ok, true, JSON.stringify(authored));
      for (let index = 0; index < 3; index += 1) {
        const executionId = index === 0 ? `execution-layout-${taskId}` : `execution-layout-${taskId}-${index - 1}`;
        for (const action of [
          { kind: "task-submit", taskId, executionId, commitSha },
          {
            kind: "task-adjudicate",
            taskId,
            executionId,
            return: true,
            reason: "Continue the isolated layout fixture round",
          },
          { kind: "task-start", taskId, executionId: `execution-layout-${taskId}-${index}` },
        ]) {
          const receipt = await requestDaemonJsonRpcAt(
            endpoint,
            "repo.task.run",
            { repo: { repoId }, payload: { action } },
            1000,
            30000,
          );
          assert.equal(receipt.ok, true, JSON.stringify(receipt));
        }
      }
    }
    try {
      await resize(1440, 900);
      await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
      await openChildDetail(page);
      // 等文件清单投影追平:树里出现种子目录。
      await page.getByTestId("task-document-tree").filter({ hasText: "split/" }).waitFor({ timeout: 30_000 });

      const hidden = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
      );
      assert.ok(
        hidden.every((window) => !window.visible && !window.focused),
        JSON.stringify(hidden),
      );
      await checkLayout(page, shot, "task-detail-content-grid", "files", "content", "task-wide");
      await expandSeedTree(page);
      const tree = await page
        .getByTestId("task-document-tree-scroll")
        .evaluate((node) => ({ height: node.clientHeight, scroll: node.scrollHeight }));
      assert.ok(tree.scroll > tree.height, "long tree scrolls inside its region");
      await page.getByTestId("task-detail-content-grid-controls-collapse").click();
      assert.equal(await page.getByTestId("task-document-tree").count(), 0);
      await page.getByTestId("task-detail-content-grid-expand").click();
      await page.getByTestId("task-document-tree").waitFor();
      await checkLayout(page, shot, "task-overview-tab", "plan", "progress", "task-plan-wide");
      const timelineScroll = await page
        .getByTestId("task-progress-timeline")
        .locator("[data-region-scroll]")
        .evaluate((node) => {
          node.scrollTop = node.scrollHeight;
          return { client: node.clientHeight, scroll: node.scrollHeight, top: node.scrollTop };
        });
      assert.ok(
        timelineScroll.scroll > timelineScroll.client && timelineScroll.top > 0,
        `long timeline scrolls internally: ${JSON.stringify(timelineScroll)}`,
      );
      await page.getByTestId("task-overview-tab-controls-reset").click();
      await resize(1120, 800);
      await checkLayout(page, shot, "task-detail-content-grid", "files", "content", "task-narrow");
      await shot("task-plan-narrow");
      const body = await page.getByTestId("task-detail-panel-scroll").boundingBox();
      assert.ok(body.width > 300 && body.height > 160, `usable narrow body ${JSON.stringify(body)}`);
      await resize(1440, 900);
      await page.getByTestId("task-detail-work").click();
      await page.getByTestId("work-overview-board").waitFor();
      await checkLayout(page, shot, "work-overview-board", "structure", "recent", "work-wide");
      await resize(1120, 800);
      await checkLayout(page, shot, "work-overview-board", "structure", "recent", "work-narrow");
      await page.getByRole("tab", { name: /根任务|Root task/u }).click();
      await page.getByTestId("task-detail-view").waitFor();
      await checkLayout(page, shot, "task-detail-content-grid", "files", "content", "root-narrow", () =>
        page.getByRole("tab", { name: /根任务|Root task/u }).click(),
      );
      await checkLayout(page, shot, "task-overview-tab", "plan", "progress", "root-plan-narrow", () =>
        page.getByRole("tab", { name: /根任务|Root task/u }).click(),
      );
      await resize(1440, 900);
      await shot("root-wide");
      // The work graph fills its own flex viewport; both narrow and wide
      // containers must fit the canvas without a horizontal scrollbar.
      await page.locator("#workspace-tab-graph").click();
      const graph = page.getByTestId("workspace-graph-scroll");
      await graph.waitFor();
      const graphLayouts = [];
      for (const width of [360, 900]) {
        await graph.evaluate((node, value) => {
          node.style.width = `${value}px`;
        }, width);
        graphLayouts.push(await assertUnscrolledLayout(graph));
        await shot(`work-graph-${width}`);
      }
      await graph.evaluate((node) => {
        node.style.width = "";
      });
      writeFileSync(path.join(runRoot, "work-graph-layout.json"), `${JSON.stringify(graphLayouts, null, 2)}\n`);

      await page.getByRole("button", { name: /^(?:总览|Overview)$/u }).click();
      await page.getByTestId("overview-board").waitFor();
      const overviewIds = await page
        .getByTestId("overview-board")
        .locator("[data-region]")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.region));
      assert.ok(overviewIds.length >= 2, `overview fixture needs multiple regions: ${overviewIds}`);
      await checkLayout(page, shot, "overview-board", overviewIds[0], overviewIds[1], "overview-wide");
      await resize(1120, 800);
      await checkLayout(page, shot, "overview-board", overviewIds[0], overviewIds[1], "overview-narrow");
      await page.evaluate(() => globalThis.localStorage.setItem("harness-locale", "en-US"));
      await page.reload();
      await page.getByTestId("overview-board").waitFor();
      await shot("overview-en");
      await page.evaluate(() => globalThis.localStorage.setItem("harness-theme", "light"));
      await page.reload();
      await page.getByTestId("overview-board").waitFor();
      await assertUnscrolledLayout(page.getByTestId("overview-board"));
      await shot("overview-light");
      const finalWindows = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused() })),
      );
      assert.ok(
        finalWindows.every((window) => !window.visible && !window.focused),
        JSON.stringify(finalWindows),
      );
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
