// harness-test-tier: fast
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

import type { TaskListSuccess } from "../src/renderer/api-client.ts";
import {
  activeTasksQuery,
  HYDRATION_PAGE_BUDGET,
  invalidateLedgerDependents,
  mergeTaskRows,
  readActiveTaskSlice,
  readTaskList,
  TASK_LIST_PAGE_LIMIT,
} from "../src/renderer/task-data.ts";

/**
 * W6 Goal 第二个合取项(`task_be076d3ac25b87b79be09b02dd`)的演进版(task_8bc3ca29):
 * 原「一次刷新只发一个分页请求」把续读交给 2s 探针节拍,2,826 行要 10~12s(F-45297836)。
 * 现合同是**受控快读水化 + 首屏状态下推**:
 *   - 同一刷新内沿游标顺序把剩余页拉完(每页严格等上一页),但单次刷新的页请求
 *     ≤ HYDRATION_PAGE_BUDGET——预算是防失控 drain 的硬上限,坏游标/断网最坏也只是
 *     每个探针节拍一串有界请求,没有无限循环;
 *   - 首屏活跃切片走 `status` 下推窄读,不把全量拉到前端再筛;
 *   - 稳态(切面 ready)仍然一页增量、一个请求。
 * (第三个合取项「只显示前 N 条必须显形」在 `gui-w6-truncation-visibility.vitest.ts`。)
 */

const LEDGER_ROWS = 1_538; // canonical 2026-08-24 的实际台账规模

function projectionRow(index: number, status = "done"): TaskListSuccess["rows"][number] {
  const taskId = `task_${String(index).padStart(6, "0")}`;
  return {
    taskId,
    createdAt: null,
    updatedAt: "2026-08-24T00:00:00.000Z",
    generation: "v1",
    snapshot: { task: { schema: "task/v2", taskId, title: `Task ${index}`, pinned: false, status } },
  } as unknown as TaskListSuccess["rows"][number];
}

interface LedgerCall {
  readonly cursor: string | null;
  readonly changedAfterRevision: number | null;
  readonly status: string | null;
  readonly rows: number;
}

/**
 * daemon 分页语义的忠实替身:keyset 按不可变主键 task_id 升序
 * (kernel `listTaskRowsNarrow`:`task_snapshot.task_id > ?`、`ORDER BY task_id`,
 * `WHERE task_snapshot.status = ?`),cursor 就是上一页最后一个 task_id,
 * `changedAfterRevision` 按行 revision 过滤。`neverEnds` 模拟死游标/无限台账:
 * 页页都报 nextCursor,用来验证页预算封顶。
 */
function installFakeLedger(size = LEDGER_ROWS, options: { readonly neverEnds?: boolean } = {}) {
  const rows = Array.from({ length: size }, (_, index) => projectionRow(index));
  const revisionOf = new Map(rows.map((row) => [row.taskId, 1_000]));
  const state = { watermark: 1_000, sourceRevision: 1_000, status: "ready" as "ready" | "pending" };
  const calls: LedgerCall[] = [];
  const getTasks = vi.fn(
    async (payload: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly status?: string;
      readonly changedAfterRevision?: number;
    }) => {
      const limit = payload.limit ?? 100,
        after = payload.cursor ?? null;
      const eligible = rows.filter(
        (row) =>
          (after === null || row.taskId > after) &&
          (payload.status === undefined || row.snapshot.task?.status === payload.status) &&
          (payload.changedAfterRevision === undefined || revisionOf.get(row.taskId)! > payload.changedAfterRevision),
      );
      const visible = eligible.slice(0, limit),
        last = visible.at(-1);
      calls.push({
        cursor: after,
        changedAfterRevision: payload.changedAfterRevision ?? null,
        status: payload.status ?? null,
        rows: visible.length,
      });
      return {
        ok: true,
        status: state.status,
        rows: visible,
        invalidRows: [],
        watermark: state.watermark,
        sourceRevision: state.sourceRevision,
        warnings: [],
        page: {
          limit,
          cursor: after,
          nextCursor: eligible.length > limit && last ? last.taskId : options.neverEnds === true ? after : null,
        },
      };
    },
  );
  Object.defineProperty(window, "harness", { configurable: true, value: { getTasks } });
  return {
    calls,
    state,
    rows,
    touch(index: number) {
      state.watermark += 1;
      state.sourceRevision = state.watermark;
      revisionOf.set(rows[index]!.taskId, state.watermark);
    },
  };
}

async function refresh(ledger: ReturnType<typeof installFakeLedger>, previous?: TaskListSuccess) {
  const before = ledger.calls.length;
  const cut = await readTaskList("repo-a", previous);
  return { cut, requests: ledger.calls.length - before };
}

