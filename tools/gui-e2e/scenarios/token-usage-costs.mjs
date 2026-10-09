import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

/**
 * Token 消耗页的金额维度(task_*-token-api):按 API 公开价折算的金额在页首、排行、趋势、
 * 成员详情、任务/工作归集各视图的呈现。种法是「本分支构建的隔离 daemon + 真实形状的用量
 * 种子」:任务/工作经 repo.task.create 落成投影实体,派工流按生产同形状落盘
 * (.harness/runtime/dispatches/*.jsonl,头部带归因,记录带 runtime_metrics 与退出)——
 * daemon 的 tokenUsage 读从这些流现算金额,页面不 mock 任何读面。
 *
 * 种子覆盖验收要的每种状态:今天全有价(页首无未计价提示)/ 7 天含 swe2 无价用量(页首
 * 占比提示 + 模型行「无价格」)/ 一次 <$0.01 的小额派工 / 跨小时的趋势桶 / 缓存写独立计价
 * (d1 gpt 与 d4 opus 带 cacheWriteTokens,写价 = 输入价 1.25 倍;p2 是缺字段的历史记录形状,
 * 读侧按写入 0 计)。断言用实算金额(价格表 agent-runtime-model-pricing.ts 的单价 × 种子
 * 计数),改价或改显示格式都会红。
 */
const REPO_ATTACHMENT_TIMEOUT_MS = 20_000,
  HOUR = 3_600_000,
  streamSchema = "runtime-dispatch-stream/v1";

const identity = (key) => createHash("sha256").update(`token-usage-costs\0${key}`).digest("hex"),
  dispatchIdOf = (key) => `dispatch_${identity(key).slice(0, 24)}`,
  runtimeSessionIdOf = (key) => `runtime_${identity(key).slice(24, 48)}`;

/** 任务/工作骨架:两个 work 根各带两个叶子,标题走真实文案(任务行与工作行都显示标题)。 */
const WORK_READ = { taskId: "task-cost-work-read", title: "统一资产读路径" },
  WORK_DOCS = { taskId: "task-cost-work-docs", title: "金额文案与排障" },
  TASKS = [
    { taskId: "task-cost-impl", title: "迁移聚合读面到新读层", parent: WORK_READ.taskId },
    { taskId: "task-cost-review", title: "复核价格表口径与来源", parent: WORK_READ.taskId },
    { taskId: "task-cost-doc", title: "补全金额展示文案", parent: WORK_DOCS.taskId },
    { taskId: "task-cost-triage", title: "排查一次小额派工", parent: WORK_DOCS.taskId },
  ];

/** 派工种子。inputTokens 含缓存读与缓存写(与 runtime_metrics 的写入形状一致);cost 是按
 * 价格表手算的期望值(四段:新输入/缓存读/缓存写/输出),页面断言直接对它。今天的种子
 * hoursAgo 相对本地午夜自适应:白天按原始间隔铺开,凌晨窗口不足时整体压进今天(顺序与
 * 落桶由 expectedBucketCost 按「实际落桶」计算,任何时段都精确)。前一段窗口放一笔 swe2
 * (无价)与一笔缺 cacheWriteTokens 字段的历史形状有价派工。 */
