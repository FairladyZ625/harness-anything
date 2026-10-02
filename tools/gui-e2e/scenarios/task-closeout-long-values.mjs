import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";
import { bridgeReady } from "./helpers.mjs";

/**
 * 收口页长值与长正文(GUI 视觉规范 v2 §4.1,任务 3a 垂直切片的 Electron 验收):
 * 长 execution ID(实体 ID 同一形态的不可断机器串)与记录 ID 在窄窗口里各自留
 * 在自身列——ID 由组件截断、悬停给完整值,记录行与页面都不横向溢出(修复前的
 * 反例:33 字符 mono ID 裸排进固定 11rem 列,溢出叠到正文列上)。
 * 数据面:经 daemon 聚合写口种真实 execution 行(start 建 execution,submit 产生
 * code-doc witness;executionId 由场景给出长值,其余全是真实投影)。submit 的
 * 收口占位门要求先有实质 closeout,在夹具仓预填 closeout.md 由 task-submit 自带
 * 的 doc-sync 步骤带过门;交付门要可解析的 40 位 commit,夹具仓 unborn HEAD,
 * 造一个带长路径文件的交付 commit(daemon 对该仓只做只读 rev-parse/cat-file)。
 * 评审记录需要 reviewer runtime,夹具不装——长 review 正文的 DOM 契约由 fast
 * vitest(entity-ref-long-values)覆盖。窗口全程隐藏(driver headless),窄宽由
 * BrowserWindow.setSize 完成,不 show/focus。
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

    // 窄窗口(隐藏):760px 内容宽把收口行三列压到 ID 截断必然发生的区间。
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
      },
      { width: 800, height: 900 },
    );

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

    // Execution 输出行:长 executionId 是展示叶(截断 + 悬停完整值),行不横向
    // 溢出(修复前裸 span 无截断,窄窗口直接把相邻列顶出去)。
    const executionRow = page.getByTestId(`task-execution-${EXECUTION_ID}`);
    await executionRow.waitFor();
    const executionIdLeaf = executionRow.locator("span[title]").first();
    assert.equal(await executionIdLeaf.getAttribute("title"), EXECUTION_ID, "hover title keeps the full execution id");
    assert.match(
      await executionIdLeaf.getAttribute("class"),
      /truncate/u,
      "execution id truncates via the shared leaf",
    );
    const executionOverflow = await executionRow.evaluate((node) => ({
      scroll: node.scrollWidth,
      client: node.clientWidth,
    }));
    assert.ok(
      executionOverflow.scroll <= executionOverflow.client + 1,
      `execution row must not spill horizontally (scroll=${executionOverflow.scroll}, client=${executionOverflow.client})`,
    );

    // Code-doc witness 记录行:ID 同一展示叶;复制动作在行的动作位(不在文字上
    // 叠按钮),点击后剪贴板拿到完整记录引用。
    const witnessRow = page.locator(`[id="closeout-record-witness-${codeDocWitness.witnessId.replaceAll("/", "-")}"]`);
    await witnessRow.waitFor();
    const witnessIdLeaf = witnessRow.locator("span[title]").first();
    assert.equal(
      await witnessIdLeaf.getAttribute("title"),
      codeDocWitness.witnessId,
      "hover title keeps the witness id",
    );
    assert.match(await witnessIdLeaf.getAttribute("class"), /truncate/u, "witness id truncates via the shared leaf");
    // 复制动作在行的动作位(不在文字上叠按钮)。投影里 witness 行会随 submit 的
    // 异步证据步骤继续到达(行序在变),点击与断言都在同一个已解析的 DOM 节点上
    // 同步完成,不做二次定位——剪贴板拿到的必须正是这一行的完整记录引用。
    // 复制动作在行的动作位(不在文字上叠按钮)。剪贴板写入是 renderer 侧异步
    // promise,「已复制」态在写入完成后才置位——以它为完成信号再读剪贴板,
    // 不与系统剪贴板的上一轮内容竞态;期望值取该行展示叶悬停的完整 ID。
    await witnessRow.getByRole("button", { name: /^复制$|^Copy$/u }).click();
    await witnessRow.getByRole("button", { name: /已复制|Copied/u }).waitFor();
    const leafTitle = await witnessRow.locator("span[title]").first().getAttribute("title");
    assert.ok(leafTitle !== null);
    // renderer 的 clipboard.readText 受权限门,经主进程 electron.clipboard 读回。
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
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
