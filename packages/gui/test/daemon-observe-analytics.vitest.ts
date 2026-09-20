// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  applyObserveTailPage,
  initialObserveTail,
  observePercentile,
  observeRowPasses,
  observeStatsLog,
  OBSERVE_BUCKET_COUNT,
  OBSERVE_BUCKET_MS,
  OBSERVE_FOLLOW_ROW_LIMIT,
  type ObserveRow,
  type ObserveStatsCache,
} from "../src/renderer/daemon-observe-model.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";

/**
 * 观察页分析面的纯数据判据(时序分桶 / 慢操作聚合 / 异常聚类 / 透镜候选 / 组合过滤):
 *  - 分桶是固定 10s × 360 桶环形缓冲:更老的行只进总数、时间跳跃覆盖旧槽位;
 *  - 统计与查询过滤同构:同版本零重算(缓存复用),growth 只喂新增行,丢行后全量重建,
 *    且「增量路径」与「从零重建路径」产出可观察相同的统计(等价性判据);
 *  - P50/P95/Max 分位点、Top 慢操作排序、异常指纹去重与 lastAt 推进均有精确断言;
 *  - 5000 行上限滚动下的统计耗时是数量级证据(< 3ms,任务 Evidence Protocol),进报告。
 */

const REPO_ID = "analytics-probe",
  // 桶下标按绝对 epoch 取整:测试基准时间对齐到桶边界,断言才与 T0 相对时间一致。
  T0 = Math.floor(Date.UTC(2026, 8, 20) / OBSERVE_BUCKET_MS) * OBSERVE_BUCKET_MS;

function logItem(input: {
  method: string;
  durationMs: number;
  ok?: boolean;
  code?: string | null;
  atMs?: number;
  nodeId?: string;
}): Record<string, unknown> {
  return {
    schema: "daemon-request-log/v1",
    at: new Date(input.atMs ?? T0).toISOString(),
    method: input.method,
    event: "request",
    ok: input.ok ?? true,
    code: input.code ?? null,
    durationMs: input.durationMs,
    ...(input.nodeId === undefined ? {} : { daemonId: input.nodeId }),
  };
}

function logPage(
  items: readonly Record<string, unknown>[],
  direction: "history" | "follow",
  offset: number,
): ObserveTailRead {
  return {
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: REPO_ID,
    mode: "local",
    kind: "repo-log",
    direction,
    status: "ready",
    items: items as never,
    historyCursor: direction === "history" && items.length > 0 ? { kind: "repo-log", fileId: "f", offset } : null,
    liveCursor: { kind: "repo-log", fileId: "f", offset: offset + items.length * 88 },
    sourceCursor: { kind: "repo-log", fileId: "f", offset: offset + items.length * 88 },
    done: true,
  };
}

function eventItem(input: { revision: number; atMs?: number; taskId?: string; sessionId?: string }): object {
  return {
    schema: "task-event/v1",
    eventId: `ev-an-${input.revision}`,
    workspaceRevision: input.revision,
    opId: "op-an",
    type: "task_created",
    actor: { kind: "agent", id: "agent_an" },
    source: { channel: "cli" },
    occurredAt: new Date(input.atMs ?? T0).toISOString(),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    payload: {
      ...(input.sessionId === undefined ? {} : { runtimeSessionId: input.sessionId }),
      task: { title: `row-${input.revision}` },
    },
  };
}

function eventPage(items: readonly object[], direction: "history" | "follow"): ObserveTailRead {
  const revisions = items.map((item) => (item as { workspaceRevision: number }).workspaceRevision);
  return {
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: REPO_ID,
    mode: "local",
    kind: "events",
    direction,
    status: "ready",
    items: items as never,
    historyCursor:
      direction === "history" && items.length > 0 ? { kind: "events", revision: Math.min(...revisions) } : null,
    liveCursor: { kind: "events", revision: revisions.length > 0 ? Math.max(...revisions) : 0 },
    sourceCursor: { kind: "events", revision: revisions.length > 0 ? Math.max(...revisions) : 0 },
    done: true,
  };
}

const collect = (rows: Iterable<ObserveRow>): ObserveRow[] => Array.from(rows);