const now = Date.now(),
  localSince = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime(),
  todayHours = (now - localSince) / HOUR,
  clampToday = (hoursAgo, floor = 0.01) => Math.min(hoursAgo, Math.max(floor, todayHours - 0.01)),
  dispatches = [
    {
      key: "d1-astra-sol-impl",
      hoursAgo: Math.min(0.7, todayHours * 0.55),
      agentId: "astra",
      agentName: "Astra",
      model: "gpt-5.6-sol",
      taskId: "task-cost-impl",
      metrics: {
        inputTokens: 180_000_000,
        cacheReadTokens: 172_000_000,
        cacheWriteTokens: 6_000_000,
        outputTokens: 4_000_000,
        toolCallCount: 210,
      },
      cost: 186.8,
    },
    {
      key: "d2-glm-impl",
      hoursAgo: clampToday(2.3, 0.009),
      agentId: "glm",
      agentName: "GLM-5.3",
      model: "GLM-5.3",
      taskId: "task-cost-impl",
      metrics: { inputTokens: 95_000_000, cacheReadTokens: 92_000_000, outputTokens: 2_500_000, toolCallCount: 160 },
      cost: 39.12,
    },
    {
      key: "d3-astra-doc",
      hoursAgo: clampToday(4.1, 0.008),
      agentId: "astra",
      agentName: "Astra",
      model: "gpt-5.6-sol",
      taskId: "task-cost-doc",
      metrics: { inputTokens: 12_000_000, cacheReadTokens: 10_000_000, outputTokens: 300_000, toolCallCount: 46 },
      cost: 18,
    },
    {
      key: "d4-glm-review",
      hoursAgo: clampToday(5.8, 0.007),
      agentId: "glm",
      agentName: "GLM-5.3",
      model: "opus",
      taskId: "task-cost-review",
      metrics: {
        inputTokens: 6_000_000,
        cacheReadTokens: 5_000_000,
        cacheWriteTokens: 500_000,
        outputTokens: 150_000,
        toolCallCount: 24,
      },
      cost: 8.5,
    },
    {
      key: "d5-astra-triage",
      hoursAgo: clampToday(6.9, 0.006),
      agentId: "astra",
      agentName: "Astra",
      model: "gemini-3.8-flash-high",
      taskId: "task-cost-triage",
      metrics: { inputTokens: 2_000, cacheReadTokens: 0, outputTokens: 800, toolCallCount: 3 },
      cost: 0.0045,
    },
    {
      key: "d6-glm-review",
      hoursAgo: clampToday(8.2, 0.005),
      agentId: "glm",
      agentName: "GLM-5.3",
      model: "GLM-5.3",
      taskId: "task-cost-review",
      metrics: { inputTokens: 20_000_000, cacheReadTokens: 19_000_000, outputTokens: 500_000, toolCallCount: 70 },
      cost: 8.54,
    },
    {
      key: "p1-glm-swe2",
      hoursAgo: 24.4,
      agentId: "glm",
      agentName: "GLM-5.3",
      model: "swe2",
      taskId: "task-cost-impl",
      metrics: { inputTokens: 30_000_000, cacheReadTokens: 28_000_000, outputTokens: 900_000, toolCallCount: 95 },
      cost: null,
    },
    {
      key: "p2-astra-sol",
      hoursAgo: 24.8,
      agentId: "astra",
      agentName: "Astra",
      model: "gpt-5.6-sol",
      taskId: "task-cost-impl",
      metrics: { inputTokens: 40_000_000, cacheReadTokens: 38_000_000, outputTokens: 1_000_000, toolCallCount: 120 },
      cost: 43.2,
    },
  ],
  totalTokensOf = ({ inputTokens, cacheReadTokens, outputTokens }) =>
    cacheReadTokens + Math.max(0, inputTokens - cacheReadTokens) + outputTokens;

async function seedTasks(endpoint, repoId) {
  const create = (payload) =>
    requestDaemonJsonRpcAt(endpoint, "repo.task.create", { repo: { repoId }, payload }, 5_000);
  for (const work of [WORK_READ, WORK_DOCS]) {
    const created = await create({ ...work, presetId: "create-work", taskClass: "work", locale: "zh-CN" });
    assert.equal(created.ok, true, `work fixture ${work.taskId} create failed: ${JSON.stringify(created)}`);
  }
  for (const task of TASKS) {
    const created = await create({ taskId: task.taskId, title: task.title, parentTaskId: task.parent });
    assert.equal(created.ok, true, `task fixture ${task.taskId} create failed: ${JSON.stringify(created)}`);
  }
}

/** 派工流落盘(生产同形状:头部归因 + provider_binding/process/runtime_metrics 记录)。 */
function seedDispatchStreams(rootDir) {
  const directory = path.join(rootDir, ".harness", "runtime", "dispatches");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [index, spec] of dispatches.entries()) {
    const dispatchId = dispatchIdOf(spec.key),
      runtimeSessionId = runtimeSessionIdOf(spec.key),
      startedMs = now - spec.hoursAgo * HOUR,
      startedAt = new Date(startedMs).toISOString(),
      endedAt = new Date(startedMs + 47 * 60_000 + index).toISOString(),
      metricsAt = new Date(startedMs + 46 * 60_000).toISOString(),
      lines = [
        {
          schema: streamSchema,
          kind: "dispatch",
          dispatchId,
          taskId: spec.taskId,
          executionId: null,
          runtimeSessionId,
          instanceId: `instance-${spec.agentId}`,
          startedAt,
          eventStreamRef: `file:.harness/runtime/dispatches/${dispatchId}.jsonl`,
          kindId: "codex",
          agentId: spec.agentId,
          agentName: spec.agentName,
          model: spec.model,
        },
        {
          schema: streamSchema,
          kind: "provider_binding",
          occurredAt: startedAt,
          providerSessionId: `provider-${spec.key}`,
        },
        { schema: streamSchema, kind: "process_started", occurredAt: startedAt, pid: 40_000 + index },
        {
          schema: streamSchema,
          kind: "runtime_metrics",
          occurredAt: metricsAt,
          ...spec.metrics,
          totalTokens: totalTokensOf(spec.metrics),
          compacted: false,
          raw: {},
          usageUnavailable: false,
        },
        { schema: streamSchema, kind: "process_exit", occurredAt: endedAt, exitCode: 0, signal: null },
      ];
    writeFileSync(
      path.join(directory, `${dispatchId}.jsonl`),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
      { mode: 0o600 },
    );
  }
}

