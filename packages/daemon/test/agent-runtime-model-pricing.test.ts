// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import {
  readAgentRuntimeTokenUsage,
  readAgentRuntimeTokenUsageDetail,
  validateAgentRuntimeTokenUsage,
  validateAgentRuntimeTokenUsageDetail,
} from "../src/agent-runtime-token-usage.ts";
import { modelPriceOf, modelPricingVersion, usageCostUsd } from "../src/agent-runtime-model-pricing.ts";

/** 价格模块与读面金额累加的定向测试:三段计价(新输入/缓存读/输出)、无价格模型不按 0 计、
 * 金额出现在每个聚合维度、校验器接受新形状。 */

const NOW = "2026-10-09T12:00:00.000Z",
  CUT = { status: "ready" as const, watermark: 3, sourceRevision: 3 },
  EMPTY_PROJECTION = { readRuntimeDispatchPage: () => ({ rows: [], nextCursor: null, done: true }) };

test("the price table resolves exact, case-folded and missing ids", () => {
  const glm = modelPriceOf("GLM-5.3");
  assert.deepEqual(glm, { inputPerMillion: 1.4, cacheReadPerMillion: 0.26, outputPerMillion: 4.4 });
  // 同一模型的大小写漂移也要能命中:查价先精确后折叠。
  assert.deepEqual(modelPriceOf("glm-5.3"), glm);
  assert.deepEqual(modelPriceOf("opus"), modelPriceOf("claude-opus-5-5"));
  assert.equal(modelPriceOf("swe2"), null);
  assert.equal(modelPriceOf(null), null);
  assert.equal(modelPriceOf(""), null);
  assert.match(modelPricingVersion, /^\d{4}-\d{2}-\d{2}$/u);
});

test("usageCostUsd prices the three token kinds separately", () => {
  const price = { inputPerMillion: 4, cacheReadPerMillion: 0.4, outputPerMillion: 20 };
  // inputTokens 含缓存读:新输入 800K、缓存读 7.65M、输出 4.37M(今天的真实量级)。
  assert.ok(
    Math.abs(
      usageCostUsd(price, { inputTokens: 8_450_000, cacheReadTokens: 7_650_000, outputTokens: 4_370_000 }) -
        (0.8 * 4 + 7.65 * 0.4 + 4.37 * 20),
    ) < 1e-9,
  );
  // 缓存读价是输入价的 1/10:把缓存读错按输入价计,仅这一段就多算 7.65M×($4−$0.4)。
  const correct = usageCostUsd(price, { inputTokens: 8_450_000, cacheReadTokens: 7_650_000, outputTokens: 4_370_000 }),
    cacheAtInputRate = 7.65 * (4 - 0.4);
  assert.ok(cacheAtInputRate / correct > 0.25, "mispricing cache reads must change the amount materially");
  // cacheReadTokens 超过 inputTokens 时按 inputTokens 截断:新输入不为负。
  assert.ok(usageCostUsd(price, { inputTokens: 100, cacheReadTokens: 500, outputTokens: 0 }) >= 0);
});

/** metrics 的生产口径:inputTokens 含缓存读,totalTokens = input + output(settlement 写入同构)。 */
function metrics(input: number, cache: number, output: number) {
  return {
    kind: "runtime_metrics",
    inputTokens: input,
    cacheReadTokens: cache,
    outputTokens: output,
    totalTokens: input + output,
    toolCallCount: 1,
    compacted: false,
    raw: { input_tokens: input, output_tokens: output },
  };
}

function seed(rootDir: string): void {
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000bb01",
    taskId: "task-cost",
    executionId: "execution-1",
    runtimeSessionId: "runtime-priced",
    instanceId: "instance-openai",
    startedAt: NOW,
    agentId: "terra",
    agentName: "Terra",
    model: "gpt-5.6-sol",
  });
  appendRuntimeWorkerRecord(rootDir, "dispatch_00000000000000000000bb01", metrics(2_000_000, 1_900_000, 500_000));
  // 无公开价的模型:金额不计,token 计入未计价。
  openDispatchStream(rootDir, {
    dispatchId: "dispatch_00000000000000000000bb02",
    taskId: "task-cost",
    executionId: "execution-2",
    runtimeSessionId: "runtime-unpriced",
    instanceId: "instance-relay",
    startedAt: NOW,
    agentId: "terra",
    agentName: "Terra",
    model: "swe2",
  });
  appendRuntimeWorkerRecord(rootDir, "dispatch_00000000000000000000bb02", metrics(300_000, 0, 100_000));
}