describe("W6 Goal 第二项演进:受控快读水化(顺序续读 + 页预算封顶)", () => {
  it("冷启动一次刷新把台账顺序拉完:游标链有效,不再每页等 2s 探针节拍", async () => {
    const ledger = installFakeLedger();
    const { cut, requests } = await refresh(ledger);
    expect(requests).toBe(4); // 1538 行 = 500×3 + 38,全部落在同一刷新内。
    expect(ledger.calls.map((call) => call.cursor)).toEqual([null, "task_000499", "task_000999", "task_001499"]);
    expect(cut.rows).toHaveLength(LEDGER_ROWS);
    expect(cut.status).toBe("ready");
    expect(cut.page).toBeUndefined();
  });

  it("页预算封顶:死游标停在预算处,切面 pending 交回探针节拍,不会失控 drain", async () => {
    const ledger = installFakeLedger(LEDGER_ROWS, { neverEnds: true });
    const first = await refresh(ledger);
    expect(first.requests).toBe(HYDRATION_PAGE_BUDGET);
    expect(first.cut.status).toBe("pending");
    expect(first.cut.page?.nextCursor).toBeTruthy();
    expect(first.cut.rows).toHaveLength(LEDGER_ROWS); // 读完真数据后游标不再前进,行集不膨胀。
    // 下一刷新(探针节拍)续读,仍然有界——持续负载上界 = 预算/节拍,没有无限循环。
    const second = await refresh(ledger, first.cut);
    expect(second.requests).toBe(HYDRATION_PAGE_BUDGET);
    expect(second.cut.rows).toHaveLength(LEDGER_ROWS);
  });

  it("预算耗尽的正常台账:下一刷新沿游标续读完,不需要重读已读的页", async () => {
    const size = HYDRATION_PAGE_BUDGET * TASK_LIST_PAGE_LIMIT + 1;
    const ledger = installFakeLedger(size);
    const first = await refresh(ledger);
    expect(first.requests).toBe(HYDRATION_PAGE_BUDGET);
    expect(first.cut.status).toBe("pending");
    const second = await refresh(ledger, first.cut);
    expect(second.requests).toBe(1);
    expect(ledger.calls.at(-1)).toMatchObject({ cursor: first.cut.page!.nextCursor, rows: 1 });
    expect(second.cut.rows).toHaveLength(size);
    expect(second.cut.status).toBe("ready");
  });

  it("续读期间投影推进只担保最老的水位,下一刷新靠增量补齐", async () => {
    const ledger = installFakeLedger();
    const first = await refresh(ledger);
    expect(first.cut.watermark).toBe(1_000);
    ledger.touch(0); // 水化完成后、下一刷新前,投影推进了一格。
    const repaired = await refresh(ledger, first.cut);
    expect(repaired.requests).toBe(1);
    expect(ledger.calls.at(-1)).toMatchObject({ cursor: null, changedAfterRevision: 1_000 });
    expect(repaired.cut.rows).toHaveLength(LEDGER_ROWS);
    expect(repaired.cut.watermark).toBe(1_001);
    expect(repaired.cut.status).toBe("ready");
  });

  it("稳态刷新读一页增量而不是整个台账", async () => {
    const ledger = installFakeLedger();
    const cut = (await refresh(ledger)).cut;
    ledger.touch(7);
    const steady = await refresh(ledger, cut);
    expect(steady.requests).toBe(1);
    expect(ledger.calls.at(-1)).toEqual({
      cursor: null,
      changedAfterRevision: cut.watermark,
      status: null,
      rows: 1,
    });
    expect(steady.cut.rows).toHaveLength(LEDGER_ROWS);
  });

  it("cut pending(投影追赶中)也走增量,不重读整页", async () => {
    // B6:daemon 报 pending 时 rows 相对所报 watermark 仍然完整,增量读即可;
    // 「正在追赶」在切面 status 上显形,不触发整页重读。
    const ledger = installFakeLedger();
    const cut = (await refresh(ledger)).cut;
    ledger.state.status = "pending";
    ledger.touch(7);
    const pending = await refresh(ledger, cut);
    expect(pending.requests).toBe(1);
    expect(ledger.calls.at(-1)).toEqual({
      cursor: null,
      changedAfterRevision: cut.watermark,
      status: null,
      rows: 1,
    });
    expect(pending.cut.rows).toHaveLength(LEDGER_ROWS);
    expect(pending.cut.status).toBe("pending"); // 「正在追赶」仍显形。
  });

  it("超过一页的增量在同一刷新内补完,水位锚定不变", async () => {
    const ledger = installFakeLedger();
    const cut = (await refresh(ledger)).cut;
    const anchor = cut.watermark;
    for (let index = 0; index < 600; index += 1) ledger.touch(index);
    const truncated = await refresh(ledger, cut);
    // 一次增量(500 行,截断)+ 三页游标续读(续读不带增量过滤,拉的是剩余全部行),
    // 全部在同一刷新内;水位停在上一轮,直到「锚定在上一水位且一页读完」的增量才推进。
    expect(truncated.requests).toBe(4);
    expect(truncated.cut.rows).toHaveLength(LEDGER_ROWS);
    expect(truncated.cut.watermark).toBe(anchor);
    expect(truncated.cut.status).toBe("ready");
  });

  it("台账规模下的读数(改前/改后同一条件的实测)", async () => {
    const ledger = installFakeLedger();
    const first = await refresh(ledger);
    const refreshes = 1,
      hydrationRequests = first.requests;
    ledger.touch(11);
    const steady = await refresh(ledger, first.cut);
    const rowsPulled = ledger.calls.slice(0, hydrationRequests).reduce((sum, call) => sum + call.rows, 0);
    const measurement = [
      `ledgerRows=${LEDGER_ROWS}`,
      `hydrationRequests=${hydrationRequests}`,
      `refreshesToComplete=${refreshes}`,
      `maxRequestsPerRefresh=${Math.max(...ledger.calls.map(() => 1), hydrationRequests / refreshes)}`,
      `steadyStateRequests=${steady.requests}`,
      `rowsPulledDuringHydration=${rowsPulled}`,
    ].join(" ");
    process.stdout.write(`[W6-MEASURE] ${measurement}\n`);
    expect(hydrationRequests).toBeLessThanOrEqual(HYDRATION_PAGE_BUDGET);
    expect(steady.requests).toBe(1);
    expect(rowsPulled).toBe(LEDGER_ROWS);
  });
});

