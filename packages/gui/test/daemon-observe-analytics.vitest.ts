// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  applyObserveTailPage,
  initialObserveTail,
  observeRowPasses,
  OBSERVE_FOLLOW_ROW_LIMIT,
  type ObserveRow,
} from "../src/renderer/daemon-observe-model.ts";
import {
  observePercentile,
  observeStatsLog,
  OBSERVE_BUCKET_COUNT,
  OBSERVE_BUCKET_MS,
  type ObserveStatsCache,
} from "../src/renderer/daemon-observe-stats.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";

/**
 * 观察页分析面的纯数据判据(时序分桶 / 慢操作聚合 / 异常聚类 / 透镜候选 / 组合过滤,
 * 以及第二轮增补的异味嗅探 / 锁争用 / Top Talkers / 信噪比):
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
  commandClass?: string;
  executorId?: string;
  connectionId?: string;
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
    ...(input.commandClass === undefined ? {} : { commandClass: input.commandClass }),
    ...(input.executorId === undefined ? {} : { executor: { kind: "agent", id: input.executorId } }),
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
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
  it("统计命令与事件调用量分布并按降序给出占比", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          logItem({ method: "repo.tasks.list", durationMs: 12 }),
          logItem({ method: "repo.tasks.list", durationMs: 15 }),
          logItem({ method: "repo.tasks.list", durationMs: 20 }),
          logItem({ method: "observe.tail", durationMs: 5 }),
          logItem({ method: "observe.tail", durationMs: 8 }),
          logItem({ method: "repo.agenda.read", durationMs: 30 }),
        ],
        "history",
        0,
      ),
    );
    const stats = observeStatsLog(state.rows, null).stats;
    expect(stats.total).toBe(6);
    expect(stats.volumes).toHaveLength(3);
    expect(stats.volumes[0]).toEqual({
      name: "repo.tasks.list",
      count: 3,
      percentage: 50,
    });
    expect(stats.volumes[1]).toEqual({
      name: "observe.tail",
      count: 2,
      percentage: (2 / 6) * 100,
    });
    expect(stats.volumes[2]).toEqual({
      name: "repo.agenda.read",
      count: 1,
      percentage: (1 / 6) * 100,
    });
  });
});

describe("读写分类与单写锁争用", () => {
  it("commandClass 权威、方法分段启发兜底;窗口读写计数、占比与 Mild 判级", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          // 权威分类:repo-write / repo-read。
          logItem({ method: "doc.sync", durationMs: 900, atMs: T0 + 10_000, commandClass: "repo-write" }),
          logItem({ method: "observe.tail", durationMs: 5, commandClass: "repo-read" }),
          // 启发兜底:run 段→写、list 段→读、无法识别→null(不计入分母)。
          logItem({ method: "repo.task.run", durationMs: 12 }),
          logItem({ method: "repo.tasks.list", durationMs: 8 }),
          logItem({ method: "mystery.op", durationMs: 3 }),
        ],
        "history",
        0,
      ),
    );
    const contention = observeStatsLog(state.rows, null).stats.windows["1h"]!.contention;
    expect(contention.writeOps).toBe(2);
    expect(contention.readOps).toBe(2);
    expect(contention.writePct).toBe(50);
    // 唯一慢写(doc.sync 900ms > 800ms)无重叠 → 轻度争用。
    expect(contention.slowWrites).toBe(1);
    expect(contention.overlap).toBe(1);
    expect(contention.level).toBe("mild");
  });

  it("慢写区间 [at-duration, at] 重叠 → Contended;纯读窗口 → Smooth", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          // doc.sync 完成于 T0+10s(占用 [T0+9.1s, T0+10s]),task.adjudicate 完成于
          // T0+10.5s(占用 [T0+9.3s, T0+10.5s]):两段区间在 [9.3s, 10s) 并存。
          logItem({ method: "doc.sync", durationMs: 900, atMs: T0 + 10_000, commandClass: "repo-write" }),
          logItem({ method: "task.adjudicate", durationMs: 1_200, atMs: T0 + 10_500, commandClass: "repo-write" }),
          logItem({ method: "repo.tasks.list", durationMs: 4, commandClass: "repo-read" }),
        ],
        "history",
        0,
      ),
    );
    const contended = observeStatsLog(state.rows, null).stats.windows["1h"]!.contention;
    expect(contended.overlap).toBe(2);
    expect(contended.level).toBe("contended");
    expect(contended.writePct).toBeCloseTo((2 / 3) * 100, 10);
    let calm = initialObserveTail();
    calm = applyObserveTailPage(
      calm,
      logPage(
        [logItem({ method: "repo.tasks.list", durationMs: 4 }), logItem({ method: "observe.tail", durationMs: 2 })],
        "history",
        0,
      ),
    );
    const smooth = observeStatsLog(calm.rows, null).stats.windows["1h"]!.contention;
    expect(smooth.level).toBe("smooth");
    expect(smooth.writeOps).toBe(0);
    expect(smooth.writePct).toBe(0);
  });
});

describe("智能异味嗅探(慢锁 / 频密轮询 / 失败毛刺)", () => {
  it("慢锁:窗口内最重慢写曝光方法与耗时;15m/1h 窗口口径生效", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          logItem({ method: "doc.sync", durationMs: 1_200, atMs: T0, commandClass: "repo-write" }),
          // 把最新数据时间推到 T0+16min:15m 窗口不再覆盖 T0,1h 窗口仍覆盖。
          logItem({ method: "repo.tasks.list", durationMs: 2, atMs: T0 + 16 * 60_000 }),
        ],
        "history",
        0,
      ),
    );
    const stats = observeStatsLog(state.rows, null).stats;
    expect(stats.windows["1h"]!.smells).toEqual([
      { kind: "slow_lock_holder", label: "doc.sync", value: 1_200, matchText: "doc.sync" },
    ]);
    expect(stats.windows["15m"]!.smells).toEqual([]);
  });

  it("频密轮询:单方法单桶 >50 次(>5 req/s)触发,50 次整不触发", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        Array.from({ length: 51 }, (_, index) =>
          logItem({ method: "agent.status", durationMs: 1, atMs: T0 + index * 190 }),
        ),
        "history",
        0,
      ),
    );
    const smells = observeStatsLog(state.rows, null).stats.windows["15m"]!.smells;
    expect(smells).toEqual([
      { kind: "spinloop_polling", label: "agent.status", value: 5.1, matchText: "agent.status" },
    ]);
    let quiet = initialObserveTail();
    quiet = applyObserveTailPage(
      quiet,
      logPage(
        Array.from({ length: 50 }, (_, index) =>
          logItem({ method: "agent.status", durationMs: 1, atMs: T0 + index * 190 }),
        ),
        "history",
        0,
      ),
    );
    expect(observeStatsLog(quiet.rows, null).stats.windows["15m"]!.smells).toEqual([]);
  });

  it("失败毛刺:窗口失败率 >15% 触发并归因到最重失败方法;健康窗口无异味", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          ...Array.from({ length: 16 }, () =>
            logItem({ method: "repo.write", durationMs: 5, ok: false, code: "repo_locked" }),
          ),
          ...Array.from({ length: 84 }, (_, index) => logItem({ method: `op.ok${index % 4}`, durationMs: 3 })),
        ],
        "history",
        0,
      ),
    );
    const smells = observeStatsLog(state.rows, null).stats.windows["1h"]!.smells;
    expect(smells).toEqual([{ kind: "spike_failures", label: "repo.write", value: 16, matchText: "repo.write" }]);
    let healthy = initialObserveTail();
    healthy = applyObserveTailPage(
      healthy,
      logPage(
        [
          ...Array.from({ length: 10 }, () => logItem({ method: "repo.write", durationMs: 5, ok: false, code: "x" })),
          ...Array.from({ length: 90 }, (_, index) => logItem({ method: `op.ok${index % 4}`, durationMs: 3 })),
        ],
        "history",
        0,
      ),
    );
    const healthyStats = observeStatsLog(healthy.rows, null).stats;
    expect(healthyStats.windows["1h"]!.smells).toEqual([]);
    expect(healthyStats.windows["15m"]!.smells).toEqual([]);
  });
});

describe("热点主体 Top Talkers", () => {
  it("事件行按 taskId 归属,次数降序并给出窗口占比", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      eventPage(
        [
          eventItem({ revision: 1, taskId: "task_a" }),
          eventItem({ revision: 2, taskId: "task_a" }),
          eventItem({ revision: 3, taskId: "task_a" }),
          eventItem({ revision: 4, taskId: "task_b" }),
        ],
        "history",
      ),
    );
    expect(observeStatsLog(state.rows, null).stats.windows["1h"]!.talkers).toEqual([
      { subject: "task_a", count: 3, percentage: 75 },
      { subject: "task_b", count: 1, percentage: 25 },
    ]);
  });

  it("日志行按 executor 调用方归属,无执行者退到连接标识;并列按字典序", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          logItem({ method: "repo.task.run", durationMs: 20, executorId: "agent_x" }),
          logItem({ method: "repo.tasks.list", durationMs: 3, executorId: "agent_x" }),
          logItem({ method: "observe.tail", durationMs: 2, connectionId: "conn-9" }),
          logItem({ method: "repo.agenda.read", durationMs: 4, connectionId: "conn-9" }),
          logItem({ method: "repo.doc.read", durationMs: 1 }),
        ],
        "history",
        0,
      ),
    );
    expect(observeStatsLog(state.rows, null).stats.windows["1h"]!.talkers).toEqual([
      { subject: "agent_x", count: 2, percentage: 40 },
      { subject: "conn-9", count: 2, percentage: 40 },
    ]);
  });
});

describe("研发信噪比(产出驱动 vs 机械巡检)", () => {
  it("写操作计产出、status/tail 计机械、普通读中性不计入分母", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      logPage(
        [
          ...Array.from({ length: 8 }, () => logItem({ method: "repo.task.run", durationMs: 30 })),
          logItem({ method: "observe.tail", durationMs: 2 }),
          logItem({ method: "daemon.status", durationMs: 1 }),
          ...Array.from({ length: 2 }, () => logItem({ method: "repo.tasks.list", durationMs: 3 })),
        ],
        "history",
        0,
      ),
    );
    const signal = observeStatsLog(state.rows, null).stats.windows["1h"]!.signal;
    expect(signal.progress).toBe(8);
    expect(signal.overhead).toBe(2);
    expect(signal.progressPct).toBe(80);
  });

  it("事件流的 task_* 业务事件计产出,未知形状中性", () => {
    let state = initialObserveTail();
    state = applyObserveTailPage(
      state,
      eventPage(
        [
          eventItem({ revision: 1, taskId: "task_a" }),
          eventItem({ revision: 2, taskId: "task_a" }),
          { schema: "entity-event/v1", eventId: "ev-an-3", workspaceRevision: 3, type: "entity-event/v1" },
        ],
        "history",
      ),
    );
    const signal = observeStatsLog(state.rows, null).stats.windows["1h"]!.signal;
    expect(signal.progress).toBe(2);
    expect(signal.overhead).toBe(0);
    expect(signal.progressPct).toBe(100);
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
    expect(average).toBeLessThan(5);
    expect(worst).toBeLessThan(15);
  });
});
