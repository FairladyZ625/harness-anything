// harness-test-tier: fast
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

import type { TaskListSuccess } from "../src/renderer/api-client.ts";
import { readTaskList, TASK_LIST_PAGE_LIMIT } from "../src/renderer/task-data.ts";

/**
 * W6 Goal 第二个合取项(`task_be076d3ac25b87b79be09b02dd`):
 * **支持 cursor/limit 的读面不得被前端消费成「一次拉 500 直到拉完」**。
 *
 * 这个文件是那一条的行为门:靠"一次刷新只允许一个 getTasks 请求"钉住——把 drain
 * 循环改回来,`requests` 立刻从 1 变成 4,下面每条都红。
 * (第三个合取项「只显示前 N 条必须显形」在 `gui-w6-truncation-visibility.vitest.ts`。)
 */

const LEDGER_ROWS = 1_538; // canonical 2026-08-24 的实际台账规模

function projectionRow(index: number): TaskListSuccess["rows"][number] {
  const taskId = `task_${String(index).padStart(6, "0")}`;
  return {
    taskId, createdAt: null, updatedAt: "2026-08-24T00:00:00.000Z", generation: "v1",
    snapshot: { task: { schema: "task/v1", taskId, title: `Task ${index}` } }
  } as unknown as TaskListSuccess["rows"][number];
}

interface LedgerCall { readonly cursor: string | null; readonly changedAfterRevision: number | null; readonly rows: number }

/**
 * daemon 分页语义的忠实替身:keyset 按不可变主键 task_id 升序
 * (kernel `listTaskRowsNarrow`:`task_snapshot.task_id > ?`、`ORDER BY task_id`),
 * cursor 就是上一页最后一个 task_id,`changedAfterRevision` 按行 revision 过滤。
 */
function installFakeLedger(size = LEDGER_ROWS) {
  const rows = Array.from({ length: size }, (_, index) => projectionRow(index));
  const revisionOf = new Map(rows.map((row) => [row.taskId, 1_000]));
  const state = { watermark: 1_000, sourceRevision: 1_000, status: "ready" as "ready" | "pending" };
  const calls: LedgerCall[] = [];
  const getTasks = vi.fn(async (payload: { readonly limit?: number; readonly cursor?: string; readonly changedAfterRevision?: number }) => {
    const limit = payload.limit ?? 100, after = payload.cursor ?? null;
    const eligible = rows.filter((row) => (after === null || row.taskId > after)
      && (payload.changedAfterRevision === undefined || revisionOf.get(row.taskId)! > payload.changedAfterRevision));
    const visible = eligible.slice(0, limit), last = visible.at(-1);
    calls.push({ cursor: after, changedAfterRevision: payload.changedAfterRevision ?? null, rows: visible.length });
    return {
      ok: true, status: state.status, rows: visible, watermark: state.watermark, sourceRevision: state.sourceRevision,
      warnings: [], page: { limit, cursor: after, nextCursor: eligible.length > limit && last ? last.taskId : null }
    };
  });
  Object.defineProperty(window, "harness", { configurable: true, value: { getTasks } });
  return {
    calls, state, rows,
    touch(index: number) { state.watermark += 1; state.sourceRevision = state.watermark; revisionOf.set(rows[index]!.taskId, state.watermark); }
  };
}

async function refresh(ledger: ReturnType<typeof installFakeLedger>, previous?: TaskListSuccess) {
  const before = ledger.calls.length;
  const cut = await readTaskList("repo-a", previous);
  return { cut, requests: ledger.calls.length - before };
}