function read(rootDir: string, now = NOW) {
  return readAgentRuntimeTokenUsage({
    rootDir,
    now,
    range: "today",
    entityLabel: () => null,
    taskOf: (taskId) => ({ taskId, title: taskId, taskClass: "task", parentTaskId: null }),
    cut: CUT,
    projection: EMPTY_PROJECTION,
  });
}

test("the aggregate converts priced models and counts unpriced tokens per dimension", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-pricing-"));
  try {
    seed(rootDir);
    const result = read(rootDir);
    assert.deepEqual(validateAgentRuntimeTokenUsage(result), []);
    assert.equal(result.pricing.version, modelPricingVersion);
    // 定价派工:新输入 100K×$4 + 缓存读 1.9M×$0.4 + 输出 500K×$20(每 1M)。
    const expected = 0.1 * 4 + 1.9 * 0.4 + 0.5 * 20;
    assert.ok(Math.abs(result.totals.costUsd - expected) < 1e-9);
    assert.equal(result.totals.unpricedTokens, 400_000);
    // 成员行与模型行带同一金额;无价格模型的行金额为 0、全部 token 未计价。
    const terra = result.agents.find(({ agentId }) => agentId === "terra")!;
    assert.ok(Math.abs(terra.costUsd - expected) < 1e-9);
    assert.equal(terra.unpricedTokens, 400_000);
    const priced = result.models.find(({ model }) => model === "gpt-5.6-sol")!,
      unpriced = result.models.find(({ model }) => model === "swe2")!;
    assert.ok(Math.abs(priced.costUsd - expected) < 1e-9);
    assert.equal(priced.unpricedTokens, 0);
    assert.equal(unpriced.costUsd, 0);
    assert.equal(unpriced.unpricedTokens, unpriced.totalTokens);
    // 时间桶:定价派工所在桶带金额。
    const spent = result.buckets.filter((bucket) => bucket.totalTokens > 0);
    assert.equal(spent.length, 1);
    assert.ok(Math.abs(spent[0]!.costUsd - expected) < 1e-9);
    // 任务行带金额(两条派工同一任务)。
    assert.equal(result.tasks.length, 1);
    assert.ok(Math.abs(result.tasks[0]!.costUsd - expected) < 1e-9);
    // 环比周期也带金额与未计价(token 计入,只是价格不编)。
    assert.equal(result.previous.totals.unpricedTokens, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the member detail carries cost totals computed from each session's model", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-pricing-detail-"));
  try {
    seed(rootDir);
    const detail = readAgentRuntimeTokenUsageDetail({
      rootDir,
      now: NOW,
      range: "today",
      member: { kind: "agent", agentId: "terra" },
      entityLabel: () => null,
      cut: CUT,
      projection: EMPTY_PROJECTION,
    });
    assert.deepEqual(validateAgentRuntimeTokenUsageDetail(detail), []);
    assert.equal(detail.pricing.version, modelPricingVersion);
    const expected = 0.1 * 4 + 1.9 * 0.4 + 0.5 * 20;
    assert.ok(Math.abs(detail.totals.costUsd - expected) < 1e-9);
    assert.equal(detail.totals.unpricedTokens, 400_000);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the validators reject results whose cost fields are absent or negative", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-token-pricing-invalid-"));
  try {
    seed(rootDir);
    const result = read(rootDir) as unknown as Record<string, unknown>;
    assert.deepEqual(validateAgentRuntimeTokenUsage(result), []);
    const totals = result.totals as Record<string, unknown>;
    assert.notEqual(
      validateAgentRuntimeTokenUsage({ ...result, totals: { ...totals, costUsd: -1 } }),
      [],
      "negative cost must be rejected",
    );
    const { costUsd: _dropped, ...withoutCost } = totals;
    assert.notEqual(
      validateAgentRuntimeTokenUsage({ ...result, totals: withoutCost }),
      [],
      "missing cost field must be rejected",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
