// harness-test-tier: fast
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { controlSucceeded, selectActiveRepoId, settleDaemonControl, systemQueryKeys } from "../src/renderer/system-data.ts";
import type { DaemonControlReceipt, SystemRepoRow, TaskListSuccess } from "../src/renderer/api-client.ts";
import { invalidateLedgerDependents, LEDGER_REFRESH_INTERVAL_MS, readTaskList, TASK_LIST_PAGE_LIMIT, taskDocumentQuery, taskListQuery, taskQueryKeys } from "../src/renderer/task-data.ts";
import { triadicQueryKeys } from "../src/renderer/triadic-data.ts";
import { favoritesStorageKey } from "../src/renderer/model/favorites.ts";

describe("GUI S3 R1 repository isolation", () => {
  it("namespaces every repository projection by repo id", () => {
    expect(taskQueryKeys.list("repo-a")).toEqual(["tasks", "repo-a", "list"]);
    expect(taskQueryKeys.document("repo-b", "task-1", "INDEX.md")).toEqual([
      "tasks", "repo-b", "task-1", "document", "INDEX.md",
    ]);
    expect(triadicQueryKeys.graph("repo-a")).toEqual(["triadic", "repo-a", "relation-graph"]);
    expect(triadicQueryKeys.decisions("repo-b")).toEqual(["triadic", "repo-b", "decisions"]);
    expect(catalogQueryKeys.snapshot("repo-a")).toEqual(["catalog", "repo-a", "snapshot"]);
    expect(catalogQueryKeys.preset("repo-b", "preset-a", "zh-TW")).toEqual([
      "catalog", "repo-b", "preset", "preset-a", "zh-TW",
    ]);
    expect(favoritesStorageKey("repo-a")).not.toBe(favoritesStorageKey("repo-b"));
  });

  it("keeps daemon-global status outside repository namespaces", () => {
    expect(systemQueryKeys.status()).toEqual(["system", "global", "status"]);
  });

  it("observes a newer ledger revision while the task view stays mounted", async () => {
    vi.useFakeTimers();
    let revision = 41;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      ...taskListQuery("repo-a"),
      queryFn: async () => ({ ok: true as const, status: "ready" as const, rows: [], watermark: revision, sourceRevision: revision, warnings: [] }),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().data?.sourceRevision).toBe(41);
      revision = 42;
      await vi.advanceTimersByTimeAsync(LEDGER_REFRESH_INTERVAL_MS + 1);
      expect(observer.getCurrentResult().data?.sourceRevision).toBe(42);
    } finally {
      unsubscribe();
      client.clear();
      vi.useRealTimers();
    }
  });

  // W6(task_be076d3ac25b87b79be09b02dd):这里原本断言的是"一次调用里沿 nextCursor
  // 把台账拉完",那正是 Goal 第二项禁止的形态。现在的合同是"一次刷新一页,没读完就
  // 把游标和 pending 状态一起交回缓存"。分页读取形态的完整门在
  // packages/gui/test/gui-w6-ledger-read-shape.vitest.ts。
  it("reads one bounded page per refresh and carries the cursor in the returned cut", async () => {
    const getTasks = vi.fn(async (payload: { readonly repoId: string; readonly limit: number; readonly cursor?: string }) => ({
      ok: true as const,
      status: "ready" as const,
      rows: [],
      watermark: 42,
      sourceRevision: 42,
      warnings: [],
      page: { limit: TASK_LIST_PAGE_LIMIT, cursor: payload.cursor ?? null, nextCursor: payload.cursor ? null : "task-page-2" }
    }));
    Object.defineProperty(window, "harness", { configurable: true, value: { getTasks } });

    const first = await taskListQuery("repo-a").queryFn();
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenNthCalledWith(1, { repoId: "repo-a", limit: TASK_LIST_PAGE_LIMIT });
    expect(first.status).toBe("pending");
    expect(first.page?.nextCursor).toBe("task-page-2");

    const second = await readTaskList("repo-a", first);
    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getTasks).toHaveBeenNthCalledWith(2, { repoId: "repo-a", limit: TASK_LIST_PAGE_LIMIT, cursor: "task-page-2" });
    expect(second).toEqual({ ok: true, status: "ready", rows: [], watermark: 42, sourceRevision: 42, warnings: [] });
  });

  // 原断言:跨 cut 的两页拼在一起要抛错。跨刷新续读必然跨 cut,抛错会让忙仓库永远读不完,
  // 所以守卫换成"报最老水位 + 由后续增量补齐"(等价保证见 task_plan 与 artifacts 报告 §2.4)。
  it("reports the oldest watermark when the projection advances mid-hydration", async () => {
    const getTasks = vi.fn(async (payload: { readonly cursor?: string }) => ({
      ok: true as const,
      status: "ready" as const,
      rows: [],
      watermark: payload.cursor ? 43 : 42,
      sourceRevision: payload.cursor ? 43 : 42,
      warnings: [],
      page: { limit: TASK_LIST_PAGE_LIMIT, cursor: payload.cursor ?? null, nextCursor: payload.cursor ? null : "task-page-2" }
    }));
    Object.defineProperty(window, "harness", { configurable: true, value: { getTasks } });

    const first = await taskListQuery("repo-a").queryFn();
    const joined = await readTaskList("repo-a", first);
    expect(joined.watermark).toBe(42);
    expect(joined.sourceRevision).toBe(42);
    expect(joined.status).toBe("ready");
  });

  it("polls only rows changed after the cached task projection revision", async () => {
    const getTasks = vi.fn(async () => ({ ok: true as const, status: "ready" as const, rows: [], watermark: 43, sourceRevision: 43, warnings: [], page: { limit: TASK_LIST_PAGE_LIMIT, cursor: null, nextCursor: null } }));
    Object.defineProperty(window, "harness", { configurable: true, value: { getTasks } });
    const cachedRows = [
      { taskId: "task-cached", updatedAt: "2026-08-21T23:58:00.000Z" },
      { taskId: "task_cached", updatedAt: "2026-08-21T23:59:00.000Z" }
    ] as TaskListSuccess["rows"];
    const result = await readTaskList("repo-a", { ok: true, status: "ready", rows: cachedRows, watermark: 42, sourceRevision: 42, warnings: [] });
    expect(getTasks).toHaveBeenCalledWith({ repoId: "repo-a", changedAfterRevision: 42, limit: TASK_LIST_PAGE_LIMIT });
    expect(result.rows).toEqual(cachedRows);
  });

  it("includes a task whose newer projection revision carries an older occurredAt", async () => {
    const projectionRow = (taskId: string, updatedAt: string) => ({
      taskId,
      createdAt: null,
      updatedAt,
      generation: "v1",
      snapshot: { task: { schema: "task/v1", taskId, title: taskId } }
    }) as TaskListSuccess["rows"][number];
    const cachedRows = [
      projectionRow("task-cached", "2026-08-21T23:59:00.000Z")
    ];
    const migratedRow = projectionRow("task-migrated", "2026-06-14T00:00:00.000Z");
    const projectionRows = [...cachedRows, migratedRow];
    const getTasks = vi.fn(async (payload: { readonly changedAfterRevision?: number; readonly updatedAfter?: string }) => ({
      ok: true as const,
      status: "ready" as const,
      rows: payload.changedAfterRevision !== undefined
        ? [migratedRow]
        : payload.updatedAfter === undefined ? projectionRows : projectionRows.filter((row) => row.updatedAt >= payload.updatedAfter!),
      watermark: 43,
      sourceRevision: 43,
      warnings: [],
      page: { limit: TASK_LIST_PAGE_LIMIT, cursor: null, nextCursor: null }
    }));
    Object.defineProperty(window, "harness", { configurable: true, value: { getTasks } });

    const result = await readTaskList("repo-a", {
      ok: true,
      status: "ready",
      rows: cachedRows,
      watermark: 42,
      sourceRevision: 42,
      warnings: []
    });

    expect(result.watermark).toBe(43);
    expect(result.rows.map((row) => row.taskId)).toEqual(["task-cached", "task-migrated"]);
    expect(getTasks).toHaveBeenCalledWith({ repoId: "repo-a", changedAfterRevision: 42, limit: TASK_LIST_PAGE_LIMIT });
  });

  it("refreshes an open task document when the ledger cut advances", async () => {
    let body = "before";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      ...taskDocumentQuery("repo-a", "task-1", "progress.md"),
      queryFn: async () => ({ ok: true as const, status: "ready" as const, taskId: "task-1", path: "progress.md", body, blobSha256: "sha", watermark: body === "before" ? 41 : 42, sourceRevision: body === "before" ? 41 : 42 }),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().data?.body).toBe("before");
      body = "after";
      await invalidateLedgerDependents(client, "repo-a");
      expect(observer.getCurrentResult().data?.body).toBe("after");
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("selects only enabled repos and retains an enabled unavailable repo", () => {
    const repos = [repo("disabled", "disabled", "not_loaded"), repo("unavailable", "enabled", "unavailable"), repo("attached", "enabled", "attached")];
    expect(selectActiveRepoId(repos, null)).toBe("attached");
    expect(selectActiveRepoId(repos, "unavailable")).toBe("unavailable");
    expect(selectActiveRepoId(repos, "disabled")).toBe("attached");
  });

  it("polls a control receipt without replaying the request and requires a new pid for restart", async () => {
    const pending = receipt("queued"), settled = receipt("settled", 10, 11), read = vi.fn(async () => settled);
    await expect(settleDaemonControl(pending, read, async () => undefined)).resolves.toBe(settled);
    expect(read).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledWith(pending.operationId);
    expect(controlSucceeded(settled)).toBe(true); expect(controlSucceeded(receipt("settled", 10, 10))).toBe(false);
  });
});

function repo(repoId: string, registrationState: SystemRepoRow["registrationState"], cellState: SystemRepoRow["cellState"]): SystemRepoRow { return { repoId, displayName: repoId, canonicalRoot: `/tmp/${repoId}`, authoredBranch: "main", registrationState, cellState, generation: null, queueDepth: null, lockState: registrationState === "disabled" ? "not_applicable" : "unknown", recoveryMs: null, lastError: null, unavailableReason: cellState === "unavailable" ? "fixture unavailable" : null }; }
function receipt(phase: DaemonControlReceipt["phase"], beforePid: number | null = null, afterPid: number | null = null): DaemonControlReceipt { const point = (pid: number) => ({ daemonId: "daemon", pid, startedAt: `generation-${pid}` }); return { schema: "daemon-control-receipt/v1", ok: phase !== "failed", outcome: phase === "failed" ? "rejected" : "pending", kind: "restart", operationId: "operation-r1", phase, requestedAt: "2026-08-14T00:00:00.000Z", completedAt: phase === "settled" ? "2026-08-14T00:00:01.000Z" : null, before: beforePid === null ? null : point(beforePid), after: afterPid === null ? null : point(afterPid), error: null, nextAction: phase === "settled" ? null : "poll" }; }
