import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady } from "./helpers.mjs";

/**
 * 收口页长值与长正文(GUI 视觉规范 v2 §4.1,任务 3a 垂直切片的 Electron 验收):
 * 长 execution ID(实体 ID 同一形态的不可断机器串)与记录 ID 在窄容器里各自留
 * 在自身列——ID 由组件截断、悬停给完整值,记录行与页面都不横向溢出(修复前的
 * 反例:33 字符 mono ID 裸排进固定 11rem 列,溢出叠到正文列上)。
 * 布局契约的最终裁决在真实 Chromium:截断/收缩是叶子组件(EntityRefLink/
 * IdText)的内联样式,同层 utility 类(whitespace-normal/overflow-visible/
 * max-w-none)在级联里覆盖不了它——场景注入同层 utility 后重读 computed style
 * 证明。窄容器不是靠声称窗口宽度:主窗 minWidth=1120 会把 setSize(800) 钳回
 * 1120,所以记录实际 contentSize,并把记录行容器本身约束到 360px 实测(行宽、
 * 截断触发、正文不越列都以测得值为准)。
 * 数据面:经 daemon 聚合写口种真实 execution 行(start 建 execution,submit 产生
 * code-doc witness;executionId 由场景给出长值,其余全是真实投影)。submit 的
 * 收口占位门要求先有实质 closeout,在夹具仓预填 closeout.md 由 task-submit 自带
 * 的 doc-sync 步骤带过门;交付门要可解析的 40 位 commit,夹具仓 unborn HEAD,
 * 造一个带长路径文件的交付 commit(daemon 对该仓只做只读 rev-parse/cat-file)。
 * 评审记录需要 reviewer runtime,夹具不装——长 review 正文的 DOM 契约由 fast
 * vitest(entity-ref-long-values)覆盖。窗口全程隐藏(driver headless),不
 * show/focus。
 */
const TASK_ID = "task-gui-smoke";
const EXECUTION_ID = "execution-gui-closeout-long-values-narrow-container-acceptance-probe-20261002";