export default {
  id: "token-usage-costs",
  feature: "token-usage",
  lane: "isolated",
  description:
    "Seeded list-price amounts render on the real token usage read: headline carries the converted cost with the price-table version and the unpriced share only when one exists, the model ranking badges no-price models and keeps sub-cent rows non-zero, the trend readout and table carry per-bucket costs, the member detail totals include the cost row, and task/work grouping rows convert the same usage.",
  async run({ page, fixture, shot }) {
    assert.ok(fixture, "the token-usage-costs scenario needs the isolated lane fixture");
    // 仓先 warming 后 attached:金额读在 warming 期会被拒,先等系统读面说仓已挂载。
    const deadline = Date.now() + REPO_ATTACHMENT_TIMEOUT_MS;
    for (;;) {
      const attached = await page.evaluate(
        async ({ repoId }) => {
          const repos = (await globalThis.harness.getSystemStatus()).repos ?? [];
          return repos.some((repo) => repo.repoId === repoId && repo.cellState === "attached");
        },
        { repoId: fixture.repoId },
      );
      if (attached) break;
      if (Date.now() > deadline)
        throw new Error(`the isolated repo ${fixture.repoId} never reached cellState=attached`);
      await page.waitForTimeout(500);
    }
    await seedTasks(fixture.endpoint, fixture.repoId);
    seedDispatchStreams(fixture.rootDir);
    // fullPage 截图不会展开内部滚动容器,加高视口让排行/归集卡整卡入镜。
    await page.setViewportSize({ width: 1440, height: 1400 });

    await page.getByRole("button", { name: /^(?:Token 消耗|Token Usage)$/u }).click();
    const view = page.getByTestId("token-usage-view");
    await view.waitFor();
    const costLine = page.getByTestId("token-usage-cost");
    await costLine.waitFor();

    // ①a 今天全有价:金额 + 折算口径 + 版本日期,没有未计价提示。
    await assertCostLine(costLine, { cost: "$260.96", unpriced: false });
    await shot("headline-today-all-priced");

    // ①b 7 天含无价用量(swe2):页首出现未计价占比提示。
    await clickOption(page, "时间范围", "7 天");
    await assertCostLine(costLine, { cost: "$304.16", unpriced: true });
    await shot("headline-7d-unpriced");

    // ② 模型排行:swe2 行「无价格」+ 有价模型的金额列。
    await clickOption(page, "消耗视角", "模型");
    const sweRow = page.getByTestId("token-usage-rank-swe2");
    await sweRow.waitFor();
    assert.match(await sweRow.innerText(), /无价格|no price/u, "the swe2 model row must say it has no price");
    assert.match(
      await page.getByTestId("token-usage-rank-gpt-5.6-sol").innerText(),
      /\$248\.00/u,
      "the priced model row must carry its converted amount (d1+d3 today plus the legacy p2 seed)",
    );
    await sweRow.scrollIntoViewIfNeeded();
    await shot("model-ranking-no-price");

    // ③ 金额小于 $0.01 的行:回到今天,模型表格里 gemini 行写 <$0.01(小额 ≠ 0)。
    await clickOption(page, "时间范围", "今天");
    await clickOption(page, "呈现方式", "表格", page.getByTestId("token-usage-ranking-card"));
    const geminiRow = page.getByTestId("token-usage-row-gemini-3.8-flash-high");
    await geminiRow.waitFor();
    assert.match(await geminiRow.innerText(), /<\$0\.01/u, "the sub-cent row must stay non-zero");
    await geminiRow.scrollIntoViewIfNeeded();
    await shot("model-table-small-cost");
    await clickOption(page, "呈现方式", "图表", page.getByTestId("token-usage-ranking-card"));

    // ④a 趋势悬停明细:选中桶的折算金额。桶序号按读侧同一算法算(本地午夜起每小时一桶),
    // 期望值按种子实际落桶求和:窗口宽时 d1 独占自己的小时桶($186.80);凌晨窗口不足、
    // 其他派工与 d1 同桶时,期望是同桶各笔的精确和 —— 任何时段都是实算,不是固定数。
    const d1 = dispatches[0],
      since = localSince,
      bucketOf = (spec) => Math.floor((now - spec.hoursAgo * HOUR - since) / HOUR),
      d1Bucket = bucketOf(d1),
      d1BucketCost = dispatches
        .filter((spec) => spec.cost !== null && spec.hoursAgo * HOUR < now - since && bucketOf(spec) === d1Bucket)
        .reduce((total, spec) => total + spec.cost, 0),
      expectedReadout = d1BucketCost.toFixed(2);
    const bar = view.locator('[data-testid^="token-usage-trend-bar-"]').nth(d1Bucket);
    const box = await bar.boundingBox();
    assert.ok(box, "the trend chart must expose a hoverable bucket");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const readout = page.getByTestId("token-usage-trend-readout");
    await readout.waitFor();
    const readoutText = await readout.innerText();
    assert.ok(
      readoutText.includes(`折算 $${expectedReadout}`) || readoutText.includes(`converted $${expectedReadout}`),
      `the readout must price the bucket at $${expectedReadout}: ${readoutText}`,
    );
    // ①c 四段构成:缓存写有自己的色段与计数;口径说明写明独立计数起点与未上报按 0。
    const note = view.getByTestId("token-usage-cache-write-note");
    await note.waitFor();
    assert.match(
      await note.innerText(),
      /缓存写入自 2026-10-10 起独立计数|counted separately and priced at the cache-write rate since 2026-10-10/u,
      "the cache-write note must date the independent counting",
    );
    const compositionText = await page.getByTestId("token-usage-composition").innerText();
    assert.match(compositionText, /缓存写入|Cache write/u, "the composition must carry the cache-write segment");
    await shot("trend-hover-readout");
    // ④b 趋势表格视图:金额列逐桶。
    await clickOption(page, "呈现方式", "表格", page.getByTestId("token-usage-trend-card"));
    await page.getByTestId("token-usage-trend-table").waitFor();
    await shot("trend-table");
    await clickOption(page, "呈现方式", "图表", page.getByTestId("token-usage-trend-card"));

    // ⑤ 成员详情:单 Worker 视角点 Astra,详情总量卡带金额行($204.80 = d1+d3+d5)。
    await clickOption(page, "消耗视角", "单 Worker");
    await page.getByTestId("token-usage-rank-astra").waitFor();
    await page.getByTestId("token-usage-rank-astra").click();
    const detailTotals = page.getByTestId("token-usage-detail-totals");
    await detailTotals.waitFor();
    assert.match(await detailTotals.innerText(), /\$204\.80/u, "the member detail must convert its own dispatches");
    await shot("member-detail");
    await page.getByTestId("token-usage-detail-back").click();
    await view.waitFor();

    // ⑥ 按任务 / 按工作两种归集:任务行 4 条(含 <$0.01 的排查任务),工作行 2 条。
    await page.getByTestId("token-usage-spend-tasks").waitFor();
    assert.match(
      await page.getByTestId("token-usage-spend-task-cost-triage").innerText(),
      /<\$0\.01/u,
      "the tiny task row must keep its sub-cent amount",
    );
    await shot("spend-by-tasks");
    await clickOption(page, "归集方式", "工作");
    const works = page.getByTestId("token-usage-spend-works");
    await works.waitFor();
    assert.equal(
      await works.locator("[data-testid^='token-usage-spend-task-cost-work-']").count(),
      2,
      "both seeded works must group their child tasks",
    );
    await shot("spend-by-works");

    // ⑦ 英文页首:走真实设置页切换语言后回看(业主要求的英文页首截图)。
    await page.getByRole("button", { name: /^(?:设置|Settings)$/u }).click();
    await page.getByTestId("settings-content").waitFor();
    await page.getByRole("button", { name: /语言|Language/u }).click();
    await page.getByRole("combobox", { name: /^(?:语言|Language)$/u }).selectOption("en-US");
    await page.getByRole("button", { name: /^Token Usage$/u }).click();
    await assertCostLine(costLine, { cost: "$260.96", unpriced: false, english: true });
    await shot("headline-en");
  },
};