describe("首屏活跃切片:状态下推 + 首屏合并", () => {
  function installStatusLedger() {
    const rows = [
      projectionRow(0, "planned"),
      projectionRow(1, "active"),
      projectionRow(2, "active"),
      projectionRow(3, "blocked"),
      projectionRow(4, "in_review"),
      projectionRow(5, "done"),
      projectionRow(6, "cancelled"),
    ];
    const calls: Array<Record<string, unknown>> = [];
    const getTasks = vi.fn(async (payload: { readonly status?: string }) => {
      calls.push(payload);
      const visible = rows.filter(
        (row) => payload.status === undefined || row.snapshot.task?.status === payload.status,
      );
      return {
        ok: true,
        status: "ready",
        rows: visible,
        invalidRows: [],
        watermark: 1_000,
        sourceRevision: 1_000,
        warnings: [],
        page: { limit: TASK_LIST_PAGE_LIMIT, cursor: null, nextCursor: null },
      };
    });
    Object.defineProperty(window, "harness", { configurable: true, value: { getTasks } });
    return { calls, rows };
  }

  it("五个非终态各一页窄读并行发出,状态过滤下推进 daemon,不带游标/增量面", async () => {
    const ledger = installStatusLedger();
    const pending = readActiveTaskSlice("repo-a");
    // map() 同步发完五个请求:串行实现在这里只会看到第一个调用。
    expect((window.harness as { getTasks: ReturnType<typeof vi.fn> }).getTasks).toHaveBeenCalledTimes(5);
    const slice = await pending;
    expect(ledger.calls).toEqual([
      { repoId: "repo-a", status: "planned", limit: TASK_LIST_PAGE_LIMIT },
      { repoId: "repo-a", status: "active", limit: TASK_LIST_PAGE_LIMIT },
      { repoId: "repo-a", status: "submitted", limit: TASK_LIST_PAGE_LIMIT },
      { repoId: "repo-a", status: "blocked", limit: TASK_LIST_PAGE_LIMIT },
      { repoId: "repo-a", status: "in_review", limit: TASK_LIST_PAGE_LIMIT },
    ]);
    expect(slice.map((row) => row.taskId)).toEqual([
      "task_000000",
      "task_000001",
      "task_000002",
      "task_000003",
      "task_000004",
    ]);
  });

  it("合并:完整切面的行胜出(增量持续更新),切片只补缺;两侧都没有时为空", () => {
    const stale = projectionRow(1, "active"),
      fresh = projectionRow(1, "active"),
      gap = projectionRow(9, "active");
    expect(mergeTaskRows([fresh], [stale, gap]).map((row) => row.taskId)).toEqual(["task_000001", "task_000009"]);
    expect(mergeTaskRows([fresh], [stale, gap])[0]).toBe(fresh);
    expect(mergeTaskRows(undefined, [gap])).toEqual([gap]);
    expect(mergeTaskRows([fresh], undefined)).toEqual([fresh]);
    expect(mergeTaskRows(undefined, undefined)).toEqual([]);
  });

  it("查询门控:切面未读完才读;ready 后停读(仍挂载),cut 扇出不再触发;重新启用即重读", async () => {
    installStatusLedger();
    const getTasks = (window.harness as { getTasks: ReturnType<typeof vi.fn> }).getTasks;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, activeTasksQuery("repo-a", true));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(getTasks).toHaveBeenCalledTimes(5); // 水化中:切片在读。
      // 完整切面 ready → App 关掉 enabled(切片查询仍挂载,与生产同形):
      // 挂载但停用的观察者不算 active,cut 前进的扇出不再触发它——稳态请求面
      // 回到「一页增量」,切片不构成常驻后台负载。
      observer.setOptions(activeTasksQuery("repo-a", false));
      await invalidateLedgerDependents(client, "repo-a");
      expect(getTasks).toHaveBeenCalledTimes(5);
      // 切面回退(投影回归重水化)→ 重新启用:重读,不拿停读前的旧切片冒充。
      observer.setOptions(activeTasksQuery("repo-a", true));
      await vi.waitFor(() => expect(getTasks).toHaveBeenCalledTimes(10));
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