export default {
  id: "task-closeout-long-values",
  feature: "board",
  lane: "isolated",
  description: "Closeout review rows keep long ids and long review text in their own columns at a narrow width.",
  async run({ page, fixture, shot, runRoot, app }) {
    // 预填实质 closeout:submit 的 doc-sync 步骤把它带进台账,收口占位门才放行。
    writeFileSync(
      path.join(fixture.rootDir, "harness", fixture.packagePath, "closeout.md"),
      [
        "# Closeout",
        "",
        "## Summary",
        "",
        "夹具任务的收口正文:为收口页长值验收准备的真实 submitted 切片。",
        "",
        "## Verification",
        "",
        "start/submit/adjudicate 回执全部 ok,投影携带 seeded execution 与 review。",
        "",
        "## Residual Risk",
        "",
        "夹具仓不发布,无残留风险。",
        "",
        "## Same Mechanism Elsewhere",
        "",
        "本夹具只服务 GUI e2e,机制句不适用于其它仓。",
        "",
      ].join("\n"),
    );
    // 种真实记录行:start 建 execution,submit 的证据准备产生 code-doc witness。
    // submit 的交付门要一个可在本地解析的 40 位 commit:夹具仓 unborn HEAD,
    // 造一个带长路径文件的交付 commit(daemon 对该仓只做只读 rev-parse/
    // cat-file)。harness/ 在夹具仓被 .gitignore 忽略,文件放仓根;长 路径
    // 成为 code-doc witness 的 paths——真实、不可断的机器串探针。
    const LONG_BASENAME =
      "entity-ref-long-values-narrow-container-acceptance-probe-20261002-closeout-review-text-overlap.md";
    writeFileSync(
      path.join(fixture.rootDir, LONG_BASENAME),
      "长值窄容器验收探针:该路径整体进入 code-doc witness 的 paths。\n",
    );
    for (const gitArgs of [
      ["add", LONG_BASENAME],
      [
        "-c",
        "user.name=GUI E2E Fixture",
        "-c",
        "user.email=gui-e2e-fixture@example.invalid",
        "commit",
        "-m",
        "closeout long-values e2e delivery probe",
      ],
    ]) {
      execFileSync("git", ["-C", fixture.rootDir, ...gitArgs], { encoding: "utf8" });
    }
    const headSha = execFileSync("git", ["-C", fixture.rootDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const receipts = {};
    for (const payload of [
      { kind: "task-start", taskId: TASK_ID, executionId: EXECUTION_ID },
      { kind: "task-submit", taskId: TASK_ID, commitSha: headSha },
    ]) {
      const receipt = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.task.run",
        { repo: { repoId: fixture.repoId }, payload: { action: payload } },
        1_000,
        10_000,
      );
      receipts[payload.kind] = receipt;
      assert.equal(receipt.ok, true, `${payload.kind}: ${JSON.stringify(receipt)}`);
      assert.equal(receipt.outcome, "applied", `${payload.kind} must create this scenario's execution`);
    }
    const read = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.tasks.list",
      { repo: { repoId: fixture.repoId }, payload: {} },
      1_000,
      5_000,
    );
    const row = read.rows?.find((task) => task.taskId === TASK_ID);
    writeFileSync(
      path.join(runRoot, "task-closeout-long-values-readback.json"),
      `${JSON.stringify(
        {
          receipts: Object.fromEntries(Object.entries(receipts).map(([kind, receipt]) => [kind, receipt])),
          snapshot: {
            reviews: row?.snapshot?.reviews ?? null,
            consents: row?.snapshot?.consents ?? null,
            codeDocWitnesses: row?.snapshot?.codeDocWitnesses ?? null,
            gateWitnesses: row?.snapshot?.gateWitnesses ?? null,
            executions: row?.snapshot?.executions?.map((execution) => execution.executionId) ?? null,
          },
        },
        null,
        2,
      )}\n`,
    );
    // 验收对象一:Execution 输出行的长 executionId(实体 ID 同一形态,由场景
    // 给出 70 字符长值,其余列来自真实投影)。验收对象二:code-doc witness 行
    // 的复制动作。评审记录需要 reviewer runtime,夹具不装,长 review 正文的
    // DOM 契约由 fast vitest(entity-ref-long-values)覆盖。
    const codeDocWitness = row?.snapshot?.codeDocWitnesses?.find((witness) => witness.schema === "code-doc-witness/v1");
    assert.ok(
      row?.snapshot?.executions?.some((execution) => execution.executionId === EXECUTION_ID),
      `projection must carry the long execution id: ${JSON.stringify(row?.snapshot?.executions?.map((execution) => execution.executionId) ?? null)}`,
    );
    assert.ok(
      codeDocWitness,
      `projection must carry a code-doc witness: ${JSON.stringify(row?.snapshot?.codeDocWitnesses ?? null)}`,
    );

    // 窄窗口(隐藏):minWidth=1120 会把 800 钳回,记录实际 contentSize 作数,
    // 不声称 800。真正的窄容器证据来自下面把记录行容器约束到 360px 的实测。
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
      },
      { width: 800, height: 900 },
    );
    const windowContentSize = await app.evaluate(({ BrowserWindow }) => {
      const [width, height] = BrowserWindow.getAllWindows()[0]?.getContentSize() ?? [0, 0];
      return { width, height };
    });

    await bridgeReady(page);
    await page.getByRole("button", { name: /^(?:看板|Board)$/u }).click();
    await page.getByTestId("board-task-card").first().click();
    await page
      .locator('aside [title^="task_"]')
      .or(page.getByRole("button", { name: /打开完整详情|Open full details/u }))
      .first()
      .click();
    await page.getByTestId("task-detail-view").waitFor();
    await page.getByRole("tab", { name: /收口与门|Closeout|收口/u }).click();
    await page.getByTestId("task-closeout-tab").waitFor();
    // Capture the requested copy in this renderer; never read or overwrite the
    // user's system clipboard during a hidden acceptance run.
    await page.evaluate(() => {
      Object.defineProperty(globalThis.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            globalThis.__guiE2eCopiedText = text;
          },
        },
      });
    });

    // DecisionReviewTab's supported metadata shape: timestamp + dispatch id + three actions.
    // Test visibility as well as overflow: the old auto track made the identity zero-width.
    const metadata = await page
      .getByTestId("task-closeout-tab")
      .locator(".bounded-content")
      .first()
      .evaluate((body) => {
        const record = body.parentElement,
          header = record.firstElementChild;
        const identity = header.firstElementChild,
          trailing = header.lastElementChild;
        const oldWidth = record.style.width,
          oldChildren = [...trailing.childNodes];
        record.style.width = "360px";
        trailing.textContent = "2026-10-02 13:55 · 67e5a389 · dispatch_4b7296db0201def045debc41";
        const actions = globalThis.document.createElement("div");
        actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
        for (const label of ["查看报告", "查看会话", "回应评审意见"]) {
          const button = globalThis.document.createElement("button");
          button.textContent = label;
          button.style.cssText = "min-height:40px;min-width:40px;padding:0 8px";
          actions.append(button);
        }
        trailing.append(actions);
        const result = {
          width: record.clientWidth,
          scroll: record.scrollWidth,
          identityWidth: identity.getBoundingClientRect().width,
          columns: globalThis.getComputedStyle(header).gridTemplateColumns,
        };
        trailing.replaceChildren(...oldChildren);
        record.style.width = oldWidth;
        return result;
      });
    assert.ok(metadata.identityWidth >= 180, `identity remains readable: ${JSON.stringify(metadata)}`);
    assert.ok(metadata.scroll <= metadata.width + 1, `metadata stays contained: ${JSON.stringify(metadata)}`);

    // Execution 输出行:长 executionId 是展示叶——截断以真实 Chromium computed
    // style 作准(内联样式:overflow/text-overflow/white-space),悬停给完整值,
    // 行不横向溢出(修复前裸 span 无截断,窄容器直接把相邻列顶出去)。
    const executionRow = page.getByTestId(`task-execution-${EXECUTION_ID}`);
    await executionRow.waitFor();
    // Exercise the shared scroll boundary on a real rendered record, without changing ledger data.
    // The temporary long/wide block distinguishes internal scrolling from an expanding page.
    const longContent = await page
      .getByTestId("task-closeout-tab")
      .locator(".bounded-content")
      .first()
      .evaluate((node) => {
        const sample = globalThis.document.createElement("pre");
        sample.textContent = ("long-record/".repeat(100) + "\n").repeat(100);
        node.append(sample);
        node.scrollTop = 100;
        node.scrollLeft = 100;
        const result = {
          height: node.clientHeight,
          contentHeight: node.scrollHeight,
          width: node.clientWidth,
          contentWidth: node.scrollWidth,
          top: node.scrollTop,
          left: node.scrollLeft,
          viewport: globalThis.innerHeight,
        };
        sample.remove();
        node.scrollTop = 0;
        node.scrollLeft = 0;
        return result;
      });
    assert.ok(longContent.height > 0 && longContent.height < longContent.contentHeight);
    assert.ok(longContent.height <= longContent.viewport * 0.56, "record uses the shared proportional cap");
    assert.ok(
      longContent.width < longContent.contentWidth && longContent.left > 0 && longContent.top > 0,
      "wide and long content scrolls inside the record on both axes",
    );
    const executionIdLeaf = executionRow.locator("span[title]").first();
    assert.equal(await executionIdLeaf.getAttribute("title"), EXECUTION_ID, "hover title keeps the full execution id");
    const executionIdStyle = await executionIdLeaf.evaluate((node) => {
      const style = globalThis.window.getComputedStyle(node);
      return { overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace };
    });
    assert.deepEqual(executionIdStyle, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });

    // 敌意同层 utility 探针:注入 Tailwind 会生成的同层规则,挂到真实叶子身上,
    // computed style 必须保持截断(内联样式优先级高于类)。证明调用方传
    // whitespace-normal/overflow-visible/max-w-none 抹不掉核心布局约束。
    const hostileProbe = await executionIdLeaf.evaluate((node) => {
      const style = globalThis.document.createElement("style");
      style.textContent =
        ".hostile-truncate-probe{white-space:normal;overflow:visible;max-width:none;text-overflow:clip}";
      globalThis.document.head.append(style);
      node.classList.add("hostile-truncate-probe");
      const computed = globalThis.window.getComputedStyle(node);
      const held = {
        overflow: computed.overflow,
        textOverflow: computed.textOverflow,
        whiteSpace: computed.whiteSpace,
      };
      node.classList.remove("hostile-truncate-probe");
      style.remove();
      return held;
    });
    assert.deepEqual(
      hostileProbe,
      { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      "same-layer utility classes must not cancel the truncation layout",
    );

    // 窄容器实测:把 execution 记录卡约束到 360px(比 @min-[420px] 断点窄),
    // 记录实际容器宽度——ID 截断必须真的触发(内容宽 > 盒宽),行不横向溢出。
    const executionNarrow = await executionRow.evaluate((node) => {
      node.style.width = "360px";
      const leaf = node.querySelector("span[title]");
      const rect = node.getBoundingClientRect();
      const result = {
        containerWidth: rect.width,
        rowScroll: node.scrollWidth,
        rowClient: node.clientWidth,
        leafScroll: leaf?.scrollWidth ?? 0,
        leafClient: leaf?.clientWidth ?? 0,
      };
      node.style.width = "";
      return result;
    });
    assert.equal(executionNarrow.containerWidth, 360, "narrow container is actually applied");
    assert.ok(
      executionNarrow.rowScroll <= executionNarrow.rowClient + 1,
      `execution row must not spill at 360px (scroll=${executionNarrow.rowScroll}, client=${executionNarrow.rowClient})`,
    );
    assert.ok(
      executionNarrow.leafScroll > executionNarrow.leafClient,
      `long execution id must actually truncate at 360px (scroll=${executionNarrow.leafScroll}, client=${executionNarrow.leafClient})`,
    );
    const executionOverflow = await executionRow.evaluate((node) => ({
      scroll: node.scrollWidth,
      client: node.clientWidth,
    }));
    assert.ok(
      executionOverflow.scroll <= executionOverflow.client + 1,
      `execution row must not spill horizontally (scroll=${executionOverflow.scroll}, client=${executionOverflow.client})`,
    );

    // Code-doc witness 记录行:ID 同一展示叶(computed style),复制动作在行的
    // 动作位(不在文字上叠按钮),点击后剪贴板拿到完整记录引用。
    const witnessRow = page.locator(`[id="closeout-record-witness-${codeDocWitness.witnessId.replaceAll("/", "-")}"]`);
    await witnessRow.waitFor();
    const witnessIdLeaf = witnessRow.locator("span[title]").first();
    assert.equal(
      await witnessIdLeaf.getAttribute("title"),
      codeDocWitness.witnessId,
      "hover title keeps the witness id",
    );
    const witnessIdStyle = await witnessIdLeaf.evaluate((node) => {
      const style = globalThis.window.getComputedStyle(node);
      return { overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace };
    });
    assert.deepEqual(witnessIdStyle, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    // 见证行同样做窄容器实测(长路径正文留在自身列,行不越容器)。
    const witnessNarrow = await witnessRow.evaluate((node) => {
      node.style.width = "360px";
      const rect = node.getBoundingClientRect();
      const result = { containerWidth: rect.width, rowScroll: node.scrollWidth, rowClient: node.clientWidth };
      node.style.width = "";
      return result;
    });
    assert.equal(witnessNarrow.containerWidth, 360);
    assert.ok(
      witnessNarrow.rowScroll <= witnessNarrow.rowClient + 1,
      `witness row must not spill at 360px (scroll=${witnessNarrow.rowScroll}, client=${witnessNarrow.rowClient})`,
    );
    // 实际量得的宽度落盘:窗口 contentSize(minWidth 钳制后的真相)与两处
    // 360px 窄容器的实测行宽/截断触发,不以声称值作数。
    writeFileSync(
      path.join(runRoot, "task-closeout-long-values-measurements.json"),
      `${JSON.stringify({ windowContentSize, executionNarrow, witnessNarrow }, null, 2)}\n`,
    );
    // Wait for the asynchronous copy completion, then compare the captured
    // renderer request with this row's full record reference (simulated clipboard).
    await witnessRow.getByRole("button", { name: /^复制$|^Copy$/u }).click();
    await witnessRow.getByRole("button", { name: /已复制|Copied/u }).waitFor();
    const leafTitle = await witnessRow.locator("span[title]").first().getAttribute("title");
    assert.ok(leafTitle !== null);
    const copied = await page.evaluate(() => globalThis.__guiE2eCopiedText);
    assert.equal(copied, `witness/${leafTitle}`);

    assert.equal(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth),
      true,
      "page must not overflow horizontally at the narrow width",
    );
    await shot("task-closeout-long-values-1-narrow-rows");
    await shot("task-closeout-long-values-2-after-copy");
  },
};
