// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSessionsWorkspace } from "../src/renderer/components/runtime/useRuntimeWorkspace.ts";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { squadRunsClient } from "../src/renderer/squad-run-client.ts";
import { invalidateLedgerDependents } from "../src/renderer/task-data.ts";

/**
 * 会话列表自动刷新(泽宇 2026-09-13 反馈):会话页挂载期间,新派工与 running→succeeded
 * 状态变化必须自动出现。刷新来源唯一——App 层台账探针推进 cut 后的
 * invalidateLedgerDependents 扇出(App.tsx 的 cut effect 调的正是它);runtime 会话
 * 生命周期事件是 canonical 事件,同样推进该 cut。会话读面自身没有计时器,第三条
 * 把这一点钉住。这里挂真实 hook(真实 query key),不复制视图层 fixture。
 */

const SINCE = "2026-09-13T00:00:00.000Z";
const runningGroups = {
  ok: true as const,
  status: "ready" as const,
  totals: { groups: 1, sessions: 1 },
  truncated: false,
  watermark: 1,
  sourceRevision: 1,
  groups: [
    {
      key: "task-bound",
      kind: "task" as const,
      label: "Bound task title",
      taskId: "task-bound",
      latestStatus: "running" as const,
      latestActivityAt: "2026-09-13T02:00:00.000Z",
      runningCount: 1,
      sessionCount: 1,
      roundCount: 1,
      latestRound: {
        runtimeSessionId: "runtime-bound",
        dispatchId: "dispatch_bbb",
        agentName: "terra",
        instanceId: "instance-terra",
        status: "running" as const,
        startedAt: "2026-09-13T02:00:00.000Z",
      },
    },
  ],
};
const settledGroups = {
  ...runningGroups,
  totals: { groups: 2, sessions: 2 },
  groups: [
    {
      ...runningGroups.groups[0]!,
      latestStatus: "succeeded" as const,
      runningCount: 0,
      latestRound: { ...runningGroups.groups[0]!.latestRound!, status: "succeeded" as const },
    },
    {
      ...runningGroups.groups[0]!,
      key: "task-incoming",
      label: "Incoming dispatch",
      taskId: "task-incoming",
    },
  ],
};
const emptySquadRuns = {
  ok: true as const,
  status: "ready" as const,
  runs: [],
  totals: { runs: 0 },
  truncated: false,
  watermark: 1,
  sourceRevision: 1,
};

const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];
let workspace: ReturnType<typeof useSessionsWorkspace> | undefined;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  workspace = undefined;
});

describe("sessions list refresh source (ledger cut fan-out)", () => {
  it("shows a newly dispatched group and a settled status once the ledger cut advances", async () => {
    await mountSessionsWorkspace(runningGroups);
    const client = mounted.at(-1)!.client;
    expect(workspace?.groups.data?.groups[0]?.latestStatus).toBe("running");
    // 服务器侧前进:原组的运行轮已成功,另派了一个新任务组。
    vi.spyOn(agentRuntimeClient, "sessionGroups").mockResolvedValue(settledGroups);

    await act(async () => {
      await invalidateLedgerDependents(client, "repo-a");
    });
    await flushEffects();

    expect(workspace?.groups.data?.groups.find((group) => group.key === "task-bound")?.latestStatus).toBe("succeeded");
    expect(workspace?.groups.data?.groups.some((group) => group.key === "task-incoming")).toBe(true);
  });

  it("rereads the squad run list on the same cut advance", async () => {
    await mountSessionsWorkspace(runningGroups);
    const client = mounted.at(-1)!.client,
      reads = vi.mocked(squadRunsClient.list),
      before = reads.mock.calls.length;

    await act(async () => {
      await invalidateLedgerDependents(client, "repo-a");
    });

    expect(reads.mock.calls.length).toBe(before + 1);
  });

  it("owns no polling of its own and an unmounted sessions query only goes stale", async () => {
    await mountSessionsWorkspace(runningGroups);
    const client = mounted.at(-1)!.client,
      groupsQuery = client
        .getQueryCache()
        .getAll()
        .find((query) => query.queryKey[0] === "session-groups")!,
      reads = vi.mocked(agentRuntimeClient.sessionGroups),
      idle = reads.mock.calls.length;
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(reads.mock.calls.length).toBe(idle);

    await act(async () => {
      mounted.pop()!.root.unmount();
    });
    const unmounted = reads.mock.calls.length;
    await act(async () => {
      await invalidateLedgerDependents(client, "repo-a");
    });
    expect(reads.mock.calls.length).toBe(unmounted);
    expect(groupsQuery.state.isInvalidated).toBe(true);
  });
});

async function mountSessionsWorkspace(groups: typeof runningGroups) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(agentRuntimeClient, "sessionGroups").mockResolvedValue(groups);
  vi.spyOn(squadRunsClient, "list").mockResolvedValue(emptySquadRuns);
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(SessionsWorkspaceProbe)));
  });
  await flushEffects();
}

function SessionsWorkspaceProbe() {
  workspace = useSessionsWorkspace("repo-a", {
    groupBy: "task",
    range: "24h",
    since: SINCE,
    squadSince: SINCE,
    query: "",
    status: [],
  });
  return null;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
