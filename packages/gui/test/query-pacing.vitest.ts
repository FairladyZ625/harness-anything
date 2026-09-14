// harness-test-tier: fast
import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

import { agendaQuery } from "../src/renderer/agenda-data.ts";
import { connectionsQuery } from "../src/renderer/connection-data.ts";
import { LEDGER_PROBE_FOCUS_REFETCH, QUERY_PACING_MS, rendererQueryDefaults } from "../src/renderer/query-pacing.ts";
import { systemStatusQuery } from "../src/renderer/system-data.ts";
import { taskListQuery } from "../src/renderer/task-data.ts";
import { workspaceSummaryQuery } from "../src/renderer/workspace-summary-data.ts";

afterEach(() => {
  // focusManager 是模块级单例,#focused 跨用例残留会让下一次 setFocused(true) 不再通知。
  focusManager.setFocused(undefined);
});

describe("renderer query pacing definitions", () => {
  it("sources every daemon read interval from the single pacing table", () => {
    expect(taskListQuery("repo-a").refetchInterval).toBe(QUERY_PACING_MS.ledgerProbe);
    expect(taskListQuery("repo-a").refetchOnWindowFocus).toBe(LEDGER_PROBE_FOCUS_REFETCH);
    expect(systemStatusQuery().refetchInterval).toBe(QUERY_PACING_MS.systemStatus);
    expect(connectionsQuery().refetchInterval).toBe(QUERY_PACING_MS.connectionStatus);
    const agendaInterval = agendaQuery("repo-a").refetchInterval as (query: {
      readonly state: { readonly data?: { readonly page?: { readonly nextCursor?: string | null } } };
    }) => number | false;
    expect(agendaInterval({ state: { data: { page: { nextCursor: "c2" } } } })).toBe(QUERY_PACING_MS.agendaCatchUp);
    expect(agendaInterval({ state: { data: { page: { nextCursor: null } } } })).toBe(false);
    // 台账派生读不带自己的计时器:间隔只存在于上表与三个自持轮询的查询上。
    expect(workspaceSummaryQuery("repo-a").refetchInterval).toBeUndefined();
    expect(rendererQueryDefaults.queries.refetchOnWindowFocus).toBe(false);
  });
});

const taskListCut = (revision: number) => ({
  ok: true as const,
  status: "ready" as const,
  rows: [],
  invalidRows: [],
  watermark: revision,
  sourceRevision: revision,
  warnings: [],
});

/**
 * 聚焦刷新的收敛策略(2026-09-14 轮询降负载裁定):聚焦时只有台账探针重读
 * (`refetchOnWindowFocus: "always"`,数据新鲜也重探);台账派生读(工作区普查等)
 * 的聚焦重取被移除——它们的新鲜度由「探针推进 cut → invalidateLedgerDependents
 * 扇出」保证。第二条在旧的「各文件自带 refetchOnWindowFocus: true」代码上是红的。
 */
describe("focus refetch flows through the ledger probe only", () => {
  it("re-probes the ledger on focus even while the probe data is fresh", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => taskListCut(41)),
      client = new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
      observer = new QueryObserver(client, { ...taskListQuery("repo-a"), queryFn: read }),
      unsubscribe = observer.subscribe(() => undefined);
    client.mount();
    try {
      await observer.refetch();
      expect(read).toHaveBeenCalledTimes(1);
      // 只推进 1s:探针计时器 2s 未到、staleTime 10s 未到——随后的重读只能来自聚焦。
      await vi.advanceTimersByTimeAsync(1_000);
      expect(read).toHaveBeenCalledTimes(1);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      client.unmount();
      client.clear();
      vi.useRealTimers();
    }
  });

  it("leaves a stale cut-covered dependent unread on focus", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ({ sourceRevision: 42 })),
      client = new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
      observer = new QueryObserver(client, {
        ...workspaceSummaryQuery("repo-a"),
        queryFn: read,
      }),
      unsubscribe = observer.subscribe(() => undefined);
    client.mount();
    try {
      await observer.refetch();
      expect(read).toHaveBeenCalledTimes(1);
      // 越过 10s staleTime:普查已过期,但聚焦不是它的刷新来源——台账探针才是。
      await vi.advanceTimersByTimeAsync(11_000);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      client.unmount();
      client.clear();
      vi.useRealTimers();
    }
  });
});