describe("W6 Goal 第二项:cursor/limit 读面不得被消费成「拉完为止」", () => {
  it("一次台账刷新只发一个分页请求,并把未读完显形成 pending", async () => {
    const ledger = installFakeLedger();
    const { cut, requests } = await refresh(ledger);
    expect(requests).toBe(1);
    expect(ledger.calls).toEqual([{ cursor: null, changedAfterRevision: null, rows: TASK_LIST_PAGE_LIMIT }]);
    expect(cut.rows).toHaveLength(TASK_LIST_PAGE_LIMIT);
    expect(cut.status).toBe("pending");
    expect(cut.page?.nextCursor).toBeTruthy();
  });

  it("跨刷新沿游标续读到完整,期间每次刷新仍然只有一个请求", async () => {
    const ledger = installFakeLedger();
    let cut = (await refresh(ledger)).cut;
    const perRefresh: number[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      const step = await refresh(ledger, cut);
      cut = step.cut;
      perRefresh.push(step.requests);
    }
    expect(perRefresh).toEqual([1, 1, 1]);
    expect(cut.rows).toHaveLength(LEDGER_ROWS);
    expect(cut.status).toBe("ready");
    expect(cut.page).toBeUndefined();
    expect(ledger.calls.map((call) => call.rows)).toEqual([500, 500, 500, 38]);
  });

  it("续读期间投影推进不再抛错重来,而是只担保最老的水位并靠增量补齐", async () => {
    const ledger = installFakeLedger();
    let cut = (await refresh(ledger)).cut;
    const base = cut.watermark;
    ledger.touch(0);
    for (let tick = 0; tick < 3; tick += 1) cut = (await refresh(ledger, cut)).cut;
    expect(cut.rows).toHaveLength(LEDGER_ROWS);
    expect(cut.watermark).toBe(base);
    const repaired = await refresh(ledger, cut);
    expect(repaired.requests).toBe(1);
    expect(ledger.calls.at(-1)).toMatchObject({ cursor: null, changedAfterRevision: base });
    expect(repaired.cut.rows).toHaveLength(LEDGER_ROWS);
    expect(repaired.cut.watermark).toBe(base + 1);
    expect(repaired.cut.status).toBe("ready");
  });

  it("稳态刷新读一页增量而不是整个台账", async () => {
    const ledger = installFakeLedger();
    let cut = (await refresh(ledger)).cut;
    for (let tick = 0; tick < 3; tick += 1) cut = (await refresh(ledger, cut)).cut;
    ledger.touch(7);
    const steady = await refresh(ledger, cut);
    expect(steady.requests).toBe(1);
    expect(ledger.calls.at(-1)).toEqual({ cursor: null, changedAfterRevision: cut.watermark, rows: 1 });
    expect(steady.cut.rows).toHaveLength(LEDGER_ROWS);
  });

  it("超过一页的增量也不 drain:截断显形成 pending,水位停在上一轮", async () => {
    const ledger = installFakeLedger();
    let cut = (await refresh(ledger)).cut;
    for (let tick = 0; tick < 3; tick += 1) cut = (await refresh(ledger, cut)).cut;
    const anchor = cut.watermark;
    for (let index = 0; index < 600; index += 1) ledger.touch(index);
    const truncated = await refresh(ledger, cut);
    expect(truncated.requests).toBe(1);
    expect(truncated.cut.status).toBe("pending");
    expect(truncated.cut.watermark).toBe(anchor);
    expect(truncated.cut.page?.nextCursor).toBeTruthy();
    const resumed = await refresh(ledger, truncated.cut);
    expect(resumed.requests).toBe(1);
    expect(resumed.cut.rows).toHaveLength(LEDGER_ROWS);
  });

  it("台账规模下的读数(改前/改后同一条件的实测)", async () => {
    const ledger = installFakeLedger();
    let cut = (await refresh(ledger)).cut, refreshes = 1, hydrationRequests = ledger.calls.length;
    while (cut.page?.nextCursor) {
      const step = await refresh(ledger, cut);
      cut = step.cut; refreshes += 1; hydrationRequests += step.requests;
    }
    const worstPerRefresh = Math.max(...ledger.calls.map(() => 1), hydrationRequests / refreshes);
    ledger.touch(11);
    const steady = await refresh(ledger, cut);
    const rowsPulled = ledger.calls.slice(0, hydrationRequests).reduce((sum, call) => sum + call.rows, 0);
    const measurement = [
      `ledgerRows=${LEDGER_ROWS}`,
      `hydrationRequests=${hydrationRequests}`,
      `refreshesToComplete=${refreshes}`,
      `maxRequestsPerRefresh=${worstPerRefresh}`,
      `steadyStateRequests=${steady.requests}`,
      `rowsPulledDuringHydration=${rowsPulled}`
    ].join(" ");
    process.stdout.write(`[W6-MEASURE] ${measurement}\n`);
    expect(worstPerRefresh).toBe(1);
  });
});