describe("时序吞吐分桶(固定 10s × 360 环形缓冲)", () => {
  it("同一 10s 窗口的行进同一桶,异常单独计数;桶边界是 [start, end)", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          logItem({ method: "a", durationMs: 1, atMs: T0 }),
          logItem({ method: "a", durationMs: 2, atMs: T0 + 9_999 }),
          logItem({ method: "a", durationMs: 3, atMs: T0 + 10_000 }),
          logItem({ method: "a", durationMs: 4, ok: false, code: "x", atMs: T0 + 12_000 }),
        ],
        "history",
        0,
      ),
    );
    const stats = observeStatsLog(state.rows, null).stats;
    expect(stats.total).toBe(4);
    expect(stats.anomalies).toBe(1);
    // 环形窗口含零桶基线(HUD 的空柱),数据行落进最后两个桶。
    const filled = stats.buckets.filter((bucket) => bucket.count > 0);
    expect(filled).toHaveLength(2);
    expect(filled[0]).toMatchObject({ startMs: T0, endMs: T0 + OBSERVE_BUCKET_MS, count: 2, anomalies: 0 });
    expect(filled[1]).toMatchObject({
      startMs: T0 + OBSERVE_BUCKET_MS,
      endMs: T0 + 2 * OBSERVE_BUCKET_MS,
      count: 2,
      anomalies: 1,
    });
  });

  it("比 1h 窗口更老的行只进总数不进桶;时间跳跃一整圈清空全部旧桶", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          logItem({ method: "a", durationMs: 1, atMs: T0 }),
          // 比 latest - 359 桶更老:进总数、不进任何桶。
          logItem({ method: "a", durationMs: 2, atMs: T0 - OBSERVE_BUCKET_MS }),
        ],
        "history",
        0,
      ),
    );
    state = applyObserveTailPage(
      state,
      logPage(
        [
          // 前进 2 小时:跳跃 ≥ 360 桶,整环清零,旧行只剩总数贡献。
          logItem({ method: "a", durationMs: 3, atMs: T0 + 2 * OBSERVE_BUCKET_MS * OBSERVE_BUCKET_COUNT }),
        ],
        "follow",
        1_000,
      ),
    );
    const stats = observeStatsLog(state.rows, null).stats;
    expect(stats.total).toBe(3);
    expect(stats.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1);
    expect(stats.buckets.at(-1)!.count).toBe(1);
  });
});

describe("慢操作聚合与分位点", () => {
  it("按方法聚合次数/最大值,Top 排序按 maxMs 降序;P50/P95/Max 取最近邻上取整秩", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          ...Array.from({ length: 100 }, (_, index) => logItem({ method: "fast.list", durationMs: index + 1 })),
          logItem({ method: "task.adjudicate", durationMs: 4_859 }),
          logItem({ method: "task.adjudicate", durationMs: 4_000 }),
        ],
        "history",
        0,
      ),
    );
    const stats = observeStatsLog(state.rows, null).stats;
    expect(stats.ops[0]).toMatchObject({ method: "task.adjudicate", count: 2, maxMs: 4_859 });
    expect(stats.ops[1]!.method).toBe("fast.list");
    // 102 个耗时的最近邻上取整秩:P50 = 第 51 个 = 51;P95 = 第 97 个 = 97。
    expect(stats.p50Ms).toBe(51);
    expect(stats.p95Ms).toBe(97);
    expect(stats.maxMs).toBe(4_859);
    expect(observePercentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(observePercentile([], 0.95)).toBeNull();
  });
});

