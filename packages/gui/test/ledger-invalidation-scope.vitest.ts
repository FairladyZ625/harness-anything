// harness-test-tier: fast
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

import { invalidateLedgerDependents, taskDocumentQuery } from "../src/renderer/task-data.ts";
import { triadicQueryKeys } from "../src/renderer/triadic-data.ts";

/**
 * 台账切面推进时的重取范围(`task_9d53606292`):**只重取当前挂载的视图正在观察的查询**。
 *
 * 这个文件是那一条的行为门。把 `invalidateLedgerDependents` 的 refetchType 改成 "all"
 * 或 "inactive",第一条立刻红——没人看的全量三元投影(实测单次响应 4,771,601.6 B,
 * daemon handler p50 1,131 ms;task_be97f0d8 S1 final-10m/summary.json)会重新在后台被拉一次。
 * 第二条钉住反向:挂载中的查询必须照常刷新,省字节不能省掉新鲜度。
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
});
