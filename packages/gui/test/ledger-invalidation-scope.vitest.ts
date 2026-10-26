// harness-test-tier: fast
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

import { invalidateLedgerDependents, taskDocumentQuery, taskQueryKeys } from "../src/renderer/task-data.ts";
import { triadicQueryKeys } from "../src/renderer/triadic-data.ts";
import { workspaceScopeQueryKeys } from "../src/renderer/workspace-scope-data.ts";

/**
 * 台账切面推进时的重取范围(`task_9d53606292`):**只重取当前挂载的视图正在观察的查询**。
 *
 * 这个文件是那一条的行为门。把 `invalidateLedgerDependents` 的 refetchType 改成 "all"
 * 或 "inactive"，第一条立刻红——没人看的全量三元投影(实测单次响应 4,771,601.6 B,
 * daemon handler p50 1,131 ms;task_be97f0d8 S1 final-10m/summary.json)会重新在后台被拉一次。
 * 第二条钉住反向:挂载中的查询必须照常刷新,省字节不能省掉新鲜度。
 *
 * workspace-scope 两条例子钉住工作页读面的同类契约:它由 App 顶层常驻挂载、无自有计时器
 * 也不做聚焦重取,唯一刷新通道就是这份扇出(两段前缀覆盖所有 rootTaskId)。
 */
describe("ledger invalidation scope", () => {
  it("leaves an unmounted ledger dependent stale instead of refetching it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const readGraph = vi.fn(async () => ({
      ok: true as const,
      edges: [],
      coverageRows: [],
      factAnchors: [],
      facts: [],
      warnings: [],
    }));
    try {
      // 没有 observer:缓存里有数据,但没有任何挂载的视图在看它。
      await client.fetchQuery({ queryKey: triadicQueryKeys.graph("repo-a"), queryFn: readGraph });
      expect(readGraph).toHaveBeenCalledOnce();

      await invalidateLedgerDependents(client, "repo-a");

      expect(readGraph).toHaveBeenCalledOnce();
      expect(client.getQueryState(triadicQueryKeys.graph("repo-a"))?.isInvalidated).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("still refetches a mounted ledger dependent on the same cut change", async () => {
    let body = "before";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      ...taskDocumentQuery("repo-a", "task-1", "progress.md"),
      queryFn: async () => ({
        ok: true as const,
        status: "ready" as const,
        taskId: "task-1",
        path: "progress.md",
        body,
        blobSha256: "sha",
        watermark: body === "before" ? 41 : 42,
        sourceRevision: body === "before" ? 41 : 42,
      }),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      body = "after";
      await invalidateLedgerDependents(client, "repo-a");
      expect(observer.getCurrentResult().data?.body).toBe("after");
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("refreshes the mounted workspace-scope read on the same cut change", async () => {
    let title = "before";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new InfiniteQueryObserver(client, {
      queryKey: workspaceScopeQueryKeys.read("repo-a", "root-mounted"),
      queryFn: async () => ({ root: { title }, tasks: [], page: { nextCursor: null } }),
      initialPageParam: null,
      getNextPageParam: () => undefined,
      staleTime: 4_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().data?.pages[0]?.root.title).toBe("before");
      // 后台推进:CLI 建了任务/改了工作名,工作页读面必须随台账 cut 前进重读。
      title = "after";
      await invalidateLedgerDependents(client, "repo-a");
      expect(observer.getCurrentResult().data?.pages[0]?.root.title).toBe("after");
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  // dec_17A863CC CH3:工作拓扑的重读只走这条既有 cut 扇出(不新增轮询/订阅)。拓扑键挂在
  // ["tasks", repoId, ...] 下,所以同一份失效把它一起重读;没挂载时只标脏、不偷跑字节。
  it("refreshes a mounted work-topology read on the same cut change", async () => {
    let revision = 1;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      queryKey: taskQueryKeys.topology("repo-a", "work-root"),
      queryFn: async () => ({ sourceRevision: revision, frontier: [`ready-${revision}`] }),
      staleTime: 10_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().data?.sourceRevision).toBe(1);
      revision = 2;
      await invalidateLedgerDependents(client, "repo-a");
      expect(observer.getCurrentResult().data?.sourceRevision).toBe(2);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("leaves an unmounted work-topology read stale instead of refetching it", async () => {
    const readTopology = vi.fn(async () => ({ sourceRevision: 7 }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await client.fetchQuery({
        queryKey: taskQueryKeys.topology("repo-a", "work-idle"),
        queryFn: readTopology,
      });
      expect(readTopology).toHaveBeenCalledOnce();
      await invalidateLedgerDependents(client, "repo-a");
      expect(readTopology).toHaveBeenCalledOnce();
      expect(client.getQueryState(taskQueryKeys.topology("repo-a", "work-idle"))?.isInvalidated).toBe(true);
    } finally {
      client.clear();
    }
  });

  it("leaves an unmounted workspace-scope page stale instead of refetching it", async () => {
    const readScope = vi.fn(async () => ({ root: { title: "idle" }, tasks: [], page: { nextCursor: null } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      // 没有 observer:换到别的工作后留下的缓存,没有任何挂载的视图在看它。
      await client.fetchInfiniteQuery({
        queryKey: workspaceScopeQueryKeys.read("repo-a", "root-idle"),
        queryFn: readScope,
        initialPageParam: null,
        getNextPageParam: () => undefined,
      });
      expect(readScope).toHaveBeenCalledOnce();

      await invalidateLedgerDependents(client, "repo-a");

      expect(readScope).toHaveBeenCalledOnce();
      expect(client.getQueryState(workspaceScopeQueryKeys.read("repo-a", "root-idle"))?.isInvalidated).toBe(true);
    } finally {
      client.clear();
    }
  });
});