describe("异常与缺口指纹聚类", () => {
  it("同类失败(方法+失败码)去重计数,lastAt 取最新,gap 标记独立成簇", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          logItem({ method: "repo.write", durationMs: 5, ok: false, code: "repo_locked", atMs: T0 }),
          logItem({ method: "repo.write", durationMs: 6, ok: false, code: "repo_locked", atMs: T0 + 5_000 }),
          logItem({ method: "repo.write", durationMs: 7, ok: false, code: "repo_locked", atMs: T0 + 1_000 }),
          logItem({ method: "repo.write", durationMs: 8, ok: false, code: "lease_lost", atMs: T0 + 2_000 }),
        ],
        "history",
        0,
      ),
    );
    state = applyObserveTailPage(state, {
      schema: "daemon.observe-tail/v3",
      ok: true,
      repoId: REPO_ID,
      mode: "local",
      kind: "repo-log",
      // history 方向的缺口只在行头插标记不裁剪(follow 方向的 gap 会整表重置,契约如此)。
      direction: "history",
      status: "gap",
      items: [],
      historyCursor: null,
      liveCursor: null,
      sourceCursor: null,
      done: false,
      gap: { reason: "cursor-file-not-retained", requestedFileId: "file-gone" },
    });
    const stats = observeStatsLog(state.rows, null).stats;
    expect(stats.anomalies).toBe(5);
    const byKey = new Map(stats.clusters.map((cluster) => [cluster.key, cluster]));
    expect(byKey.get("err|repo.write|repo_locked")).toMatchObject({
      count: 3,
      kind: "error",
      label: "repo.write · repo_locked",
      matchText: "repo_locked",
      lastAt: new Date(T0 + 5_000).toISOString(),
    });
    expect(byKey.get("err|repo.write|lease_lost")!.count).toBe(1);
    expect(byKey.get("gap|cursor-file-not-retained")).toMatchObject({
      kind: "gap",
      count: 1,
      matchText: "gap cursor-file-not-retained",
    });
    // 聚类排序按次数降序。
    expect(stats.clusters[0]!.count).toBeGreaterThanOrEqual(stats.clusters[1]!.count);
  });
});

describe("透镜候选(活跃 task/session/method/node)", () => {
  it("事件引用与日志节点/方法分别归组,按频次排序", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      eventPage(
        [
          eventItem({ revision: 1, taskId: "task_a" }),
          eventItem({ revision: 2, taskId: "task_a" }),
          eventItem({ revision: 3, taskId: "task_b" }),
          eventItem({ revision: 4, sessionId: "runtime_x" }),
        ],
        "history",
      ),
    );
    state = applyObserveTailPage(
      state,
      logPage(
        [
          logItem({ method: "repo.tasks.list", durationMs: 3, nodeId: "edge-1" }),
          logItem({ method: "repo.tasks.list", durationMs: 4, nodeId: "edge-1" }),
          logItem({ method: "repo.write", durationMs: 9, nodeId: "edge-2" }),
        ],
        "follow",
        500,
      ),
    );
    const lens = observeStatsLog(state.rows, null).stats.lens;
    expect(lens.tasks.map((entry) => [entry.value, entry.count])).toEqual([
      ["task_a", 2],
      ["task_b", 1],
    ]);
    expect(lens.sessions.map((entry) => entry.value)).toEqual(["runtime_x"]);
    expect(lens.methods.map((entry) => [entry.value, entry.count])).toEqual([
      ["repo.tasks.list", 2],
      ["repo.write", 1],
    ]);
    expect(lens.nodes.map((entry) => [entry.value, entry.count])).toEqual([
      ["edge-1", 2],
      ["edge-2", 1],
    ]);
  });
});

describe("组合过滤(透镜 + 时段)", () => {
  const rows = collect(
    applyObserveTailPage(
      initialObserveTail(),
      logPage(
        [
          logItem({ method: "a.op", durationMs: 1, atMs: T0 }),
          logItem({ method: "b.op", durationMs: 2, atMs: T0 + 30_000, nodeId: "edge-1" }),
        ],
        "history",
        0,
      ),
    ).rows,
  );
  it("透镜命中 searchText(含节点归属),时段按 atMs 半开区间过滤,无时间行被时段排除", () => {
    const passes = (filter: Parameters<typeof observeRowPasses>[1]) =>
      rows.filter((row) => observeRowPasses(row, filter));
    expect(passes({ needle: "", lens: "a.op", fromMs: null, toMs: null })).toHaveLength(1);
    expect(passes({ needle: "", lens: "edge-1", fromMs: null, toMs: null })).toHaveLength(1);
    expect(passes({ needle: "", lens: null, fromMs: T0 + 30_000, toMs: T0 + 40_000 })).toHaveLength(1);
    expect(passes({ needle: "", lens: null, fromMs: T0, toMs: T0 + 10_000 })).toHaveLength(1);
  });
});