/** 页首金额行断言:金额、折算口径(必须明说非实际花费)、版本日期、未计价提示只在有无价用量时出现。 */
async function assertCostLine(costLine, { cost, unpriced, english = false }) {
  await costLine.scrollIntoViewIfNeeded();
  const text = await costLine.innerText();
  assert.match(text, new RegExp(`\\${cost}\\b`, "u"), `the headline must carry ${cost}: ${text}`);
  if (english) {
    assert.match(text, /price table 2026-10-10/u, "the English headline must date the price table");
    assert.match(text, /not actual spend/u, "the English headline must disclaim actual spend");
  } else {
    assert.match(text, /价格表 2026-10-10/u, "the headline must date the price table");
    assert.match(text, /按 API 公开价折算/u, "the headline must say the amount is converted");
    assert.match(text, /非实际花费/u, "the headline must disclaim actual spend");
  }
  if (unpriced) assert.match(text, /无公开价|has no public price/u, "the unpriced share hint must be present");
  else
    assert.doesNotMatch(text, /无公开价|has no public price/u, "no unpriced hint may appear when all usage is priced");
}

/** SegCtl 选项点击:组名 + 选项文本定位(同名组可传 scope 收窄)。 */
async function clickOption(page, groupLabel, optionLabel, scope = page) {
  await scope.getByRole("group", { name: groupLabel }).getByRole("button", { name: optionLabel, exact: true }).click();
}