describe("统计缓存:增量续用与等价性", () => {
  it("同版本零重算;growth 只喂新增行;增量结果与从零重建可观察等价;丢行后全量重建", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        Array.from({ length: 40 }, (_, index) =>
          logItem({
            method: `m${index % 4}`,
            durationMs: index,
            ok: index % 9 === 0,
            code: index % 9 === 0 ? "boom" : null,
          }),
        ),
        "history",
        0,
      ),
    );
    const first = observeStatsLog(state.rows, null);
    expect(observeStatsLog(state.rows, first)).toBe(first);
    state = applyObserveTailPage(
      state,
      logPage(
        Array.from({ length: 24 }, (_, index) => logItem({ method: `m${index % 4}`, durationMs: 500 + index })),
        "follow",
        4_000,
      ),
    );
    const grown = observeStatsLog(state.rows, first);
    expect(grown).not.toBe(first);
    expect(grown.stats.total).toBe(64);
    // 等价性:增量路径与缓存丢弃后的全量重建产出逐字段相同的统计。
    expect(observeStatsLog(state.rows, null).stats).toEqual(grown.stats);
    // 贴底封顶丢行后缓存作废重建,统计与行集重新对齐。
    state = applyObserveTailPage(state, { ...logPage([logItem({ method: "m0", durationMs: 1 })], "follow", 9_999) });
    const afterDrop = observeStatsLog(state.rows, grown);
    expect(afterDrop.stats.total).toBe(state.rows.length);
    expect(observeStatsLog(state.rows, null).stats).toEqual(afterDrop.stats);
  });
});

describe("5000 行上限滚动下的统计耗时(Evidence Protocol)", () => {
  it("HUD 统计与慢操作聚合的每页计算 < 3ms,含封顶丢行后的全量重建路径", () => {
    let state = initialObserveTail();
    const width = 64;
    for (let page = 0; page * width < OBSERVE_FOLLOW_ROW_LIMIT; page += 1) {
      const items = Array.from({ length: Math.min(width, OBSERVE_FOLLOW_ROW_LIMIT - page * width) }, (_, index) =>
        logItem({ method: `m${(page * width + index) % 12}`, durationMs: (page * width + index) % 900 }),
      );
      state = applyObserveTailPage(state, logPage(items, "history", page * width * 88));
    }
    expect(state.rows).toHaveLength(OBSERVE_FOLLOW_ROW_LIMIT);
    let cache: ObserveStatsCache | null = observeStatsLog(state.rows, null);
    let offset = OBSERVE_FOLLOW_ROW_LIMIT * 88;
    /** 一次「页应用 + 统计」最重路径:follow 增长越过上限 → 贴底丢最旧端 → 全量重建。 */
    const runPage = (page: number) => {
      state = applyObserveTailPage(
        state,
        logPage(
          Array.from({ length: 16 }, (_, index) => logItem({ method: `m${index}`, durationMs: 100 * index + page })),
          "follow",
          offset,
        ),
      );
      offset += 16 * 88;
      cache = observeStatsLog(state.rows, cache);
    };
    // 预热 10 页(不计入):首轮全量重建带着 JIT 冷启动,不是稳态每页代价。
    for (let page = 0; page < 10; page += 1) runPage(page);
    const pageCosts: number[] = [];
    for (let page = 10; page < 60; page += 1) {
      const started = performance.now();
      runPage(page);
      pageCosts.push(performance.now() - started);
    }
    const worst = Math.max(...pageCosts),
      average = pageCosts.reduce((sum, cost) => sum + cost, 0) / pageCosts.length;
    console.info(
      `[perf] observe stats over ${OBSERVE_FOLLOW_ROW_LIMIT}-row capped follow:` +
        ` 50 pages | avg ${average.toFixed(3)}ms | worst ${worst.toFixed(3)}ms`,
    );
    expect(cache!.stats.total).toBe(state.rows.length);
    expect(average).toBeLessThan(3);
    expect(worst).toBeLessThan(3);
  });
});
